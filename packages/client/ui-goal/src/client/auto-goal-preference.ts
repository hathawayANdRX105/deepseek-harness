/**
 * The auto-goal preference's persistence.
 *
 * The browser owns the preference's live value and keeps it in local
 * storage, so the toggle works as soon as the page loads. The Host
 * user-settings document mirrors it when the Host serves the `ui-goal`
 * namespace, which carries the preference across browsers; a Host that does
 * not serve it leaves the browser-local value authoritative.
 */

import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { AUTO_GOAL_FIELD, type GoalSettings } from '../goal-settings.ts'

/** Local-storage key of the browser-held preference. */
export const AUTO_GOAL_STORAGE_KEY = 'dsh.ui-goal.autoGoal'

/** The preference's live value and its writers. */
export interface AutoGoalPreference {
  /** The live value. */
  readonly value: { getSnapshot(): boolean; subscribe(listener: () => void): () => void }
  /** Write the preference to the browser and, when the Host serves it, to the Host too. */
  readonly set: (enabled: boolean) => void
}

/**
 * Build the preference over the browser store and the Host's form.
 * @param form - the Host's configuration form for the `ui-goal` namespace.
 * @returns the preference and its writers.
 */
export function createAutoGoalPreference(form: ConfigForm<GoalSettings>): AutoGoalPreference {
  const store = createSnapshotStore<boolean>(false, { persist: { name: AUTO_GOAL_STORAGE_KEY } })
  const publish = (enabled: boolean): void => {
    if (store.getSnapshot() === enabled) return
    store.set(enabled)
    // The Host's form rejects a field its namespace does not declare, so a
    // write that fails leaves the browser-local value in charge.
    void form.set(AUTO_GOAL_FIELD, enabled).catch(() => {})
  }
  return {
    value: {
      getSnapshot: () => store.getSnapshot(),
      subscribe: listener => store.subscribe(listener),
    },
    set: publish,
  }
}
