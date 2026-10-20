/** Per-session Conversation store shared by the shell body and header. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ConversationSeatSnapshot } from './contract/seats.ts'
import { ConversationSeats } from './conversation-seats.ts'
import type { ConversationStoreState } from './contract/views.ts'
import type { DraftInput, DraftSnapshot } from './contract/draft-editor.ts'
import { parseStoredDraft } from './draft.ts'

const CONVERSATION_STORE_KEY = 'dsh.conversation'

/** Declared write set for the Conversation shell. */
type ConversationActions = {
  setDraft: (draft: ConversationStoreState, text: DraftInput) => void
  setView: (draft: ConversationStoreState, view: string) => void
  openView: (draft: ConversationStoreState, view: string, focus: string) => void
  completeViewRequest: (draft: ConversationStoreState) => void
}

/**
 * Declare per-session draft persistence and View selection.
 * @returns the store handle.
 */
export function createConversationStore(): EngineStoreHandle<ConversationStoreState, ConversationActions> {
  return defineStore({
    init: (): ConversationStoreState => ({ draft: '', view: null, viewRequest: null }),
    persist: CONVERSATION_STORE_KEY,
    actions: {
      setDraft: (d, text: DraftInput) => { d.draft = text },
      setView: (d, view: string) => { d.view = view },
      openView: (d, view: string, focus: string) => {
        d.view = view
        d.viewRequest = { view, focus }
      },
      completeViewRequest: (d) => { d.viewRequest = null },
    },
  })
}

/**
 * Read a Session's draft before its input source is published to React.
 * @param sessionId - Session-scoped persistence suffix.
 * @returns saved semantic content, or an empty document when storage is absent or invalid.
 */
export function readConversationDraft(sessionId: SessionId): DraftSnapshot {
  const empty: DraftSnapshot = { text: '', references: [] }
  if (typeof localStorage === 'undefined') return empty
  try {
    const raw = localStorage.getItem(`${CONVERSATION_STORE_KEY}.${sessionId}`)
    if (raw === null) return empty
    const stored: unknown = JSON.parse(raw)
    if (typeof stored !== 'object' || stored === null || !('draft' in stored)) return empty
    return parseStoredDraft(stored.draft) ?? empty
  } catch (_error: unknown) {
    // Unavailable browser storage or malformed JSON has no usable saved draft.
    return empty
  }
}

/**
 * Read the persisted View preference before the Slot store is materialized.
 * @param sessionId - Session-scoped persistence suffix.
 * @returns the preferred View id, or null when storage has no usable value.
 */
export function readConversationViewPreference(sessionId: SessionId): string | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(`${CONVERSATION_STORE_KEY}.${sessionId}`)
    if (raw === null) return null
    const stored: unknown = JSON.parse(raw)
    if (typeof stored !== 'object' || stored === null || !('view' in stored)) return null
    return typeof stored.view === 'string' ? stored.view : null
  } catch {
    return null
  }
}

/** Declared write set for the retained Session seats of the main surface. */
type ConversationSeatsActions = {
  select: (draft: ConversationSeatSnapshot[], sessionId: SessionId | undefined) => void
  selectMainView: (draft: ConversationSeatSnapshot[], mainViewIds: readonly SessionId[]) => void
  remove: (draft: ConversationSeatSnapshot[], sessionId: SessionId) => void
  releaseAll: (draft: ConversationSeatSnapshot[]) => void
}

/**
 * Declare the retained Session seats of the main Conversation surface. The
 * store publishes the seats; their Session references are owned by the seat
 * manager, which the actions drive.
 * @param sessions - allocator for the seats' independent references.
 * @returns the store handle.
 */
export function createConversationSeatsStore(
  sessions: ISessions,
): EngineStoreHandle<ConversationSeatSnapshot[], ConversationSeatsActions> {
  const seats = new ConversationSeats(sessions)
  const publish = (draft: ConversationSeatSnapshot[]): void => {
    draft.splice(0, draft.length, ...seats.snapshot())
  }
  return defineStore({
    init: (): ConversationSeatSnapshot[] => [],
    actions: {
      select: (draft, sessionId) => {
        seats.select(sessionId)
        publish(draft)
      },
      selectMainView: (draft, mainViewIds) => {
        seats.selectMainView(mainViewIds)
        publish(draft)
      },
      remove: (draft, sessionId) => {
        seats.remove(sessionId)
        publish(draft)
      },
      releaseAll: (draft) => {
        seats.dispose()
        draft.splice(0, draft.length)
      },
    },
  })
}
