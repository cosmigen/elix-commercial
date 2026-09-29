# `@deepseek-ai/dsh-shell-layout`

Authoritative ELIX OS Shell Layout capability owning per-monitor shell reservations, maximized-window work area policy, deterministic edge conflict handling, Home exclusion publication, and native Windows AppBar synchronization.

## Architecture & Ownership Chain

ELIX enforces a strict separation of concerns across the shell pipeline:

```text
Windows Context
     ↓
physical monitor topology / DPI / native work areas
     ↓
Shell Layout
     ↓
shell reservation policy & computed work areas
     ↓
Surface Core
     ↓
native shell surfaces (HWND / WebView2)

And for desktop items:

Shell Layout
     ↓
source-neutral exclusion geometry
     ↓
Home Layout Engine
```

### Separation of Responsibilities

1. **Windows Context (`ctx.windowsContext`)**:
   Owns physical monitor discovery, virtual-screen topology, per-monitor DPI, foreground window tracking, and fullscreen detection.
2. **Shell Layout (`ctx.shellLayout`)**:
   Owns shell geometry reservations (edge-docked and floating), per-monitor work-area calculation for maximized windows, deterministic multi-surface edge conflict resolution, and publication into Home exclusion zones.
3. **Surface Core (`ctx.surface`)**:
   Owns Win32 HWND allocation, WebView2 composition, z-order stacking, and physical virtual-screen surface boundaries.
4. **Home (`ctx.home`)**:
   Owns desktop item and widget placement on the desktop grid; consumes source-neutral exclusion zones published by Shell Layout.
5. **Future Dock / Status Bar**:
   Own their visual presentation, user interaction, and register their geometry into Shell Layout through generic, source-neutral APIs.
6. **Native Core (`elix-native-core`)**:
   Owns low-level Win32 `SHAppBarMessage` execution (`ABM_NEW`, `ABM_QUERYPOS`, `ABM_SETPOS`, `ABM_REMOVE`), ensuring clean restoration of desktop work area across process lifecycles and supervisor recoveries.

## Reservation Model

Reservations are source-neutral and typed:

```ts
interface ShellReservation {
  id: string
  monitorId: string
  ownerId: string
  kind: 'edge' | 'floating'
  rect: PhysicalPixelRect
  edge?: 'top' | 'bottom' | 'left' | 'right'
  affectsWorkArea: boolean
  affectsHomeLayout: boolean
  visible: boolean
  priority: number
  hwnd?: number
}
```

- **Edge Reservations**: Dock to `top`, `bottom`, `left`, or `right`. Geometry is per-monitor in canonical physical virtual-screen pixels.
- **Floating Surfaces**: Claim their exact rectangle without reserving an entire edge strip. They block Home items via exclusions without altering the Windows work area unless explicitly configured.
- **Visibility**: Hidden reservations (`visible: false`) suspend work-area and Home exclusions. Showing them restores reservations deterministically.
- **Deterministic Conflict Handling**: Multiple surfaces claiming the same edge are sorted by `priority` descending, with stable lexicographical `id` tie-breaking to eliminate registration-order non-determinism.
- **Native Update Ordering**: AppBar mutations for one reservation ID execute serially, so an older native completion cannot overwrite or remove the latest desired geometry.

## Home Layout Engine Integration

When an active reservation with `affectsHomeLayout: true` is registered or updated, Shell Layout publishes an exclusion zone into `HomeLayoutEngine.registerExclusionZone()`. Covered desktop items automatically reconcile to the nearest free grid slot and persist.

## Stale Disposer Safety

Every registration returns a `ShellReservationHandle` with a safe `dispose()` method. A disposer from an older registration cannot remove a newer replacement with the same ID.

## Known Limitations and Deferred Work

- Shell Layout computes authoritative work-area policies and synchronizes with Windows AppBar APIs; however, ELIX does not permanently replace Windows Explorer.
- Dock and Status Bar visual user interfaces belong to Phase 11+.
- WorkerW shell desktop replacement and full takeover are deferred to future phases.
