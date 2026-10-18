---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-18-long-job-reminder-source

English | [中文](2026-10-18-long-job-reminder-source.zh.md)

## Summary

Adds a producer-owned `long-job-reminder` message source for the notice the job-duration guard injects into an agent's next step.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-18-long-job-reminder-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-05-working-directory-attribution"
    after: "a276978f8fd69ea2adfbeb51b85236bb73db82924e013071c0e19d1009f08219"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-05-working-directory-attribution"
    after: "d4e594be3cd5621757f1927d7074b8f9242950a6231c38b16d07d77bda1d9171"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-07-title-reasoning-effort"
    after: "4b5f1efa4b07e63ea9d1d4528182bc9123e80baafe8cf4ffdf1450fc2efc504c"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-05-working-directory-attribution"
    after: "4ec27a54ddaa8b997377b27498bb459d4342e941c1571ada3ebf55901b581831"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The change adds one alternative to the `source` attribution slot of messages a step already carries, and leaves every existing alternative, field, event type, envelope field, and header field unchanged. Readers select behaviour by comparing `source.kind` against the kinds they handle and otherwise read the message as an ordinary notice, so an older reader reads a `long-job-reminder` message as text whose id, role, and content are intact, and drops no accepted data and reinterprets none. A newer reader reads every historical kind exactly as before; the reminder carries no required structure of its own. This is the attribution-kind case the compatibility table classifies as same-version.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/guard/long-job-reminder/tests: 12 tests passed (notice text, due rule, once-per-job record, fail-loud config, real Loader composition). pnpm exec vitest run packages/guard/unbounded-scan-guard/tests: 22 tests passed. pnpm run test:snapshot -t scan-guard-denial: the authored headless scenario replayed through dsh --profile headless. Per-file coverage of both package sources is 100% statements, branches, functions, and lines.

<a id="dev-note"></a>
## Dev Note

None.
