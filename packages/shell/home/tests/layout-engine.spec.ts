import { describe, expect, it } from 'vitest'
import {
  DEFAULT_GRID_CONFIG,
  HomeItemManager,
  HomeLayoutEngine,
  computeAvailableBounds,
  findNearestFreeSlot,
  rectsIntersect,
  snapToGrid,
} from '../src/index.ts'
import type { Rect, ReservedRegion } from '../src/index.ts'

describe('HomeLayoutEngine & Reserved Regions', () => {
  const monitorBounds: Rect = { x: 0, y: 0, width: 1920, height: 1080 }

  it('computes available bounds accounting for external reserved regions', () => {
    const reservations: ReservedRegion[] = [
      {
        id: 'dock-bottom',
        edge: 'bottom',
        size: 72,
        priority: 10,
        monitorId: 'all',
        rect: { x: 0, y: 1008, width: 1920, height: 72 },
      },
      {
        id: 'status-bar-top',
        edge: 'top',
        size: 32,
        priority: 10,
        monitorId: 'all',
        rect: { x: 0, y: 0, width: 1920, height: 32 },
      },
    ]

    const available = computeAvailableBounds(monitorBounds, reservations)
    expect(available).toEqual({
      x: 0,
      y: 32,
      width: 1920,
      height: 1080 - 32 - 72, // 976
    })
  })

  it('dynamically updates available bounds upon reservation registration/unregistration', () => {
    const engine = new HomeLayoutEngine()
    const initialBounds = engine.getAvailableBounds('mon-1', monitorBounds)
    expect(initialBounds).toEqual(monitorBounds)

    // Register a bottom dock reservation
    const unregisterDock = engine.registerReservedRegion({
      id: 'dock-reservation',
      edge: 'bottom',
      size: 64,
      priority: 1,
      monitorId: 'mon-1',
      rect: { x: 0, y: 1016, width: 1920, height: 64 },
    })

    const withDock = engine.getAvailableBounds('mon-1', monitorBounds)
    expect(withDock.height).toBe(1080 - 64)
    expect(withDock.y).toBe(0)

    // Register a top status bar reservation
    const unregisterStatus = engine.registerReservedRegion({
      id: 'status-bar-reservation',
      edge: 'top',
      size: 28,
      priority: 1,
      monitorId: 'all',
      rect: { x: 0, y: 0, width: 1920, height: 28 },
    })

    const withBoth = engine.getAvailableBounds('mon-1', monitorBounds)
    expect(withBoth.y).toBe(28)
    expect(withBoth.height).toBe(1080 - 64 - 28)

    // Unregister dock
    unregisterDock()
    const withStatusOnly = engine.getAvailableBounds('mon-1', monitorBounds)
    expect(withStatusOnly.y).toBe(28)
    expect(withStatusOnly.height).toBe(1080 - 28)

    // Unregister status
    unregisterStatus()
    expect(engine.getAvailableBounds('mon-1', monitorBounds)).toEqual(monitorBounds)
  })

  it('snaps coordinates to discrete desktop grid cells', () => {
    const availableBounds: Rect = { x: 0, y: 32, width: 1920, height: 1000 }
    const pos = { x: 110, y: 120 }
    const snapped = snapToGrid(pos, availableBounds, DEFAULT_GRID_CONFIG)

    expect(snapped.x).toBeGreaterThanOrEqual(availableBounds.x)
    expect(snapped.y).toBeGreaterThanOrEqual(availableBounds.y)

    // Snapping is deterministic
    const secondSnap = snapToGrid(snapped, availableBounds, DEFAULT_GRID_CONFIG)
    expect(secondSnap).toEqual(snapped)
  })

  it('resolves item collisions via radial spiral free-slot search', () => {
    const availableBounds: Rect = { x: 0, y: 0, width: 1000, height: 1000 }
    const itemA: Rect = { x: 24, y: 24, width: 86, height: 72 }

    // Desired position occupies the same slot as itemA
    const desired: Rect = { x: 24, y: 24, width: 86, height: 72 }
    expect(rectsIntersect(desired, itemA, DEFAULT_GRID_CONFIG.gap)).toBe(true)

    const freeSlot = findNearestFreeSlot(desired, [itemA], availableBounds, DEFAULT_GRID_CONFIG)
    expect(freeSlot).not.toEqual({ x: itemA.x, y: itemA.y })

    const freeSlotRect: Rect = {
      x: freeSlot.x,
      y: freeSlot.y,
      width: desired.width,
      height: desired.height,
    }
    // New slot must not intersect with existing occupied item
    expect(rectsIntersect(freeSlotRect, itemA, DEFAULT_GRID_CONFIG.gap)).toBe(false)
  })

  it('exposes findNearestFreeSlot method directly on HomeLayoutEngine', () => {
    const engine = new HomeLayoutEngine()
    const itemA: Rect = { x: 24, y: 24, width: 84, height: 96 }
    const desired: Rect = { x: 24, y: 24, width: 84, height: 96 }

    const freeSlot = engine.findNearestFreeSlot(desired, [itemA], 'mon-1', monitorBounds)
    expect(freeSlot).not.toEqual({ x: itemA.x, y: itemA.y })
    expect(rectsIntersect({ ...desired, ...freeSlot }, itemA, DEFAULT_GRID_CONFIG.gap)).toBe(false)
  })

  it('resolves placement through HomeLayoutEngine with ItemManager', () => {
    const engine = new HomeLayoutEngine()
    const itemManager = new HomeItemManager()

    const item1 = itemManager.addItem({
      id: 'item-1',
      type: 'shortcut',
      position: { x: 24, y: 24 },
      size: { width: 84, height: 96 },
      metadata: {},
    })

    const item2 = itemManager.addItem({
      id: 'item-2',
      type: 'shortcut',
      position: { x: 24, y: 24 }, // Collision with item1
      size: { width: 84, height: 96 },
      metadata: {},
    })

    const resolvedPos = engine.resolvePlacement(item2, itemManager.getItems(), monitorBounds)
    expect(resolvedPos).not.toEqual(item1.position)
  })

  it('manages exclusion zones and prevents item placement inside them', () => {
    const engine = new HomeLayoutEngine()
    const notifications: number[] = []

    const unbind = engine.onExclusionZonesChange((zones) => {
      notifications.push(zones.length)
    })

    const unregister = engine.registerExclusionZone({
      id: 'custom-widget-island',
      rect: { x: 24, y: 24, width: 200, height: 200 },
      monitorId: 'mon-1',
    })

    expect(engine.getExclusionZones()).toHaveLength(1)
    expect(notifications).toEqual([1])

    // Candidate item at (24, 24) is blocked by the exclusion zone
    const item: Rect = { x: 24, y: 24, width: 84, height: 96 }
    const freeSlot = findNearestFreeSlot(
      item,
      [],
      monitorBounds,
      DEFAULT_GRID_CONFIG,
      engine.getExclusionZones(),
      'mon-1',
    )

    // The free slot must be moved outside the (24, 24, 200, 200) exclusion zone
    const freeRect: Rect = { ...item, x: freeSlot.x, y: freeSlot.y }
    expect(rectsIntersect(freeRect, { x: 24, y: 24, width: 200, height: 200 }, 0)).toBe(false)

    unregister()
    expect(engine.getExclusionZones()).toHaveLength(0)
    expect(notifications).toEqual([1, 0])
    unbind()
  })
})

describe('Home exclusion acceptance matrix', () => {
  const bounds: Rect = { x: 0, y: 0, width: 800, height: 600 }
  const item = (x: number, y: number, monitorId = 'monitor-a') => ({
    id: 'candidate',
    type: 'shortcut' as const,
    monitorId,
    position: { x, y },
    size: { width: 84, height: 96 },
    metadata: {},
    createdAt: 0,
    updatedAt: 0,
  })

  it('accepts outside placement and resolves full or partial rectangle intersections', () => {
    const engine = new HomeLayoutEngine()
    engine.registerExclusionZone({
      id: 'zone',
      monitorId: 'monitor-a',
      rect: { x: 200, y: 180, width: 240, height: 180 },
    })

    expect(engine.resolvePlacement(item(24, 24), [], bounds, false)).toEqual({ x: 24, y: 24 })

    for (const blocked of [item(220, 200), item(150, 220)]) {
      const resolved = engine.resolvePlacement(blocked, [], bounds, false)
      expect(resolved).not.toEqual(blocked.position)
      expect(rectsIntersect({ ...resolved, ...blocked.size }, { x: 200, y: 180, width: 240, height: 180 })).toBe(false)
    }
  })

  it('blocks only the floating rectangle and leaves bottom corners usable', () => {
    const engine = new HomeLayoutEngine()
    engine.registerExclusionZone({
      id: 'floating-dock',
      monitorId: 'monitor-a',
      rect: { x: 250, y: 480, width: 300, height: 88 },
    })

    expect(engine.resolvePlacement(item(24, 470), [], bounds, false)).toEqual({ x: 24, y: 470 })
    expect(engine.resolvePlacement(item(690, 470), [], bounds, false)).toEqual({ x: 690, y: 470 })
  })

  it('moves a zone atomically, ignores stale disposal, and releases it on current disposal', () => {
    const engine = new HomeLayoutEngine()
    const disposeA = engine.registerExclusionZone({
      id: 'moving-zone',
      monitorId: 'monitor-a',
      rect: { x: 20, y: 20, width: 120, height: 130 },
    })
    expect(engine.resolvePlacement(item(24, 24), [], bounds, false)).not.toEqual({ x: 24, y: 24 })

    const disposeB = engine.registerExclusionZone({
      id: 'moving-zone',
      monitorId: 'monitor-a',
      rect: { x: 300, y: 220, width: 120, height: 130 },
    })
    expect(engine.resolvePlacement(item(24, 24), [], bounds, false)).toEqual({ x: 24, y: 24 })
    expect(engine.resolvePlacement(item(310, 230), [], bounds, false)).not.toEqual({ x: 310, y: 230 })

    disposeA()
    expect(engine.getExclusionZones()).toHaveLength(1)
    disposeB()
    expect(engine.resolvePlacement(item(310, 230), [], bounds, false)).toEqual({ x: 310, y: 230 })
  })

  it('isolates monitor zones and avoids every applicable zone', () => {
    const engine = new HomeLayoutEngine()
    engine.registerExclusionZone({
      id: 'monitor-a-only',
      monitorId: 'monitor-a',
      rect: { x: 20, y: 20, width: 120, height: 130 },
    })
    expect(engine.resolvePlacement(item(24, 24, 'monitor-b'), [], bounds, false)).toEqual({ x: 24, y: 24 })

    engine.registerExclusionZone({
      id: 'second-zone',
      monitorId: 'monitor-a',
      rect: { x: 122, y: 24, width: 84, height: 280 },
    })
    const resolved = engine.resolvePlacement(item(24, 24), [], bounds)
    const resolvedRect = { ...resolved, width: 84, height: 96 }
    for (const zone of engine.getExclusionZones('monitor-a')) {
      expect(rectsIntersect(resolvedRect, zone.rect)).toBe(false)
    }
  })
})
