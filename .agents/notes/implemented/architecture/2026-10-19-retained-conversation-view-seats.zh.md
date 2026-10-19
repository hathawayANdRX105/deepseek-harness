# Agent Note: Retained Conversation view seats

Status: implemented

[English](2026-10-19-retained-conversation-view-seats.md) | 中文

## Problem

在会话视图（Chat 与 Trajectory）之间切换时，离开的视图会被卸载，进入的视图会从快照重建。Chat 的 transcript 以 DOM 形式承载已加载的 Turn 窗口——对一个 200-turn 会话的 24-turn 初始窗口约有 2,300 个元素——而 Trajectory 每次激活都会重建其虚拟化台账。

在 Chromium 诊断 [session-switch.perf.ts](../../../../apps/web/tests/session-switch.perf.ts)（200-turn 种子会话、已构建 Web 产物、真实 Host scaffold、headless Chromium）上测得：可信的 Trajectory-to-Chat 标签点击在第一次返回时耗时 264 ms、Chromium 主线程任务 240 ms；第二次返回为 293 ms / 244 ms——两次返回都没有复用刚被销毁的 transcript。

## Decision

[DefaultConversationViews.tsx](../../../../packages/client/ui-conversation/src/client/skeleton/DefaultConversationViews.tsx) 为会话激活过的每个视图保留一个 seat（`data-view`、`data-active`），并按保留视图逐个以 `{ only: id }` 渲染 `conversation.view` outlet。本会话从未激活的视图完全不会挂载，因此打开会话仍只构建活动视图。seat 包装层在活动时布局中立、非活动时脱离布局（[ConversationRoot.module.css](../../../../packages/client/ui-conversation/src/client/skeleton/ConversationRoot.module.css)），因此视图自身的根元素仍是视图区的 flex 子元素，非活动视图不会影响 transcript 几何。

保留集合是组件状态：它按会话隔离，并在会话 shell 重挂载时重置，与会话级 View 偏好的生命周期一致。返回保留视图时复用其 DOM、滚动位置以及其 Definition 已累积的行，不会重新执行视图的激活工作。视图槽位的 owner 属性携带 `active`，使保留的 target 能在其 seat 脱离布局时暂停滚动策略（[use-chat-scroll.ts](../../../../packages/client/ui-chat/src/client/chat/use-chat-scroll.ts)）：非活动的 Chat seat 清除 opened 标记、取消采样，并忽略 scroll、scrollend、resize 与 intent 事件，再次激活时从会话已保存的滚动记忆重新落位。

## Measurements

同一诊断在同一机器上修改后的结果：Trajectory-to-Chat 为 138 ms wall / 98 ms task 与 141 ms wall / 106 ms task，script 时间从 118 ms 降到 12 ms。剩余成本来自浏览器对展开子树的样式与布局计算，以及点击的可操作性检查。首次 Trajectory 激活（393 ms）不变，因为它仍从已加载窗口构建台账。

侧边栏会话切换（本次改动不涉及）在冷、热样本上测得 764 ms（首次打开）、554 ms、459 ms、342 ms、491 ms、424 ms。热返回比冷打开便宜的原因仅是 Host 预制备观察的复用：客户端仍会丢弃 Session 实例、重新拉取尾部页面并重新折叠窗口。

## Alternatives considered

**挂载所有已注册视图并隐藏非活动者。** 已拒绝：这样打开会话时即使读者从不打开 Trajectory，也会先构建其台账（实测约 390 ms）；按激活顺序构建才能让视图成本跟随其使用。

**在槽位渲染器上增加框架选项（`keepMounted`）。** 已拒绝：保留策略是 Conversation shell 的属性，而不是一般列表槽位渲染的属性；由 shell 决定视图的激活工作是否值得保留，渲染器只按调用方意图执行。shell 改为对每个保留视图调用现有 outlet 一次。

**只保留视图快照并重建 DOM。** 已拒绝：实测返回成本主要由 DOM 构建、script 时间及随后的样式计算构成，而非快照折叠；仅保留快照无法消除重建。

## Consequences

内存：非活动的保留视图会保留其 DOM 与已累积行。读者的保留集合受其实际打开过的视图数量约束（交付表面只有两个），且注册消失或会话 shell 卸载时视图会停止挂载。基准中的 GC 后堆与 DOM 计数仍是诊断项，不是预算。

几何：非活动视图脱离布局而非以零尺寸测量，因此其自身滚动容器与共享 transcript 滚动口只在再次显示时重新测量。[views.client.spec.tsx](../../../../packages/client/ui-trajectory/tests/views.client.spec.tsx) 钉住切换后 Chat transcript 仍挂载在非活动 seat 内；[skeleton.client.spec.tsx](../../../../packages/client/ui-conversation/tests/skeleton.client.spec.tsx) 钉住从未激活的视图不会挂载、保留视图在两次切换间保持同一 DOM 节点、每个 seat 报告其活动状态。[chat-view.client.spec.tsx](../../../../packages/client/ui-chat/tests/chat-view.client.spec.tsx) 钉住非活动的 Chat seat 不会采样或落位，激活时会消费已保存的滚动记忆。

跨 Trajectory 绕行后的滚动恢复已通过把 composer-overlay CSS 限定到活动 seat 解决：[ConversationRoot.module.css](../../../../packages/client/ui-conversation/src/client/skeleton/ConversationRoot.module.css) 仅通过 `.viewSeat[data-active='true'] [data-conversation-composer-overlay]` 进入 overlay 模式，因此保留但非活动的 Trajectory seat 不再折叠活动 Chat seat 的滚动口。浏览器契约测试 "keeps composer resizing on the correct scroll owner across reopened Sessions" 在保留 seat 下通过。