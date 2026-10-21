/**
 * Goal surface plugin, node half. Registers the volatile auto-goal
 * preference in the Host user-settings document and, while that preference
 * is enabled, turns every ordinary composer prompt into the session's goal:
 * an existing non-complete goal is cleared first, so each prompt starts a
 * fresh armed goal that the goal-round-driver continues until completion.
 * Only root-session agents qualify; goal rounds, commands, and subagent
 * traffic never create or replace a goal here.
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
// Type-only: pulls the agent inbox event map, the goal service merge, and the
// settings service merge through their owning packages.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-goal'
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

/** Services required by the Host preference projection and goal mutations. */
export const name = 'ui-goal'
export const inject = ['settings', 'goals']

/** Join the text blocks of one admitted prompt into the goal objective. */
function objectiveOf(message: UserMessage): string {
  return message.content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim()
}

/** Host preferences are consumed through the configuration form projection.
 * @param ctx Plugin context used for optional settings presentation and goal mutation.
 * @param config Resolved live preference references.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })

  ctx.effect(() => ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (message.source.kind !== 'user') return
    if (agent.session.header.parentSession !== undefined) return
    if (!config.autoGoal.get()) return
    const objective = objectiveOf(message)
    if (objective === '') return
    try {
      const current = ctx.goals.get(agent)
      if (current !== undefined && current.phase !== 'complete') {
        ctx.goals.clear(agent, { id: current.id, revision: current.revision })
      }
      ctx.goals.create(agent, { objective })
    } catch (error) {
      ctx.logger.warn(
        `[ui-goal] auto goal creation failed for agent "${agent.id}": ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }), 'ui-goal: auto goal on composer prompt')
}
