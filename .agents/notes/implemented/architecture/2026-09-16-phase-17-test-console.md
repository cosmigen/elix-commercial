# Phase 17 interactive acceptance console

Date: 2026-09-16

## Context

Phase 17 combines live native window previews with reversible manual window placement. Existing acceptance runners exercised those capabilities from terminal-driven scripts, but final Windows verification also needs repeated visual confirmation, topology changes, destructive lifetime checks, and manual interaction without remembering individual commands.

## Decision

Add a developer-only Phase 17 Test Console that boots the same production Cordis services and Rust native host used by the Phase 17 implementation. Surface Core hosts the dashboard and two transparent preview destinations. The dashboard calls the public Window Preview, Window Control, Windows Context, Shell Layout, Window Registry, and Window Placement service APIs; it does not introduce a parallel control path or expose raw HWND/native preview handles to the UI.

The preview budget is intentionally configured to two live relationships so the dashboard can verify deterministic priority eviction. A dedicated spawned Notepad provides a disposable default target, while Window Registry selection allows real application coverage. Placement checks include every public zone, reversible restore, sizing constraints, maximized state, conflict fencing, cancellation, stale lifetime rejection, monitor moves, and named layouts. Monitor/DPI/orientation and live-pixel correctness remain explicit user confirmations because synthetic assertions cannot establish those visual outcomes.

## Resource ownership

The HTTP server listens only on an ephemeral `127.0.0.1` port. WebView2 user-data folders and the Notepad input document live under a random operating-system temp directory. Normal exit releases preview leases before destroying their destination surfaces, disposes the Cordis fiber and native bridge, terminates the console-owned Notepad if still alive, closes the listener, and removes temporary state. SIGINT and SIGTERM use the same teardown path.

## Scope

This console is verification tooling, not a shipped ELIX shell surface. It does not change Phase 17A/17B production semantics and does not replace focused Vitest coverage, typechecking, build gates, or the final manual Windows regression pass.
