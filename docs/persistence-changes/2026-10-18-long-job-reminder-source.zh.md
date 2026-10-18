---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-18-long-job-reminder-source

[English](2026-10-18-long-job-reminder-source.md) | 中文

## 概述

新增写入方自有的 `long-job-reminder` 消息来源，用于作业时长护栏注入到 agent 下一步的提醒。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

本次变更只是在一个步骤已经携带的消息的 `source` 归属槽位中新增一个候选项，既有的候选项、字段、事件类型、信封字段与头部字段均未改变。读取方通过比较 `source.kind` 与自己处理的类型来选择行为，其余情况按普通通知读取消息，因此旧版读取方会把 `long-job-reminder` 消息当作文本读取，其 id、role 与 content 保持完整，不会丢弃或重新解释任何已接受的数据。新版读取方对历史类型的读取与以往完全一致；该提醒自身不携带任何必填结构。这正是兼容性表中归类为 same-version 的归属类型情形。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/guard/long-job-reminder/tests：12 个测试通过（提醒文本、到期规则、同一作业只提醒一次、配置失败即报错、真实 Loader 组合）。pnpm exec vitest run packages/guard/unbounded-scan-guard/tests：22 个测试通过。pnpm run test:snapshot -t scan-guard-denial：该手工编写的 headless 场景经 dsh --profile headless 回放通过。两个包源码的逐文件覆盖率为语句、分支、函数、行均为 100%。

<a id="dev-note"></a>
## 开发备注

无。
