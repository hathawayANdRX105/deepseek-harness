/**
 * Auto-goal behaviour for the browser half: while the preference is armed,
 * every ordinary composer prompt becomes the session's goal through the
 * `/goal` command.
 *
 * The browser observes the Session's durable event window, so a prompt is
 * recognized by the same `agent/inbox/spliced` event the Host records. The
 * goal itself is created through the generated Command Remote API: a fresh
 * goal runs `/goal <objective>`, and a goal that is still open runs
 * `/goal edit <objective>` to take over the new objective without resetting
 * the goal lifecycle. The goal system then drives the agent, which reads the
 * goal and completes or clears it through its own tool calls.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
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

/** Live inputs for one Session's auto-goal source. */
export interface AutoGoalSourceDeps {
  /** The browser-held preference and its listener surface. */
  readonly enabled: ObservableSnapshot<boolean>
  /**
   * Make one composer prompt the Session's goal through the `/goal` command.
   * @param objective - the goal objective text.
   */
  readonly applyGoalCommand: (objective: string) => void
  /** Watch the Session's durable event window for composer prompts. */
  readonly subscribePrompts: (onPrompt: (objective: string) => void) => () => void
}

/**
 * Create one registrant-private auto-goal source. The source subscribes to
 * the Session's event window and the preference only while a framework hook
 * observes it, so unmount releases both listeners. The preference is read at
 * the moment a prompt arrives, so a prompt that arrives before the button is
 * pressed creates no goal.
 * @param deps - preference, event window, and goal command inputs.
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
    if (!enabled) return
    deps.applyGoalCommand(objective)
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

/** Goal phases that still stand and should take a new objective via `/goal edit`. */
function isOpenGoal(goal: { readonly phase: string } | undefined): boolean {
  return goal !== undefined && goal.phase !== 'complete'
}

/**
 * Apply the auto-goal preference to one composer prompt: create a fresh goal
 * or take the prompt over as the current goal's objective, through the
 * `/goal` command.
 * @param ctx - the client context owning the Remote APIs.
 * @param sessionId - the Session whose goal changes.
 * @param objective - the goal objective text.
 */
export async function applyGoalCommand(
  ctx: ClientContext,
  sessionId: SessionId,
  objective: string,
): Promise<void> {
  const current = await ctx.remote.goals.get(sessionId)
  const line = isOpenGoal(current.ok ? current.value : undefined)
    ? `/goal edit ${objective}`
    : `/goal ${objective}`
  const result = await ctx.remote.commands.execute(sessionId, line, [])
  if (!result.ok) {
    ctx.logger.warn(`[ui-goal] ${line} failed: ${result.error.message}`)
  } else if (result.value === undefined) {
    ctx.logger.warn(`[ui-goal] ${line} did not resolve a command`)
  } else {
    ctx.logger.info(`[ui-goal] ${line} settled`)
  }
}

/**
 * Subscribe to the Session's event window and report every composer prompt.
 *
 * Only the tail of the window is new since the last observation, and the
 * window may be replaced by a history open, which resets the tail. The
 * subscription starts from the window's current tail, so messages admitted
 * before the preference was armed never count as prompts.
 * @param ctx - the client context owning the Session.
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
      if (entry.event.type !== 'agent/inbox/spliced') continue
      for (const message of entry.event.data.inserted) {
        if (isPrompt(message)) onPrompt(objectiveOf(message))
      }
    }
  })
}
