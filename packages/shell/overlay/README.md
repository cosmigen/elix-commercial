# @deepseek-ai/dsh-shell-overlay

Authoritative reusable **Overlay / Popup Core** for ELIX OS.

Overlay Core owns the lifecycle, placement, monitor selection, stacking, and dismissal policies for temporary shell surfaces (context menus, flyouts, anchored panels, previews, submenus, transient AI panels).

## Subsystem Architecture & Responsibilities

```text
Home / Dock / Status Bar / Quick Settings (Feature Plugins)
                         ↓
                    ctx.overlay (Overlay Core)
                         ↓
                    Surface Core (Phase 7)
                         ↓
                    Native Core (Phase 5)
                         ↓
                    Windows OS
```

- **Overlay Core (`ctx.overlay`)**: Owns temporary shell surface placement, monitor selection, flip/shift/clamp mechanics, focus policy, dismissal triggers (outside-click, Escape, lost focus), stacking order, parent-child submenu nesting, and safe owner cleanup.
- **Surface Core (`ctx.surface`)**: Owns native Win32 HWND allocation, WebView2 hosting, Per-Monitor V2 DPI handling, and ready-before-show synchronization.
- **Windows Context (`ctx.windowsContext`)**: Owns authoritative hardware display topology, physical pixel bounds, native work areas, and foreground window tracking.
- **Shell Layout (`ctx.shellLayout`)**: Owns permanent shell geometry and work-area reservations (AppBar / Dock / Status Bar). Popups float above work areas without registering permanent work areas.
- **Feature Plugins**: Own domain logic, actions, data models, and renderer markup.

## Core Concepts

### 1. Definition vs Instance

- **Overlay Definition** (`OverlayDefinition`): Registered persistently by a plugin. Declares default dimensions, placement preferences, focus policy, dismissal policy, stacking group, and renderer specification.
- **Overlay Instance** (`OverlayInstance`): Ephemeral representation of an open or opening popup on screen. Tracks active physical bounds, effective placement, generation token, parent/child relationships, and underlying native surface.

### 2. Anchor Coordinate Space & Resolution

Anchors represent the screen reference point where popups anchor:
- `point`: Virtual-screen physical pixel coordinates `{ x, y }`.
- `rect`: Virtual-screen physical pixel rectangle `{ x, y, width, height }`.
- `surface-relative`: Relative pixel offset inside an existing native surface, resolved dynamically to physical virtual-screen coordinates.

### 3. Deterministic Placement Engine

Given an anchor, target size, and available bounds (from `workArea` or `monitorBounds`), placement is computed in strict deterministic sequence:
1. **Primary Alignment**: Evaluates requested direction (`top`, `bottom`, `left`, `right`, `auto`, and `-start`/`-end`/center variants).
2. **Auto Selection**: If `auto` is specified, checks space on all sides and chooses the best candidate (defaulting to bottom-start).
3. **Flip**: If the primary side overflows the monitor boundary and the opposite side has sufficient room, flips to the opposite side.
4. **Shift**: Slides the popup along the cross-axis to prevent clipping at the monitor edges.
5. **Clamp**: Ensures the popup never extends outside usable monitor bounds.

### 4. Focus Policies

- `activate`: Popups that require keyboard navigation (e.g. context menus) gain foreground activation.
- `no-activate`: Popups that should not steal focus from current foreground apps (e.g. hover cards, dock previews) map to `WS_EX_NOACTIVATE / MA_NOACTIVATE`.

### 5. Dismissal Policies

- **Outside Click**: Event-driven outside-click detection dismissing open popups when clicks occur outside their bounding hierarchy.
- **Escape Key**: Closes the topmost eligible overlay. In parent-child nested menus, child submenus are closed first.
- **Lost Focus**: Optional dismissal when an activating popup loses foreground focus.
- **Monitor Removal**: Overlays on disconnected monitors close or reposition safely.
- **Owner Unload**: Unloading an owner plugin immediately terminates active overlays and unregisters definitions with zero orphan HWNDs.

### 6. Parent-Child Submenus & Stacking

- **Nesting**: Submenus declare a `parentInstanceId`. Closing a parent automatically closes all descendants depth-first. Closing a child leaves the parent open.
- **Cycle Prevention & Depth Limit**: Hierarchy validation prevents cyclic relationships and enforces `maxNestingDepth` (default 10).
- **Exclusive Groups**: Multiple flyouts sharing an exclusive group (e.g. Wi-Fi flyout vs Battery flyout) automatically close previous siblings when opened.

### 7. Native Host Recovery Policy

- `close` (default): Ephemeral context menus close on native host restart.
- `recreate`: Persistent flyouts restore and recreate native surfaces after native supervisor recovery.

## Public Service API

```typescript
// Register & manage definitions
const unregister = ctx.overlay.register(definition: OverlayDefinition)
ctx.overlay.unregister(id: string): boolean
ctx.overlay.unregisterByOwner(ownerId: string): readonly string[]
ctx.overlay.cleanupOwner(ownerId: string, options?: OverlayCloseOptions): Promise<OwnerCleanupResult>
ctx.overlay.getDefinition(id: string): OverlayDefinition | undefined
ctx.overlay.listDefinitions(): readonly OverlayDefinition[]

// Instance lifecycle
const instance = await ctx.overlay.open(options: OverlayOpenOptions)
await ctx.overlay.close(instanceId: string, options?: OverlayCloseOptions): Promise<boolean>
await ctx.overlay.closeAll(options?: OverlayCloseOptions): Promise<number>
await ctx.overlay.closeByOwner(ownerId: string, options?: OverlayCloseOptions): Promise<number>

// Queries
ctx.overlay.getInstance(instanceId: string): OverlayInstance | undefined
ctx.overlay.getActive(): readonly OverlayInstance[]
ctx.overlay.getTopmost(filter?: (inst: OverlayInstance) => boolean): OverlayInstance | undefined

// Reposition & Dismissal
await ctx.overlay.reposition(instanceId: string, newAnchor?: OverlayAnchor): Promise<OverlayInstance>
await ctx.overlay.notifyEscapeKey(): Promise<string | undefined>
await ctx.overlay.notifyOutsideClick(point?: OverlayPoint, hitSurfaceId?: string): Promise<readonly string[]>

// Subscriptions & Teardown
const unsubscribe = ctx.overlay.subscribe(listener: (event: OverlayChangeEvent) => void): () => void
await ctx.overlay.dispose(): Promise<void>
```

## Known Limitations

1. Physical virtual-screen coordinates are authoritative; cross-DPI popup repositioning relies on Windows Context Per-Monitor V2 updates.
2. Web renderers are restricted to loopback HTTP(S) and `about:blank` for local security.
