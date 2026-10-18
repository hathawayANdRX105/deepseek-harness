/**
 * Reminder coverage for @deepseek-ai/dsh-long-job-reminder: the due rule
 * against real background-job projections, the once-per-job record, the
 * bounded listing text, the fail-loud configuration, and the Loader path that
 * ships it. Steps are proposed through the same `agent/pre-step` dispatch the
 * agent loop uses, so the assertion reads the decision the loop would act on.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { JobId } from '@deepseek-ai/dsh-jobs'
import type { JobView } from '@deepseek-ai/dsh-jobs'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as LongJobReminder from '@deepseek-ai/dsh-long-job-reminder'
import { formatDuration, reminderText } from '@deepseek-ai/dsh-long-job-reminder'
import type { Config } from '@deepseek-ai/dsh-long-job-reminder'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    'test-job': 'test-job'
  }
}

let ctx: Context | undefined
let root: string | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** One job projection with only the fields the reminder reads made explicit. */
function jobView(id: string, startedAt: number, label: string, status: JobView['status'] = 'running'): JobView {
  return { id: JobId(id), kind: 'test-job', label, status, startedAt, output: { total: 0, earliest: 0 } }
}

const MINUTE = 60_000

/** Propose one step through the dispatch the loop uses, against a real agent. */
function proposeStep(context: Context, agent: Agent): Promise<PreStepDecision> {
  return agentEvents(context, agent).waterfall(
    'agent/pre-step',
    { messages: [] as UserMessage[], turn: 1, step: 0, signal: new AbortController().signal },
    () => Promise.resolve<PreStepDecision>({ kind: 'enter', messages: [] }),
  )
}


/** A registry-backed harness: real agent loop, a job listing this test owns, and the guard. */
async function harness(config: Config, jobs: readonly JobView[]): Promise<{ agent: Agent; propose: () => Promise<PreStepDecision> }> {
  const context = new Context()
  ctx = context
  await mountAgentLoopTestDependencies(context)
  await context.plugin(AgentLoop, { agents: [] })
  context.llm.registerAdapter(['mock'], new MockAdapter([textResponse('done')]))
  context.provide('jobs', { list: () => [...jobs] } as never)
  await context.plugin(LongJobReminder, config)
  const agent = await context.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
  const propose = () => agentEvents(context, agent).waterfall(
    'agent/pre-step',
    { messages: [] as UserMessage[], turn: 1, step: 0, signal: new AbortController().signal },
    () => Promise.resolve<PreStepDecision>({ kind: 'enter', messages: [] }),
  )
  return { agent, propose }
}

/** The injected reminders in one decision, flattened for terse assertions. */
function injected(decision: PreStepDecision): { text: string; source: unknown }[] {
  if (decision.kind === 'reject') return []
  return decision.messages
    .filter(message => message.source.kind === 'long-job-reminder')
    .map(message => ({
      text: message.content.map(block => block.type === 'text' ? block.text : '').join('|'),
      source: message.source,
    }))
}

describe('duration and listing text', () => {
  it('renders seconds, minutes, and hours', () => {
    expect(formatDuration(0)).toBe('0s')
    expect(formatDuration(45_000)).toBe('45s')
    expect(formatDuration(12 * MINUTE + 3_000)).toBe('12m 3s')
    expect(formatDuration(3 * 3600_000 + 4 * MINUTE)).toBe('3h 4m')
    expect(formatDuration(-5)).toBe('0s')
  })

  it('names every job, truncates a long label, and counts the omitted ones', () => {
    const text = reminderText([
      { job: jobView('bash-7', 0, 'grep -rn ci_scope --include=* .'), elapsedMs: 12 * MINUTE },
      { job: jobView('bash-8', 0, 'x'.repeat(50)), elapsedMs: 3 * MINUTE },
    ], 2, 40)
    expect(text).toContain('- bash-7 (12m 0s): grep -rn ci_scope --include=* .')
    expect(text).toContain(`- bash-8 (3m 0s): ${'x'.repeat(40)}…`)
    expect(text).toContain('2 more jobs have been running as long.')
    expect(text).toContain('job_output')
    expect(text).toContain('job_kill')
  })
})

describe('due rule', () => {
  it('reminds about a job past the budget and records it once', async () => {
    const old = Date.now() - 10 * MINUTE
    const { propose } = await harness({ remindAfterMs: MINUTE }, [jobView('bash-7', old, 'grep -rn ci_scope --include=* .')])
    const first = injected(await propose())
    expect(first).toHaveLength(1)
    expect(first[0]!.text).toContain('- bash-7 (10m 0s): grep -rn ci_scope --include=* .')
    expect(first[0]!.source).toMatchObject({ kind: 'long-job-reminder', form: 'notice' })
    expect(injected(await propose())).toHaveLength(0)
  })

  it('leaves a young job alone', async () => {
    const { propose } = await harness({ remindAfterMs: MINUTE }, [jobView('bash-1', Date.now(), 'pnpm build')])
    expect(injected(await propose())).toHaveLength(0)
  })

  it('ignores settled jobs', async () => {
    const { propose } = await harness({ remindAfterMs: 1 }, [jobView('bash-2', Date.now() - 10 * MINUTE, 'x', 'completed')])
    expect(injected(await propose())).toHaveLength(0)
  })

  it('lists the longest-running jobs first and caps the listing', async () => {
    const now = Date.now()
    const { propose } = await harness({ remindAfterMs: 1, maxListed: 2 }, [
      jobView('bash-1', now - 2 * MINUTE, 'second'),
      jobView('bash-2', now - 30 * MINUTE, 'longest'),
      jobView('bash-3', now - 5 * MINUTE, 'third'),
    ])
    const reminders = injected(await propose())
    expect(reminders).toHaveLength(1)
    expect(reminders[0]!.text.indexOf('bash-2')).toBeLessThan(reminders[0]!.text.indexOf('bash-3'))
    expect(reminders[0]!.text).not.toContain('bash-1')
    expect(reminders[0]!.text).toContain('1 more job has been running as long.')
  })

  it('reports a job that was still running when its record came back', async () => {
    const { propose } = await harness({ remindAfterMs: 1 }, [jobView('bash-9', Date.now() - MINUTE, 'stopping', 'stopping')])
    expect(injected(await propose())).toHaveLength(1)
  })

  it('forgets a settled job, so a new job under the same id is reported again', async () => {
    const jobs: JobView[] = [jobView('bash-4', Date.now() - 10 * MINUTE, 'first run')]
    const context = new Context()
    ctx = context
    await mountAgentLoopTestDependencies(context)
    await context.plugin(AgentLoop, { agents: [] })
    context.llm.registerAdapter(['mock'], new MockAdapter([textResponse('done')]))
    context.provide('jobs', { list: () => [...jobs] } as never)
    await context.plugin(LongJobReminder, { remindAfterMs: 1 })
    const agent = await context.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    const propose = () => proposeStep(context, agent)
    expect(injected(await propose())).toHaveLength(1)
    jobs[0] = jobView('bash-4', Date.now() - 10 * MINUTE, 'first run', 'completed')
    expect(injected(await propose())).toHaveLength(0)
    jobs[0] = jobView('bash-4', Date.now() - 10 * MINUTE, 'second run')
    expect(injected(await propose())).toHaveLength(1)
  })

  it('leaves a step alone when a later listener rejects it', async () => {
    const context = new Context()
    ctx = context
    await mountAgentLoopTestDependencies(context)
    await context.plugin(AgentLoop, { agents: [] })
    context.llm.registerAdapter(['mock'], new MockAdapter([textResponse('done')]))
    context.provide('jobs', { list: () => [jobView('bash-5', Date.now() - MINUTE, 'x')] } as never)
    await context.plugin(LongJobReminder, { remindAfterMs: 1 })
    await context.plugin({
      name: 'reject-steps',
      apply(rejectCtx: Context) {
        rejectCtx.on('agent/pre-step', () => Promise.resolve<PreStepDecision>({ kind: 'reject' }))
      },
    })
    const agent = await context.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    const decision = await agentEvents(context, agent).waterfall(
      'agent/pre-step',
      { messages: [] as UserMessage[], turn: 1, step: 0, signal: new AbortController().signal },
      () => Promise.resolve<PreStepDecision>({ kind: 'enter', messages: [] }),
    )
    expect(decision).toEqual({ kind: 'reject' })
  })

  it('fails loud on an unusable configuration', async () => {
    const context = new Context()
    ctx = context
    await mountAgentLoopTestDependencies(context)
    await context.plugin(AgentLoop, { agents: [] })
    context.provide('jobs', { list: () => [] } as never)
    const zero = await context.plugin(LongJobReminder, { remindAfterMs: 0 }).then(() => undefined, (error: unknown) => error)
    expect(String(zero)).toMatch(/remindAfterMs/)
    const noListing = await context.plugin(LongJobReminder, { maxListed: 0 }).then(() => undefined, (error: unknown) => error)
    expect(String(noListing)).toMatch(/maxListed/)
    const noLabel = await context.plugin(LongJobReminder, { labelPreviewChars: 0 }).then(() => undefined, (error: unknown) => error)
    expect(String(noLabel)).toMatch(/labelPreviewChars/)
  })
})

describe('long-job-reminder real Loader composition', () => {
  it('loads the plugin and injects its reminder into a proposed step', async () => {
    const context = new Context()
    ctx = context
    await mountAgentLoopTestDependencies(context)
    await context.plugin(AgentLoop, { agents: [] })
    context.llm.registerAdapter(['mock'], new MockAdapter([textResponse('done')]))

    const old = Date.now() - 10 * MINUTE
    const stubJobs = {
      name: 'stub-jobs',
      apply(stubCtx: Context) {
        stubCtx.provide('jobs', { list: () => [jobView('bash-7', old, 'grep -rn ci_scope')] } as never)
      },
    }
    root = await mkdtemp(join(tmpdir(), 'dsh-long-job-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      '- name: cordis:stub-jobs',
      "- name: 'cordis:@deepseek-ai/dsh-long-job-reminder'",
      '  config:',
      '    remindAfterMs: 60000',
      '    maxListed: 3',
      '',
    ].join('\n'))
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    context.loader.builtins['stub-jobs'] = stubJobs
    context.loader.builtins['@deepseek-ai/dsh-long-job-reminder'] = LongJobReminder
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await context.loader.await()

    const agent = await context.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    const decision = await agentEvents(context, agent).waterfall(
      'agent/pre-step',
      { messages: [] as UserMessage[], turn: 1, step: 0, signal: new AbortController().signal },
      () => Promise.resolve<PreStepDecision>({ kind: 'enter', messages: [] }),
    )
    const reminders = injected(decision)
    expect(reminders).toHaveLength(1)
    expect(reminders[0]!.text).toContain('bash-7')
  })

  it('exports named plugin members and no default export', async () => {
    const module = await import('@deepseek-ai/dsh-long-job-reminder')
    expect('default' in module).toBe(false)
    expect(module.name).toBe('long-job-reminder')
    expect(typeof module.apply).toBe('function')
  })
})
