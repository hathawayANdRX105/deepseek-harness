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
    previous: "2026-10-13-user-rpc-principal"
    after: "c104b0cd8b32a691f7166bc6ed6c7e741a5dcba2e06d13645e88c50c8cee2fe5"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "0a80aac7a8640a9b7f508d1827c6c1e88c0f65436cefbf2a833900332e6a457b"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-user-rpc-principal"
    after: "5b21722e0616826fe9ec403eca153ea8f8662e8f53fa604b3001de7c6896b56a"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "aeb5f99e278983e6a5861f13dbcea70159545a00bde505cb5896f59884f590a5"
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
