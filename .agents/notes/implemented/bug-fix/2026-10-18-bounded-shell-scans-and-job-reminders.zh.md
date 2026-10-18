# Agent Note: 有界的 shell 扫描与后台任务提醒

Status: implemented

[English](2026-10-18-bounded-shell-scans-and-job-reminders.md) | 中文

## 问题

一个会话在约 192 GB 的仓库中运行了 `grep -rn ci_scope --include=* .`，其中仅 `target/` 就占约 82 GB。`bash` 的出厂前台截止时间为 60 秒——[`packages/bundle/base/cordis.patch.yml`](../../../../packages/bundle/base/cordis.patch.yml) 中的 `bash-sandbox` 配置项把执行器的 `timeoutMs` 设为 `60000`——而 [`dsh-tool-bash`](../../../../packages/shell/tool-bash/src/index.ts) 的 `promoteOnTimeout` 默认为 true。于是到期时该命令没有被终止，而是被分离成一个无人监管的 `ctx.jobs` 后台任务。它持续以 140–234 MB/s 读取磁盘并占用一个 CPU 核心达 5.5 分钟，直到人工将其杀掉；此时 CPU 封装温度达到 94 °C，而 Tjmax 为 100 °C。

有三个缺口让这条命令造成了这样的代价。没有任何机制检查 shell 命令文本——在 `packages/**/src` 中搜索找不到任何命令形态策略——因此对构建目录的递归 `grep` 看起来与普通命令无异。晋升后的工具结果不携带任何资源证据，模型无从判断该后台任务代价高昂。而产品中唯一有界的内容搜索路径——[`grep` 工具](../../../../packages/fs/tool-fs-search/src/grep.ts)，它以 ripgrep 为后端、遵循 ignore 文件，预算为 30 秒，匹配上限 250 条、原始输出上限 20 MB——并没有在 `bash` 工具描述中给出指引。

## 决策

四个部分一并落地。

**命令形态拒绝。** [`packages/guard/unbounded-scan-guard`](../../../../packages/guard/unbounded-scan-guard/src/index.ts) 通过 `ctx.tools.guard()` 在配置的工具（默认 `['bash']`）上注册一个单调 guard。它把命令字符串切成顶层分段，将每一段归类为全树遍历——递归的 `grep` 系列命令（`-r`、`-R`、`--recursive`）、不带 `-maxdepth`/`-prune` 的 `find`、不带 `--max-depth` 的 `du`、禁用 ignore 文件的 `rg`/`ripgrep`——再按调用的工作目录解析路径操作数，并在某个解析出的扫描根目录下存在已配置的重型目录（默认 `node_modules`、`target`、`.git`、`.venv`、`venv`、`__pycache__`、`.next`、`.turbo`、`vendor`、`.wt`）时拒绝该调用。命令本身已带的排除项（`--exclude-dir`、`--exclude`）会为其指明的目录解除拒绝。拒绝信息会点名违规分段、扫描根目录、阻塞的目录、`grep` 系列的修正命令，以及作为有界替代方案的 `grep` 工具。[工具子系统参考](../../../../docs/subsystems/tools.zh.md) 拥有该 guard 槽位的语义及其在执行流水线中的位置。

**长任务提醒。** [`packages/guard/long-job-reminder`](../../../../packages/guard/long-job-reminder/src/index.ts) 监听 `agent/pre-step`：当该 agent（智能体）拥有运行超过 `remindAfterMs`（默认 120000）的后台任务时，它在最前面注入一条已记录的通知，任务按时长从长到短排列，数量上限为 `maxListed`（默认 5）。该消息声明来源的 `kind` 为 `long-job-reminder`、`form` 为带 `summary` 的 `notice`，[上下文形态词汇](../feature/2026-08-05-context-form-vocabulary.zh.md) 定义了该形态；其文本点名 `job_output` 与 `job_kill` 作为结束该局面的操作。同一个后台任务只报告一次。

**终止命令的前台截止时间。** base bundle 中的每个 `tool-bash` 与 `tool-pwsh` 配置项都设置 `config.promoteOnTimeout: false`，因此 headless 与 CLI 配置文件会在前台命令到达截止时间时将其终止并报告失败。三个 `web-app` preset 保留 `promoteOnTimeout: true`——CI 表明其 e2e 套件固定了晋升任务 UX：归档对话框把前台调用列为必须停止的工作，人在环的 web 应用从侧边栏监督任务。确实需要更长时间的工作通过 `run_in_background` 或更大的 `timeoutMs` 自行声明，参数描述说明了这一点。

**面向模型文本中的有界路径。** `bash` 与 `pwsh` 的工具描述点名 `grep` 工具以及无界递归搜索的代价——pwsh 描述还点名 `Select-String` 与 `Get-ChildItem -Recurse`——两种工具在晋升后的结果文本中都说明被分离的命令会持续占用 CPU 与磁盘，并指向有界搜索。

## 测试

两个包各自的 spec 直接覆盖其行为。[`unbounded-scan-guard.spec.ts`](../../../../packages/guard/unbounded-scan-guard/tests/unbounded-scan-guard.spec.ts) 覆盖分段语法、每个受检工具自身的边界与排除事实、拒绝文本，以及通过真实工具注册表执行的策略；[`long-job-reminder.spec.ts`](../../../../packages/guard/long-job-reminder/tests/long-job-reminder.spec.ts) 覆盖时长与列表文本以及到期规则，包括只报告一次。两个包还各有一个真实 loader 组合测试，它启动仅测试用的 `cordis.yml`、挂载插件，并观察拒绝或注入的消息。

刷新后的 recorded session fixture（测试前置数据）固定了变更后的模型可见文本：整个会话语料的工具 schema 预期都带有新的 `bash` 描述以及 `timeoutMs` 参数文本，而 `snapshots/session/bash-startup-timeout/` 记录的是一条前台命令结算为 `[timed out after 1ms]` 与 `[killed by signal: SIGTERM]`，而不是晋升为后台任务。`pwsh` 描述由 `platform: pwsh` 场景 [`snapshots/session/pwsh-tool-turn/`](../../../../snapshots/session/pwsh-tool-turn/snapshot.yml) 固定，它只在具备 `pwsh` 宿主的平台上回放；其已记录的 schema 携带着更新后的描述，因录制环境没有 `pwsh`，该文本为就地修改。[`snapshots/session/persistent-pwsh-tool-turn/`](../../../../snapshots/session/persistent-pwsh-tool-turn/snapshot.yml) 固定的持久化工具保留了自己的描述，因此该场景无需更新。两个人工编写的压缩预算场景 `snapshots/session/compaction-output-reserve/` 与 `snapshots/session/compaction-summary-headroom/` 需要重新标定其固定的上下文窗口：更大的工具 schema 会移动主动压缩的触发点，因此两个组合都改为在回放历史与其替代内容之间恰好压缩一次。拒绝的 recorded session 覆盖是 [`snapshots/session/scan-guard-denial/`](../../../../snapshots/session/scan-guard-denial/snapshot.yml) 中人工编写的 headless 场景，它通过出厂 profile 回放一次被拒绝的扫描，并把该拒绝固定为模型可见的结果。

## 考虑过的替代方案

**采样子进程的 CPU 与 I/O，以在运行时发现失控。** 这种信号来自进程本身而非命令文本，但读取它需要平台相关机制——Linux 的 `/proc`、macOS 的 `/bin/ps`、Windows 的 Toolhelp32——本仓库没有这些机制，也没有任何资源遥测可供比对。词法检查不需要新的平台面，并能在读取开始之前就拒绝。

**收紧全局前台默认值。** 更短的默认值无法把扫描与合法的构建或测试运行区分开，而出厂的 60 秒已经会让需要数分钟的工作失败。代价会落在普通命令上，而高代价的形态依然合法。

**重写命令以添加排除项。** `tools/pre-execute` 监听器可以拒绝或允许一次调用，但无法重写其参数，而静默重写命令会改变调用方的原意。合成排除标志还要求重写层了解每个受检工具的标志语法。

**在调用之后警告。** `tools/post-execute` 警告到达时，高代价的读取已经结束。拒绝的存在是为了阻止这些工作，而不是事后解释它们。

## 后果

对重型目录的无界扫描在开始前就被拒绝，被分离的后台任务在 agent 仍能收集或停止它时得到通知，到达截止时间的前台命令会停止，而不是继续无人监管地运行。内容搜索通过 `bash` 与 `pwsh` 描述以及拒绝信息本身被引导到 `grep` 工具，因此模型被告知的是有界路径。

检测是词法层面的命令字符串启发式：嵌套 shell、脚本文件、变量展开的路径或未列入的工具都会携带策略永远看不到的扫描，因为不会执行任何东西去查明。重型目录检测基于名称，因此任何带有已配置名称的目录都会阻塞扫描，同名的小目录也会被拒绝。探测读取 harness 自己的文件系统，因此执行环境为远程或沙箱的扫描只是被近似判断，策略在那里失败开放（fail open）。

在截止时间终止会把过去被分离的长任务变成可见的失败：超过超时的构建或测试运行现在必须用 `run_in_background` 或更大的 `timeoutMs` 显式选择，只有设置 `promoteOnTimeout: true` 的部署才保留晋升。提醒从不限制或杀掉后台任务，且只在 agent 提出下一步时触发，因此结束轮次的会话会留下未被提及的运行中后台任务。
