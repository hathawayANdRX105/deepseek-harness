# Agent Note: 空闲会话保留池

Status: implemented

[English](2026-10-19-idle-session-retention-pool.md) | 中文

## Problem

侧边栏会话切换会从零重建被切走的会话。导航释放上一个 `mainView` 引用后，引用分配器会丢弃常驻实例；下一次热返回需要重新拉取尾部历史页并重新折叠窗口，才能绘制首个内容。在 [session-switch.perf.ts](../../../../apps/web/tests/session-switch.perf.ts) 的 Chromium 诊断中，侧边栏热返回大约耗时 250–460 ms 墙钟（script 96–180 ms），只比冷打开略便宜，因为复用的仅是 Host 端 prepared-observation 缓存。

## Decision

[service.ts](../../../../packages/api/session-controller/src/client/sessions/service.ts) 在释放的会话作用域代际完全销毁后，把其实例保留在有界空闲池中。最终引用释放现在会撤回该代并销毁其 fiber；清理落定后，会话进入空闲池（最多两个）而不是被丢弃。之后再次 `retain` 会用新的作用域代复用池中实例：`open()` 已结算，因此无需重新拉取历史或重新折叠窗口。

池必须有界，因为常驻会话会保活 observe 流与投影缓存。两条不变量把热复用与既有代际替换语义区分开：

- 在清理窗口内 retain 仍走冷路径：丢弃过期实例，打开全新代。
- 已从 Host 列表移除的会话无法再从 UI 到达，因此其释放会真正丢弃而不是入池；这避免已删除会话的 observe 流泄漏。

## Measurements

改动后同一诊断（单独运行，无并发浏览器 worker）显示了热返回的收益：`coldSwitchAlphaToBravo` 耗时 514 ms 墙钟 / 202 ms script，而随后的 `warmSwitchAlphaToBravo`（Bravo 从空闲池复用）耗时 328 ms 墙钟 / 130 ms script——重新拉取与重新折叠的 script 工作消失；`warmSwitchCharlieToAlpha` 耗时 393 ms 墙钟 / 123 ms script，其 cold 对等项为 437 ms 墙钟。会话切换的结构断言（chat seat 保持活动、流窗口已加载）通过；session-controller 全套（961 个测试）与 workspace/session/sidebar 客户端套件（1527 个测试）全部无变化通过。会话壳层中的 DOM 重挂载与布局仍主导剩余热返回成本（script 约 120–190 ms 外加 style/layout），因此热返回落在约 330–500 ms，相比之前的 250–460 ms 区间只获得了对象层节省部分的提升。

## Alternatives considered

**让所有释放的会话无限期常驻。** 拒绝：每个常驻会话都持有 observe 流与投影缓存；无界池会随访问过的会话增长，且既有契约要求作用域释放时关闭会话流。

**用延迟销毁代替入池。** 拒绝：observe 流契约要求释放时关闭流；防抖要么保持流打开（与入池同成本，但没有显式有界池），要么关闭流并丢失热窗口。

**直接复用作用域代本身。** 拒绝：引用分配器的代际替换语义要求，当 retain 与上一次释放竞争时产生全新代（新 binding、cold `openState`）；只有旧 fiber 完全销毁后，已打开窗口才可安全共享。

## Consequences

最近访问的两个会话的热返回不再重新拉取或重新折叠历史；剩余成本是会话壳层中的 DOM 重挂载与布局。仍被列表保留的已释放会话在空闲期间保持 observe 流（上限两个），因此对象层每个控制器最多持有三个活跃流（当前选中会话加空闲对）。已移除会话的流仍立即关闭。更深层的 UI 级保留（跨会话切换保持对话 DOM 挂载）仍是未来工作。