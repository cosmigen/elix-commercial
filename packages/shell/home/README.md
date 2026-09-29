# `@deepseek-ai/dsh-home`

`ctx.home` owns the durable ELIX desktop model and projects it into one React-rendered WebView2 Home surface per Windows Context monitor. Home owns items, folders, widget placeholders, selection, marquee and drag semantics, layout, wallpaper preferences, personalization presets, and atomic persistence. It does not own HWNDs, WebView2 controllers, monitor discovery, launch execution, shell overlays, or arbitrary widget/live-wallpaper code.

## Composition

Production Home requires `ctx.windowsContext`, `ctx.surface`, and `ctx.webServer`. Windows Context supplies stable monitor IDs, physical virtual-screen bounds, and per-monitor DPI. Home creates each surface through Surface Core with `noActivate`, bottom z-order, taskbar omission, full physical monitor bounds, and ready-before-show. An explicit `initialMonitors` fixture is available only for deterministic tests.

The WebView loads a tokenized loopback URL registered with the shared webserver. React server rendering produces the document and state projections; a dependency-free browser adapter handles transient pointer feedback and posts a bounded discriminated intent union back to Home. Server-sent events replace renderer projections after authoritative state changes. The renderer receives labels, geometry, selection, presentation fields, and tokenized asset URLs, but never shortcut targets or local media paths.

## Geometry and interaction

Home stores item, drag, reserved-region, and exclusion geometry in canonical physical virtual-screen pixels. Renderer coordinates are monitor-local CSS pixels and are converted with the Windows Context monitor origin and scale factor before Home evaluates selection, marquee, drag, collision, and grid snapping.

`HomeLayoutEngine.registerExclusionZone()` is the source-neutral publication API for future shell components. Rectangles are monitor-specific or global, may float away from an edge, and do not alter the Windows work area. Re-registering an ID replaces its rectangle; the old disposer cannot remove the replacement. When an exclusion covers existing root items, Home preserves their identities and moves only affected items with the existing nearest-free-slot algorithm, then persists the corrected positions.

## Wallpaper, personalization, and lifecycle

Wallpaper state supports static images, gradients/colors, compositor-backed video, and a closed set of ELIX-owned live CSS scenes. Local files are served through tokenized media endpoints with byte-range support. User-imported image/video wallpaper sources are restricted to absolute local paths or file URLs and the renderer's closed media-type allowlist. Video elements are muted, looped, inline, and release their source on replacement or unload.

The wallpaper catalogue is global, while stable Windows Context monitor IDs may hold independent wallpaper selection, fit, blur, saturation, and dim overrides. A monitor without an override follows the global wallpaper state. Disconnecting a monitor preserves its durable override for a later reconnect, but cancels an in-flight preview targeted at that display.

`HomePersonalizationCoordinator` is a transaction coordinator, not a second preference authority. Wallpaper ownership stays in `WallpaperManager`; normal shell appearance ownership stays in Phase 16B `UiFoundationService`. Built-in Home presets combine those existing authorities. Coordinated previews are transient and default to 15 seconds: wallpaper preview state is held only in memory while the appearance half delegates to UI Foundation's Keep/Revert transaction. Unkept previews therefore cannot enter Home's durable snapshot even if another Home change triggers a save. Keep commits through the existing authorities; Revert, owner disappearance, confirmation disappearance, monitor loss, and Home teardown restore the previous state.

Per-monitor wallpaper personalization is available in Phase 16C. Space-specific personalization is intentionally deferred until Phase 18 provides stable Windows Virtual Desktop identities. Arbitrary third-party live wallpaper scripts remain outside Home's trust boundary.

Surface hide, WebView unload, and native-host recovery drive explicit active, suspended, and disposed runtime states; the same control accepts later power-policy hints without introducing a system-capabilities service here.

Surface Core remains the sole native owner. Home awaits create, bounds, visibility, reload, and destroy operations; renderer reload reconstructs from Home state, while native-host recreation retains the logical Surface instance and re-establishes current-generation readiness. Teardown closes renderer streams and subscriptions before awaiting native surface destruction.

## Limitations

Home emits activation, folder-open, and context-menu requests but does not launch programs or present the final shared overlay UI. Widget content is a placeholder only. Dock, Status Bar, AppBar/work-area reservation, WorkerW attachment, arbitrary third-party scripts, window enumeration/control, fullscreen shell policy, and Space-specific personalization belong to later capabilities.
