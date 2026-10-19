# Agent Note: 跨会话对话 seat

Status: proposed

[English](2026-10-19-cross-session-conversation-seats.md) | 中文

## Problem

在[空闲会话保留池](../../implemented/architecture/2026-10-19-idle-session-retention-pool.zh.md)消除了重新拉取/重新折叠的 script 工作后，侧边栏会话切换在 200 回合长会话上仍约需 330–500 ms 墙钟。剩余成本来自会话壳层重建 DOM：切换 `mainView` 引用会改变 `main.conversation` 槽的 `session-maybe` 绑定，slot 渲染器会重挂载 `ConversationRoot`（24 回合窗口约 2300 个元素，外加 header、composer 与轨迹账本）。对象层在切换期间保住了已打开窗口与事件流，但 React 子树仍会整体拆除并重建。

## Proposal

为最近访问的每个会话保留一个对话子树，在会话级别复刻已实现的[对话视图 seat](../../implemented/architecture/2026-10-19-retained-conversation-view-seats.zh.md) 模式。

具体而言，`ConversationPanel`（root 级 `main` 占用者）将变成一个会话 seat 宿主：

- 它跟踪访问过的会话 id（有界，例如与空闲池一致的两个）。
- 每个访问过的会话有一个 seat `<div data-session-seat data-active={sessionId === current}>`；非活动 seat 退出布局（`display: none` 或 `content-visibility`），活动 seat 恰好参与一次布局。
- 每个 seat 为自己的会话渲染 `main.conversation` 出口。这要求 slot 机制能针对显式会话绑定而不是仅当前选择来解析 `session-maybe` 出口：目前 `SessionMaybeEntry` 通过 `useScopeBinding()` 获取绑定，并在会话切换时用 incarnation epoch 重挂载。扩展方式是给 seat 的出口提供作用域化的 `ScopeProvider`/绑定覆盖，保留与 `useMaybeIncarnation` 相同的收养簿记，但按会话为键。

保留的子树会保持其滚动位置、DOM 与活动事件订阅（对象层已为列表中的会话保持 observe 流打开）。返回保留会话时，可跳过完整重挂载与布局。

### Scope boundary

只有 `main` 对话面获得会话 seat。嵌入式对话出现（hero、目录流、工具视图）与侧边栏列表保持现有生命周期。内存策略与空闲池相同：除活动会话外，最多保留两个对话子树，每个约等于一个已加载窗口的大小。composer 栏与输入 dock 保持会话作用域并在每次切换时重挂载，除非证明它们足够廉价可以放入 seat 内。

## Alternatives considered

**虚拟化聊天流。** 会减小每次挂载的 DOM 体量，但会改变滚动契约（`chat-scroll-contract.e2e.ts` 在真实 DOM 高度上测量滚动所有权、锚点与 composer 缩放），并引入第二套滚动系统。本步骤拒绝。

**对转录行使用 `content-visibility: auto`。** 可降低屏外行的布局成本而不改变 React 挂载成本，但会与滚动高度测量和锚点恢复逻辑交互；需要单独的契约审计。可作为后续项，不是首选修复。

**接受当前成本。** 热返回已从约 250–460 ms 降到约 330–500 ms，script 时间大约减半；若用户优先考虑内存而非延迟，剩余的 200–300 ms DOM 重挂载与布局成本可以接受。

## Acceptance criteria

- 切走再切回会话时不再重挂载其对话子树：性能诊断中热返回的 `nodesDelta` 降到视图切换量级，`totalNodes` 不再每次返回增长一个完整窗口。
- `chat-scroll-contract.e2e.ts` 保持全绿：会话切换并返回后，滚动所有权、锚点、composer 缩放与底部跟随行为完全一致。
- 会话移除会销毁其 seat：列表中的会话从 Host 列表消失后，其保留的 DOM 与事件订阅被拆除。
- 内存保持有界：除活动会话外最多保留两个对话子树，淘汰策略与空闲池一致。

## Risks

- **Slot 机制回归**：为 `session-maybe` 增加显式按会话解析路径会触及所有会话作用域面共享的绑定/收养核心；一旦出错，可能超出预期 seat 范围导致对话重挂载或双重挂载。缓解：seat 宿主保持可选（无保留会话时不产生 seat），并运行完整 `ui-renderer`/`ui-conversation` 套件与 `chat-scroll-contract.e2e.ts`。
- **陈旧 DOM 更新**：保留的对话子树会继续订阅其会话的活动事件；如果 Host 列表移除了某个会话，其 seat 必须与对象层实例一起销毁，避免隐藏子树持续消费更新。
- **Composer 与输入状态**：目前 composer 栏与输入 dock 在每次切换时重挂载；如果它们留在 seat 外，返回时焦点与草稿状态仍会重置，可能感觉像部分回退。

## Consequences

- 一旦子树已挂载，热返回会降到约等于视图切换的成本（约 140 ms）。
- 内存：每个保留会话持有其对话 DOM 加对象层窗口；有界为两个保留会话。
- `main.conversation` 槽的 `session-maybe` 语义获得显式按会话解析路径；在没有 seat 宿主时，现有单绑定行为必须保持不变。
- 测试：扩展 `session-switch.perf.ts` 的结构断言，并新增 chat-scroll-contract 用例：切换会话、返回，并验证滚动所有者与 composer 几何在未重挂载的情况下保持不变。