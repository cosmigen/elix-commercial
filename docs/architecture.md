# ELIX OS Architecture

English | [中文](architecture.zh.md)

ELIX is a Windows shell platform built as a small Cordis-hosted TypeScript domain layer over an out-of-process Rust native substrate. It is not an agent harness: the model, tool, session, sandbox, and agent-runtime packages from the imported baseline are absent. Cordis remains only as the lifecycle and service-composition kernel for ELIX capabilities.

## System layers

```text
CLI / profile boot
        |
        v
Cordis service composition
        |
        +--> ctx.home --> tokenized React renderer
        +--> ctx.surface --> HWND / WebView2
        +--> ctx.windowsContext
        +--> ctx.shellNamespace
        +--> ctx.appRegistry
                     |
                     v
          TypeScript native adapters
                     |
              versioned NDJSON
                     |
                     v
            Rust Native Core host
                     |
              Win32 / COM / NTFS
```

The layers have separate ownership:

- TypeScript and Cordis own domain models, catalogs, reconciliation, service lifecycles, configuration, and public capability semantics.
- Rust owns low-level Win32, COM, monitor/DPI queries, window observation, filesystem notification, file identity, icon, shortcut, and process-launch operations.
- The bridge owns process isolation, protocol framing, generation fencing, backpressure, restart policy, and native observation-intent restoration.
- Surface Core owns native shell-window lifecycle; Home owns its renderer projection and desktop interaction model.

## Boot and composition

[`apps/cli`](../apps/cli/README.md) parses the invocation and boots a profile through [`packages/boot/app-boot`](../packages/boot/app-boot/README.md). A profile is a Cordis configuration tree assembled from the base bundle, profile-local configuration, machine-local overrides, and explicit command-line overlays. Cordis effects own service cleanup when the tree unloads.

[`packages/bundle/base`](../packages/bundle/base/README.md) is intentionally minimal. It supplies only the shared host facilities required by the current ELIX composition. Removed DeepSeek Harness capabilities are not architectural extension points for this product.

## Product capabilities

| Area | Package | Responsibility |
|---|---|---|
| Home | [`packages/shell/home`](../packages/shell/home/README.md) | Desktop state, layout, selection, folders, widget placeholders, wallpaper, persistence, renderer intents, and one projection per monitor. |
| Surface Core | [`packages/core/surface`](../packages/core/surface/README.md) | Authoritative HWND/WebView2 lifecycle, readiness, physical bounds, focus, z-order, recovery, and teardown. |
| Shell Namespace | [`packages/services/shell-namespace`](../packages/services/shell-namespace/README.md) | Authoritative files, folders, shortcuts, known folders, Desktop aggregation, stable item identity, catalog reconciliation, and normalized change events. |
| App Registry | [`packages/services/app-registry`](../packages/services/app-registry/README.md) | Installed-application discovery, identity, normalization, reconciliation, search, icons, cache, and launch semantics. |
| Windows Context | [`packages/core/windows-context`](../packages/core/windows-context/README.md) | Authoritative immutable monitor topology, physical-pixel geometry, per-monitor DPI, foreground application context, and fullscreen classification. |
| Native Core | [`native/`](phase-5-rust-native-core-architecture.md) and `packages/native/core` | Crash-isolated Win32/COM implementation and typed TypeScript adapters. |
| Web host | [`packages/host/webserver`](../packages/host/webserver/README.md) | Generic HTTP, upgrade, static-file, and index-transform routing without ELIX domain ownership. |
| Utilities | `packages/util/*` | Small shared primitives for identity, paths, atomic writes, timeouts, command execution, and launch environment capture. |

The stable service entry points are `ctx.home`, `ctx.surface`, `ctx.windowsContext`, `ctx.shellNamespace`, and `ctx.appRegistry`. Consumers depend on those service APIs, not on bridge methods or Win32 primitives. Windows Context fails explicitly when native Windows state is unavailable; catalog adapters may use documented TypeScript fallbacks without changing their service APIs.

## Windows Context authority

[`ctx.windowsContext`](phase-6-windows-context-architecture.md) is the only production authority for monitor, DPI, foreground-window, and fullscreen state. Rust captures complete physical-pixel snapshots and owns one event thread with WinEvent hooks and a hidden notification window; TypeScript validates and freezes replacements, assigns consumer revisions, retains the last known-good snapshot after capture failure, and isolates listeners. Home projects this service into its Phase 2 monitor model; only explicit test fixtures can bypass that projection.

## Home rendering and Surface Core

Home creates one Surface Core instance for each Windows Context monitor. Surface Core owns the HWND and WebView2 lifecycle, including current-generation ready-before-show and native-host restoration. Home retains the durable model across renderer reloads and native recreation, and reprojects that model through a tokenized loopback document plus bounded typed intents and server-sent state updates.

Home keeps canonical item and shell-exclusion geometry in physical virtual-screen pixels. Its renderer uses monitor-local CSS pixels; Home applies the authoritative monitor origin and DPI scale before selection, marquee, drag, collision, or snapping. Generic exclusion rectangles affect Home placement only and remain distinct from native surface bounds, input hitboxes, and Windows work-area reservation.

## Shell Namespace authority

Shell Namespace is the authority for filesystem-derived catalog state. Native watcher events are hints that cause directory enumeration and a catalog diff; they are not authoritative item mutations.

When native event precision is lost, the watcher enters a degraded state and emits one sticky container invalidation. Shell Namespace re-enumerates the container, applies the normalized diff, and completes reconciliation before the adapter rearms fine-grained native delivery. A failed reconciliation leaves the watcher degraded. This ordering also covers native buffer overflow, watcher failure, and host downtime.

## Native process and protocol

The TypeScript bridge launches one `elix-native-host.exe` process and communicates through bounded, versioned NDJSON request and event frames. Protocol version and package version are separate fields. Incompatible protocol versions fail the handshake.

Every host process has a monotonically increasing client-side generation. Pending requests and native watcher IDs belong to exactly one generation. Host termination rejects that generation's requests and immediately invalidates every native subscription binding before reconnect begins. Declarative watcher and Windows Context observation intent remains in TypeScript and is restored after a successful handshake; Windows Context then publishes a fresh `recovered` replacement. Generation checks reject old-process events before dispatch.

Responses and ordinary watcher events use bounded channels. Fine-grained events may be dropped under pressure, but one invalidation per affected subscription remains in sticky state until stdout writes it. This preserves eventual reconciliation without unbounded priority-event growth.

The supervisor uses bounded exponential backoff and a stability window. A handshake does not erase crash history; only a host that remains healthy for the configured window resets the restart budget. Repeated crash-flapping reaches a terminal `faulted` state.

Disposal first requests `bridge/shutdown`, waits a bounded interval for process exit, then terminates the child as a fallback and waits again. Watcher disposal signals the worker, cancels overlapped I/O with `CancelIoEx`, joins the thread, and releases handles through RAII.

## Phase boundaries

The implemented product foundation is divided as follows:

1. Phase 1: modular host baseline and composition.
2. Phase 2: Home domain model and abstract surface lifecycle.
3. Phase 3: Application Registry.
4. Phase 4: Shell Namespace and File Provider.
5. Phase 5: Rust Native Core and crash-isolated bridge.
6. Phase 6: authoritative Windows Context Core.
7. Phase 7: authoritative native Surface Core.
8. Phase 8: Home Renderer V1 over Surface Core.
9. Phase 9: Intent Router and File Operations.

The foundation stops at Intent Routing and File Operations. It does not include WorkerW integration, Dock, Status Bar, Windows AppBar reservation, Launcher UI, shared overlays, arbitrary widget or wallpaper execution, window manipulation, persistent Window Registry semantics, fullscreen shell policy, or an AI/agent runtime.

## Change placement

- Put domain behavior and public service semantics in the owning TypeScript service.
- Put raw Windows operations and resource ownership in `native/crates/elix-native-core`.
- Put RPC routing and bounded transport behavior in `native/crates/elix-native-bridge`.
- Put process supervision, generation ownership, and adapter translation in `packages/native/core`.
- Preserve `ctx.shellNamespace` and `ctx.appRegistry` when replacing or extending native implementations.
- Keep Home independent of Win32 handles and bridge protocol details; it consumes `ctx.surface`, while production monitor state is projected from `ctx.windowsContext`.

Tests follow the same split: Rust unit tests cover resource and watcher mechanics; bridge process tests cover protocol and recovery; Windows live tests cover actual Win32/COM behavior; service tests cover catalog and public capability semantics.
