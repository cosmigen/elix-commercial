/**
 * Authoritative types, models, and contracts for ELIX Shell Layout.
 *
 * Shell Layout owns the geometry and reservation policy used by shell surfaces
 * (Dock, Status Bar, shell-edge surfaces, floating panels) across Windows monitors,
 * computes authoritative maximized-window work areas, and publishes source-neutral
 * exclusion geometry into Home Layout Engine.
 *
 * @module @deepseek-ai/dsh-shell-layout/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { NativeBridgeClient } from '@deepseek-ai/dsh-native-core'
import type { PhysicalPixelRect } from '@deepseek-ai/dsh-windows-context'

/** Opaque stable reservation identity. */
export type ReservationId = Branded<'ReservationId'>

/** Screen edges available for docked shell surface reservations. */
export type ShellEdge = 'top' | 'bottom' | 'left' | 'right'

/** Kind of shell reservation: edge-docked strip or floating bounding rectangle. */
export type ShellReservationKind = 'edge' | 'floating'

/** Operating policy for how ELIX cooperates with the Windows shell. */
export type ShellMode = 'coexistence' | 'overlay' | 'replacement'

/** Conflict policy for multiple reservations targeting the same monitor edge. */
export type ShellBoundaryConflictPolicy = 'stack' | 'exclusive'

/** Explicit lifecycle states of the Shell Layout subsystem. */
export type ShellLayoutLifecycleState =
  | 'STARTING'
  | 'ACTIVE'
  | 'RECONCILING'
  | 'DISPOSED'

/** Authoritative shell reservation descriptor. */
export interface ShellReservation {
  readonly id: string
  readonly monitorId: string
  readonly ownerId: string
  readonly ownerGeneration: number
  readonly kind: ShellReservationKind
  readonly rect: PhysicalPixelRect
  readonly effectiveRect?: PhysicalPixelRect | undefined
  readonly edge?: ShellEdge | undefined
  readonly affectsWorkArea: boolean
  readonly affectsHomeLayout: boolean
  readonly visible: boolean
  readonly priority: number
  readonly conflictPolicy: ShellBoundaryConflictPolicy
  readonly suspendInFullscreen: boolean
  readonly hwnd?: number | undefined
  readonly createdAt: number
  readonly updatedAt: number
}

/** Specification required when registering a new shell reservation. */
export interface ShellReservationSpec {
  readonly id: string
  readonly monitorId: string
  readonly ownerId: string
  readonly ownerGeneration?: number | undefined
  readonly kind: ShellReservationKind
  readonly rect: PhysicalPixelRect
  readonly edge?: ShellEdge | undefined
  readonly affectsWorkArea?: boolean | undefined
  readonly affectsHomeLayout?: boolean | undefined
  readonly visible?: boolean | undefined
  readonly priority?: number | undefined
  readonly conflictPolicy?: ShellBoundaryConflictPolicy | undefined
  readonly suspendInFullscreen?: boolean | undefined
  readonly hwnd?: number | undefined
}

/** Partial update patch for an existing shell reservation. Lease identity is immutable. */
export type ShellReservationUpdate = Partial<
  Omit<ShellReservationSpec, 'id' | 'ownerId' | 'ownerGeneration'>
>

/** Stable owner-generation lease returned by registerReservation. */
export interface ShellReservationHandle {
  readonly id: string
  readonly ownerId: string
  readonly ownerGeneration: number
  get(): ShellReservation | undefined
  update(patch: ShellReservationUpdate): ShellReservation
  dispose(): boolean
}

/** Authoritative layout state computed for a single connected display monitor. */
export interface MonitorLayoutState {
  readonly monitorId: string
  readonly monitorBounds: PhysicalPixelRect
  readonly originalWorkArea: PhysicalPixelRect
  readonly computedWorkArea: PhysicalPixelRect
  readonly edgeThickness: Readonly<Record<ShellEdge, number>>
  readonly reservations: readonly ShellReservation[]
  readonly isFullscreenActive: boolean
}

/** One detected exclusive shell-edge ownership conflict. */
export interface ShellBoundaryConflict {
  readonly monitorId: string
  readonly edge: ShellEdge
  readonly reservationIds: readonly [string, string]
  readonly ownerIds: readonly [string, string]
}

/** Minimal state an independent guardian needs to restore shell safety. */
export interface ShellRecoverySnapshot {
  readonly shellMode: ShellMode
  readonly recoveryGuardianReady: boolean
  readonly reservations: readonly Readonly<{
    id: string
    ownerId: string
    ownerGeneration: number
    monitorId: string
    kind: ShellReservationKind
    edge?: ShellEdge | undefined
    affectsWorkArea: boolean
    visible: boolean
  }>[]
}

/** Notification event emitted after Shell Layout state changes. */
export interface ShellLayoutChangeEvent {
  readonly type:
    | 'registered'
    | 'updated'
    | 'removed'
    | 'reconciled'
    | 'topology'
    | 'owner-released'
    | 'mode'
    | 'fullscreen'
    | 'recovered'
  readonly reservationId?: string | undefined
  readonly monitorId?: string | undefined
  readonly affectedMonitorIds: readonly string[]
}

/** Construction and runtime configuration for the Shell Layout service. */
export interface ShellLayoutConfig {
  readonly enabled?: boolean | undefined
  readonly syncNativeWorkArea?: boolean | undefined
  readonly bridge?: NativeBridgeClient | undefined
  readonly shellMode?: ShellMode | undefined
  /** Replacement is opt-in and still requires an active recovery guardian. */
  readonly allowTaskbarReplacement?: boolean | undefined
  readonly recoveryGuardianReady?: boolean | undefined
  /** Optional durable recovery journal override, primarily for tests/packaging. */
  readonly recoveryJournalPath?: string | undefined
  /** Windows-session identity used to prevent cross-session restoration. */
  readonly recoverySessionId?: string | undefined
  /** Host/controller generation persisted with risky replacement transitions. */
  readonly controllerGeneration?: number | undefined
}

/** Public read and mutation operations exposed by `ctx.shellLayout`. */
export interface ShellLayoutSource {
  registerReservation(spec: ShellReservationSpec): ShellReservationHandle
  updateReservation(id: string, patch: ShellReservationUpdate): ShellReservation
  removeReservation(id: string): boolean
  releaseOwner(ownerId: string, ownerGeneration: number): number
  getOwnerGeneration(ownerId: string): number | undefined
  getReservation(id: string): ShellReservation | undefined
  getReservations(monitorId?: string): readonly ShellReservation[]
  getMonitorLayout(monitorId: string): MonitorLayoutState | undefined
  getWorkArea(monitorId: string): PhysicalPixelRect | undefined
  isFullscreenActive(monitorId: string): boolean
  getFullscreenPolicy(monitorId: string): { isFullscreen: boolean; occludesShellSurfaces: boolean }
  getShellMode(): ShellMode
  setShellMode(mode: ShellMode): void
  setRecoveryGuardianReady(ready: boolean): void
  getBoundaryConflicts(): readonly ShellBoundaryConflict[]
  getRecoverySnapshot(): ShellRecoverySnapshot
  reconcileBoundaries(): Promise<void>
  getLifecycleState(): ShellLayoutLifecycleState
  subscribe(listener: (event: ShellLayoutChangeEvent) => void): () => void
}
