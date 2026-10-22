---
description: "Goal surface for the Web GUI: the composer-context strip that shows the current goal and edits, pauses, resumes, or clears it; for users and maintainers of the goal experience."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-goal

English | [中文](README.zh.md)

## Summary

The Web GUI goal surface shows both the durable goal state and its current process-local activation, and lets users edit, pause, resume, or clear the goal; rejected changes appear inline. It displays durable `/goal` runs as `Command input` bubbles so commands from users or the model remain visible after reload. An `Auto goal` toggle above the composer turns each composer prompt into the session goal while it stays on; goal creation through `/goal` remains independent of it. Shipped Web presets other than `minimal` make `/goal` available to agents.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin alongside `ui-conversation` and the goal domain package; the strip then appears as the third card in the composer-context stack (after the auto-goal toggle and Todo, before Queue) whenever the session has a goal. Todo and Goal use the same panel elevation above the composer. An armed active goal offers pause; an active-but-disarmed or paused goal offers resume; edit rewrites the objective in the ui-primitives `InlineEditor`, so multi-line objectives survive editing; clear removes the goal and suppresses the strip until the projection catches up.

### The command-input bubble

Each durable `/goal` run projects as a right-aligned user-style bubble labeled `Command input` (or `指令输入`), rendered before the generic command result row; the leading `/goal` token renders as a command reference chip in the code face through ui-primitives `projectUserText`, and the objective stays plain body text. It carries no timestamp, copy, or branch actions, and reloading reconstructs it from the run.

### The auto-goal toggle

The first card in the composer-context stack is the `goal` button (above Todo, Goal, and Queue). It is off by default and its state lives in the browser's local storage, so the toggle works as soon as the page loads and survives a reload. The Host's user-settings document mirrors the value whenever the Host serves the `ui-goal` namespace, which carries the preference across browsers. While the button is armed, each ordinary composer prompt becomes the session goal: an existing goal that is not complete is cleared first, and the new objective arms a fresh goal that continues until it completes. Goal rounds, commands, and subagent traffic never trigger it, and a prompt with no text creates nothing. Turning it off leaves the current goal running.

### Failures

A rejected mutation surfaces the Remote error inline on the strip; loading, absent, completed, and successfully cleared goals render nothing. A failed auto-goal creation leaves the prompt itself untouched and is logged on the Host.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The durable goal arrives through `useProjection('goal')` (seeded by the history tail page and updated by `session/projection` frames). The inject face carries a registrant-private activation hook source plus the four mutation verbs. That source starts only while the framework hook observes it, reads `ctx.remote.goals.get`, subscribes to `goal/activation-changed`, and refreshes on running-state or connection resets. Live-event epochs invalidate in-flight reads, so a stale HTTP result cannot overwrite a newer activation edge; running refreshes retain the last known activation until the read resolves. The strip owns no domain store or cross-plugin cache. Each mutation reads the CAS ref from the session's current projected value at call time, and the RPC's compare-and-set is the staleness guard. The strip single-flights mutations synchronously because a pending render cannot fence same-frame clicks. The command-input projection is a separate Conversation Definition that builds a `command-input` Chat Node before the generic command result Node; it never creates `user/message` or a model turn.

Activation reads hold a temporary `goalActivation` Client reference and send `goals.get` only after that Session's initial history open succeeds. A stale binding or failed open sends no RPC. Rejected reads are logged without changing the projected goal or last known activation; the temporary reference is released when the read settles.

The package now carries two faces. The node half declares the `autoGoal` volatile Config field of the `ui-goal` settings namespace and keeps its own instance off the generated Settings pages. The browser half owns the behaviour: it holds the preference in local storage and mirrors it into the Host's form, and it watches the Session's durable event window. A prompt is recognized by the same `agent/inbox/spliced` event the Host records, so a goal round, a command, or a subagent message never qualifies; the goal itself is created through the generated Goal Remote API, which clears a goal that is not complete before creating the new one.

The goal-round driver owns continuation. A goal this package creates is armed on creation, so the driver claims rounds of its own; a later composer prompt clears that goal and creates another, and the driver takes the new one over. A prompt that arrives while a goal round runs marks the round competing, and the driver resumes the goal once that turn ends.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the goal surface is not enough. They move from the browser strip to the goal domain and the slots it fills.

- [dsh-goal](../../goal/goal/README.md) — the goal domain, projection, and `/goal` command this surface reads and mutates.
- [ui-conversation](../ui-conversation/README.md) — declares the `conversation.input.dock` slot and owns the composer.
- [Client package map](../README.md) — adjacent browser UI packages.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the `goals/edit`, `goals/pause`, `goals/resume`, and `goals/clear` mutations the strip routes; the host GoalService owns the model-visible goal context message those mutations queue. With the auto-goal toggle on, the composer prompt itself becomes a `goals/create` mutation, so the same goal context message reaches the model on the next round.

#### KV Cache effect

None unless the queued goal context is admitted. An admitted context extends the history tail like any other message; an insertion discarded before admission does not affect the cache.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the current goal surface. They are current package constraints, not a goal-domain comparison or a task backlog.

- **Preset-independent host state** — switching an active session to `minimal` leaves its host-owned goal intact. `/goal` and goal tools disappear, while this strip can still edit, pause, resume, or clear the goal.
- **Profile-wide toggle** — the auto-goal preference is one Host setting for the whole profile, not a per-session choice, and it creates goals only for root-session agents.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
