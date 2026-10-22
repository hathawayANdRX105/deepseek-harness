/**
 * Goal surface plugin, browser half: the GoalBar entry and the auto-goal
 * toggle in the conversation.input.dock strip. The durable goal arrives through
 * `useProjection('goal')`. A registrant-private activation hook source owns
 * the live Remote read and event subscription; the inject face carries that
 * hook plus the four mutation verbs through the generated Goal Remote API.
 * Activation reads retain the Client Session through completion and wait
 * for its initial history open to succeed before contacting the Host.
 * The auto-goal toggle mirrors the Host-persisted `ui-goal.autoGoal`
 * preference and publishes toggle writes through the shared config form.
 * This plugin does not create goals by itself; deployments may expose
 * /goal separately, and the Host half of this plugin turns composer
 * prompts into goals only while the auto-goal preference is enabled.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the generated Remote API and ctx.remote merge through the Client assembly boundary.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the Session Controller service used for projected goal state.
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: pulls the Chat node slot and its keyed data map.
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
// Type-only: pulls the Conversation service and input-dock slot.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the renderer-owned slots service.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the Session standard useProjection seat.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
// Type-only: pulls the shared configuration-form service (ctx.configForms).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the `goal` SessionProjectionMap key merge (single source, the domain's pure outlet).
import type { GoalProjection, GoalRef } from '@deepseek-ai/dsh-goal/client'
import { GOAL_SETTINGS_NAMESPACE, type GoalSettings } from '../goal-settings.ts'
import type { AutoGoalToggleInjected, GoalActionResult, GoalBarInjected } from './slots.ts'
import { createGoalActivationSource } from './activation-source.ts'
import { armGoal, createAutoGoalSource, subscribePrompts } from './auto-goal.ts'
import { createAutoGoalPreference } from './auto-goal-preference.ts'
import { GoalDock } from './GoalBar.tsx'
import { AutoGoalToggle } from './AutoGoalToggle.tsx'
import { GoalCommandInputView } from './GoalCommandInputView.tsx'
import { goalCommandInputDefinition } from './goal-command-input.ts'
import { en, zh, type GoalKey } from './locales.ts'

export { GoalBar, GoalDock } from './GoalBar.tsx'
export type {
  GoalActionResult, GoalBarActions,
} from './slots.ts'
export type { GoalKey } from './locales.ts'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    /** A live goal read waiting for initial history and its RPC result. */
    goalActivation: unknown
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The goal strip's copy. */
    goal: GoalKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'goal'

/** Required services for the Goal dock, command-input projection, Remote mutations, auto-goal preference, and copy. */
export const inject = ['slots', 'sessions', 'remote', 'remote.goals', 'locale', 'uiConversation', 'configForms']

/**
 * Client plugin body: the GoalBar and auto-goal dock entries with their
 * mutation verbs and the mirrored auto-goal preference.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.uiConversation.events.register(goalCommandInputDefinition)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-goal: dictionaries')

  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'command-input',
    locale: NS,
  }, GoalCommandInputView))

  const sessions = ctx.sessions

  /** The session's current projected CAS ref, read at verb call time (no staleness fence: the RPC's CAS is the guard). */
  const refOf = (sessionId: SessionId): GoalRef | undefined => {
    const face = sessions.binding(sessionId)?.session.projections.faceOf('goal')
    const projection = face?.getSnapshot() as GoalProjection | null | undefined
    if (projection == null) return undefined
    return { id: projection.goal.id, revision: projection.goal.revision }
  }

  const noCurrentGoal: GoalActionResult = {
    ok: false,
    error: { code: 'no-current-goal', message: 'no current goal to mutate' },
  }

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'goal',
    order: 10,
    locale: NS,
    inject: (sessionId: SessionId): GoalBarInjected => {
      const binding = sessions.binding(sessionId)
      if (binding === undefined) throw new Error(`ui-goal: session "${sessionId}" is unavailable`)
      const goalActivation = createGoalActivationSource({
        projection: binding.session.projections.faceOf('goal') as HostObservable<GoalProjection | null | undefined>,
        session: binding.session,
        getGoal: async () => {
          if (sessions.binding(sessionId) !== binding) {
            throw new Error(`ui-goal: session "${sessionId}" is unavailable`)
          }
          return sessions.using(sessionId, { source: 'goalActivation' }, async (reference) => {
            const state = reference.binding.session.getSnapshot()
            if (state.openState !== 'open') {
              throw state.openError ?? new Error(`session "${sessionId}" is not open`)
            }
            return ctx.remote.goals.get(sessionId)
          })
        },
        subscribeActivation: listener => ctx.remote.$on('goal/activation-changed', (event) => {
          if (event.sessionId === sessionId) listener(event.goal)
        }),
        subscribeReset: listener => ctx.on('connection/reset', listener),
      })
      return {
        hooks: { goalActivation },
        onEdit: async (objective) => {
          const ref = refOf(sessionId)
          if (ref === undefined) return noCurrentGoal
          return await ctx.remote.goals.edit(sessionId, ref, { objective })
        },
        onPause: async () => {
          const ref = refOf(sessionId)
          if (ref === undefined) return noCurrentGoal
          return await ctx.remote.goals.pause(sessionId, ref)
        },
        onResume: async () => {
          const ref = refOf(sessionId)
          if (ref === undefined) return noCurrentGoal
          return await ctx.remote.goals.resume(sessionId, ref)
        },
        onClear: async () => {
          const ref = refOf(sessionId)
          if (ref === undefined) return noCurrentGoal
          return await ctx.remote.goals.clear(sessionId, ref)
        },
      }
    },
  }, GoalDock))

  // Auto-goal preference: the browser holds the live value in local storage
  // and mirrors it into the Host's settings document when the Host serves
  // the `ui-goal` namespace.
  const goalSettingsForm = ctx.configForms.get<GoalSettings>(GOAL_SETTINGS_NAMESPACE)
  const preference = createAutoGoalPreference(goalSettingsForm)

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'goal-auto',
    order: -10,
    locale: NS,
    inject: (sessionId: SessionId): AutoGoalToggleInjected => ({
      hooks: {
        autoGoal: createAutoGoalSource({
          enabled: preference.value,
          armGoal: (objective) => { void armGoal(ctx, sessionId, objective) },
          subscribePrompts: onPrompt => subscribePrompts(ctx, sessionId, onPrompt),
        }),
      },
      setAutoGoal: (enabled) => { preference.set(enabled) },
    }),
  }, AutoGoalToggle))
}
