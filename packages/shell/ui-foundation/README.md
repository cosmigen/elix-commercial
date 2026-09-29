# ELIX UI Foundation

Phase 16B shared preferences, design-token, accessibility, and interaction foundation.

## Ownership

`UiFoundationService` is the single authority for normal shell appearance preferences. It owns durable preference state, deterministic precedence, risky preview transactions, applied capability fallback, and renderer propagation. It does not own wallpapers, Dock settings, Status Bar settings, or Windows system settings.

Precedence is:

`shipped defaults -> selected preset -> user overrides -> feature -> monitor -> app -> active preview -> accessibility overrides`

Space-specific persistence is intentionally unavailable until Phase 18 supplies stable Windows desktop identity; callers receive an explicit fallback marker instead of persisting unstable IDs.

## Persistence

Preferences are stored atomically under the DSH home by default in `elix-ui-preferences.json`. The previous valid primary is retained as `.bak`. Corrupt primary state falls back to that backup, then to safe shipped defaults. Imports use the same strict versioned schema and cannot introduce arbitrary fields such as HWNDs, PIDs, secrets, or notification text.

## Risky previews

`beginPreview()` applies appearance changes in memory only. The default Keep/Revert deadline is 15 seconds. The preview auto-reverts on timeout, owner release, or when its confirmation UI disappears. `keep()` is the only operation that turns preview state into durable user overrides.

## Design and accessibility

The resolver publishes dark, light, follow-system, and high-contrast variants plus typography, spacing, icon sizing, focus, density, materials, hit targets, and motion tokens. Desired preferences remain intact when a runtime capability is unavailable; the `applied` projection records opaque/no-motion fallbacks instead.

The existing Home Phase-12 token module re-exports these shared tokens for compatibility. `UiFoundationService` also pushes resolved tokens into Home's existing `setThemeTokens()` hot-update path and posts the same state to active Surface/WebView2 renderers.

## Interaction contracts

Framework-neutral primitive contracts cover buttons, toggles, sliders, segmented controls, menus/submenus/context menus, tooltips, popovers, sheets/dialogs, search, lists, tabs, toasts, empty/loading/error states, progress, and cancel actions. Renderers retain native HTML/ARIA semantics; the foundation standardizes keyboard, focus, dismissal, hit-target, and motion rules rather than inventing a second widget runtime.

Tab labels remain unbroken at accessibility text scales; constrained tab rows scroll horizontally while each tab retains the shared minimum hit target.

## Verification

Run focused tests with:

```powershell
pnpm exec vitest run packages/shell/ui-foundation/tests --no-file-parallelism
```

Run the real WebView2 component gallery with:

```powershell
pnpm run demo:ui-foundation
```
