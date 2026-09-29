---
category: architecture
title: Phase 16B shared UI foundation
status: implemented
---

## Decision

Phase 16B adds one shared `@deepseek-ai/dsh-ui-foundation` authority instead of separate preference, theme, accessibility, and widget-style services.

## Why

Home already contained a Phase-12 design-token prototype and a hot `setThemeTokens()` renderer path. Creating another Home-specific theme system would duplicate authority. The old Home token module now re-exports the shared token source so existing imports remain compatible.

The new service owns validated/versioned preferences, deterministic precedence, atomic persistence and previous-valid backup recovery, strict export/import, 15-second risky previews, applied capability fallback, accessibility override precedence, design-token resolution, primitive interaction contracts, and WebView2 state propagation.

## Boundaries

- Wallpapers remain Home/Phase 16C-owned.
- Dock, Status Bar, and Control Center feature settings remain with their future owners.
- Windows system settings remain Windows-owned/delegated.
- Space-specific persistence is intentionally blocked until Phase 18 supplies stable desktop identity.
- Shared primitive contracts standardize semantics/focus/keyboard/dismissal; they do not create a second renderer framework.
- Existing Surface Core and Overlay own native surfaces and popup lifecycle.

## Recovery and persistence

Preference writes use the existing atomic-write utility and the DSH home path. The previous valid primary document is retained as a backup. Corrupt primary state restores from backup, otherwise shipped defaults remain usable.

Risky previews never write durable state until Keep succeeds. They auto-revert on timeout, owner release, or loss of the confirmation UI.

## Acceptance

Focused tests cover schema validation/migration, backup recovery, precedence, desired-vs-applied fallback, unstable Space fallback, previews, accessibility resolution, primitive keyboard contracts, and Home hot-theme propagation. `demo:ui-foundation` provides a real Surface/WebView2 component gallery plus a real themed Overlay for keyboard, Narrator, mixed-DPI, long-label, high-contrast, 200% text, reduced-motion, and live theme propagation checks.
