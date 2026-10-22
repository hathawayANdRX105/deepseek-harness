/**
 * Goal surface plugin, node half. Declares the volatile auto-goal preference
 * in the Host user-settings document, so the browser half can read it and
 * write it back through the shared configuration form.
 *
 * The preference's behaviour lives in the browser half, which watches the
 * Session's durable event window and creates the goal through the Goal
 * Remote API. This half only owns the schema and keeps its own instance off
 * the generated Settings pages.
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only: pulls the settings service merge (ctx.settings).
import type {} from '@deepseek-ai/dsh-settings'
import { AUTO_GOAL_FIELD, GoalSettingsFields } from './goal-settings.ts'

export {
  AUTO_GOAL_FIELD, GOAL_SETTINGS_NAMESPACE, type GoalSettings,
} from './goal-settings.ts'

/** Live preferences projected to the browser. */
export interface Config {
  /** Create or replace the session goal with each composer prompt while enabled. */
  autoGoal: Volatile<boolean>
}

/** Live preferences projected to the browser. */
export const Config = z.object({
  autoGoal: GoalSettingsFields[AUTO_GOAL_FIELD].volatile(),
})

/** Services required by the Host preference projection. */
export const name = 'ui-goal'
export const inject = ['settings']

/**
 * Host preferences are consumed through the configuration form projection.
 * @param ctx Plugin context used for optional settings presentation.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })
}
