# Agent Note: Pre-Phase-17 audit hardening

Status: implemented

## Problem

The Phase 1–16D audit found scaled tab labels splitting inside words, two stale Home test fixtures, nondeterministic lifecycle acceptance closure, recovery checks tied to the runner's desktop, and overlapping AppBar mutations that could let an older completion disturb newer native state.

## Decision

The findings are resolved at their owning layer. UI Foundation keeps scaled tab labels intact and makes constrained tab rows scroll horizontally. Home test fixtures implement the current Windows Context interface, and their theme assertion follows the shared semantic token instead of duplicating its resolved dark color.

Window Control continues to request normal application closure with `WM_CLOSE`. It does not terminate a process or destroy another thread's window as a timeout fallback because either action can bypass application-owned save and confirmation behavior. The Phase 16D helper delegates `WM_CLOSE` to `DefWindowProcW`, which owns the ordinary `WM_CLOSE` to `DestroyWindow` transition while its custom `WM_DESTROY` handling keeps the process alive for the background-state assertion.

`NativeWorkAreaSync` runs mutations for one reservation ID in issue order. A newer generation suppresses stale publication, but the queued operation still establishes the latest native state after an older in-flight call returns. Disposal waits for queued mutations before unregistering the remaining active IDs, so teardown reaches native quiescence.

Shell Recovery opens the `default` desktop with read access and passes that handle to `EnumDesktopWindows`. This finds Explorer taskbars when the recovery process runs on another desktop in the same window station. If the default desktop cannot be opened, the tool retains current-desktop enumeration as a restricted-environment fallback; it does not switch desktops or elevate privileges.

## Consequences

Shared tabs preserve the minimum hit-target height and prevent label words from splitting at increased text scales. Rapid AppBar updates may wait behind an in-flight mutation for the same ID, while unrelated reservation IDs remain independent. Shell Recovery can inspect Explorer from a non-default runner desktop without changing the process or thread desktop. Application close requests retain normal Windows data-loss protections.

## Alternatives considered

- Force-closing the target window or terminating its process after a timeout was rejected because it can discard unsaved application state.
- Increasing the AppBar convergence timeout was rejected because it would mask, rather than remove, stale native completion races.
- Enumerating only the current desktop was rejected because automated runners can execute outside the Explorer desktop.

## Testing

Focused Vitest coverage pins the Home fixtures and token expectation, generated tab CSS, and rapid AppBar update ordering. Rust tests and a live recovery `check` cover the recovery executable. The real Phase 16D lifecycle acceptance exercises `stopped → background → running → background → stopped` through the native bridge and a real Win32 helper window.
