---
description: "Package map for the loop-hygiene guard family: the repeat-tool reminder, the tool-call timeout policy, the unbounded-scan policy, and the job-duration reminder, for users and maintainers choosing or composing the guards."
kind: "package-group"
---

# guard/ — loop-hygiene guard family

English | [中文](README.zh.md)

## Summary

The `guard/` group keeps the agent loop productive and its resource use bounded. `repeat-tool-reminder` notices an identical tool call repeated without progress and asks the model to change approach or finish. `timeout-policy` gives tool calls their declared cooperative time limits and returns a clear timeout error after cancellation settles. `unbounded-scan-guard` denies a tree-wide shell search whose starting directory holds build or dependency trees, naming the narrowed command to run instead. `long-job-reminder` tells the model about background jobs that outlived their budget so it can collect or stop them. All four ship enabled in the `dsh` base bundle.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Four plugins cover the group's patterns; each README below explains when to keep, tune, or remove it.

| Package | What it provides |
|---|---|
| [`repeat-tool-reminder/`](repeat-tool-reminder/README.md) | Reminds the model when it repeats the same tool call, so it changes approach or finishes |
| [`timeout-policy/`](timeout-policy/README.md) | Times out tool calls that declare a limit, so the model gets a clear error instead of waiting forever |
| [`unbounded-scan-guard/`](unbounded-scan-guard/README.md) | Denies a tree-wide shell search over build or dependency trees and names the narrowed command |
| [`long-job-reminder/`](long-job-reminder/README.md) | Tells the model about background jobs past their budget, so it can collect or stop them |

-----

<a id="related-documentation"></a>
## Related documentation

Start with the tools subsystem reference for the tool-call pipeline and the background job runtime for the registry the job reminder reads, then the guard configuration and the timeout-library decision behind the policy.

- [Tools subsystem reference](../../docs/subsystems/tools.md) — the tool-call pipeline and the decisions every guard builds on.
- [Background job runtime](../../docs/subsystems/jobs.md) — the job registry, statuses, and views `long-job-reminder` reads.
- [Generated configuration catalog](../../docs/config-catalog.md) — every accepted field of the repeat-call reminder, the scan policy, the job reminder, and the tools whose limits `timeout-policy` enforces.
- [Timeout deadline library Agent Note](../../.agents/notes/implemented/architecture/2026-07-06-timeout-deadline-library.md) — the timing/termination split `timeout-policy` enforces.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
