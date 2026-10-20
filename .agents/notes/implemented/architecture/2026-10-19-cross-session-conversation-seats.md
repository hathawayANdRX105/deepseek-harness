# Agent Note: Cross-session conversation seats

Status: implemented

English | [中文](2026-10-19-cross-session-conversation-seats.zh.md)

## Problem

Sidebar Session switches still cost roughly 330–500 ms wall on a 200-turn Session after the [idle Session retention pool](2026-10-19-idle-session-retention-pool.md) removes the re-fetch/re-fold script work. The remaining cost is the conversation shell rebuilding its DOM: switching the `mainView` reference changes the `session-maybe` binding of the `main.conversation` slot, and the slot renderer remounts `ConversationRoot` (about 2,300 elements for a 24-turn window plus the header, composer, and Trajectory ledger). The object layer keeps the opened window and event stream alive across the switch, but the React subtree still tears down and rebuilds.

## Decision

Every Session the main surface has shown keeps a seat of its own, and the seats are keyed by Session identity.

- [conversation-seats.ts](../../../../packages/client/ui-conversation/src/client/conversation-seats.ts) owns the seats: each seat holds its own `SessionReference` (source `conversationSeat`), so the Session's scope, opened window, and event stream stay resident while the seat is parked. The pool holds the selected Session plus two parked ones; parking a third releases the oldest.
- [stores.ts](../../../../packages/client/ui-conversation/src/client/stores.ts) publishes the roster through an entry-declared store, so the panel reads it with `useStore` and no global hook seat is added.
- [ConversationPanel.tsx](../../../../packages/client/ui-conversation/src/client/skeleton/ConversationPanel.tsx) renders one seat per retained Session, each bound to its own Session through the framework `SessionProvider` (the same mechanism the Sidebar's independent Session views use), and renders the Session-less Conversation when no Session is selected.
- A parked seat leaves layout without unmounting ([ConversationRoot.module.css](../../../../packages/client/ui-conversation/src/client/skeleton/ConversationRoot.module.css)), so the retained transcript keeps its DOM and its subscriptions.
- The `sessionActive` owner share travels from `main.conversation` through the content factory and the Session body into the View owner share, where it merges with the View's own `active` flag. A parked seat therefore parks its Views' scroll policy too, and Chat restores its scroll memory when the seat is selected again.

## Measurements

The Chromium diagnostic ([session-switch.perf.ts](../../../../apps/web/tests/session-switch.perf.ts), single run) on the same machine:

| Switch | Before | After |
| --- | --- | --- |
| warm return to the first Session | 502 ms wall / 189 ms script | **283 ms wall / 31 ms script** |
| warm return to the second Session | 328 ms wall / 130 ms script | **242 ms wall / 32 ms script** |
| warm return after a cold switch | 393 ms wall / 123 ms script | **326 ms wall / 35 ms script** |
| cold switch | 529 ms wall / 244 ms script | 529 ms wall / 244 ms script |

The warm returns no longer commit new content (`firstContent` is absent because the transcript is already mounted) and the node delta drops from about +2,370 to about +130, so the remaining time is style and layout over the revealed subtree.

## Alternatives considered

**Virtualize the chat flow.** Would cut DOM size on every mount, but changes the scroll contract (`chat-scroll-contract.e2e.ts` measures scroll ownership, anchors, and composer resizing on the real DOM height) and adds a second scroll system. Rejected for this step.

**`content-visibility: auto` on transcript rows.** Reduces layout cost for off-screen rows without changing React mount cost, but interacts with scroll-height measurements and the anchor restoration logic; needs its own contract audit. A possible follow-up, not the primary fix.

**A global seat roster hook.** Rejected because every client package that builds a complete props object would have to provide the new seat, and the roster type would pull the Conversation package into packages that only need the Workspace UI.

**Keep the Session-less seat mounted beside the Session seats.** Rejected because the parked transcript would keep answering the same selectors as the active one; the Session-less seat is therefore mounted only while no Session is selected, which rebuilds the Hero tree when the first Session appears.

## Consequences

- Warm sidebar returns reuse the parked transcript instead of rebuilding it; the object layer keeps the same Sessions resident as before, plus their DOM.
- A parked Session holds its transcript DOM, so a reader with several long Sessions open pays for that memory (measured: about 10 MB more heap for two retained 200-turn transcripts).
- Browser tests that address conversation elements must scope them to the selected seat (`[data-session-seat][data-active="true"]`), because a parked seat keeps the same elements mounted.
- Components that automatically open a Sidebar preview "when their Session is on screen" must compare the on-screen Session with their own `sessionId`, because a parked seat stays mounted while another Session is on screen (the plan-review opener needed this check).
- The first Session of a session-less surface replaces the Hero tree; the assembly test now asserts that the Hero stays complete instead of that the same DOM node survives.
