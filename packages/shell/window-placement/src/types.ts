/** Public contracts for ELIX Phase 17B placement policy. */

import type { WindowPlacementConstraints } from '@deepseek-ai/dsh-window-control'
import type { WindowId, WindowState } from '@deepseek-ai/dsh-window-registry'
import type { MonitorId, PhysicalPixelRect } from '@deepseek-ai/dsh-windows-context'

/** Manual CORE placement zones. Automatic tiling is intentionally out of scope. */
export type PlacementZone =
  | 'left-half'
  | 'right-half'
  | 'top-half'
  | 'bottom-half'
  | 'top-left-quarter'
  | 'top-right-quarter'
  | 'bottom-left-quarter'
  | 'bottom-right-quarter'
  | 'center'
  | 'fill'

export type PlacementTarget =
  | Readonly<{
    kind: PlacementZone
    /** Defaults to the window's current monitor, then primary if unresolved. */
    monitorId?: MonitorId | undefined
  }>
  | Readonly<{
    kind: 'move-to-monitor'
    monitorId: MonitorId
    placement?: 'preserve-offset' | 'center' | undefined
  }>

export type PlacementStatus = 'applied' | 'adjusted' | 'rejected' | 'cancelled'

export type PlacementAdjustment =
  | 'minimum-width'
  | 'minimum-height'
  | 'maximum-width'
  | 'maximum-height'
  | 'work-area-clamp'
  | 'monitor-fallback'
  | 'window-adjusted-geometry'

export type PlacementFailureReason =
  | 'authority-unavailable'
  | 'operation-conflict'
  | 'stale-window-id'
  | 'target-not-application'
  | 'window-hidden'
  | 'window-minimized'
  | 'unknown-monitor'
  | 'shell-work-area-unavailable'
  | 'nonresizable-window'
  | 'display-topology-unstable'
  | 'placement-constraints-unavailable'
  | 'restore-before-placement-failed'
  | 'geometry-refused'
  | 'native-mutation-failed'
  | 'no-placement-record'
  | 'restore-failed'
  | 'duplicate-layout-target'

export interface PlacementResult {
  readonly windowId: WindowId
  /** Present for placement requests; restore results refer to the saved record instead. */
  readonly target?: PlacementTarget | undefined
  readonly status: PlacementStatus
  readonly monitorId?: MonitorId | undefined
  readonly displayRevision?: number | undefined
  readonly requestedRect?: PhysicalPixelRect | undefined
  readonly appliedRect?: PhysicalPixelRect | undefined
  readonly constraints?: WindowPlacementConstraints | undefined
  readonly adjustments: readonly PlacementAdjustment[]
  readonly reason?: PlacementFailureReason | undefined
  readonly detail?: string | undefined
}

/** Reversible state for one continuous WindowId lifetime. No HWND is retained. */
export interface PlacementRecord {
  readonly windowId: WindowId
  readonly originalBounds: PhysicalPixelRect
  readonly originalState: Extract<WindowState, 'normal' | 'maximized'>
  readonly originalMonitorId?: MonitorId | undefined
  readonly sourceRegistryGeneration: number
  readonly createdDisplayRevision: number
  readonly createdAt: number
  readonly lastTarget: PlacementTarget
  readonly lastAppliedBounds: PhysicalPixelRect
  readonly lastAppliedMonitorId?: MonitorId | undefined
  readonly updatedAt: number
}

export interface NamedPlacementEntry {
  readonly windowId: WindowId
  readonly target: PlacementTarget
}

export interface NamedPlacementLayout {
  readonly name: string
  readonly entries: readonly NamedPlacementEntry[]
}

export interface NamedPlacementResult {
  readonly name: string
  readonly results: readonly PlacementResult[]
  readonly applied: number
  readonly adjusted: number
  readonly rejected: number
  readonly cancelled: number
}

export interface PlacementOptions {
  /** Cooperative cancellation. A cancelled operation rolls back a temporary restore when possible. */
  readonly signal?: AbortSignal | undefined
}

export interface PlacementRecordEvent {
  readonly type: 'created' | 'updated' | 'restored' | 'invalidated' | 'released'
  readonly windowId: WindowId
  readonly record?: PlacementRecord | undefined
  readonly reason?: string | undefined
}

export interface WindowPlacementSource {
  place(
    windowId: WindowId,
    target: PlacementTarget,
    options?: PlacementOptions,
  ): Promise<PlacementResult>
  restorePlacement(windowId: WindowId, options?: PlacementOptions): Promise<PlacementResult>
  establishFreePlacement(windowId: WindowId): boolean
  getPlacementRecord(windowId: WindowId): PlacementRecord | undefined
  listPlacementRecords(): readonly PlacementRecord[]
  applyNamedLayout(
    layout: NamedPlacementLayout,
    options?: PlacementOptions,
  ): Promise<NamedPlacementResult>
  subscribe(listener: (event: PlacementRecordEvent) => void): () => void
}

export interface WindowPlacementConfig {
  readonly enabled: boolean
  /** Bounded retries when topology/work-area revision changes while a target is being negotiated. */
  readonly maxDisplayReplans: number
}
