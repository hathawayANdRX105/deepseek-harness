/** Auto-goal preference stored in the Host user-settings document. */

import z from '@deepseek-ai/schemastery'

/** Settings namespace owned by the goal surface plugin. */
export const GOAL_SETTINGS_NAMESPACE = 'ui-goal'

/** Field carrying the auto-goal-on-send toggle. */
export const AUTO_GOAL_FIELD = 'autoGoal'

/** Durable goal-surface section shared by the Host schema and the browser scope. */
export interface GoalSettings {
  /** Create or replace the session goal with each composer prompt while enabled. */
  autoGoal: boolean
}

/** Durable goal-surface schema; also the wire envelope the browser scope validates against. */
export const GoalSettingsFields = {
  [AUTO_GOAL_FIELD]: z.boolean().default(false),
}

/** Schema for shared goal-surface configuration values. */
export const GoalSettingsSchema = z.object(GoalSettingsFields)
