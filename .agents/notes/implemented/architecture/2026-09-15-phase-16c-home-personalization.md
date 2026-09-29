# Phase 16C — Home Personalization, Themes, and Wallpapers

## Ownership

Phase 16C extends the existing Home wallpaper authority instead of creating another theme or persistence stack.

- `WallpaperManager` remains the durable wallpaper catalogue and display-preference owner.
- `UiFoundationService` from Phase 16B remains the shell appearance/accessibility authority.
- `HomePersonalizationCoordinator` only coordinates transactions that span those two authorities.
- `HomePersistenceManager` remains the sole durable Home-state writer.
- `HomeRendererHost` remains the renderer publication and tokenized local-media transport.

## Wallpaper model

The wallpaper catalogue is global. Top-level wallpaper display settings are the default used by every display. Stable Windows Context monitor IDs can override wallpaper selection, fit, blur, saturation, and dim independently. Removing a monitor does not delete its durable override, so reconnect can recover the same personalization. A monitor-specific preview is cancelled if that monitor disappears.

Supported local wallpaper media stays closed to renderer-supported image/video formats. User-provided image/video wallpaper sources must be absolute local paths or `file://` URLs; arbitrary remote URLs and unsupported file extensions are rejected before renderer projection.

## Preview and preset model

Wallpaper preview state is held only in memory by `HomePersonalizationCoordinator`; `buildPersistentSnapshot()` always reads committed `WallpaperManager` state. A save triggered elsewhere in Home therefore cannot accidentally persist an unconfirmed wallpaper preview.

Normal previews expire after 15 seconds unless kept. Revert, owner disappearance, confirmation disappearance, target-monitor loss, and Home teardown also discard the transient wallpaper state. Appearance changes delegate to the Phase 16B Keep/Revert transaction.

Coordinated wallpaper + shell-appearance presets are global. Monitor-scoped previews intentionally allow wallpaper changes only because Phase 16B appearance preview is global rather than monitor-scoped. This prevents a per-monitor wallpaper UI from misleadingly changing the entire shell theme.

## Renderer behavior

`HomeService` resolves the effective wallpaper independently for each monitor before creating its renderer snapshot. Wallpaper image/video asset requests resolve against the same monitor-specific effective wallpaper. Preview publication updates existing Home renderers in place; Surface Core HWND ownership is unchanged.

## Persistence and compatibility

Per-monitor overrides are an optional nested field inside the existing wallpaper preferences object, so the Home persistence schema remains v2. Old states without monitor overrides continue to resolve through the top-level default display preferences.

## Explicit deferrals

- Space-specific personalization waits for Phase 18 stable Windows Virtual Desktop identities.
- Final Settings/file-picker UX is not owned by this foundation phase; Phase 16C exposes validated APIs and an acceptance harness.
- Arbitrary third-party live-wallpaper scripts remain outside Home's privileged renderer trust boundary.
