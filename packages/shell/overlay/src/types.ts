/**
 * Authoritative types, models, and contracts for ELIX Overlay Core.
 *
 * Overlay Core owns the lifecycle, deterministic placement, monitor selection,
 * stacking, nesting, and dismissal policies for temporary shell surfaces such as
 * context menus, flyouts, anchored panels, previews, and transient popups.
 *
 * @module @deepseek-ai/dsh-shell-overlay/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type {
  PhysicalBounds,
  SurfaceInstance,
  SurfaceRendererSpec,
} from '@deepseek-ai/dsh-surface'
import type {
  PhysicalPixelRect,
  WindowsMonitor,
} from '@deepseek-ai/dsh-windows-context'

/** Opaque stable definition identity. */
export type OverlayDefinitionId = Branded<'OverlayDefinitionId'>

/** Opaque temporary instance identity. */
export type OverlayInstanceId = Branded<'OverlayInstanceId'>

/** Two-dimensional coordinate point in virtual-screen physical pixels. */
export interface OverlayPoint {
  readonly x: number
  readonly y: number
}

/** Two-dimensional dimensions in physical pixels. */
export interface OverlaySize {
  /** Target width in physical pixels. */
  readonly width: number
  /** Target height in physical pixels. */
  readonly height: number
  /** Minimum permissible width in physical pixels. */
  readonly minWidth?: number | undefined
  /** Minimum permissible height in physical pixels. */
  readonly minHeight?: number | undefined
  /** Maximum permissible width in physical pixels. */
  readonly maxWidth?: number | undefined
  /** Maximum permissible height in physical pixels. */
  readonly maxHeight?: number | undefined
}

/**
 * Anchor specification defining where an overlay should be positioned.
 * Coordinates are canonical physical virtual-screen coordinates.
 */
export type OverlayAnchor =
  | { readonly type: 'point'; readonly x: number; readonly y: number }
  | { readonly type: 'rect'; readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  | {
    readonly type: 'surface-relative'
    readonly surfaceId: string
    readonly rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  }

/** Deterministic placement direction relative to the anchor. */
export type OverlayPlacement =
  | 'auto'
  | 'top'
  | 'bottom'
  | 'left'
  | 'right'
  | 'top-start'
  | 'top-end'
  | 'bottom-start'
  | 'bottom-end'
  | 'left-start'
  | 'left-end'
  | 'right-start'
  | 'right-end'

/**
 * Focus and activation policy for an overlay.
 * - 'activate': gains foreground focus when opened (e.g. context menus, keyboard-navigable panels).
 * - 'no-activate': does not steal focus from existing foreground window (e.g. hover cards, previews).
 */
export type OverlayFocusPolicy = 'activate' | 'no-activate'

/** Dismissal policies for an overlay. */
export interface OverlayDismissPolicy {
  /** Close when user clicks outside the overlay and its descendant popups. Defaults to true. */
  readonly outsideClick?: boolean | undefined
  /** Close topmost overlay when Escape is pressed. Defaults to true. */
  readonly escape?: boolean | undefined
  /** Close when the overlay loses foreground focus (for activating popups). Defaults to false. */
  readonly onLostFocus?: boolean | undefined
  /** Behavior if the host monitor is disconnected/removed. Defaults to 'close'. */
  readonly onMonitorDisconnect?: 'close' | 'reposition' | undefined
}

/** Stacking and group policy. */
export interface OverlayStackPolicy {
  /** Optional logical group identifier (e.g. 'status-bar-flyout', 'context-menu'). */
  readonly group?: string | undefined
  /** If true, opening an overlay in this group automatically closes any other active overlays in the same group. */
  readonly exclusive?: boolean | undefined
  /** Stack level ordering: tooltip > modal > normal. Defaults to 'normal'. */
  readonly stackLevel?: 'normal' | 'modal' | 'tooltip' | undefined
}

/** Native host recovery policy upon native-host restart. */
export type OverlayRecoveryPolicy = 'close' | 'recreate'

/** Bounds constraint defining the bounding region popups must stay within. */
export type OverlayBoundsConstraint = 'workArea' | 'monitorBounds'

/**
 * Authoritative persistent Overlay Definition registered by plugins.
 */
export interface OverlayDefinition {
  /** Unique definition identifier (e.g. 'desktop-context-menu', 'dock-preview'). */
  readonly id: string
  /** Owning subsystem or plugin identifier (e.g. 'home', 'status-bar', 'dock'). */
  readonly ownerId: string
  /** Default size in physical pixels. */
  readonly size: OverlaySize
  /** Default placement preference. Defaults to 'auto'. */
  readonly defaultPlacement?: OverlayPlacement | undefined
  /** Gap offset in pixels between the anchor and the overlay. Defaults to 4. */
  readonly placementOffset?: number | undefined
  /** Focus policy. Defaults to 'activate'. */
  readonly focusPolicy?: OverlayFocusPolicy | undefined
  /** Dismissal policy. */
  readonly dismiss?: OverlayDismissPolicy | undefined
  /** Stack / group policy. */
  readonly stack?: OverlayStackPolicy | undefined
  /** Native host crash recovery policy. Defaults to 'close'. */
  readonly recovery?: OverlayRecoveryPolicy | undefined
  /** Renderer specification (URL or HTML content). */
  readonly renderer: SurfaceRendererSpec
  /** Usable region boundary constraint. Defaults to 'workArea'. */
  readonly boundsConstraint?: OverlayBoundsConstraint | undefined
  /** Optional arbitrary metadata. */
  readonly metadata?: Readonly<Record<string, unknown>> | undefined
}

/** Lifecycle state machine for an active overlay instance. */
export type OverlayLifecycleState =
  | 'CREATING'
  | 'OPENING'
  | 'OPEN'
  | 'CLOSING'
  | 'CLOSED'
  | 'FAULTED'

/** Point-in-time snapshot of an active overlay instance. */
export interface OverlayInstance {
  readonly instanceId: string
  readonly definitionId: string
  readonly ownerId: string
  readonly surfaceId: string
  readonly monitorId: string
  readonly anchor: OverlayAnchor
  readonly resolvedAnchorRect: PhysicalPixelRect
  readonly requestedSize: OverlaySize
  readonly actualBounds: PhysicalBounds
  readonly requestedPlacement: OverlayPlacement
  readonly effectivePlacement: OverlayPlacement
  readonly parentInstanceId?: string | undefined
  readonly childInstanceIds: readonly string[]
  readonly focusPolicy: OverlayFocusPolicy
  readonly dismiss: OverlayDismissPolicy
  readonly stack: OverlayStackPolicy
  readonly recovery: OverlayRecoveryPolicy
  readonly boundsConstraint: OverlayBoundsConstraint
  readonly state: OverlayLifecycleState
  readonly generation: number
  readonly createdAt: number
  readonly surface?: SurfaceInstance | undefined
  readonly metadata?: Readonly<Record<string, unknown>> | undefined
}

/** Options for opening an overlay instance. */
export interface OverlayOpenOptions {
  /** The registered definition ID to instantiate. */
  readonly definitionId: string
  /** Anchor point, rectangle, or surface-relative bounds. */
  readonly anchor: OverlayAnchor
  /** Owning plugin ID override (defaults to definition's ownerId). */
  readonly ownerId?: string | undefined
  /** Parent overlay instance ID for nested submenus. */
  readonly parentInstanceId?: string | undefined
  /** Placement override. Defaults to definition's defaultPlacement or 'auto'. */
  readonly placement?: OverlayPlacement | undefined
  /** Offset override in physical pixels. */
  readonly offset?: number | undefined
  /** Size override. Defaults to definition's size. */
  readonly size?: OverlaySize | undefined
  /** Optional metadata associated with this specific instance. */
  readonly metadata?: Readonly<Record<string, unknown>> | undefined
}

/** Options for closing an overlay instance. */
export interface OverlayCloseOptions {
  readonly reason?:
    | 'explicit'
    | 'outside-click'
    | 'escape'
    | 'owner-close'
    | 'parent-close'
    | 'group-exclusive'
    | 'monitor-disconnect'
    | 'plugin-unload'
    | 'fault'
    | undefined
}

/** Result of placement calculation. */
export interface PlacementResult {
  readonly bounds: PhysicalBounds
  readonly effectivePlacement: OverlayPlacement
  readonly flipped: boolean
  readonly shifted: boolean
  readonly clamped: boolean
  readonly monitor: WindowsMonitor
  readonly availableBounds: PhysicalPixelRect
}

/** Notification events emitted by Overlay Core. */
export interface OverlayRegisteredEvent {
  readonly definition: OverlayDefinition
}

export interface OverlayUnregisteredEvent {
  readonly definitionId: string
  readonly ownerId: string
}

export interface OverlayOpeningEvent {
  readonly instance: OverlayInstance
}

export interface OverlayOpenedEvent {
  readonly instance: OverlayInstance
}

export interface OverlayClosingEvent {
  readonly instance: OverlayInstance
  readonly reason: string
}

export interface OverlayClosedEvent {
  readonly instanceId: string
  readonly definitionId: string
  readonly ownerId: string
  readonly reason: string
}

export interface OverlayPlacementChangedEvent {
  readonly instance: OverlayInstance
  readonly previousBounds: PhysicalBounds
  readonly newBounds: PhysicalBounds
}

export interface OverlayFaultedEvent {
  readonly instanceId: string
  readonly definitionId: string
  readonly error: Error
}

/** Discriminated union of all overlay change events emitted to direct subscribers. */
export type OverlayChangeEvent =
  | { readonly type: 'registered'; readonly definition: OverlayDefinition }
  | { readonly type: 'unregistered'; readonly definitionId: string; readonly ownerId: string }
  | { readonly type: 'opening'; readonly instance: OverlayInstance }
  | { readonly type: 'opened'; readonly instance: OverlayInstance }
  | { readonly type: 'closing'; readonly instance: OverlayInstance; readonly reason: string }
  | { readonly type: 'closed'; readonly instanceId: string; readonly definitionId: string; readonly ownerId: string; readonly reason: string }
  | { readonly type: 'placement-changed'; readonly instance: OverlayInstance; readonly previousBounds: PhysicalBounds; readonly newBounds: PhysicalBounds }
  | { readonly type: 'faulted'; readonly instanceId: string; readonly definitionId: string; readonly error: Error }

/** Result of owner-level teardown and cleanup. */
export interface OwnerCleanupResult {
  readonly closedInstances: number
  readonly removedDefinitions: readonly string[]
}

/** Construction and configuration options for OverlayService. */
export interface OverlayConfig {
  readonly enabled?: boolean | undefined
  readonly defaultOffset?: number | undefined
  readonly maxNestingDepth?: number | undefined
}
