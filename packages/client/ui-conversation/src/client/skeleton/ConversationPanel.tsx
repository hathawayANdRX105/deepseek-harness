/** Root-scoped main occupant; Session binding belongs to its Conversation child. */
import { useEffect } from 'react'
import type { PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PropsStore } from '@deepseek-ai/dsh-client-store'
import type { ConversationSeatSnapshot } from '../contract/seats.ts'
import type { createConversationSeatsStore } from '../stores.ts'
import type {} from '../contract/slots.ts'
import css from './ConversationRoot.module.css'

/** One seat of the main Conversation surface: a retained Session, or no Session at all. */
function ConversationSeat({ seat, renderSlot, SessionProvider }: {
  seat: ConversationSeatSnapshot | undefined
} & Pick<PropsRenderSlots<'main.conversation'>, 'renderSlot' | 'SessionProvider'>) {
  useEffect(() => seat?.mount(), [seat?.mount])
  return (
    <div
      className={css.sessionSeat}
      data-session-seat={seat?.sessionId}
      data-active={seat === undefined || seat.selected}
    >
      {seat === undefined
        ? renderSlot('main.conversation', { sessionActive: true })
        : (
          <SessionProvider session={seat.reference}>
            {renderSlot('main.conversation', { sessionActive: seat.selected })}
          </SessionProvider>
        )}
    </div>
  )
}

/** Full props of the main Conversation panel, including its retained seat roster. */
export type ConversationPanelProps = PropsRuntime<'main'>
  & PropsRenderSlots<'main.conversation'>
  & PropsStore<ReturnType<typeof createConversationSeatsStore>>

/**
 * Render the Conversation with optional current-Session binding.
 *
 * Every retained Session owns a seat keyed by its identity, so a Session that
 * was visited keeps its mounted Conversation (transcript DOM, scroll memory,
 * live subscriptions) behind the selected one. Without a selected Session the
 * surface renders the ambient (Session-less) Conversation instead.
 * @param props - main-slot inputs, the retained seat roster, and the declared Conversation renderer.
 * @returns the Conversation subtree.
 */
export function ConversationPanel({ renderSlot, SessionProvider, useStore }: ConversationPanelProps) {
  const seats = useStore(state => state)
  const selected = seats.find(seat => seat.selected)
  return (
    <>
      {seats.map(seat => (
        <ConversationSeat
          key={seat.sessionId}
          seat={seat}
          renderSlot={renderSlot}
          SessionProvider={SessionProvider}
        />
      ))}
      {selected === undefined && (
        <ConversationSeat
          key="empty"
          seat={undefined}
          renderSlot={renderSlot}
          SessionProvider={SessionProvider}
        />
      )}
    </>
  )
}
