# Agent Note: 实心悬浮面板

Status: implemented

[English](2026-10-20-opaque-floating-surfaces.md) | 中文

## Problem

悬浮面板（菜单、弹出层、下拉、悬停卡片）渲染在半透明填充上（`--dsw-menu-surface-fill` 为 45–58% 不透明度）并带有 40px 背景模糊。macOS 上菜单还会在页面内容背后绘制不透明 backing，以便 Chromium 在原生 vibrancy 上做模糊。半透明材质会让面板下方的文字透出，偏好实心表面的用户难以阅读。

## Decision

让所有悬浮面板不透明并移除背景模糊：

- `--dsw-menu-surface-fill` 与 `--dsw-alias-menu-group-header-fill` 在两个主题中都解析为实心 `rgb(...)`。
- `--dsw-menu-backdrop-filter` 为 `none`；`MenuSurface` 移除 `backdrop-filter` 声明及其 macOS `backing` 元素与 CSS anchor。
- 拖放覆盖层、dock scrim、桌面 onboarding 卡片上的独立背景模糊一并移除；菜单溢出提示改用不透明菜单填充而非透明渐变。
- `MenuSurface` 的 `data-menu-material` 值改为 `opaque`。
- 模态遮罩保持半透明且无模糊（`--dsw-mask-blur: none` 不变）——遮罩是变暗层，不是表面。

ui-theme 的 elevation 规范及其包测试更新为断言实心材质；浏览器 menu-material e2e 现在验证每个平台与主题下都是实心填充、`blur: none`，且不存在菜单 backing。

## Consequences

- 悬浮面板完全不透明；底层内容被完全隐藏而不是模糊。
- `MenuSurface` 的 macOS `backing` 元素及其 portal 被移除，菜单不再需要为 backing 维护 anchor-CSS 机制。
- 消费 `--dsw-specific-menu`/`--dsw-menu-surface-fill` 与 `--dsw-menu-backdrop-filter` 的组件通过主题 token 自动变为不透明；除移除少量硬编码的 backdrop-filter 外，无需逐组件改背景。

## Alternatives considered

**保留半透明并仅提高不透明度。** 90%+ 的不透明填充仍会让明亮内容从边缘透出，并让 macOS backing 机制继续存在却收益甚微；用户要求的是实心表面。

**在隔离的 `.material` 层上保留背景模糊。** 该滤镜的存在是为了让半透明填充模糊其背后的内容。填充变为不透明后，滤镜没有可采样的内容，因此与 backing 一并移除。
