---
description: "Advisory job-duration guard that tells the model about background jobs running past a configured budget, for users and maintainers choosing, configuring, or debugging the plugin."
kind: "package-reference"
---

# @deepseek-ai/dsh-long-job-reminder

English | [中文](README.zh.md)

## Summary

Use this package to learn in-session about background jobs that ran past their budget, while you can still collect or stop them. Before an agent's next step, the guard lists that agent's live jobs past a configured wall-clock threshold, longest-running first and up to a configured count, and tells the model to read their output or kill them. Each job is reported at most once while it stays live. The reminder is advisory: it never kills, pauses, or bounds a job. The `dsh` base bundle enables it with a two-minute budget.

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

Mount this plugin when agents start background jobs and then move on without checking them. The `dsh` base bundle already runs it with a two-minute budget; tune the budget and the listing below when your jobs are routinely longer or shorter.

### When to choose it

Choose it when a session starts long builds, searches, or watch processes in the background and nobody waits for them: the reminder is the model's cue to collect or stop them at its next step. Avoid it when you need a hard bound on job duration — the plugin reminds, and it never kills, stops, or times out a job — and when the extra notice is not worth the context it adds to a step.

### Setting the budget and the listing

Mount the plugin with the base bundle's settings, or with none to accept the same defaults:

```yaml
- name: '@deepseek-ai/dsh-long-job-reminder'
  config:
    remindAfterMs: 120000
```

| Field | Default | Meaning |
|---|---|---|
| `remindAfterMs` | `120000` | Wall-clock milliseconds a job may run before the model is told about it |
| `maxListed` | `5` | Maximum jobs one reminder lists, longest-running first |
| `labelPreviewChars` | `120` | Maximum characters of a job label quoted in the reminder; the cap never affects which jobs are listed |

Invalid configuration fails at plugin load: each field must be a positive safe integer. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-long-job-reminder) is the exhaustive source for every accepted field.

### What you get

When the agent proposes its next step, the guard reads that agent's live jobs — status `running` or `stopping` — and selects those that have been running for at least `remindAfterMs`, longest first. It injects one notice user message ahead of the step's own messages, with one line per listed job: `- <id> (<duration>): <label>`. A duration reads `45s`, `12m 3s`, or `1h 4m`; a label longer than `labelPreviewChars` is cut and ends with `…`. Jobs beyond `maxListed` are counted in one closing line and remain eligible for a later reminder. Every listed job is recorded, so it is reported once while it stays live, and a job that settles leaves the record on the next look. A reminder is computed only for an entering step: a rejected step gets none.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the guard decides that a reminder is due and how it delivers one, and points at the code that realizes it; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The guard is built on four commitments:

- **Logged context, not a loop change.** The reminder rides the existing `agent/pre-step` waterfall and becomes an ordinary logged user message; the agent loop needs no new event and the session can reconstruct what the model read.
- **Advisory only.** Nothing is cancelled, paused, or rewritten; ending the work stays the model's decision through `job_kill`.
- **Bounded listing.** `maxListed` bounds the lines and `labelPreviewChars` bounds each label, so a session with many jobs cannot turn one reminder into an unbounded transcript entry.
- **Fail loud at load.** Every config field is re-checked in `apply` and throws on an unusable value, never silently disabling the reminder.

### The due rule and the once-per-job record

`ctx.jobs.list(agent.id)` supplies one agent's jobs; only `running` and `stopping` statuses are considered. The guard subtracts `job.startedAt` from `Date.now()`, keeps the jobs at or past `remindAfterMs`, sorts them by elapsed time with the longest first, and lists at most `maxListed` of them. The listed ids go into a `WeakMap<Agent, Set<JobId>>` — the once-per-job record — whose entries for no-longer-live jobs are dropped on the next look.

### Delivery on the step boundary

The `agent/pre-step` listener delegates through `next()` first and returns a `reject` decision untouched. Otherwise it computes the due reminder, if any, and prepends it to the decision's messages, so the notice frames the step it arrives with and is logged beside the messages the step already carried. The message is created with source `{ kind: 'long-job-reminder', form: 'notice', summary: '<n> job(s) running past <duration>' }`, which marks it as a one-off account of something that just happened.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config` schema, fail-loud validation, `formatDuration`/`reminderText`, the `agent/pre-step` listener |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the job registry to the step boundary the reminder rides, the tools it tells the model to use, and the guard group map.

- [Background job runtime](../../../docs/subsystems/jobs.md) — the job registry, statuses, and views this guard reads.
- [Agent loop interception decisions](../../../docs/subsystems/core.md) — the `agent/pre-step` waterfall that carries the reminder.
- [Tool catalog: `job_output`](../../../docs/tool-catalog.md#job_output) — the tool the reminder tells the model to read a job with.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-long-job-reminder) — every accepted config field and its source declaration.
- [guard group map](../README.md) — the sibling guard packages and the loop-hygiene family.

-----

<a id="model-experience"></a>
## Model Experience

### Injected reminder notice

#### What the model sees

Nothing until a live job passes the budget. Then, before the agent's next proposed step, the step's messages gain one injected user message — the template below — whose source is the literal `{ kind: 'long-job-reminder', form: 'notice', summary: '<n> job(s) running past <duration>' }`. It is a one-off notice that supersedes nothing. Job lines are ordered longest-running first, `<duration>` is the `45s`/`12m 3s`/`1h 4m` form, and a `<label>` longer than `labelPreviewChars` ends with `…`. The omitted-jobs line appears only when more jobs are due than `maxListed` lists; it names the count, writing `1 more job has been running as long.` for one and `<n> more jobs have been running as long.` above one.

##### Reminder template

```markdown
Background jobs you started are still running:
- <id> (<duration>): <label>
[<n> more job(s) have been running as long.]
Read the latest output with job_output, or stop a job you no longer need with job_kill. A search or build nobody is waiting on keeps consuming CPU and disk until it is stopped.
```

#### Token effect

Zero tokens while every job is young, already reported, or settled. A reminder adds one retained user message: one line per listed job plus the closing instruction, bounded by `maxListed` lines and `labelPreviewChars` characters per label.

#### KV Cache effect

Append-only; the reminder is injected ahead of the next step's messages, after all previously sent history, so it does not invalidate existing KV Cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the guard is a poor fit. They are current package constraints, not a task backlog.

- **It reminds; it never bounds a job** — nothing is killed, paused, or timed out, so a job the model ignores keeps consuming CPU and disk with no further reminder about that same job.
- **It fires on the next proposed step** — an agent that never proposes another step (idle, waiting on a human, or finished) is never reminded, and a rejected step computes no reminder.
- **A reported job is not reported again while it stays live** — the per-agent record marks each listed id, so a job that outlives many steps draws one reminder rather than a stream.
- **Elapsed time is wall-clock from registration** — it counts the time a job spent waiting for execution capacity or for a subprocess slot, so the quoted duration can exceed the work the job itself performed.
- **The once-per-job record is in memory** — resuming a session starts with an empty record, so a live job that already drew a reminder is reported again in the resumed session.
- **Jobs past `maxListed` are counted, not named** — they stay eligible for a later reminder, so a session with many stale jobs receives several notices instead of one complete list.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

The `dsh` base bundle composes this plugin as the `long-job-reminder` row of `packages/bundle/base/cordis.patch.yml` with `remindAfterMs: 120000` inline, so that budget is what ships. The [guard group map](../README.md) owns the family view, and the [background job runtime](../../../docs/subsystems/jobs.md) owns the registry contract this guard reads. Open questions: whether a job's own producer should be able to declare a shorter budget than the deployment default, and whether a reminder should ever ask for a kill rather than offer one.

</details>
