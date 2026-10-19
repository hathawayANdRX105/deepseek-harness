/** Retained Session seats of the main Conversation surface. */
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/**
 * One retained Session seat of the main Conversation surface. The reference is
 * the framework `SessionProvider` target that binds the seat's Conversation
 * subtree to its own Session, not a business-component service.
 */
export interface ConversationSeatSnapshot {
  /** Session displayed by this seat. */
  readonly sessionId: SessionId
  /** Session reference bound to this seat's subtree. */
  readonly reference: SessionReference
  /** Whether this seat is the selected Session's seat. */
  readonly selected: boolean
  /**
   * Bind one committed root of this seat; the returned disposer releases a
   * retired seat once its last root unmounted.
   */
  readonly mount: () => () => void
}
