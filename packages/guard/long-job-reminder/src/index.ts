/**
 * Advisory job-duration reminder. A background job that nobody watches keeps
 * spending CPU and disk, so before an agent's next step this guard lists the
 * jobs that have run past a configured budget and tells the model to collect
 * or stop them. It injects logged model context and never kills anything.
 * Configuration lives in the package README.
 * @module @deepseek-ai/dsh-long-job-reminder
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import type { JobId, JobView } from '@deepseek-ai/dsh-jobs'
import type { UserMessage } from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'long-job-reminder': { kind: 'long-job-reminder' } & ContextFormed
  }
}

export const name = 'long-job-reminder'

/** The background job registry this guard reads. */
export const inject = ['jobs']

/** Plugin configuration: when a reminder is due, and how much of each job it quotes. */
export interface Config {
  /**
   * Wall-clock milliseconds a job may run before the model is told about it
   * (default 120000). The shipped foreground command budget is shorter, so a
   * job past this point is one that was detached and then left alone.
   */
  remindAfterMs?: number
  /** Maximum jobs one reminder lists, longest-running first (default 5). */
  maxListed?: number
  /**
   * Maximum characters of a job label quoted in the reminder (default 120).
   * A label is producer-supplied and bounded only for what this guard writes;
   * the cap never affects which jobs are listed.
   */
  labelPreviewChars?: number
}

export const Config: z<Config> = z.object({
  remindAfterMs: z.number().default(120_000),
  maxListed: z.number().default(5),
  labelPreviewChars: z.number().default(120),
})

/** One live job with the wall-clock time it has been running. */
interface RunningJob {
  readonly job: JobView
  readonly elapsedMs: number
}

/**
 * Render a duration the model can compare against its own sense of time.
 * @param elapsedMs - milliseconds the job has been running.
 * @returns a compact `1h 4m`, `12m 3s`, or `45s` form.
 */
export function formatDuration(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

/**
 * The model-facing reminder: every listed job's id, elapsed time, and bounded
 * label, then the two actions that end the situation.
 * @param running - the jobs to list, longest-running first.
 * @param omitted - how many further jobs were due but did not fit the listing.
 * @param labelPreviewChars - per-label character cap.
 * @returns the notice text.
 */
export function reminderText(running: readonly RunningJob[], omitted: number, labelPreviewChars: number): string {
  const lines = running.map(({ job, elapsedMs }) => {
    const label = job.label.length <= labelPreviewChars ? job.label : `${job.label.slice(0, labelPreviewChars)}…`
    return `- ${job.id} (${formatDuration(elapsedMs)}): ${label}`
  })
  const rest = omitted === 0 ? '' : `\n${omitted} more job${omitted === 1 ? '' : 's'} ${omitted === 1 ? 'has' : 'have'} been running as long.`
  return 'Background jobs you started are still running:\n'
    + `${lines.join('\n')}${rest}\n`
    + 'Read the latest output with job_output, or stop a job you no longer need with job_kill. '
    + 'A search or build nobody is waiting on keeps consuming CPU and disk until it is stopped.'
}

/**
 * Install the reminder on the step boundary: it runs before each proposed
 * step, so the model learns about a stale job while it can still act on it.
 * A job is reported at most once; a settled job leaves the record.
 * @param ctx - plugin context; the listener is removed with it.
 * @param config - validated {@link Config}, re-checked here so an unusable
 * value fails at load instead of silently disabling the reminder.
 */
export function apply(ctx: Context, config: Config): void {
  const remindAfterMs = config.remindAfterMs as number
  const maxListed = config.maxListed as number
  const labelPreviewChars = config.labelPreviewChars as number
  if (!Number.isSafeInteger(remindAfterMs) || remindAfterMs <= 0) {
    throw new Error(`long-job-reminder: remindAfterMs must be a positive safe integer, got ${String(remindAfterMs)}`)
  }
  if (!Number.isSafeInteger(maxListed) || maxListed < 1) {
    throw new Error(`long-job-reminder: maxListed must be a positive safe integer, got ${String(maxListed)}`)
  }
  if (!Number.isSafeInteger(labelPreviewChars) || labelPreviewChars < 1) {
    throw new Error(`long-job-reminder: labelPreviewChars must be a positive safe integer, got ${String(labelPreviewChars)}`)
  }

  /** Job ids already reported per agent; entries for settled jobs are dropped on the next look. */
  const reported = new WeakMap<Agent, Set<JobId>>()

  /** The reminder due for one agent, or `undefined` when every job is either young or already reported. */
  function dueReminder(agent: Agent): UserMessage | undefined {
    const live = ctx.jobs.list(agent.id).filter(job => job.status === 'running' || job.status === 'stopping')
    const remembered = reported.get(agent) ?? new Set<JobId>()
    const liveIds = new Set(live.map(job => job.id))
    for (const id of remembered) {
      if (!liveIds.has(id)) remembered.delete(id)
    }
    reported.set(agent, remembered)
    const now = Date.now()
    const due = live
      .map(job => ({ job, elapsedMs: now - job.startedAt }))
      .filter(({ job, elapsedMs }) => elapsedMs >= remindAfterMs && !remembered.has(job.id))
      .sort((left, right) => right.elapsedMs - left.elapsedMs)
    if (due.length === 0) return undefined
    const listed = due.slice(0, maxListed)
    for (const { job } of listed) remembered.add(job.id)
    return createUserMessage({
      content: [{ type: 'text', text: reminderText(listed, due.length - listed.length, labelPreviewChars) }],
      source: {
        kind: 'long-job-reminder',
        form: 'notice',
        summary: `${listed.length} job${listed.length === 1 ? '' : 's'} running past ${formatDuration(remindAfterMs)}`,
      },
    })
  }

  ctx.on('agent/pre-step', async ({ agent }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const reminder = dueReminder(agent)
    if (reminder === undefined) return decision
    // Prepend: the reminder frames the step it arrives with, and the loop logs
    // it as a user message beside the messages the step already carried.
    return { ...decision, messages: [reminder, ...decision.messages] }
  })
}
