# Phase 18A — Windows-backed Spaces / Virtual Desktop Adapter

## Scope correction

Phase 18A is the complete Windows-backed Spaces authority, not merely the documented `IVirtualDesktopManager` read surface. The documented provider remains an important fallback, but the phase is not complete until ELIX can enumerate, switch, create, remove, rename, move arbitrary third-party application windows, and observe desktop changes on the target Windows build.

Window Registry remains the sole `WindowId` and native-window lifetime authority throughout both providers.

## Why two providers are required

Microsoft's documented `IVirtualDesktopManager` reliably supports cross-process membership reads:

- query the virtual-desktop GUID hosting a top-level window;
- ask whether a top-level window is on the current virtual desktop.

The documented interface exposes `MoveWindowToDesktop`, but real Windows acceptance showed `E_ACCESSDENIED` when ELIX targeted a Notepad window owned by another process. It also does not expose complete desktop enumeration, switching, creation/removal/rename, or desktop notifications.

Therefore Phase 18A uses a dual-provider design:

```text
                         SpacesService
                              |
                capability-qualified runtime selection
                    +---------+---------+
                    |                   |
             Shell provider        Public fallback
      windows-shell-virtual-       windows-public-
             desktop               virtual-desktop-manager
                    |                   |
       enumerate/current/name      membership by window
       switch/create/remove        is-on-current
       rename/move external        stable fallback
       native notifications
                    |
          pinned winvd adapter
                    |
      undocumented Explorer/Shell COM
```

The Shell implementation is isolated because its underlying COM interfaces are not a Microsoft-supported public contract and can change across Windows builds. The public provider is never weakened to accommodate it.

## Shell runtime qualification

The richer provider is enabled only when a live `spaces/shellSnapshot` probe returns:

- at least one desktop;
- unique, non-`GUID_NULL` desktop identities;
- a current desktop present in the enumerated set;
- coherent desktop indices.

A successful probe exposes `provider: windows-shell-virtual-desktop` and complete capabilities. A probe or later Shell failure falls back to `windows-public-virtual-desktop-manager` rather than crashing Spaces or inventing success.

While in fallback, Spaces periodically re-probes the Shell provider so Explorer recovery or a transient COM failure can upgrade the service again.

## Shell backend implementation

`native/crates/elix-native-core/src/shell_spaces.rs` wraps a pinned `winvd = 0.0.49` backend and exposes guarded native primitives for:

- complete desktop enumeration, including empty desktops;
- current desktop;
- switch desktop;
- create desktop;
- remove desktop with explicit fallback;
- rename desktop;
- move an arbitrary application window through the Shell application-view path;
- native desktop notifications.

The dependency is pinned deliberately. An upgrade is an ABI audit event, not a routine floating dependency update.

## Window mutation safety

`moveWindowToSpace(windowId, spaceId)` keeps the existing Window Registry safety contract:

1. resolve a live `APPLICATION` `WindowId`;
2. validate HWND/PID/TID/process-creation/class evidence;
3. require the destination `SpaceId` to be in the current complete Shell snapshot;
4. invoke the Shell application-view move path;
5. verify committed membership through documented `IVirtualDesktopManager`;
6. revalidate the Window Registry lifetime after native I/O;
7. reject concurrent moves for the same `WindowId`.

A recycled HWND, `GUID_NULL`, fabricated Space GUID, stale Space, protected Shell window, or unverifiable process lifetime never becomes mutation authority.

## Snapshot semantics

With a qualified Shell provider:

- `completeness: complete-shell-enumeration`;
- empty desktops are represented;
- each Space can expose Windows index and name;
- `currentSpaceId` is the actual Shell current desktop;
- queryable Window Registry application memberships are attached to their desktop;
- unresolved application windows remain explicit in `unresolvedWindowIds`.

With the public fallback:

- `completeness: observed-application-windows`;
- only desktop GUIDs observed through queryable application windows are represented;
- mutation/lifecycle capabilities are `false`.

## Change detection

The native Shell backend registers virtual-desktop notifications. Instead of duplicating desktop authority in JavaScript, native events increment a generation counter. Spaces polls the tiny notification status and schedules a complete reconciliation only when that generation changes.

If native notification registration cannot be established but Shell enumeration remains usable, the provider remains functionally rich while topology/current-desktop fingerprints are polled. `nativeNotifications` accurately reports whether the native listener is active.

## Runtime composition

Windows runtime order remains:

`windows-context -> surface -> window-registry -> spaces -> window-preview -> window-control -> shell-layout -> window-placement -> app-registry -> process-observation -> application-runtime`

Spaces consumes stable window identity but does not own monitor topology, placement, preview, or application lifecycle state.

## Capability matrix

| Capability | Shell provider | Public fallback |
| --- | --- | --- |
| Window -> Space membership | yes | yes |
| Is window on current Space | yes | yes |
| Enumerate every Space, including empty Spaces | yes | no |
| Actual current Space | yes | observed only |
| Switch current Space | yes | no |
| Create Space | yes | no |
| Remove Space with fallback | yes | no |
| Rename Space | yes | no |
| Move arbitrary third-party application window | yes | no |
| Native Space-change notifications | runtime-qualified | no |

## Existing live evidence

The public foundation has already been proven on real Windows:

- two real virtual desktops were observed simultaneously;
- current Space was derived correctly;
- Notepad on Desktop 2 was reported with `current=false` and a distinct GUID;
- `GUID_NULL` is fenced as unresolved;
- documented cross-process move reached Windows and returned access denied, establishing the need for the Shell mutation provider.

This evidence remains valid fallback-provider coverage. It is not the full Phase 18A acceptance gate.

## Full Phase 18A freeze gate

Do not freeze or merge Phase 18A until all of the following pass on the target Windows build:

- Shell provider runtime probe reports full capabilities;
- complete desktop enumeration includes an empty temporary desktop;
- create -> rename -> switch -> switch back -> remove lifecycle smoke passes;
- Notepad or another ordinary third-party application moves between Spaces and membership verifies;
- external Task View / `Win+Ctrl+Left/Right` changes are detected and reconciled;
- public fallback still reports correct membership when the Shell provider is unavailable;
- `pnpm exec vitest run packages/core/spaces/tests packages/bundle/windows-runtime/tests/composition.spec.ts`;
- `pnpm exec tsc -b tsconfig.host.json --pretty false`;
- `pnpm run build`;
- targeted rustfmt for Phase 18A native files;
- `cargo test --manifest-path native/Cargo.toml -p elix-native-core`;
- `cargo build --manifest-path native/Cargo.toml -p elix-native-bridge`;
- regenerated Rust/pnpm lockfiles are reviewed and committed;
- final Phase 17 regression remains green.

Only after these gates is Phase 18A frozen. The next roadmap phase is **18B — Global Input & Shell Navigation**.
