/**
 * AutoGoalToggle: a compact button at the top of the composer context stack
 * that flips the auto-goal preference. While enabled, every ordinary
 * composer prompt is turned into the session's goal (an existing non-complete
 * goal is replaced), so the goal-round-driver keeps the agent running until
 * completion. The preference is Host-persisted and mirrored through the
 * injected hook source.
 */

import { Button, IconGoalOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-conversation SlotMap merge (the input.dock seat).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { AutoGoalToggleInjected } from './slots.ts'
import css from './AutoGoalToggle.module.css'

/** Full props of the auto-goal dock entry: runtime share + injected preference face + the locale seat. */
export type AutoGoalToggleProps =
  PropsRuntime<'conversation.input.dock'>
  & InjectFace<AutoGoalToggleInjected>
  & PropsLocale<'goal'>

/** Dock entry: a button whose stroke marks the enabled state. */
export function AutoGoalToggle({ useAutoGoal, setAutoGoal, t }: AutoGoalToggleProps) {
  const enabled = useAutoGoal(s => s)
  return (
    <div className={css.dock} data-auto-goal-toggle>
      <Button
        variant="outline"
        size="sm"
        className={enabled ? css.enabled : css.disabled}
        icon={<IconGoalOutlineRegular size={14} />}
        aria-pressed={enabled}
        aria-label={t(enabled ? 'autoGoal.on.aria' : 'autoGoal.off.aria')}
        title={t(enabled ? 'autoGoal.on.title' : 'autoGoal.off.title')}
        onClick={() => { setAutoGoal(!enabled) }}
      >
        {t('autoGoal.label')}
      </Button>
    </div>
  )
}
