---
description: "Shell 扫描策略：拒绝起始目录包含构建树或依赖树的树级 grep、find、du 与 ripgrep 调用，供选择、配置或排查此插件的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-unbounded-scan-guard

[English](README.md) | 中文

## 概述

用本包阻止树级 shell 搜索读取数 GB 的构建数据、依赖数据或仓库数据。在被检查的工具调用运行之前，策略会分类该命令，并拒绝起始目录包含重量级目录的递归 `grep`、`find`、`du` 或 `rg`；模型会收到阻塞它的目录名，以及应当改用的收窄命令。被拒绝的调用绝不会执行。已经限定遍历范围、或排除了每一个重量级目录的搜索则原样通过。`dsh` 基础组合包以默认目录列表启用本包。

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

当 shell 搜索可能从包含构建树、依赖树或仓库数据的目录开始时，挂载此插件。`dsh` 基础组合包已经以默认目录列表运行它；当你的布局不同时，调优下面的目录列表或被检查的工具即可。

### 何时选择

当 agent（智能体）搜索的内容你心中有数，而一次疏忽的 `grep -rn` 扫过 `node_modules`、`target` 或 `.git` 会消耗数分钟 CPU 和数 GB 读取量时，选择它。当模型需要不受限制的 shell 搜索时避免使用它——拒绝会强制改用收窄后的命令——当搜索通过策略读不到的路径到达文件系统时也一样：默认被检查的工具是 `bash`，因此 Windows PowerShell 工具、脚本内部的扫描或由变量展开的根目录都不会被检查。

### 设置策略

不配置任何字段挂载插件，即接受两项默认值：

```yaml
- name: '@deepseek-ai/dsh-unbounded-scan-guard'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `heavyDirectories` | `['node_modules', 'target', '.git', '.venv', 'venv', '__pycache__', '.next', '.turbo', 'vendor', '.wt']` | 使对其父目录的扫描成为无界扫描的目录名；在某个扫描根下完全不存在的名字绝不会触发拒绝 |
| `tools` | `['bash']` | 调用会被检查的工具名；另一个 shell 消费方需要先有自己的命令文法，才能列在这里 |

无效配置会在插件加载时失败：`heavyDirectories` 条目为空、只有空白或包含 `/`，以及 `tools` 列表为空。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-unbounded-scan-guard)是每个受支持字段的穷尽真源。

### 你会得到什么

一次 `bash` 调用会被拆成顶层分段，每个分段单独分类。递归的 `grep`（`egrep`、`fgrep`、`ggrep`）、不带 `-maxdepth` 或 `-prune` 的 `find`、不带 `--max-depth`／`-d` 的 `du`，或禁用忽略文件的 `rg`，都算作无界遍历。对这样的遍历，策略把每个路径操作数解析到该调用的工作目录——调用自身的 `workdir`，否则会话目录，否则进程目录——丢弃不是现有目录的操作数，并移除命令已排除的目录。若仍有某个根持有配置中的名字，该调用在运行前即被拒绝，模型读到的是错误结果 `Error: <reason>`，而不是工具的输出。该原因会写明违规分段、各个根、阻塞目录、收窄后的命令以及 `grep` 工具；一次调用中第一个违规分段决定该文本。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释策略如何读取命令并作出判断，并指出实现它的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

策略建立在四项承诺之上：

- **只做词法分析，绝不执行 shell。** 命令字符串按词、引号与顶层操作符读取；不执行、不展开，也不通过 shell 解析任何内容。文法看不到的构造只是不会被分类。
- **一次只判断一个分段。** 分段按 `;`、`|`、`||`、`&&` 和换行切分，因此复合调用中靠后的扫描会与单独出现的扫描受到完全相同的判断。
- **本地探测，失败即放行。** 扫描根用 `statSync` 在 harness 自身的文件系统上探测；不存在、不可读或不是目录的路径不可能是要保护的树，因此调用继续执行。
- **单调 guard。** 策略注册在 `ctx.tools.guard()` 上，因此后续监听器无法把它的拒绝变回许可，而调用未受检查的工具只需一次集合查找、不做任何文件系统操作。

### 什么算作无界遍历

每个受检查的命令都带有自己的限界与排除事实。

- **`grep` 家族。** 递归来自 `-r`、`-R`、`--recursive`、`--dereference-recursive` 或 `-d recurse`；`--exclude-dir`／`--exclude` 的值（内联或独立、带 `=` 或不带）记录为排除项。除非 `-e`／`-f`／`--regexp`／`--file` 已提供模式，否则第一个裸操作数就是模式，绝不会被误当成路径。
- **`find`。** `-maxdepth` 与 `-prune` 使遍历有界；收集操作数时会跳过 `!`、`(` 以及每个选项词。
- **`du`。** `--max-depth`／`-d` 使遍历有界；`--exclude-dir`／`--exclude` 记录排除项。
- **`rg`／`ripgrep`。** ripgrep 默认遵循忽略文件，因此只有禁用忽略的形式（`-u` 簇、`--no-ignore*`）才算无界。

为找出每个分段实际调用的命令，会跳过命令前缀（`sudo`、`env`、`time`、`nohup`、`nice`、`ionice`、`stdbuf`）、`VAR=value` 赋值以及任何带路径的命令词。没有路径操作数的扫描从工作目录开始。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config` schema、快速失败校验、`splitSegments`／`scanIntent`／`denialReason`，以及 `tools.guard()` 注册 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从工具调用流水线逐步进入所执行的 guard 语义、推荐的替代工具与 guard 组映射。

- [工具子系统参考](../../../docs/subsystems/tools.zh.md)——本策略注册进的 `tools/execute` 流水线与单调 guard 槽位。
- [工具目录：`grep`](../../../docs/tool-catalog.zh.md#grep)——拒绝时推荐用来替代无界 shell 搜索的模型可见工具。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-unbounded-scan-guard)——每个受支持配置字段及其源声明。
- [guard 组映射](../README.zh.md)——同组的 guard 包与循环卫生家族。

-----

<a id="model-experience"></a>
## 模型体验

### 被拒绝的工具调用

#### 模型看到什么

在被拒绝之前什么都不会出现。被拒绝的调用绝不运行，也不产生正常结果；模型改为收到注册表针对该调用的拒绝结果——一个文本块 `Error: <reason>`，且 `isError: true`——以代替工具自己的输出。下面的模板就是完整的该原因：`<command>` 是违规分段，`<roots>` 是它本会搜索的各个根，`<directories>` 是这些根下存在的配置名字（写作 `<name>/`），`<remedy>` 则是同一条命令后跟每个阻塞名一个 `--exclude-dir=<directory>` 标志，或者对 `find`、`du` 与 `rg` 而言，写明该工具自身限界的一句话（`find` 用 `-maxdepth`／`-prune` 形式，`du` 用 `--max-depth`／`--exclude` 形式）。末句指向 `grep` 工具：它遵循忽略文件，并受自身超时与结果上限约束。

##### 拒绝原因模板

```markdown
Blocked a tree-wide scan: `<command>` searches <roots>, which holds <directories>. Those directories hold build, dependency, or repository data; walking them reads gigabytes and can hold a CPU core for minutes. <remedy> The grep tool searches with ripgrep, honors ignore files, and is bounded by its own timeout and result caps.
```

#### Token 影响

策略未拒绝的调用为零 token。拒绝会添加一条保留的错误结果，代替该调用本会产生的工具输出；其长度受命令分段与所引用目录名的限制。

#### KV Cache 影响

仅追加；拒绝只替换该调用新增的结果，位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明 guard 何时不合适。它们是当前包约束，不是任务积压。

- **词法命令字符串就是全部输入**——策略只读取词、引号与顶层操作符，因此它看不到的扫描（嵌套 shell、脚本文件、由变量展开的路径、未列出的工具）绝不会被拒绝。
- **探测是本地行为**——扫描根在 harness 自身的文件系统上探测，因此执行环境为远程或沙箱的扫描只能被近似，策略失败即放行。
- **重量级目录是按名字判定的**——任何带有配置名字的目录都会阻塞扫描，因此同名的小目录同样会被拒绝；没有大小或文件数检查。
- **只检查已配置的工具**——默认是 `bash`，因此 Windows PowerShell 命令目前不在范围内；另一个 shell 消费方需要先有自己的命令文法，才能加入 `tools`。
- **排除项只按末段名匹配**——`--exclude-dir`／`--exclude` 的值被截取其最后一段路径，因此像 `build/node_modules` 这样的排除会让命令仍会遍历的顶层 `node_modules` 不再触发拒绝。
- **一次调用只给一条拒绝**——第一个违规分段决定该消息，同一条命令中更靠后的分段不会被报告。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与尚未决定的探索方向。它明确不具权威性——已交付的行为、限制与既定理由以上文、包代码和相关 Agent Note 为准。

`dsh` 基础组合包把本插件组合为 `packages/bundle/base/cordis.patch.yml` 中的 `unbounded-scan-guard` 行，且不带内联配置，因此上文两项默认值就是随包交付的行为。[guard 组映射](../README.zh.md)拥有家族视图，[工具子系统参考](../../../docs/subsystems/tools.zh.md)拥有本策略注册进的单调 guard 语义。开放问题：是否应以基于大小或文件数的探测取代名字列表，以及 Windows PowerShell 工具需要怎样的命令文法才能加入 `tools`。

</details>
