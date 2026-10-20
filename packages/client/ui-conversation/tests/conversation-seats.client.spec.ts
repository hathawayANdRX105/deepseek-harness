// @vitest-environment jsdom
/** Retained Session seats of the main Conversation surface. */
import { afterEach, expect, it, vi } from 'vitest'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ConversationSeats } from '../src/client/conversation-seats.ts'

const A = 'a' as SessionId
const B = 'b' as SessionId
const C = 'c' as SessionId
const D = 'd' as SessionId
const runtimes: SlotTestRuntime[] = []

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose()
  vi.restoreAllMocks()
})

async function runtime(...ids: readonly SessionId[]) {
  const created = await SlotTestRuntime.create()
  runtimes.push(created)
  for (const id of ids) await created.sessions.add({ id })
  return created
}

it('retains one reference per visited Session and marks the selected one', async () => {
  const r = await runtime(A, B)
  const seats = new ConversationSeats(r.sessions)
  seats.select(A)
  const first = seats.snapshot()
  expect(first).toHaveLength(1)
  expect(first[0]?.sessionId).toBe(A)
  expect(first[0]?.selected).toBe(true)
  expect(first[0]?.reference.sessionId).toBe(A)

  seats.select(B)
  const second = seats.snapshot()
  expect(second.map(seat => seat.sessionId)).toEqual([B, A])
  expect(second.map(seat => seat.selected)).toEqual([true, false])
  seats.dispose()
})

it('parks the previous Session behind the selected one', async () => {
  const r = await runtime(A, B)
  const seats = new ConversationSeats(r.sessions)
  seats.select(A)
  seats.select(B)
  const parked = seats.snapshot().find(seat => seat.sessionId === A)
  expect(parked?.selected).toBe(false)
  expect(parked?.reference.sessionId).toBe(A)
  seats.dispose()
})

it('evicts the oldest parked Session beyond the cap', async () => {
  const r = await runtime(A, B, C, D)
  const seats = new ConversationSeats(r.sessions)
  seats.select(A)
  const evicted = seats.snapshot()[0]?.reference
  const release = vi.spyOn(evicted!, 'release')
  seats.select(B)
  seats.select(C)
  // Two parked Sessions fit the cap; the third one evicts the oldest.
  expect(seats.snapshot().map(seat => seat.sessionId)).toEqual([C, A, B])
  expect(release).not.toHaveBeenCalled()
  seats.select(D)
  expect(seats.snapshot().map(seat => seat.sessionId)).toEqual([D, B, C])
  expect(release).toHaveBeenCalledOnce()
  seats.dispose()
})

it('releases a removed Session seat after its last root unmounts', async () => {
  const r = await runtime(A)
  const seats = new ConversationSeats(r.sessions)
  seats.select(A)
  const seat = seats.snapshot()[0]!
  const release = vi.spyOn(seat.reference, 'release')
  const unmount = seat.mount()
  seats.remove(A)
  expect(seats.snapshot()).toHaveLength(0)
  expect(release).not.toHaveBeenCalled()
  unmount()
  expect(release).toHaveBeenCalledOnce()
  seats.dispose()
})

it('selects the newly acquired Session while a switch still holds two', async () => {
  const r = await runtime(A, B)
  const seats = new ConversationSeats(r.sessions)
  seats.selectMainView([A])
  seats.selectMainView([A, B])
  expect(seats.snapshot().find(seat => seat.selected)?.sessionId).toBe(B)
  seats.selectMainView([B])
  expect(seats.snapshot().find(seat => seat.selected)?.sessionId).toBe(B)
  seats.dispose()
})

it('releases every seat on dispose', async () => {
  const r = await runtime(A, B)
  const seats = new ConversationSeats(r.sessions)
  seats.select(A)
  seats.select(B)
  const references = seats.snapshot().map(seat => seat.reference)
  const releases = references.map(reference => vi.spyOn(reference, 'release'))
  seats.dispose()
  for (const release of releases) expect(release).toHaveBeenCalledOnce()
  expect(seats.snapshot()).toHaveLength(0)
})
