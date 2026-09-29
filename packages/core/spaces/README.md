# @deepseek-ai/dsh-spaces

Phase 18A Spaces is ELIX's capability-qualified Windows virtual-desktop authority.

## Architecture

Spaces owns one public contract but has two Windows backends with different trust boundaries:

1. **Documented fallback — `windows-public-virtual-desktop-manager`**
   - uses Microsoft's documented `IVirtualDesktopManager`;
   - reliably queries a top-level window's desktop GUID and whether it is on the current desktop;
   - remains available if the richer Windows Shell provider fails.

2. **Runtime-qualified Shell provider — `windows-shell-virtual-desktop`**
   - uses a pinned `winvd` adapter around Explorer's internal virtual-desktop COM surface;
   - is isolated from the documented provider because these Shell interfaces are undocumented and Windows-build-sensitive;
   - is enabled only after a live enumeration/current-desktop probe returns a coherent non-empty desktop set;
   - exposes complete desktop enumeration, switching, creation, removal, rename, arbitrary application-window movement, and native desktop-change observation.

The public `IVirtualDesktopManager::MoveWindowToDesktop` method is intentionally not used as ELIX's arbitrary-window mutation path. Real Windows acceptance showed `E_ACCESSDENIED` for a Notepad window owned by another process. The Shell provider instead moves the Shell application view and verifies the committed membership through the documented read path.

## Authority and identity

Spaces consumes stable `WindowId` values from Window Registry. Raw HWND/PID/TID/process-creation/class evidence is resolved only at the native boundary. Consumers never receive COM objects or own HWND authority.

Every external-window mutation:

- accepts only a live Window Registry `APPLICATION` window;
- sends complete HWND/PID/TID/process-creation/class lifetime evidence;
- validates the target before Shell mutation;
- re-queries documented desktop membership afterward;
- re-fences the Window Registry lifetime after native I/O;
- rejects stale/recycled windows rather than operating on reused HWNDs.

`SpaceId` remains an opaque branded `space:<guid>` identity. `GUID_NULL` is never accepted as a real Space.

## Snapshot semantics

When the Shell provider qualifies, `SpacesSnapshot.completeness` is `complete-shell-enumeration`. Empty desktops are included, each Space can expose its Windows index and name, and `currentSpaceId` comes from the Shell's actual current desktop.

When the Shell provider is unavailable, Spaces automatically falls back to the documented provider. The fallback snapshot is `observed-application-windows`: only desktops discoverable through queryable application windows appear, and unsupported mutation capabilities become `false`.

Window Registry `APPLICATION` windows whose documented membership cannot be resolved are listed in `unresolvedWindowIds`; ELIX never invents a desktop assignment.

## Full Phase 18A API

- `getCapabilities()`
- `getSnapshot()` / `getObservedSpaces()` / `getCurrentSpaceId()`
- `getWindowSpace(windowId)`
- `isWindowOnCurrentSpace(windowId)`
- `moveWindowToSpace(windowId, spaceId)`
- `switchSpace(spaceId)`
- `createSpace(name?)`
- `removeSpace(spaceId, fallbackSpaceId?)`
- `renameSpace(spaceId, name)`
- `refresh()`
- `subscribe(listener)`

All mutations are capability-gated. No provider is allowed to fake success.

## Native change detection and recovery

The Shell backend registers Windows virtual-desktop notifications through `winvd`. Native events increment a generation counter inside the native host. The TypeScript authority polls that tiny generation status (default 400 ms) and performs a full reconciliation only when the generation changes. This keeps native notifications authoritative without adding a second unmanaged desktop tracker to the JS process.

If Explorer/Shell COM becomes unavailable or its internal ABI no longer matches the current Windows build, the next reconciliation drops back to the documented provider. While in fallback, Spaces periodically re-probes the Shell provider and upgrades again when it becomes coherent.

## Windows acceptance

Build the current native bridge and inspect the active provider:

```powershell
pnpm demo:phase18a
```

A fully qualified machine should report:

```text
provider: windows-shell-virtual-desktop
moveWindow: true
enumerateSpaces: true
switchSpace: true
createSpace: true
removeSpace: true
renameSpace: true
nativeNotifications: true
completeness: complete-shell-enumeration
```

Run the non-destructive lifecycle smoke. It creates one temporary Space, renames it, switches into it, switches back, removes it with the original current Space as fallback, and attempts cleanup if any intermediate step fails:

```powershell
pnpm demo:phase18a -- --shell-smoke
```

For arbitrary external-window movement, keep a uniquely named normal app on another desktop and return to the destination desktop:

```powershell
pnpm demo:phase18a -- --move-current-title "notepad_test.txt"
```

For native external-change acceptance, start a watch and then use Windows Task View or `Win+Ctrl+Left/Right` while it is running:

```powershell
pnpm demo:phase18a -- --watch 20
```

The runner also supports explicit `--switch`, `--create`, `--rename`, and `--remove` commands for targeted debugging.

Phase 18A must not be frozen until the richer provider passes lifecycle, arbitrary-window move, external-change, fallback, TypeScript, Rust, and regression gates on the target Windows build.
