# Agent Note: 跨会话对话 seat

Status: implemented

[English](2026-10-19-cross-session-conversation-seats.md) | 中文

## Problem

在[空闲会话保留池](2026-10-19-idle-session-retention-pool.zh.md)消除重新拉取/折叠的 script 工作后，侧边栏会话切换在 200 回合长会话上仍约需 330–500 ms 墙钟。剩余成本来自会话壳层重建 DOM：切换 `mainView` 引用会改变 `main.conversation` 槽的 `session-maybe` 绑定，slot 渲染器会重挂载 `ConversationRoot`（24 回合窗口约 2300 个元素，外加 header、composer 与轨迹账本）。对象层在切换期间保住了已打开窗口与事件流，但 React 子树仍会整体拆除并重建。

## Decision

主界面展示过的每个会话都保留自己的 seat，seat 以会话标识为键。

- [conversation-seats.ts](../../../../packages/client/ui-conversation/src/client/conversation-seats.ts) 负责 seat：每个 seat 持有自己的 `SessionReference`（来源 `conversationSeat`），因此会话的作用域、已打开窗口与事件流在停放期间保持常驻。池中包含当前选中的会话与两个停放会话；停放第三个时释放最旧的一个。
- [stores.ts](../../../../packages/client/ui-conversation/src/client/stores.ts) 通过 entry 声明的 store 发布名单，面板用 `useStore` 读取，无需新增全局 hook 席位。
- [ConversationPanel.tsx](../../../../packages/client/ui-conversation/src/client/skeleton/ConversationPanel.tsx) 为每个保留会话渲染一个 seat，各自通过框架 `SessionProvider` 绑定到自己的会话（与侧边栏独立会话视图同一机制）；没有选中会话时渲染无会话的 Conversation。
- 停放的 seat 退出布局但不卸载（[ConversationRoot.module.css](../../../../packages/client/ui-conversation/src/client/skeleton/ConversationRoot.module.css)），因此保留的转录保持其 DOM 与订阅。
- `sessionActive` owner share 从 `main.conversation` 经内容工厂与会话体传入 View owner share，并与 View 自身的 `active` 合并。停放 seat 因此让其 View 一并暂停滚动策略，重新选中时 Chat 从滚动记忆恢复。

## Measurements

同一台机器上的 Chromium 诊断（[session-switch.perf.ts](../../../../apps/web/tests/session-switch.perf.ts)，单独运行）：

| 切换 | 之前 | 之后 |
| --- | --- | --- |
| 返回第一个会话 | 502 ms 墙钟 / 189 ms script | **283 ms 墙钟 / 31 ms script** |
| 返回第二个会话 | 328 ms 墙钟 / 130 ms script | **242 ms 墙钟 / 32 ms script** |
| 冷切换后返回 | 393 ms 墙钟 / 123 ms script | **326 ms 墙钟 / 35 ms script** |
| 冷切换 | 529 ms 墙钟 / 244 ms script | 529 ms 墙钟 / 244 ms script |

热返回不再提交新内容（`firstContent` 缺失，因为转录已挂载），节点增量从约 +2370 降到约 +130，剩余时间是对显示子树做样式与布局。

## Alternatives considered

**虚拟化聊天流。** 会减小每次挂载的 DOM 体量，但会改变滚动契约（`chat-scroll-contract.e2e.ts` 在真实 DOM 高度上测量滚动所有权、锚点与 composer 缩放），并引入第二套滚动系统。本步骤拒绝。

**对转录行使用 `content-visibility: auto`。** 可降低屏外行的布局成本而不改变 React 挂载成本，但会与滚动高度测量和锚点恢复逻辑交互；需要单独的契约审计。可作为后续项，不是首选修复。

**全局的 seat 名单 hook。** 拒绝：每个构造完整 props 对象的客户端包都必须提供该 seat，且名单类型会把 Conversation 包引入只需要 Workspace UI 的包。

**让无会话 seat 与会话 seat 并存挂载。** 拒绝：停放的转录会继续响应与活动 seat 相同的选择器；因此无会话 seat 仅在没有选中会话时挂载，这会在首个会话出现时重建 Hero 树。

## Consequences

- 侧边栏热返回复用停放的转录而不是重建；对象层保持与之前相同的会话常驻，外加它们的 DOM。
- 停放会话持有其转录 DOM，因此同时打开多个长会话的读者要为这部分内存付费（实测：两个保留的 200 回合转录约多占 10 MB 堆）。
- 访问对话元素的浏览器测试必须限定到选中的 seat（`[data-session-seat][data-active="true"]`），因为停放 seat 保持同样的元素挂载。
- 自动打开侧边栏预览的组件在“其会话在屏幕上时”必须将当前屏幕会话与自身 `sessionId` 比较，因为停放 seat 在其他会话在屏时仍保持挂载（plan-review 的自动打开需要此检查）。
- 无会话界面的首个会话会替换 Hero 树；装配测试现在断言 Hero 仍然完整，而不是同一个 DOM 节点存活。
