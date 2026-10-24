---
description: "循环卫生 guard 家族的包映射：重复工具提醒、工具调用超时策略、无界扫描策略与任务时长提醒，供选择或组合 guard 的用户与维护者阅读。"
kind: "package-group"
---

# guard/：循环卫生 guard 家族

[English](README.md) | 中文

## 概述

`guard/` 组让 agent（智能体）循环保持高效，并让其资源占用有界。`repeat-tool-reminder` 会在模型重复完全相同的工具调用却没有进展时提醒它改变方法或结束任务。`timeout-policy` 为工具调用执行它们配置的协作式时间上限，并在取消完成后返回清晰的超时错误。`unbounded-scan-guard` 拒绝起始目录包含构建树或依赖树的树级 shell 搜索，并写明应当改用的收窄命令。`long-job-reminder` 把超出预算的后台任务告知模型，使其能够收集或停止它们。四者都在 `dsh` 基础组合包中默认启用。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

四个插件覆盖本组的模式；下文每个 README 都说明何时保留、调优或移除它。

| 包 | 提供什么 |
|---|---|
| [`repeat-tool-reminder/`](repeat-tool-reminder/README.zh.md) | 在模型重复完全相同的工具调用时提醒它，使其改变方法或结束任务 |
| [`timeout-policy/`](timeout-policy/README.zh.md) | 为声明了限时的工具调用设置超时，让模型得到清晰错误而不是无限等待 |
| [`unbounded-scan-guard/`](unbounded-scan-guard/README.zh.md) | 拒绝扫过构建树或依赖树的树级 shell 搜索，并写明收窄后的命令 |
| [`long-job-reminder/`](long-job-reminder/README.zh.md) | 把超出预算的后台任务告知模型，使其能够收集或停止它们 |

-----

<a id="related-documentation"></a>
## 相关文档

先从工具子系统参考了解工具调用流水线、从后台任务运行时了解任务提醒读取的注册表，再看 guard 配置与策略背后的超时库决策。

- [工具子系统参考](../../docs/subsystems/tools.zh.md)——工具调用流水线以及每个 guard 都依赖的决策。
- [后台任务运行时](../../docs/subsystems/jobs.zh.md)——`long-job-reminder` 读取的任务注册表、状态与视图。
- [生成配置目录](../../docs/config-catalog.zh.md)——重复调用提醒、扫描策略与任务提醒的每个受支持字段，以及 `timeout-policy` 所执行的工具限时。
- [超时截止时间库 Agent Note](../../.agents/notes/implemented/architecture/2026-07-06-timeout-deadline-library.zh.md)——`timeout-policy` 所执行的时序／终止拆分。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
