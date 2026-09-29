# Agent Note: Phase 9 Intent Router and File Operations

Status: implemented

## Problem

ELIX Home, Launcher, and future shell surfaces required a decoupled, authoritative mechanism to convert user interactions into real OS actions without bypassing capability boundaries, embedding process launch logic inside UI renderers, or corrupting existing App Registry and Shell Namespace state. Direct manipulation of filesystem paths without validation risked path traversal, control character injection, recursive directory nesting loops, and silent failure modes.

## Decision

We introduce `@deepseek-ai/dsh-intent-router` (`@elix/plugin-intent-router`) as a dedicated Cordis service (`ctx.intentRouter`). The Intent Router serves as the unified routing and action coordination authority. It defines a strongly typed intent schema (`open-app`, `open-file`, `open-folder`, `open-shortcut`, `reveal-in-folder`, `rename`, `delete`, `move`, `copy`, `create-folder`, `resolve-target`, and `get-available-actions`) returning structured result envelopes with deterministic status codes (`success`, `invalid-request`, `not-found`, `permission-denied`, `already-exists`, `unsupported`, `native-failure`).

Strict input validation enforces valid Windows path constraints, forbids relative traversal sequences (`..`), strips control characters, validates base filenames against Windows reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`), and verifies that directory move/copy operations never nest a folder into itself or its own descendants.

The router acts as an action coordinator across existing capability owners rather than reinventing them: application activation delegates to App Registry (`ctx.appRegistry`), shell item lookup and resolution queries Shell Namespace (`ctx.shellNamespace`), shortcut target resolution recursively traverses `.lnk` targets with cycle detection and a bounded recursion depth of 16, and file operations (`rename`, `move`, `copy`, `createFolder`, `delete`) execute through filesystem primitives. Permanent deletion requires explicit confirmation (`permanent: true`), while soft deletion returns `unsupported` until a native IFileOperation Recycle Bin capability is mounted.

A `DesktopProjector` subsystem synchronizes physical Desktop directory items into Home screen slots using nearest-free-slot placement, reconciling additions, renames, updates, and removals via live Shell Namespace change observation.

## Alternatives considered

**Embed action logic in Home renderer or UI components.** Having Home or WebView2 components launch processes directly would violate capability boundaries, duplicate Win32 execution logic across UI views, and prevent headless testing or non-renderer shell components (e.g. Launcher or keyboard shortcuts) from reusing action handling.

**Implement custom Win32 process spawning inside Intent Router.** Shell item launching and app execution are already owned by Native Core and App Registry. Intent Router coordinates targets and options but delegates the low-level spawn to existing launchers.

**Silent Recycle Bin fallback to permanent deletion.** Silently deleting files when soft deletion is requested would lead to irreversible data loss. The router explicitly rejects soft deletion requests as `unsupported` until Phase 11+.

## Consequences

UI components emit high-level intents and receive typed results without knowledge of underlying Win32 APIs, COM apartment threading, or process mechanics. Capability boundaries are strictly preserved. The Intent Router introduces no new UI components, leaving Dock, Status Bar, and context menus for subsequent phases.
