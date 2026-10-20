/** Retained Session seats of the main Conversation surface. */
import type { ISessions, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ConversationSeatSnapshot } from './contract/seats.ts'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    conversationSeat: unknown
  }
}

/** Maximum parked (unselected) Session seats; the selected seat is not counted. */
const MAX_PARKED_SEATS = 2

/**
 * Whether a retention failure means the Session can no longer be addressed.
 * @param error - the retention failure.
 * @returns true when the Controller no longer knows the Session.
 */
function isUnaddressableSession(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('sessions.retain: unknown session')
}

/** One retained Session seat: its reference, its mount lifetime, and its retirement. */
class ConversationSeat {
  /** Session reference bound to this seat's Conversation subtree. */
  readonly reference: SessionReference
  private mounts = 0
  private retired = false
  private disposed = false

  /**
   * @param sessionId - Session displayed by this seat.
   * @param sessions - allocator for this seat's independent reference.
   * @param onDispose - removes this seat from the collection before its reference is released.
   */
  constructor(
    readonly sessionId: SessionId,
    sessions: ISessions,
    private readonly onDispose: (seat: ConversationSeat) => void,
  ) {
    this.reference = sessions.retain(sessionId, { source: 'conversationSeat' })
    void this.reference.ready.catch((error: unknown) => {
      // A released seat rejects its readiness; that is the ordinary teardown
      // path, not an opening failure.
      if (this.disposed) return
      console.error('Conversation seat opening failed:', error)
    })
  }

  /**
   * Bind one committed root; the returned disposer releases a retired seat once
   * its last root unmounted.
   * @returns cleanup to call once for this root.
   */
  readonly mount = (): (() => void) => {
    this.mounts += 1
    return () => {
      this.mounts -= 1
      if (this.retired && this.mounts === 0) this.dispose()
    }
  }

  /** End a withdrawn seat after its committed roots finish unmounting. */
  retire(): void {
    this.retired = true
    if (this.mounts === 0) this.dispose()
  }

  /** Whether this seat was withdrawn and no longer belongs to the roster. */
  get withdrawn(): boolean {
    return this.retired
  }

  /** Release once; plugin shutdown does not wait for remaining React mounts. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.retired = true
    this.onDispose(this)
    this.reference.release()
  }
}

/**
 * Owns the retained Session seats of the main Conversation surface. The
 * selected Session's seat is always present; up to two earlier Sessions stay
 * mounted behind it, so returning to a Session reuses its transcript DOM
 * instead of rebuilding it.
 */
export class ConversationSeats {
  private readonly seats = new Map<SessionId, ConversationSeat>()
  private readonly order: SessionId[] = []
  private selected: SessionId | undefined
  private previousMainView = new Set<SessionId>()
  private closed = false

  /**
   * @param sessions - allocator for the seats' independent references.
   */
  constructor(private readonly sessions: ISessions) {}

  /**
   * Publish the seats for a newly selected Session. The previously selected
   * Session stays parked behind the new one until the parked cap evicts it.
   * @param sessionId - selected Session, or absence.
   */
  select(sessionId: SessionId | undefined): void {
    if (this.closed || this.selected === sessionId) return
    this.selected = sessionId
    if (sessionId !== undefined && !this.seats.has(sessionId)) {
      try {
        const seat = new ConversationSeat(sessionId, this.sessions, (retired) => {
          this.seats.delete(retired.sessionId)
          const index = this.order.indexOf(retired.sessionId)
          if (index >= 0) this.order.splice(index, 1)
        })
        this.seats.set(sessionId, seat)
        this.order.push(sessionId)
      } catch (error: unknown) {
        // The Session left the Host list between the selection and this
        // acquisition: it can no longer be addressed, so it gets no seat.
        if (!isUnaddressableSession(error)) throw error
        this.selected = undefined
      }
    }
    this.evictParked()
  }

  /**
   * Select the Session the main view holds, given every Session currently
   * held by that source. A switch briefly holds two of them; the newly
   * acquired one wins, because the released one is still listed.
   * @param mainViewIds - Sessions currently held by the main view.
   */
  selectMainView(mainViewIds: readonly SessionId[]): void {
    let next: SessionId | undefined
    if (mainViewIds.length === 1) next = mainViewIds[0]
    else if (mainViewIds.length > 1) {
      next = mainViewIds.find(id => !this.previousMainView.has(id)) ?? mainViewIds[0]
    }
    this.previousMainView = new Set(mainViewIds)
    this.select(next)
  }

  /**
   * Retire the seat of a Session that left the Host list: it can no longer be
   * selected, so its subtree and its reference are released.
   * @param sessionId - Session that left the Host list.
   */
  remove(sessionId: SessionId): void {
    const seat = this.seats.get(sessionId)
    if (seat === undefined) return
    if (this.selected === sessionId) this.selected = undefined
    seat.retire()
  }

  /** Release every seat when the plugin shuts down. */
  dispose(): void {
    if (this.closed) return
    this.closed = true
    for (const seat of this.seats.values()) seat.dispose()
    this.seats.clear()
    this.order.length = 0
  }

  /** Retire the oldest parked seats beyond the cap. */
  private evictParked(): void {
    const parked = this.order.filter(id => id !== this.selected)
    while (parked.length > MAX_PARKED_SEATS) {
      const oldest = parked.shift()
      if (oldest === undefined) return
      this.seats.get(oldest)?.retire()
    }
  }

  /**
   * The seat roster in selection order.
   * @returns the retained seats with their selection state.
   */
  snapshot(): readonly ConversationSeatSnapshot[] {
    const selected = this.selected
    return this.order
      .map(id => this.seats.get(id))
      .filter((seat): seat is ConversationSeat => seat !== undefined && !seat.withdrawn)
      .map(seat => ({
        sessionId: seat.sessionId,
        reference: seat.reference,
        selected: seat.sessionId === selected,
        mount: seat.mount,
      }))
      // The selected seat comes first: a reader (and the browser tests) meet
      // the live conversation before the parked ones in DOM order.
      .sort((left, right) => Number(right.selected) - Number(left.selected))
  }
}
