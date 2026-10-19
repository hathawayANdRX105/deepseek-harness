import { useEffect, useState } from 'react'
import type { ConversationSessionSlotProps } from '../contract/slots.ts'
import { conversationPhase } from '../contract/snapshot.ts'
import { resolveActiveView } from '../view-selection.ts'
import css from './ConversationRoot.module.css'

/**
 * Renders the Session's visited Views inside the resident scrollport and keeps
 * the input draft persisted while blank Hero chrome is visible. Each visited
 * View lives in its own seat (`data-view`, `data-active`); an inactive seat
 * leaves layout without unmounting, so returning to a View reuses its DOM,
 * accumulated rows, and scroll memory instead of rebuilding them.
 * @param props - Strict Session input/store, view ledger, and render shares.
 * @returns the visited view seats, or null while the Session remains blank.
 * The seat also passes `active` through the view owner share, and a retained
 * target reads that flag to park its scroll policy while hidden.
 */
export function DefaultConversationViews({
  view, sessionActive, useSession, useConversation, useConversationViews, inputActions, useStore, actions,
  renderSlot, bindDraftPersistence, openView, useInspectCall,
}: ConversationSessionSlotProps) {
  const tabs = useConversationViews(value => value)
  const inspectCall = useInspectCall(value => value)
  const selectedId = useStore(s => s.view)
  const active = resolveActiveView(tabs, selectedId)
  const session = useSession(s => s)
  const conversation = useConversation(s => s)
  const viewRequest = useStore(s => s.viewRequest ?? null)
  // Views the reader has opened in this Session, in first-visit order. A
  // visited View stays mounted while another View is active, so returning to
  // it reuses its DOM, scroll position, and accumulated rows instead of
  // rebuilding them; a View never opened in this Session is not mounted at all.
  const [visitedViews, setVisitedViews] = useState<readonly string[]>([])
  const activeId = view ?? active?.id

  useEffect(() => {
    const unbindDraftPersistence = bindDraftPersistence(actions.setDraft)
    inputActions.persistDraft()
    return () => { unbindDraftPersistence() }
    // The Session input owns content before this persistence writer is attached.
  }, [inputActions])

  useEffect(() => {
    if (activeId === undefined) return
    setVisitedViews(current => current.includes(activeId) ? current : [...current, activeId])
  }, [activeId])

  if (session.blank && conversationPhase(session, conversation) === 'blank') return null
  // Render the activating View in the same pass that selects it; the effect
  // above records it once the seat exists.
  const retainedViews = activeId === undefined || visitedViews.includes(activeId)
    ? visitedViews
    : [...visitedViews, activeId]

  return (
    <div className={css.viewArea}>
      {retainedViews.map(id => (
        <div key={id} className={css.viewSeat} data-view={id} data-active={id === activeId}>
          {renderSlot('conversation.view', {
            // A View is active only while its Session seat is selected too: a
            // parked Session seat leaves layout, so its Views must park their
            // scroll policy with it.
            active: id === activeId && sessionActive,
            inspectCall,
            viewRequest,
            openView,
            completeViewRequest: actions.completeViewRequest,
          }, { only: id })}
        </div>
      ))}
    </div>
  )
}
