# Agent Note: Opaque floating surfaces

Status: implemented

English | [中文](2026-10-20-opaque-floating-surfaces.zh.md)

## Problem

Floating surfaces (menus, popovers, dropdowns, hover cards) rendered on a
translucent fill (`--dsw-menu-surface-fill` at 45–58% alpha) blurred with a
40px backdrop filter. On macOS the menu additionally painted an opaque backing
behind the page content so Chromium could blur over native vibrancy. The
translucent material made text under a floating panel bleed through, which is
unreadable for readers who prefer solid surfaces.

## Decision

Make every floating surface opaque and remove the backdrop blur:

- `--dsw-menu-surface-fill` and `--dsw-alias-menu-group-header-fill` resolve to
  solid `rgb(...)` values in both palettes.
- `--dsw-menu-backdrop-filter` is `none`; `MenuSurface` drops its
  `backdrop-filter` declaration and its macOS `backing` element and CSS anchors.
- Standalone backdrop filters on drag/drop overlays, the dock scrim, and the
  desktop onboarding cards are removed; the menu overflow hint uses the opaque
  menu fill instead of a transparent gradient.
- `MenuSurface`'s `data-menu-material` value becomes `opaque`.
- Modal masks stay translucent without blur (`--dsw-mask-blur: none` is
  unchanged) — the mask is a dimming layer, not a surface.

The ui-theme elevation spec and its package test were updated to assert the
opaque material, and the browser menu-material e2e now verifies solid fills,
`blur: none`, and the absence of a menu backing on every platform and palette.

## Consequences

- Floating panels are fully opaque; underlying content is hidden entirely
  instead of blurred.
- The macOS `backing` element and its portal are removed from `MenuSurface`,
  so the menu no longer needs the anchor-CSS machinery for the backing.
- Components that consumed `--dsw-specific-menu`/`--dsw-menu-surface-fill`
  and `--dsw-menu-backdrop-filter` automatically become opaque through the theme
  tokens; no per-component background changes were needed beyond removing the
  few hardcoded backdrop filters.

## Alternatives considered

**Keep the translucency and only raise the alpha.** A 90%+ opaque fill would
still let bright content bleed through at the edges and would keep the macOS
backing machinery alive for little benefit; the reader asked for solid
surfaces.

**Keep the backdrop filter on the isolated `.material` layer.** The filter
existed so the translucent fill could blur what was behind it. With an opaque
fill the filter has nothing to sample, so it was removed together with the
backing.
