/**
 * Auto-goal behaviour for the browser half: while the preference is armed,
 * every ordinary composer prompt becomes the session's goal.
 *
 * The browser observes the Session's durable event window, so a prompt is
 * recognized by the same `agent/inbox/spliced` event the Host records. The
 * goal itself is created through the generated Goal Remote API.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { GoalRef } from '@deepseek-ai/dsh-goal/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'

/** Join the text blocks of one admitted prompt into the goal objective. */
function objectiveOf(message: UserMessage): string {
  return message.content
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim()
}

/**
 * Replace the Session's current goal with one built from a prompt.
 *
 * A goal that is not complete is cleared first, because the Host refuses a
 * second goal while one stands. A completed goal is left alone: the Host
 * replaces it on the next create.
 * @param ctx - the client context owning the Remote API.
 * @param sessionId - the Session whose goal changes.
 * @param objective - the goal objective text.
 */
export async function armGoal(
  ctx: ClientContext,
  sessionId: SessionId,
  objective: string,
): Promise<void> {
  const current = await ctx.remote.goals.get(sessionId)
  if (current.ok && current.value !== undefined && current.value.phase !== 'complete') {
    const ref: GoalRef = { id: current.value.id, revision: current.value.revision }
    const cleared = await ctx.remote.goals.clear(sessionId, ref)
    if (!cleared.ok) {
      ctx.logger.warn(`[ui-goal] could not clear the previous goal: ${cleared.error.message}`)
      return
    }
  }
  const created = await ctx.remote.goals.create(sessionId, { objective })
  if (!created.ok) {
    ctx.logger.warn(`[ui-goal] could not create the goal: ${created.error.message}`)
  }
}

/**
 * Subscribe to the Session's event window and report every composer prompt.
 *
 * Only the tail of the window is new since the last observation, and the
 * window may be replaced by a history open, which resets the tail.
 * @param ctx - the client context owning the Session and Remote API.
 * @param sessionId - the Session to watch.
 * @param onPrompt - receives the objective of every composer prompt.
 * @returns a disposer that stops the watch.
 */
export function subscribePrompts(
  ctx: ClientContext,
  sessionId: SessionId,
  onPrompt: (objective: string) => void,
): () => void {
  const binding = ctx.sessions.binding(sessionId)
  if (binding === undefined) return () => {}
  let seen = 0
  return binding.eventSource.subscribe(() => {
    const entries = binding.eventSource.getSnapshot().entries
    if (entries.length < seen) seen = 0
    const fresh = entries.slice(seen)
    seen = entries.length
    for (const entry of fresh) {
      if (entry.type !== 'event') continue
      if (entry.event.type !== 'agent/inbox/spliced') continue
      for (const message of entry.event.data.inserted) {
        if (message.source.kind !== 'user') continue
        const objective = objectiveOf(message)
        if (objective === '') continue
        onPrompt(objective)
      }
    }
  })
}

/** Live inputs for one Session's auto-goal source. */
export interface AutoGoalSourceDeps {
  /** The browser-held preference and its listener surface. */
  readonly enabled: ObservableSnapshot<boolean>
  /** Make one composer prompt the Session's goal. */
  readonly armGoal: (objective: string) => void
  /** Watch the Session's durable event window for composer prompts. */
  readonly subscribePrompts: (onPrompt: (objective: string) => void) => () => void
}

/**
 * Create one registrant-private auto-goal source. The source subscribes to
 * the Session's event window and the preference only while a framework hook
 * observes it, so unmount releases both listeners; the preference is read at
 * the moment a prompt arrives, so a prompt that arrives before the button is
 * pressed creates no goal.
 * @param deps - preference, event window, and arming action inputs.
 * @returns stable snapshot source consumed by `useAutoGoal`.
 */
export function createAutoGoalSource(deps: AutoGoalSourceDeps): ObservableSnapshot<boolean> {
  let enabled = deps.enabled.getSnapshot()
  let subscriptions = 0
  let disposers: readonly (() => void)[] = []
  const listeners = new Set<() => void>()

  const publish = (next: boolean): void => {
    if (next === enabled) return
    enabled = next
    for (const listener of listeners) listener()
  }

  const onPrompt = (objective: string): void => {
    if (enabled) deps.armGoal(objective)
  }

  const start = (): void => {
    disposers = [
      deps.enabled.subscribe(() => { publish(deps.enabled.getSnapshot()) }),
      deps.subscribePrompts(onPrompt),
    ]
  }

  const stop = (): void => {
    for (const dispose of disposers) dispose()
    disposers = []
  }

  return {
    getSnapshot: () => enabled,
    subscribe(listener) {
      listeners.add(listener)
      if (subscriptions === 0) start()
      subscriptions++
      return () => {
        listeners.delete(listener)
        subscriptions--
        if (subscriptions === 0) stop()
      }
    },
  }
}
