/**
 * Auto-goal behaviour for the browser half: while the preference is armed,
 * every ordinary composer prompt becomes the session's goal, and the goal is
 * marked complete once the agent produces its answer.
 *
 * The browser observes the Session's durable event window, so a prompt is
 * recognized by the same `agent/inbox/spliced` event the Host records, and
 * the completion signal is the `assistant/message` event the Host appends
 * when a model turn finishes. The goal itself is created and completed
 * through the generated Goal Remote API.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId, SessionEvent } from '@deepseek-ai/dsh-session/types'
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

/** One admitted composer prompt: a user-sourced message with non-empty text. */
function isPrompt(message: UserMessage): boolean {
  return message.source.kind === 'user' && objectiveOf(message) !== ''
}

/** Whether one durable event is the final message of a model turn. */
function isAssistantAnswer(event: SessionEvent): boolean {
  return event.type === 'assistant/message'
}

/**
 * Create the Session's goal from a prompt, replacing a goal that is not
 * complete.
 *
 * The Host refuses a second goal while one stands, so a goal that is not
 * complete is cleared first. A completed goal is left alone: the Host
 * replaces it on the next create.
 * @param ctx - the client context owning the Remote API.
 * @param sessionId - the Session whose goal changes.
 * @param objective - the goal objective text.
 * @returns the created goal reference, or undefined when the goal could not
 * be created.
 */
export async function armGoal(
  ctx: ClientContext,
  sessionId: SessionId,
  objective: string,
): Promise<GoalRef | undefined> {
  const current = await ctx.remote.goals.get(sessionId)
  if (current.ok && current.value !== undefined && current.value.phase !== 'complete') {
    const ref: GoalRef = { id: current.value.id, revision: current.value.revision }
    const cleared = await ctx.remote.goals.clear(sessionId, ref)
    if (!cleared.ok) {
      ctx.logger.warn(`[ui-goal] could not clear the previous goal: ${cleared.error.message}`)
      return undefined
    }
  }
  const created = await ctx.remote.goals.create(sessionId, { objective })
  if (!created.ok) {
    ctx.logger.warn(`[ui-goal] could not create the goal: ${created.error.message}`)
    return undefined
  }
  return created.value.ref
}

/** Mark the Session's goal complete once the agent answered. */
export async function completeGoal(
  ctx: ClientContext,
  sessionId: SessionId,
  ref: GoalRef,
): Promise<void> {
  const completed = await ctx.remote.goals.complete(sessionId, ref)
  if (!completed.ok) {
    ctx.logger.warn(`[ui-goal] could not complete the goal: ${completed.error.message}`)
  }
}

/**
 * Subscribe to the Session's event window and report every composer prompt
 * and model-turn completion.
 *
 * Only the tail of the window is new since the last observation, and the
 * window may be replaced by a history open, which resets the tail. The
 * subscription starts from the window's current tail, so messages admitted
 * before the preference was armed never count as prompts.
 * @param ctx - the client context owning the Session and Remote API.
 * @param sessionId - the Session to watch.
 * @param onPrompt - receives the objective of every composer prompt.
 * @param onAssistantAnswer - called after a model turn finishes.
 * @returns a disposer that stops the watch.
 */
export function subscribeAutoGoalEvents(
  ctx: ClientContext,
  sessionId: SessionId,
  onPrompt: (objective: string) => void,
  onAssistantAnswer: () => void,
): () => void {
  const binding = ctx.sessions.binding(sessionId)
  if (binding === undefined) return () => {}
  const eventSource = binding.eventSource
  // Start from the current tail so only events that arrive after the
  // subscription began are considered; a history window reset restarts the
  // scan from the new tail.
  let seen = eventSource.getSnapshot().entries.length
  return eventSource.subscribe(() => {
    const entries = eventSource.getSnapshot().entries
    if (entries.length < seen) seen = 0
    const fresh = entries.slice(seen)
    seen = entries.length
    for (const entry of fresh) {
      if (entry.type !== 'event') continue
      const event = entry.event
      if (event.type === 'agent/inbox/spliced') {
        for (const message of event.data.inserted) {
          if (isPrompt(message)) onPrompt(objectiveOf(message))
        }
      } else if (isAssistantAnswer(event)) {
        onAssistantAnswer()
      }
    }
  })
}

/** Live inputs for one Session's auto-goal source. */
export interface AutoGoalSourceDeps {
  /** The browser-held preference and its listener surface. */
  readonly enabled: ObservableSnapshot<boolean>
  /** Create the Session's goal from one composer prompt. */
  readonly armGoal: (objective: string) => Promise<GoalRef | undefined>
  /** Mark the Session's goal complete after the agent answers. */
  readonly completeGoal: (ref: GoalRef) => Promise<void>
  /** Watch the Session's durable event window. */
  readonly subscribeEvents: (
    onPrompt: (objective: string) => void,
    onAssistantAnswer: () => void,
  ) => () => void
}

/**
 * Create one registrant-private auto-goal source. The source subscribes to
 * the Session's event window and the preference only while a framework hook
 * observes it, so unmount releases both listeners. The preference is read at
 * the moment a prompt arrives, so a prompt that arrives before the button is
 * pressed creates no goal; the goal created by a prompt is completed when
 * the agent's answer lands, so a finished turn does not leave the goal
 * running.
 * @param deps - preference, event window, and goal mutation inputs.
 * @returns stable snapshot source consumed by `useAutoGoal`.
 */
export function createAutoGoalSource(deps: AutoGoalSourceDeps): ObservableSnapshot<boolean> {
  let enabled = deps.enabled.getSnapshot()
  let subscriptions = 0
  let disposers: readonly (() => void)[] = []
  let pendingGoal: GoalRef | undefined
  const listeners = new Set<() => void>()

  const publish = (next: boolean): void => {
    if (next === enabled) return
    enabled = next
    for (const listener of listeners) listener()
  }

  const onPrompt = (objective: string): void => {
    if (!enabled) return
    pendingGoal = undefined
    void deps.armGoal(objective).then((ref) => { pendingGoal = ref })
  }

  const onAssistantAnswer = (): void => {
    if (!enabled || pendingGoal === undefined) return
    const ref = pendingGoal
    pendingGoal = undefined
    void deps.completeGoal(ref)
  }

  const start = (): void => {
    disposers = [
      deps.enabled.subscribe(() => { publish(deps.enabled.getSnapshot()) }),
      deps.subscribeEvents(onPrompt, onAssistantAnswer),
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
