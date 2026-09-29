/**
 * Home Exclusion Publisher for ELIX Shell Layout.
 *
 * Bridges active Shell Layout reservations into Home's generic ExclusionZone system,
 * ensuring desktop items automatically avoid Dock, Status Bar, and floating panels.
 *
 * @module @deepseek-ai/dsh-shell-layout/home-publisher
 */

import type { PhysicalPixelRect } from '@deepseek-ai/dsh-windows-context'
import type { ShellReservation } from './types.ts'

/** Minimal interface representing Home Layout Engine's exclusion capability. */
export interface HomeLayoutCapability {
  registerExclusionZone(zone: { id: string; monitorId: string; rect: PhysicalPixelRect }): () => void
  unregisterExclusionZone(id: string): boolean
}

/** Home service accessor contract. */
export interface HomeServiceRef {
  readonly layout: HomeLayoutCapability
}

/**
 * Coordinates publication of Shell Layout reservations into Home Layout Engine.
 */
export class HomePublisher {
  private readonly disposers = new Map<string, () => void>()
  private homeRef: HomeServiceRef | undefined
  private readonly getHome?: (() => HomeServiceRef | undefined) | undefined

  constructor(getHome?: () => HomeServiceRef | undefined) {
    this.getHome = getHome
    if (getHome) {
      this.homeRef = getHome()
    }
  }

  private get activeHome(): HomeServiceRef | undefined {
    return this.homeRef ?? this.getHome?.()
  }

  /**
   * Sets or updates the active Home service reference.
   */
  setHome(home: HomeServiceRef | undefined): void {
    this.homeRef = home
  }

  /**
   * Publishes or updates a reservation in Home's exclusion zone registry.
   */
  publish(reservation: ShellReservation): void {
    const home = this.activeHome
    if (!home) return

    const effectiveRect =
      reservation.kind === 'edge' && reservation.effectiveRect
        ? reservation.effectiveRect
        : reservation.rect

    // If reservation does not affect Home, is hidden, or has non-positive dimensions, remove any previous exclusion
    if (
      !reservation.affectsHomeLayout ||
      !reservation.visible ||
      effectiveRect.width <= 0 ||
      effectiveRect.height <= 0
    ) {
      this.unpublish(reservation.id)
      return
    }

    // Register with Home Layout Engine
    const zone = {
      id: reservation.id,
      monitorId: reservation.monitorId,
      rect: { ...effectiveRect },
    }

    const dispose = home.layout.registerExclusionZone(zone)
    this.disposers.set(reservation.id, dispose)
  }

  /**
   * Unpublishes a reservation from Home by ID.
   */
  unpublish(id: string): boolean {
    const dispose = this.disposers.get(id)
    if (dispose) {
      this.disposers.delete(id)
      dispose()
      return true
    }
    const home = this.activeHome
    if (home) {
      return home.layout.unregisterExclusionZone(id)
    }
    return false
  }

  /**
   * Synchronizes all current reservations into Home.
   */
  syncAll(reservations: readonly ShellReservation[]): void {
    if (!this.activeHome) return

    const activeIds = new Set<string>()
    for (const res of reservations) {
      const effectiveRect =
        res.kind === 'edge' && res.effectiveRect
          ? res.effectiveRect
          : res.rect
      if (
        res.affectsHomeLayout &&
        res.visible &&
        effectiveRect.width > 0 &&
        effectiveRect.height > 0
      ) {
        activeIds.add(res.id)
        this.publish(res)
      }
    }

    // Remove any previously published zones that are no longer active
    for (const id of Array.from(this.disposers.keys())) {
      if (!activeIds.has(id)) {
        this.unpublish(id)
      }
    }
  }

  /**
   * Disposes all published exclusions cleanly.
   */
  dispose(): void {
    for (const dispose of this.disposers.values()) {
      try {
        dispose()
      } catch {
        // Best-effort teardown
      }
    }
    this.disposers.clear()
  }
}
