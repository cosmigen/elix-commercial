/**
 * Dedicated Desktop Layout Engine and Reserved-Region Subsystem for ELIX Home Screen.
 * Computes available desktop work areas by subtracting external reservations (e.g. Dock, Status Bar),
 * enforces collision prevention, and calculates grid-snapped item placements.
 *
 * @module @deepseek-ai/dsh-home/layout
 */

import type { HomeItem } from './items.ts'
import type { ExclusionZone, GridConfig, HomeLayoutContext, Position, Rect, ReservedRegion } from './types.ts'

/** Default grid layout configuration for desktop items and widgets. */
export const DEFAULT_GRID_CONFIG: GridConfig = {
  cellWidth: 86,
  cellHeight: 72,
  gap: 12,
  padding: {
    top: 24,
    bottom: 24,
    left: 24,
    right: 24,
  },
}


/**
 * Check whether two axis-aligned bounding rectangles intersect, accounting for an optional gap margin.
 */
export function rectsIntersect(a: Rect, b: Rect, gap = 0): boolean {
  return (
    a.x - gap < b.x + b.width &&
    a.x + a.width + gap > b.x &&
    a.y - gap < b.y + b.height &&
    a.y + a.height + gap > b.y
  )
}

/**
 * Clamp a rectangle so it stays completely inside the given boundary rectangle.
 */
export function clampRectToBounds(rect: Rect, bounds: Rect): Rect {
  const width = Math.min(Math.max(10, rect.width), bounds.width)
  const height = Math.min(Math.max(10, rect.height), bounds.height)
  const x = Math.max(bounds.x, Math.min(bounds.x + bounds.width - width, rect.x))
  const y = Math.max(bounds.y, Math.min(bounds.y + bounds.height - height, rect.y))
  return { x, y, width, height }
}

/**
 * Compute available desktop work area by subtracting all applicable edge reservations
 * (such as future Dock or Status Bar plugins) from the raw physical monitor rectangle.
 */
export function computeAvailableBounds(
  monitorBounds: Rect,
  reservedRegions: readonly ReservedRegion[],
  monitorId?: string,
): Rect {
  let leftOffset = 0
  let topOffset = 0
  let rightOffset = 0
  let bottomOffset = 0

  // Filter reservations applicable to this monitor
  const applicable = reservedRegions.filter(
    r => r.monitorId === 'all' || monitorId === undefined || r.monitorId === monitorId,
  )

  for (const r of applicable) {
    switch (r.edge) {
      case 'top':
        topOffset = Math.max(topOffset, r.size)
        break
      case 'bottom':
        bottomOffset = Math.max(bottomOffset, r.size)
        break
      case 'left':
        leftOffset = Math.max(leftOffset, r.size)
        break
      case 'right':
        rightOffset = Math.max(rightOffset, r.size)
        break
    }
  }

  const rawWidth = monitorBounds.width - leftOffset - rightOffset
  const rawHeight = monitorBounds.height - topOffset - bottomOffset

  // Ensure available work area never collapses below a minimal usable threshold
  const width = Math.max(200, rawWidth)
  const height = Math.max(200, rawHeight)

  return {
    x: monitorBounds.x + leftOffset,
    y: monitorBounds.y + topOffset,
    width,
    height,
  }
}

/**
 * Snap a point to the nearest discrete desktop grid cell.
 */
export function snapToGrid(
  pos: Position,
  availableBounds: Rect,
  grid: GridConfig = DEFAULT_GRID_CONFIG,
): Position {
  const relX = Math.max(0, pos.x - (availableBounds.x + grid.padding.left))
  const relY = Math.max(0, pos.y - (availableBounds.y + grid.padding.top))

  const stepX = grid.cellWidth + grid.gap
  const stepY = grid.cellHeight + grid.gap

  const col = Math.round(relX / stepX)
  const row = Math.round(relY / stepY)

  return {
    x: availableBounds.x + grid.padding.left + col * stepX,
    y: availableBounds.y + grid.padding.top + row * stepY,
  }
}

/**
 * Check whether a candidate rectangle intersects with any external exclusion zone.
 */
export function intersectsAnyExclusionZone(
  candidate: Rect,
  exclusionZones: readonly ExclusionZone[],
  monitorId?: string,
  gap = 0,
): boolean {
  for (const zone of exclusionZones) {
    if (zone.monitorId === 'all' || monitorId === undefined || zone.monitorId === monitorId) {
      if (rectsIntersect(candidate, zone.rect, gap)) {
        return true
      }
    }
  }
  return false
}

/**
 * Find the nearest unoccupied slot on the desktop grid using a radial spiral search,
 * avoiding both existing desktop items and external exclusion zones.
 */
export function findNearestFreeSlot(
  desired: Rect,
  occupied: readonly Rect[],
  availableBounds: Rect,
  grid: GridConfig = DEFAULT_GRID_CONFIG,
  exclusionZones: readonly ExclusionZone[] = [],
  monitorId?: string,
  enforceSnap = true,
): Position {
  const isCandidateBlocked = (candidate: Rect): boolean => {
    if (occupied.some(occ => rectsIntersect(candidate, occ, grid.gap))) return true
    if (intersectsAnyExclusionZone(candidate, exclusionZones, monitorId, grid.gap)) return true
    return false
  }

  const startSnapped = enforceSnap
    ? snapToGrid({ x: desired.x, y: desired.y }, availableBounds, grid)
    : { x: desired.x, y: desired.y }
  const candidateStart: Rect = {
    ...desired,
    x: startSnapped.x,
    y: startSnapped.y,
  }
  const clampedStart = clampRectToBounds(candidateStart, availableBounds)

  if (!isCandidateBlocked(clampedStart)) {
    return { x: clampedStart.x, y: clampedStart.y }
  }

  const stepX = enforceSnap ? grid.cellWidth + grid.gap : Math.max(12, grid.gap)
  const stepY = enforceSnap ? grid.cellHeight + grid.gap : Math.max(12, grid.gap)
  const maxRadius = Math.ceil(
    Math.max(availableBounds.width, availableBounds.height) / Math.min(stepX, stepY),
  ) + 2

  const visited = new Set<string>()
  visited.add(`${Math.round(clampedStart.x)}:${Math.round(clampedStart.y)}`)

  for (let radius = 1; radius <= maxRadius; radius++) {
    const offsets: Array<[number, number]> = []
    for (let cross = -radius + 1; cross < radius; cross++) {
      offsets.push([radius, cross], [-radius, cross])
    }
    for (let cross = -radius; cross <= radius; cross++) {
      offsets.push([cross, -radius], [cross, radius])
    }

    for (const [colOffset, rowOffset] of offsets) {
      const candX = clampedStart.x + colOffset * stepX
      const candY = clampedStart.y + rowOffset * stepY

      if (
        candX < availableBounds.x ||
        candX + desired.width > availableBounds.x + availableBounds.width ||
        candY < availableBounds.y ||
        candY + desired.height > availableBounds.y + availableBounds.height
      ) {
        continue
      }

      const candidate: Rect = {
        ...desired,
        x: candX,
        y: candY,
      }

      const key = `${Math.round(candidate.x)}:${Math.round(candidate.y)}`
      if (visited.has(key)) continue
      visited.add(key)

      if (!isCandidateBlocked(candidate)) {
        return { x: candidate.x, y: candidate.y }
      }
    }
  }

  return { x: clampedStart.x, y: clampedStart.y }
}

/** Callback for reserved region modifications. */
export type ReservedRegionChangeListener = (regions: readonly ReservedRegion[]) => void

/** Callback for exclusion zone modifications. */
export type ExclusionZoneChangeListener = (zones: readonly ExclusionZone[]) => void

/**
 * Layout engine managing available bounds, reserved edge regions, exclusion zones, and desktop item positioning.
 */
export class HomeLayoutEngine {
  private readonly reservedRegions = new Map<string, ReservedRegion>()
  private readonly exclusionZones = new Map<string, ExclusionZone>()
  private readonly listeners = new Set<ReservedRegionChangeListener>()
  private readonly exclusionListeners = new Set<ExclusionZoneChangeListener>()

  constructor(private gridConfig: GridConfig = DEFAULT_GRID_CONFIG) {}

  /** Get the current grid configuration. */
  getGridConfig(): GridConfig {
    return { ...this.gridConfig, padding: { ...this.gridConfig.padding } }
  }

  /** Update the grid configuration. */
  setGridConfig(config: Partial<GridConfig>): void {
    this.gridConfig = {
      ...this.gridConfig,
      ...config,
      padding: { ...this.gridConfig.padding, ...config.padding },
    }
  }

  /** Retrieve all currently active external reserved regions. */
  getReservedRegions(): readonly ReservedRegion[] {
    return Array.from(this.reservedRegions.values())
  }

  /**
   * Register an external edge reservation (called by future Dock or Status Bar plugins).
   * @param region - Edge reservation descriptor.
   * @returns Disposer function that unregisters the reservation.
   */
  registerReservedRegion(region: ReservedRegion): () => void {
    validateRegionId(region.id, 'reserved region')
    validateRect(region.rect, 'reserved region')
    const registered = { ...region, rect: { ...region.rect } }
    this.reservedRegions.set(region.id, registered)
    this.notify()
    return () => {
      if (this.reservedRegions.get(region.id) === registered) this.unregisterReservedRegion(region.id)
    }
  }

  /**
   * Unregister an existing edge reservation by ID.
   */
  unregisterReservedRegion(id: string): boolean {
    if (!this.reservedRegions.has(id)) return false
    this.reservedRegions.delete(id)
    this.notify()
    return true
  }

  /** Subscribe to reservation changes. */
  onReservedRegionsChange(listener: ReservedRegionChangeListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Register a generic external exclusion zone where items must not be placed.
   * @param zone - Generic exclusion rectangle descriptor.
   * @returns Disposer function that unregisters the exclusion zone.
   */
  registerExclusionZone(zone: ExclusionZone): () => void {
    validateRegionId(zone.id, 'exclusion zone')
    validateRegionId(zone.monitorId, 'exclusion monitor')
    validateRect(zone.rect, 'exclusion zone')
    const registered = { ...zone, rect: { ...zone.rect } }
    this.exclusionZones.set(zone.id, registered)
    this.notifyExclusion()
    return () => {
      if (this.exclusionZones.get(zone.id) === registered) this.unregisterExclusionZone(zone.id)
    }
  }

  /**
   * Unregister an external exclusion zone by ID.
   */
  unregisterExclusionZone(id: string): boolean {
    if (!this.exclusionZones.has(id)) return false
    this.exclusionZones.delete(id)
    this.notifyExclusion()
    return true
  }

  /** Retrieve active exclusion zones (optionally filtered by monitor). */
  getExclusionZones(monitorId?: string): readonly ExclusionZone[] {
    const all = Array.from(this.exclusionZones.values())
    if (monitorId === undefined) return all
    return all.filter(z => z.monitorId === 'all' || z.monitorId === monitorId)
  }

  /** Subscribe to exclusion zone changes. */
  onExclusionZonesChange(listener: ExclusionZoneChangeListener): () => void {
    this.exclusionListeners.add(listener)
    return () => {
      this.exclusionListeners.delete(listener)
    }
  }

  /**
   * Calculate the usable desktop work area for a given monitor.
   */
  getAvailableBounds(monitorId: string, monitorBounds: Rect): Rect {
    return computeAvailableBounds(monitorBounds, this.getReservedRegions(), monitorId)
  }

  /**
   * Assemble complete conceptual layout context for a monitor.
   */
  getLayoutContext(
    monitorId: string,
    monitorBounds: Rect,
    desktopItems: readonly HomeItem[],
  ): HomeLayoutContext {
    return {
      monitorBounds,
      exclusionZones: this.getExclusionZones(monitorId),
      reservedRegions: this.getReservedRegions().filter(
        r => r.monitorId === 'all' || r.monitorId === monitorId,
      ),
      desktopItems: desktopItems.filter(it => it.monitorId === monitorId),
      availableBounds: this.getAvailableBounds(monitorId, monitorBounds),
    }
  }

  /**
   * Resolve safe placement for an item on desktop, avoiding collisions and staying inside available bounds.
   * Respects both existing desktop items, external exclusion zones, and optionally other occupied regions (e.g. widgets).
   */
  resolvePlacement(
    targetItem: HomeItem,
    allItems: readonly HomeItem[],
    availableBounds: Rect,
    enforceSnap = true,
    additionalOccupied: readonly Rect[] = [],
  ): Position {
    const otherRects = allItems
      .filter(
        it =>
          it.id !== targetItem.id &&
          it.monitorId === targetItem.monitorId &&
          it.folderId === undefined,
      )
      .map(it => ({
        x: it.position.x,
        y: it.position.y,
        width: it.size.width,
        height: it.size.height,
      }))

    const desiredRect: Rect = {
      x: targetItem.position.x,
      y: targetItem.position.y,
      width: targetItem.size.width,
      height: targetItem.size.height,
    }

    return this.resolveRectPlacement(
      desiredRect,
      [...otherRects, ...additionalOccupied],
      availableBounds,
      enforceSnap,
      targetItem.monitorId,
    )
  }

  /**
   * Resolve safe placement for an arbitrary rectangle on desktop, avoiding collisions with occupied areas and exclusions.
   *
   * @param candidate - Candidate rectangle to place.
   * @param occupied - Rectangles already occupied on this monitor.
   * @param availableBounds - Usable area bounds.
   * @param enforceSnap - Whether to snap to grid cells (true) or resolve freeform (false).
   * @param monitorId - Optional monitor identifier for exclusion filtering.
   * @returns Collision-free position.
   */
  resolveRectPlacement(
    candidate: Rect,
    occupied: readonly Rect[],
    availableBounds: Rect,
    enforceSnap = true,
    monitorId?: string,
  ): Position {
    const zones = this.getExclusionZones(monitorId)
    const gap = this.gridConfig.gap

    if (!enforceSnap) {
      const clamped = clampRectToBounds(candidate, availableBounds)
      const collidesOccupied = occupied.some(occ => rectsIntersect(clamped, occ, gap))
      const collidesExclusions = intersectsAnyExclusionZone(clamped, zones, monitorId, gap)
      if (!collidesOccupied && !collidesExclusions) {
        return { x: clamped.x, y: clamped.y }
      }
    }

    return findNearestFreeSlot(
      candidate,
      occupied,
      availableBounds,
      this.gridConfig,
      zones,
      monitorId,
      enforceSnap,
    )
  }

  /**
   * Find the nearest unoccupied slot on the desktop grid for a candidate rectangle.
   *
   * @param desired - Target candidate rectangle.
   * @param occupied - Rectangles already occupied on the desktop.
   * @param monitorId - Optional target monitor identifier.
   * @param availableBounds - Optional usable bounds; defaults to monitor available bounds.
   * @param enforceSnap - Whether to snap to grid cells. Defaults to true.
   * @returns Collision-free snapped position.
   */
  findNearestFreeSlot(
    desired: Rect,
    occupied: readonly Rect[],
    monitorId?: string,
    availableBounds?: Rect,
    enforceSnap = true,
  ): Position {
    const bounds = availableBounds ?? this.getAvailableBounds(monitorId ?? '', { x: 0, y: 0, width: 1920, height: 1080 })
    return findNearestFreeSlot(
      desired,
      occupied,
      bounds,
      this.gridConfig,
      this.getExclusionZones(monitorId),
      monitorId,
      enforceSnap,
    )
  }

  private notify(): void {
    const list = this.getReservedRegions()
    for (const listener of this.listeners) {
      try {
        listener(list)
      } catch (err) {
        console.error('Error in reserved regions listener:', err)
      }
    }
  }

  private notifyExclusion(): void {
    const list = this.getExclusionZones()
    for (const listener of this.exclusionListeners) {
      try {
        listener(list)
      } catch (err) {
        console.error('Error in exclusion zones listener:', err)
      }
    }
  }
}

function validateRegionId(value: string, subject: string): void {
  if (value.trim().length === 0 || value.length > 256) {
    throw new Error(`${subject} identifier must contain between 1 and 256 characters.`)
  }
}

function validateRect(rect: Rect, subject: string): void {
  if (
    !Number.isFinite(rect.x) ||
    !Number.isFinite(rect.y) ||
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height) ||
    rect.width <= 0 ||
    rect.height <= 0
  ) {
    throw new Error(`${subject} rectangle must have finite coordinates and positive dimensions.`)
  }
}
