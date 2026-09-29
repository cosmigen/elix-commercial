/**
 * Native Windows AppBar Work Area Synchronization for ELIX Shell Layout.
 *
 * Coordinates desired work-area reservations with the Rust Native Core bridge,
 * managing native AppBar registration, updating, unregistering, and supervisor recovery.
 *
 * @module @deepseek-ai/dsh-shell-layout/native-work-area-sync
 */

import type { NativeBridgeClient } from '@deepseek-ai/dsh-native-core'
import type { PhysicalPixelRect } from '@deepseek-ai/dsh-windows-context'
import type { ShellReservation } from './types.ts'

/** Item specification acceptable for native work-area synchronization. */
export interface NativeSyncItem {
  readonly id: string
  readonly edge?: ShellReservation['edge']
  readonly rect: PhysicalPixelRect
  readonly hwnd?: number | undefined
  readonly affectsWorkArea: boolean
  readonly visible: boolean
  readonly kind: ShellReservation['kind']
}

/** Callback invoked when Windows approves/adjusts an AppBar rectangle. */
export type OnNativeApprovedRect = (id: string, approvedRect: PhysicalPixelRect) => void

/** Manages native AppBar synchronization over the Native Bridge client. */
export class NativeWorkAreaSync {
  private readonly bridge?: NativeBridgeClient | undefined
  private readonly enabled: boolean
  private readonly onApproved?: OnNativeApprovedRect | undefined
  private readonly activeNativeBarIds = new Set<string>()
  private readonly pendingGenerations = new Map<string, number>()
  private readonly pendingOperations = new Map<string, Promise<unknown>>()
  private isDisposed = false

  constructor(
    bridge?: NativeBridgeClient,
    enabled = true,
    onApproved?: OnNativeApprovedRect,
  ) {
    this.bridge = bridge
    this.enabled = enabled && bridge !== undefined
    this.onApproved = onApproved
  }

  /** Whether native AppBar synchronization is active. */
  get isEnabled(): boolean {
    return this.enabled && !this.isDisposed
  }

  /** Returns a stable snapshot of currently tracked native AppBar IDs. */
  getActiveIds(): readonly string[] {
    return Object.freeze(Array.from(this.activeNativeBarIds).sort())
  }

  /** Syncs a single reservation to the native host AppBar system. */
  async syncReservation(reservation: NativeSyncItem): Promise<PhysicalPixelRect | undefined> {
    const bridge = this.bridge
    if (!this.isEnabled || !bridge) return undefined

    const gen = (this.pendingGenerations.get(reservation.id) ?? 0) + 1
    this.pendingGenerations.set(reservation.id, gen)

    return this.enqueue(reservation.id, async () => {
      if (this.isDisposed || this.pendingGenerations.get(reservation.id) !== gen) return undefined

      if (
        reservation.affectsWorkArea &&
        reservation.kind === 'edge' &&
        reservation.edge !== undefined &&
        reservation.visible
      ) {
        try {
          const approvedRect = await bridge.appBar.register({
            id: reservation.id,
            edge: reservation.edge,
            rect: reservation.rect,
            ...(reservation.hwnd !== undefined ? { hwnd: reservation.hwnd } : {}),
          })

          if (this.hasBeenDisposed()) {
            await bridge.appBar.unregister(reservation.id).catch(() => false)
            return undefined
          }
          if (this.pendingGenerations.get(reservation.id) !== gen) {
            return undefined
          }

          this.activeNativeBarIds.add(reservation.id)
          this.onApproved?.(reservation.id, approvedRect)
          return approvedRect
        } catch {
          return undefined
        }
      }

      await this.unreserveNow(reservation.id)
      return undefined
    })
  }

  /** Removes a native AppBar reservation. */
  async unreserve(id: string): Promise<boolean> {
    if (!this.isEnabled || !this.bridge) return false

    const gen = (this.pendingGenerations.get(id) ?? 0) + 1
    this.pendingGenerations.set(id, gen)

    return this.enqueue(id, async () => {
      if (this.isDisposed || this.pendingGenerations.get(id) !== gen) return false
      return this.unreserveNow(id)
    })
  }

  /**
   * Reconciles the complete desired set with the native host.
   * Unknown tracked registrations are explicitly removed before desired items are re-applied.
   */
  async reconcileAll(
    reservations: readonly NativeSyncItem[],
    isStillValid?: (id: string) => boolean,
  ): Promise<void> {
    if (!this.isEnabled || !this.bridge) return

    const desired = new Set(
      reservations
        .filter(reservation =>
          reservation.affectsWorkArea &&
          reservation.kind === 'edge' &&
          reservation.visible &&
          (!isStillValid || isStillValid(reservation.id)),
        )
        .map(reservation => reservation.id),
    )

    const staleIds = Array.from(this.activeNativeBarIds)
      .filter(id => !desired.has(id))

    for (const id of staleIds) {
      await this.unreserve(id)
    }

    for (const reservation of reservations) {
      if (!desired.has(reservation.id)) continue

      // The desired set is only a snapshot. Recovery can pause on a previous
      // native call while a plugin/user releases another reservation. Re-check
      // immediately before issuing the next native register so stale recovery
      // work cannot resurrect a boundary claim that has already been removed.
      if (isStillValid && !isStillValid(reservation.id)) {
        desired.delete(reservation.id)
        await this.unreserve(reservation.id)
        continue
      }

      await this.syncReservation(reservation)
    }
  }

  /** Cleanly unregisters all active native reservations and disposes the synchronizer. */
  async dispose(): Promise<void> {
    if (this.isDisposed) return
    this.isDisposed = true

    await Promise.allSettled(this.pendingOperations.values())

    if (this.bridge) {
      const bridge = this.bridge
      const ids = Array.from(this.activeNativeBarIds)
      this.activeNativeBarIds.clear()
      await Promise.allSettled(ids.map(id => bridge.appBar.unregister(id)))
    }

    this.pendingGenerations.clear()
    this.pendingOperations.clear()
  }

  private async unreserveNow(id: string): Promise<boolean> {
    if (!this.bridge) return false
    this.activeNativeBarIds.delete(id)
    try {
      return await this.bridge.appBar.unregister(id)
    } catch {
      return false
    }
  }

  private enqueue<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.pendingOperations.get(id)
    const current = previous ? previous.then(operation, operation) : operation()
    const clear = (): void => {
      if (this.pendingOperations.get(id) === current) {
        this.pendingOperations.delete(id)
      }
    }
    this.pendingOperations.set(id, current)
    void current.then(clear, clear)
    return current
  }

  private hasBeenDisposed(): boolean {
    return this.isDisposed
  }
}
