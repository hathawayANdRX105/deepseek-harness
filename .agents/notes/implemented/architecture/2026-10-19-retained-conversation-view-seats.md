# Agent Note: Retained Conversation view seats

Status: implemented

English | [中文](2026-10-19-retained-conversation-view-seats.zh.md)

## Problem

Switching between the conversation Views (Chat and Trajectory) unmounted the outgoing View and rebuilt the incoming one from its snapshot. Chat's transcript carries the loaded Turn window as DOM — roughly 2,300 elements for a 24-Turn window of a 200-Turn Session — and Trajectory rebuilds its virtualized ledger on activation.

Measured on the Chromium diagnostic in [session-switch.perf.ts](../../../../apps/web/tests/session-switch.perf.ts) (200-Turn seeded Sessions, built Web artifacts, real Host scaffold, headless Chromium), the trusted Trajectory-to-Chat tab click cost 264 ms and 240 ms of Chromium main-thread task time on the first return, and 293 ms and 244 ms on the second: neither return reused the transcript it had just destroyed.

## Decision

[DefaultConversationViews.tsx](../../../../packages/client/ui-conversation/src/client/skeleton/DefaultConversationViews.tsx) keeps one seat per View the Session has activated (`data-view`, `data-active`) and renders the `conversation.view` outlet once per retained View with `{ only: id }`. A View this Session never activated is not mounted at all, so opening a Session still builds only the active View. The seat wrapper is layout-neutral while active and leaves layout while inactive ([ConversationRoot.module.css](../../../../packages/client/ui-conversation/src/client/skeleton/ConversationRoot.module.css)), so the View's own root stays the flex child of the view area and an inactive View cannot affect transcript geometry.

The retained set is component state: it is per Session and resets when the Session's shell remounts, matching the per-Session lifetime of the Conversation store's View preference. Returning to a retained View reuses its DOM, its scroll position, and the rows its Definition already accumulated; it does not re-run the View's activation work. The view slot owner share carries `active` so a retained target can park its scroll policy while its seat is out of layout ([use-chat-scroll.ts](../../../../packages/client/ui-chat/src/client/chat/use-chat-scroll.ts)): an inactive Chat seat clears its opened flag, cancels sampling, and ignores scroll, scrollend, resize, and intent events, then lands again from the Session's saved scroll memory on activation.

## Measurements

The same diagnostic on the same machine after the change: Trajectory-to-Chat cost 138 ms wall / 98 ms task and 141 ms wall / 106 ms task, with script time falling from 118 ms to 12 ms. The remaining cost is the browser's style and layout pass over the revealed subtree plus the click's actionability checks. First-time Trajectory activation (393 ms) is unchanged, because it still builds its ledger from the loaded window.

Sidebar Session switches, which this change does not touch, measured 764 ms (first open), 554 ms, 459 ms, 342 ms, 491 ms, and 424 ms wall across the cold and warm samples. Warm returns are cheaper than cold opens only by the Host's prepared-observation reuse: the Client still discards the Session instance, re-fetches the tail page, and re-folds the window.

## Alternatives considered

**Keep every registered View mounted and hide the inactive ones.** Rejected because the first render of a Session would build Trajectory's ledger (roughly 390 ms measured) even for readers who never open it; activation order is what makes a View's cost follow its use.

**A framework option on the slot renderer (`keepMounted`).** Rejected because the retention policy is a property of the Conversation shell, not of list-slot rendering in general: the shell decides when a View's activation work is worth keeping, and the renderer takes orders from the caller. The shell calls the existing outlet once per retained View instead.

**Preserve only the View's snapshot and rebuild its DOM.** Rejected because the measured cost of the return is dominated by DOM construction, script time, and the style pass that followed it, not by the snapshot fold; a retained snapshot alone would not remove the rebuild.

## Consequences

Memory: an inactive retained View keeps its DOM and accumulated rows. The reader's retained set is bounded by the Views they actually opened — the shipped surface has two — and a View stops being mounted when its registration disappears or the Session shell unmounts. The benchmark's post-GC heap and DOM counts remain diagnostics, not budgets.

Geometry: an inactive View is removed from layout rather than measured at zero size, so its own scroll container and the shared transcript scrollport are only re-measured when it is revealed again. [views.client.spec.tsx](../../../../packages/client/ui-trajectory/tests/views.client.spec.tsx) pins that a switch keeps the Chat transcript mounted inside its inactive seat, and [skeleton.client.spec.tsx](../../../../packages/client/ui-conversation/tests/skeleton.client.spec.tsx) pins that a never-activated View is not mounted, that a retained View keeps its DOM node across two switches, and that each seat reports its activity. [chat-view.client.spec.tsx](../../../../packages/client/ui-chat/tests/chat-view.client.spec.tsx) pins that an inactive Chat seat does not sample or land and that activation consumes the saved scroll memory.

Scroll restoration across a Trajectory detour is resolved by scoping the composer-overlay CSS to the active seat: [ConversationRoot.module.css](../../../../packages/client/ui-conversation/src/client/skeleton/ConversationRoot.module.css) elects overlay mode only through `.viewSeat[data-active='true'] [data-conversation-composer-overlay]`, so a retained-but-inactive Trajectory seat no longer collapses the active Chat seat's scrollport. The browser contract test "keeps composer resizing on the correct scroll owner across reopened Sessions" passes with the retained seats.