# Agent Note: Idle Session retention pool

Status: implemented

English | [中文](2026-10-19-idle-session-retention-pool.zh.md)

## Problem

Sidebar Session switches rebuild the outgoing Session from scratch. Navigation releases the previous `mainView` reference, the reference allocator drops the resident instance, and the next warm return re-fetches the tail page and re-folds the window before the first content can paint. On the Chromium diagnostic in [session-switch.perf.ts](../../../../apps/web/tests/session-switch.perf.ts), warm sidebar returns cost roughly 250–460 ms wall (96–180 ms script), barely cheaper than a cold open because only the Host's prepared-observation cache is reused.

## Decision

[service.ts](../../../../packages/api/session-controller/src/client/sessions/service.ts) keeps a released Session's resident instance in a bounded idle pool after its scope generation tears down. A final reference release now withdraws the generation and tears down its fiber; once teardown settles, the Session parks in the pool (at most two) instead of being dropped. A later `retain` reuses the parked instance with a fresh scope generation: `open()` is already settled, so no history is re-fetched and no window is re-folded.

The pool is bounded because resident Sessions keep their observe streams and projection caches alive. Two invariants separate warm reuse from established replacement semantics:

- A retain during the teardown window still takes the cold path: the stale instance is dropped and a fresh generation opens.
- A Session removed from the Host list can no longer be reached from the UI, so its release drops for real instead of parking; this keeps observe streams from leaking for deleted Sessions.

## Measurements

The same diagnostic after the change (single run, no competing browser workers) shows the warm-return saving: `coldSwitchAlphaToBravo` cost 514 ms wall / 202 ms script, while the next `warmSwitchAlphaToBravo` (Bravo reused from the idle pool) cost 328 ms wall / 130 ms script — the re-fetch and re-fold script work disappears, and `warmSwitchCharlieToAlpha` cost 393 ms wall / 123 ms script against 437 ms wall for its cold counterpart. Session-switch structural assertions (the chat seat stays active and the flow window is loaded) pass, and the full session-controller suite (961 tests) and workspace/session/sidebar client suites (1527 tests) pass unchanged. DOM remount and layout of the conversation shell still dominate the remaining warm-return cost (roughly 120–190 ms of script plus style/layout), so warm returns land around 330–500 ms rather than the previous 250–460 ms band improving only by the object-layer saving.

## Alternatives considered

**Keep every released Session resident indefinitely.** Rejected because every resident Session holds an observe stream and projection caches; an unbounded pool would grow with every visited Session, and the existing contract closes a Session's stream when its scope drops.

**Delay the drop instead of parking the instance.** Rejected because the observe-stream contract requires the stream to close on release; a debounce would either keep the stream open (same cost as parking, without the explicit bounded pool) or close it and lose the warm window.

**Reuse the scope generation itself.** Rejected because the reference allocator's replacement semantics require a fresh generation (new binding, cold `openState`) when a retain races the previous release; only after the old fiber has fully torn down is the opened window safe to share.

## Consequences

Warm sidebar returns no longer re-fetch or re-fold history for the two most recently visited Sessions; the remaining cost is DOM remount and layout in the conversation shell. Released Sessions that are still listed keep their observe streams alive while parked (bounded to two), so the object layer holds at most three live streams per controller (the selected Session plus the idle pair). Removed Sessions still close their streams immediately. Deeper UI-level retention (keeping the conversation DOM mounted across Session switches) remains future work.