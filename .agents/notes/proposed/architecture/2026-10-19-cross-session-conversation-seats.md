# Agent Note: Cross-session conversation seats

Status: proposed

English | [中文](2026-10-19-cross-session-conversation-seats.zh.md)

## Problem

Sidebar Session switches still cost roughly 330–500 ms wall on a 200-turn Session after the [idle Session retention pool](../../implemented/architecture/2026-10-19-idle-session-retention-pool.md) removes the re-fetch/re-fold script work. The remaining cost is the conversation shell rebuilding its DOM: switching the `mainView` reference changes the `session-maybe` binding of the `main.conversation` slot, and the slot renderer remounts `ConversationRoot` (about 2,300 elements for a 24-turn window plus the header, composer, and Trajectory ledger). The object layer keeps the opened window and event stream alive across the switch, but the React subtree still tears down and rebuilds.

## Proposal

Retain one conversation subtree per recently visited Session, mirroring the retained [conversation view seats](../../implemented/architecture/2026-10-19-retained-conversation-view-seats.md) at the Session level.

Concretely, `ConversationPanel` (the root-scoped `main` occupant) becomes a Session-seat host:

- It tracks the visited Session ids (bounded, e.g. two like the idle pool).
- Each visited Session gets a seat `<div data-session-seat data-active={sessionId === current}>`; inactive seats leave layout (`display: none` or `content-visibility`), active seats participate in layout exactly once.
- Each seat renders the `main.conversation` outlet for its own Session. This requires the slot machinery to resolve a `session-maybe` outlet against an explicit Session binding rather than only the current selection: `SessionMaybeEntry` currently derives its binding from `useScopeBinding()` and remounts on Session switch via the incarnation epoch. The extension is a scoped `ScopeProvider`/binding override for the seat's outlet, with the same adoption bookkeeping as `useMaybeIncarnation` but keyed per Session.

The retained subtree keeps its scroll position, DOM, and live event subscription (the object layer already keeps the observe stream open for listed Sessions). Returning to a retained Session skips the full remount and layout pass.

### Scope boundary

Only the `main` conversation surface gains Session seats. Embedded conversation occurrences (hero, directory flow, tool views) and the sidebar list keep their current lifecycle. Memory is bounded by the same policy as the idle pool: at most two retained conversation subtrees besides the active one, each roughly the size of one loaded window. The composer bar and input dock stay Session-scoped and remount per switch unless they prove cheap enough to keep inside the seat.

## Alternatives considered

**Virtualize the chat flow.** Would cut DOM size on every mount, but changes the scroll contract (`chat-scroll-contract.e2e.ts` measures scroll ownership, anchors, and composer resizing on the real DOM height) and adds a second scroll system. Rejected for this step.

**`content-visibility: auto` on transcript rows.** Reduces layout cost for off-screen rows without changing React mount cost, but interacts with scroll-height measurements and the anchor restoration logic; needs its own contract audit. A possible follow-up, not the primary fix.

**Accept the current cost.** Warm returns already dropped from ~250–460 ms to ~330–500 ms with script time roughly halved; the remaining 200–300 ms of DOM remount and layout may be acceptable if the user prioritizes memory over latency.

## Acceptance criteria

- Switching away from a Session and back does not remount its conversation subtree: the perf diagnostic's `nodesDelta` for a warm return drops to view-toggle scale, and `totalNodes` no longer grows by a full window per return.
- `chat-scroll-contract.e2e.ts` stays green: scroll ownership, anchors, composer resizing, and bottom-follow behave identically after a Session switch and return.
- Session removal drops its seat: after a listed Session disappears from the Host list, its retained DOM and event subscription are torn down.
- Memory stays bounded: at most two retained conversation subtrees besides the active one, enforced by the same eviction policy as the idle pool.

## Risks

- **Slot-machinery regression**: adding an explicit per-Session resolution path to `session-maybe` touches the binding/adoption core shared by every Session-scoped surface; a mistake could remount or double-mount conversations beyond the intended seats. Mitigation: keep the seat host optional (no seats when no retained Sessions), and run the full `ui-renderer`/`ui-conversation` suites plus `chat-scroll-contract.e2e.ts`.
- **Stale DOM updates**: retained conversation subtrees keep subscribing to their Session's live events; if the Host list removes a Session, its seat must drop with the object-layer instance so the hidden subtree cannot keep consuming updates.
- **Composer and input state**: the composer bar and input dock remount per switch today; if they stay outside the seat, focus and draft state still reset on return, which may feel like a partial regression.

## Consequences

- Warm returns drop to roughly the view-toggle cost (about 140 ms) once the subtree is already mounted.
- Memory: each retained Session holds its conversation DOM plus the object-layer window; bounded to two retained Sessions.
- The `main.conversation` slot's `session-maybe` semantics gain an explicit per-Session resolution path; existing single-binding behavior must remain unchanged when no seat host is present.
- Tests: extend `session-switch.perf.ts` structural assertions and add a chat-scroll-contract case that switches Sessions, returns, and verifies the scroll owner and composer geometry are preserved without remount.