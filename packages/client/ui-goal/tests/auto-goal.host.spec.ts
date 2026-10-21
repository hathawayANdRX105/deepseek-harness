/**
 * REAL-composition coverage: the auto-goal preference behind a real profile
 * boot (real settings document, real Loader) over a real agent and the real
 * goal service. The browser half is covered by browser-plugin.client.spec.tsx.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import GoalService from '@deepseek-ai/dsh-goal'
import type { GoalView } from '@deepseek-ai/dsh-goal'
import * as GoalRoundDriver from '@deepseek-ai/dsh-goal-round-driver'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import Settings from '@deepseek-ai/dsh-settings'
import * as AutoGoal from '../src/index.ts'

/** One successful plain-text model response. */
function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** Request-recording adapter answering every turn with plain text. */
class TextAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield* textResponse('acknowledged')
  }
}

/** Write a minimal profile whose patch mounts the settings service and the plugin. */
function writeProfile(home: string, autoGoal: boolean): { dir: string; profile: ProfileContext } {
  const dir = join(home, 'profiles', 'test')
  initProfile(dir, ['test-bundle'])
  const bundle = join(dir, 'node_modules', 'test-bundle')
  mkdirSync(bundle, { recursive: true })
  writeFileSync(join(home, 'package.json'), '{"name":"test-installation"}\n')
  writeFileSync(join(bundle, 'package.json'), JSON.stringify({ name: 'test-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  writeFileSync(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'config-editor', name: 'cordis:editor' },
    { id: 'settings', name: 'cordis:settings' },
    { id: 'auto-goal', name: 'cordis:auto-goal', config: { autoGoal } },
  ] }]))
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  return {
    dir,
    profile: {
      name: 'test', startedBundles: ['test-bundle'], dir, patchPath: join(dir, 'cordis.patch.yml'),
      installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
    },
  }
}

interface Harness {
  readonly ctx: Context
  readonly agent: Agent
  readonly adapter: TextAdapter
}

/** Boot the profile with the agent and goal services mounted before the Loader settles. */
async function harness(autoGoal: boolean, options: { driver?: boolean } = {}): Promise<Harness> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ui-goal-auto-')))
  const { dir, profile } = writeProfile(home, autoGoal)
  onTestFinished(() => { rmSync(home, { recursive: true, force: true }) })
  const adapter = new TextAdapter()
  const ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), async (ctx) => {
    ctx.provide('profileContext', profile)
    ctx.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
    Object.assign(ctx.loader.builtins, { editor: ConfigEditor, settings: Settings, 'auto-goal': AutoGoal })
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(GoalService)
    ctx.llm.registerAdapter(['mock'], adapter)
    await ctx.plugin(AgentLoop, { agents: [] })
    if (options.driver === true) await ctx.plugin(GoalRoundDriver)
  })
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const agent = await ctx.agentLoop.create(SessionId(`auto-goal-${Math.random()}`), { provider: 'mock', model: 'mock' })
  return { ctx, agent, adapter }
}

/** Send one ordinary composer prompt. */
function prompt(agent: Agent, text: string): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

/** Wait until the goal projection reports one goal, then return it. */
async function currentGoal(ctx: Context, agent: Agent): Promise<GoalView | undefined> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const goal = ctx.goals.get(agent)
    if (goal !== undefined) return goal
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  return undefined
}

/** Wait until the goal has started at least one driver round, then return it. */
async function drivenGoal(ctx: Context, agent: Agent): Promise<GoalView | undefined> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const goal = ctx.goals.get(agent)
    if (goal !== undefined && goal.roundsStarted > 0) return goal
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  return ctx.goals.get(agent)
}

/** Give the listener time to observe a message that must not create a goal. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 100))
}

describe('ui-goal auto goal (real composition)', () => {
  it('creates one armed goal per composer prompt while enabled', async () => {
    const { ctx, agent } = await harness(true)
    prompt(agent, 'ship the release notes')
    const goal = await currentGoal(ctx, agent)
    expect(goal?.objective).toBe('ship the release notes')
    expect(goal?.phase).toBe('active')
  })

  it('replaces a previous goal so each prompt starts fresh', async () => {
    const { ctx, agent } = await harness(true)
    prompt(agent, 'first task')
    const first = await currentGoal(ctx, agent)
    prompt(agent, 'second task')
    const second = await currentGoal(ctx, agent)
    expect(second?.objective).toBe('second task')
    expect(second?.id).not.toBe(first?.id)
  })

  it('stops creating goals while the preference is disabled', async () => {
    const { ctx, agent } = await harness(false)
    prompt(agent, 'no goal wanted')
    await settle()
    expect(ctx.goals.get(agent)).toBeUndefined()
  })

  it('replaces a completed goal on the next prompt', async () => {
    const { ctx, agent } = await harness(true)
    prompt(agent, 'finished task')
    const created = await currentGoal(ctx, agent)
    ctx.goals.complete(agent, { id: created!.id, revision: created!.revision })
    expect(ctx.goals.get(agent)?.phase).toBe('complete')
    prompt(agent, 'next task')
    const replaced = await currentGoal(ctx, agent)
    expect(replaced?.objective).toBe('next task')
  })

  it('ignores an empty prompt', async () => {
    const { ctx, agent } = await harness(true)
    prompt(agent, '   ')
    await settle()
    expect(ctx.goals.get(agent)).toBeUndefined()
  })

  it('keeps the goal-round driver driving the goal it created', async () => {
    const { ctx, agent } = await harness(true, { driver: true })
    prompt(agent, 'drive this goal')
    const goal = await drivenGoal(ctx, agent)
    // The driver claims rounds of its own and the mock adapter answers
    // instantly, so the goal can reach its round cap. What matters is that the
    // driver took the created goal and advanced it.
    expect(goal?.roundsStarted).toBeGreaterThan(0)
    expect(goal?.id).toBeDefined()
  })

  it('hands the goal-round driver the replaced goal after a new prompt', async () => {
    const { ctx, agent } = await harness(true, { driver: true })
    prompt(agent, 'first driven goal')
    const first = await drivenGoal(ctx, agent)
    expect(first?.roundsStarted).toBeGreaterThan(0)
    prompt(agent, 'second driven goal')
    const second = await drivenGoal(ctx, agent)
    expect(second?.objective).toBe('second driven goal')
    expect(second?.id).not.toBe(first?.id)
    expect(second?.roundsStarted).toBeGreaterThan(0)
  })
})
