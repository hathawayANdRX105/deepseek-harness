---
description: "建议性任务时长 guard：把运行超过配置预算的后台任务告知模型，供选择、配置或排查此插件的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-long-job-reminder

[English](README.md) | 中文

## 概述

用本包在会话内得知哪些后台任务已超出预算，此时你仍能收集或停止它们。在 agent（智能体）提出下一步之前，guard 会列出该 agent 超过配置的墙钟阈值的存活任务，按运行时间从长到短、最多列出配置的数量，并告知模型去读取它们的输出或结束它们。每个任务在其存活期间至多被报告一次。该提醒只提供建议：它绝不结束、暂停或限制任何任务。`dsh` 基础组合包以两分钟的预算启用它。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当 agent 启动后台任务后不再查看它们时，挂载此插件。`dsh` 基础组合包已经以两分钟的预算运行它；当你的任务通常更长或更短时，调优下面的预算与列表即可。

### 何时选择

当会话会在后台启动长时间构建、搜索或监视进程、且没有人在等待它们时，选择它：该提醒就是模型在下一步收集或停止它们的提示。当你需要对任务时长设置硬上限时避免使用它——本插件只提醒，绝不结束、停止或超时任何任务——当额外通知不值得它给步骤增加的上下文时也一样。

### 设置预算与列表

按基础组合包的设置挂载插件，或完全不配置以接受相同的默认值：

```yaml
- name: '@deepseek-ai/dsh-long-job-reminder'
  config:
    remindAfterMs: 120000
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `remindAfterMs` | `120000` | 任务可运行多久（墙钟毫秒）之后模型会被告知它 |
| `maxListed` | `5` | 一条提醒最多列出的任务数，按运行时间从长到短 |
| `labelPreviewChars` | `120` | 提醒中引用的任务标签最大字符数；该上限绝不影响哪些任务被列出 |

无效配置会在插件加载时失败：每个字段都必须是正的安全整数。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-long-job-reminder)是每个受支持字段的穷尽真源。

### 你会得到什么

当 agent 提出下一步时，guard 读取该 agent 的存活任务——状态为 `running` 或 `stopping`——并选出已运行至少 `remindAfterMs` 的任务，最长的在前。它在该步骤自身的消息之前注入一条 notice 用户消息，每个列出的任务一行：`- <id> (<duration>): <label>`。时长写作 `45s`、`12m 3s` 或 `1h 4m`；超过 `labelPreviewChars` 的标签会被截断并以 `…` 结尾。超出 `maxListed` 的任务由末尾一行计数，并仍可在之后的提醒中列出。每个被列出的任务都会被记录，因此它在存活期间只被报告一次；已结束的任务会在下一次查看时离开该记录。只有进入的步骤才会计算提醒：被拒绝的步骤不会得到提醒。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释 guard 如何判定提醒到期以及如何投递提醒，并指出实现它的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

guard 建立在四项承诺之上：

- **记录在案的上下文，而非改动循环。** 提醒搭载现有的 `agent/pre-step` waterfall（瀑布式事件），成为一条普通的已记录用户消息；agent loop（智能体循环）无需新事件，会话也能重建模型读到的内容。
- **仅提供建议。** 不取消、不暂停、不改写任何东西；结束工作仍是模型通过 `job_kill` 作出的决定。
- **列表有界。** `maxListed` 限制行数，`labelPreviewChars` 限制每个标签，因此任务很多的会话无法把一条提醒变成无界的 transcript（文本记录）条目。
- **加载时快速失败。** 每个配置字段都会在 `apply` 中重新校验，遇到不可用的值即抛出错误，绝不静默停用提醒。

### 到期规则与「每任务一次」记录

`ctx.jobs.list(agent.id)` 提供一个 agent 的任务；只考虑 `running` 与 `stopping` 两种状态。guard 用 `Date.now()` 减去 `job.startedAt`，保留达到或超过 `remindAfterMs` 的任务，按已运行时间从长到短排序，并最多列出 `maxListed` 个。被列出的 id 进入 `WeakMap<Agent, Set<JobId>>`——即「每任务一次」记录——其中不再存活的任务条目会在下一次查看时被删除。

### 在步骤边界投递

`agent/pre-step` 监听器先通过 `next()` 委派，并原样返回 `reject` 决策。否则它会计算到期的提醒（若有），并把提醒放在该决策消息数组之前，因此这条 notice 为它随之而来的步骤定调，并与该步骤原本携带的消息一同记录。消息创建时带有来源 `{ kind: 'long-job-reminder', form: 'notice', summary: '<n> job(s) running past <duration>' }`，表明它是对刚刚发生的事情的一次性说明。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config` schema、快速失败校验、`formatDuration`／`reminderText`、`agent/pre-step` 监听器 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从任务注册表逐步进入提醒搭载的步骤边界、它让模型使用的工具与 guard 组映射。

- [后台任务运行时](../../../docs/subsystems/jobs.zh.md)——本 guard 读取的任务注册表、状态与视图。
- [Agent 循环的拦截决策](../../../docs/subsystems/core.zh.md)——承载提醒的 `agent/pre-step` waterfall。
- [工具目录：`job_output`](../../../docs/tool-catalog.zh.md#job_output)——提醒让模型用来读取任务的工具。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-long-job-reminder)——每个受支持配置字段及其源声明。
- [guard 组映射](../README.zh.md)——同组的 guard 包与循环卫生家族。

-----

<a id="model-experience"></a>
## 模型体验

### 注入的提醒 notice

#### 模型看到什么

在存活任务超过预算之前什么都不会出现。此后，在 agent 提出下一步之前，该步骤的消息中会多出一条注入的用户消息——下面的模板——其来源字面量为 `{ kind: 'long-job-reminder', form: 'notice', summary: '<n> job(s) running past <duration>' }`。它是一次性说明，不取代任何内容。任务行按运行时间从长到短排列，`<duration>` 采用 `45s`／`12m 3s`／`1h 4m` 形式，超过 `labelPreviewChars` 的 `<label>` 以 `…` 结尾。省略任务行只在到期任务多于 `maxListed` 所列出数量时出现；它会写出数量：一个时写 `1 more job has been running as long.`，多于一个时写 `<n> more jobs have been running as long.`。

##### 提醒模板

```markdown
Background jobs you started are still running:
- <id> (<duration>): <label>
[<n> more job(s) have been running as long.]
Read the latest output with job_output, or stop a job you no longer need with job_kill. A search or build nobody is waiting on keeps consuming CPU and disk until it is stopped.
```

#### Token 影响

当每个任务都还年轻、已被报告或已结束时为零 token。一条提醒会添加一条保留的用户消息：每个列出的任务一行，再加末尾的指令，受 `maxListed` 行数与每个标签 `labelPreviewChars` 字符数的约束。

#### KV Cache 影响

仅追加；提醒注入在下一步骤的消息之前、所有此前已发送历史之后，不会使现有 KV Cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明 guard 何时不合适。它们是当前包约束，不是任务积压。

- **它只提醒，绝不限制任务**——不会结束、暂停或超时任何东西，因此模型忽略的任务会继续占用 CPU 与磁盘，且不会再收到关于该任务的提醒。
- **它在下一个被提出的步骤上触发**——从不提出下一步的 agent（空闲、等待人工输入或已结束）绝不会收到提醒，被拒绝的步骤也不计算提醒。
- **被报告过的任务在其存活期间不再报告**——按 agent 的记录会标记每个已列出的 id，因此跨越许多步骤的任务只产生一次提醒，而不是持续不断的提醒流。
- **已运行时间是自注册起的墙钟时间**——它包含任务等待执行容量或等待子进程槽位的时间，因此所引用的时长可能超过任务自身完成的工作。
- **「每任务一次」记录仅驻留内存**——恢复会话会以空记录开始，因此已经收到过提醒的存活任务会在恢复后的会话中再次被报告。
- **超出 `maxListed` 的任务只被计数，不被点名**——它们仍可在之后的提醒中列出，因此存在许多陈旧任务的会话会收到多条通知，而不是一份完整的列表。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与尚未决定的探索方向。它明确不具权威性——已交付的行为、限制与既定理由以上文、包代码和相关 Agent Note 为准。

`dsh` 基础组合包把本插件组合为 `packages/bundle/base/cordis.patch.yml` 中的 `long-job-reminder` 行，并内联 `remindAfterMs: 120000`，因此随包交付的就是该预算。[guard 组映射](../README.zh.md)拥有家族视图，[后台任务运行时](../../../docs/subsystems/jobs.zh.md)拥有本 guard 读取的注册表约定。开放问题：任务自己的生产者是否应能声明比部署默认值更短的预算，以及提醒是否应直接要求结束任务，而不只是提供这一选项。

</details>
