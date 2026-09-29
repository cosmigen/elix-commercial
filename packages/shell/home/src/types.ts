/**
 * Core geometric and foundational types for the ELIX Home Screen subsystem.
 *
 * @module @deepseek-ai/dsh-home/types
 */

/** Two-dimensional coordinate point in pixels. */
export interface Position {
  x: number
  y: number
}

/** Two-dimensional dimension in pixels. */
export interface Size {
  width: number
  height: number
}

/** Bounding rectangle in monitor coordinate space. */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Screen edges that can host external reserved regions (e.g. Dock, Status Bar). */
export type Edge = 'top' | 'bottom' | 'left' | 'right'

/**
 * An external region reserved on a monitor by other shell plugins (e.g. Dock or Status Bar).
 * HomeLayoutEngine excludes these areas when computing the available desktop work area.
 */
export interface ReservedRegion {
  /** Unique reservation identifier. */
  id: string
  /** Screen edge on which the reservation is anchored. */
  edge: Edge
  /** Thickness of the reserved strip in physical or logical pixels. */
  size: number
  /** Priority when multiple regions claim the same edge (higher priority claims outer strip). */
  priority: number
  /** Specific monitor identifier, or 'all' for every connected display. */
  monitorId: string
  /** Full calculated bounding rectangle in monitor coordinate space. */
  rect: Rect
}

/** Grid placement and snapping configuration. */
export interface GridConfig {
  /** Horizontal cell spacing in pixels. */
  cellWidth: number
  /** Vertical cell spacing in pixels. */
  cellHeight: number
  /** Inter-cell gap in pixels. */
  gap: number
  /** Minimum margins from the available work area boundaries. */
  padding: {
    top: number
    bottom: number
    left: number
    right: number
  }
}

/** General Home surface user preferences. */
export interface HomePreferences {
  /** Base icon size in pixels (44 to 96, default 64). */
  iconSize: number
  /** Whether item name labels are visible beneath desktop icons. */
  showLabels: boolean
  /** Whether desktop grid snapping is strictly enforced. */
  snapToGrid: boolean
  /** Whether auto-alignment on monitor change is enabled. */
  autoAlign: boolean
}

/**
 * Generic external exclusion zone on a monitor where Home-managed items may not be placed.
 * Produced by external shell surfaces (e.g. Dock, Status Bar, temporary popups).
 * Home treats these regions strictly as opaque layout colliders/obstacles.
 */
export interface ExclusionZone {
  /** Unique exclusion identifier. */
  readonly id: string
  /** Target monitor identifier, or 'all' if applicable to every display. */
  readonly monitorId: string
  /** Obstacle bounding rectangle in monitor coordinate space. */
  readonly rect: Rect
}

/**
 * Conceptual context for Home screen layout computation.
 * Bridges monitor bounds, external exclusion zones, reserved edge regions (e.g. Dock, Status Bar),
 * and desktop items residing on that display.
 */
export interface HomeLayoutContext {
  /** Physical bounds of the target display monitor. */
  readonly monitorBounds: Rect
  /** Generic external exclusion zones acting as layout obstacles on this display. */
  readonly exclusionZones: readonly ExclusionZone[]
  /** Edge regions reserved on this monitor by other shell plugins (e.g. Dock, Status Bar). */
  readonly reservedRegions: readonly ReservedRegion[]
  /** Desktop items placed on this monitor. */
  readonly desktopItems?: readonly unknown[] | undefined
  /** Usable desktop bounds remaining after subtracting reserved regions. */
  readonly availableBounds: Rect
}

/** Target entity for right-click / context menu interactions. */
export type ContextMenuTargetType = 'desktop' | 'item' | 'folder' | 'widget'

/**
 * Context menu interaction intent request.
 * Dispatched by Home when the user right-clicks on the desktop or an item.
 * Visual presentation is deferred to the future overlay/dialog subsystem.
 */
export interface ContextMenuRequest {
  readonly targetType: ContextMenuTargetType
  readonly targetId?: string | undefined
  readonly position: Position
  readonly monitorId: string
}

/** External file or payload dragged onto the desktop from the OS. */
export interface ExternalDropPayload {
  readonly name: string
  readonly type?: 'shortcut' | 'app shortcut' | 'file' | 'folder' | 'widget' | 'system' | 'system shortcut' | undefined
  readonly path?: string | undefined
  readonly target?: string | undefined
  readonly metadata?: Record<string, unknown> | undefined
}
