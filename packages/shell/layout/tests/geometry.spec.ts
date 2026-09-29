import { describe, expect, it } from 'vitest'
import {
  computeMonitorLayout,
  getReservationDepth,
  getUnreflectedReservationDepth,
  sortReservationsDeterministically,
} from '../src/layout-engine.ts'
import type { PhysicalPixelRect } from '@deepseek-ai/dsh-windows-context'
import type { ShellReservation } from '../src/types.ts'

function createMockReservation(params: {
  id: string
  monitorId?: string
  kind?: 'edge' | 'floating'
  edge?: 'top' | 'bottom' | 'left' | 'right'
  rect: PhysicalPixelRect
  effectiveRect?: PhysicalPixelRect
  affectsWorkArea?: boolean
  visible?: boolean
  priority?: number
  suspendInFullscreen?: boolean
}): ShellReservation {
  return {
    id: params.id,
    monitorId: params.monitorId ?? 'mon-1',
    ownerId: 'test',
    ownerGeneration: 0,
    kind: params.kind ?? 'edge',
    edge: params.edge,
    rect: params.rect,
    ...(params.effectiveRect
      ? { effectiveRect: params.effectiveRect }
      : {}),
    affectsWorkArea: params.affectsWorkArea ?? true,
    affectsHomeLayout: true,
    visible: params.visible ?? true,
    priority: params.priority ?? 0,
    conflictPolicy: 'stack',
    suspendInFullscreen: params.suspendInFullscreen ?? true,
    createdAt: 1000,
    updatedAt: 1000,
  }
}

describe('Shell Layout Geometry and Engine', () => {
  const bounds: PhysicalPixelRect = { x: 0, y: 0, width: 1920, height: 1080 }
  const originalWorkArea: PhysicalPixelRect = { x: 0, y: 0, width: 1920, height: 1040 }

  it('calculates reservation depth based on edge orientation', () => {
    const topRes = createMockReservation({
      id: 'top',
      edge: 'top',
      rect: { x: 0, y: 0, width: 1920, height: 32 },
    })
    const bottomRes = createMockReservation({
      id: 'bottom',
      edge: 'bottom',
      rect: { x: 0, y: 1000, width: 1920, height: 80 },
    })
    const leftRes = createMockReservation({
      id: 'left',
      edge: 'left',
      rect: { x: 0, y: 0, width: 64, height: 1080 },
    })
    const rightRes = createMockReservation({
      id: 'right',
      edge: 'right',
      rect: { x: 1856, y: 0, width: 64, height: 1080 },
    })
    const floatingRes = createMockReservation({
      id: 'float',
      kind: 'floating',
      rect: { x: 100, y: 100, width: 200, height: 200 },
    })

    expect(getReservationDepth(topRes)).toBe(32)
    expect(getReservationDepth(bottomRes)).toBe(80)
    expect(getReservationDepth(leftRes)).toBe(64)
    expect(getReservationDepth(rightRes)).toBe(64)
    expect(getReservationDepth(floatingRes)).toBe(0)
  })

  it('sorts reservations deterministically by priority descending and ID ascending', () => {
    const r1 = createMockReservation({ id: 'z-res', priority: 5, rect: { x: 0, y: 0, width: 100, height: 40 } })
    const r2 = createMockReservation({ id: 'a-res', priority: 10, rect: { x: 0, y: 0, width: 100, height: 40 } })
    const r3 = createMockReservation({ id: 'b-res', priority: 5, rect: { x: 0, y: 0, width: 100, height: 40 } })

    const sorted = sortReservationsDeterministically([r1, r2, r3])
    expect(sorted.map(r => r.id)).toEqual(['a-res', 'b-res', 'z-res'])
  })

  it('computes edge thicknesses and shrunk work area accurately', () => {
    const topBar = createMockReservation({
      id: 'status-bar',
      edge: 'top',
      rect: { x: 0, y: 0, width: 1920, height: 30 },
    })
    const dock = createMockReservation({
      id: 'dock',
      edge: 'bottom',
      rect: { x: 0, y: 1010, width: 1920, height: 70 },
    })
    const sidebar = createMockReservation({
      id: 'sidebar',
      edge: 'left',
      rect: { x: 0, y: 0, width: 50, height: 1080 },
    })

    const layout = computeMonitorLayout('mon-1', bounds, originalWorkArea, [topBar, dock, sidebar])

    expect(layout.edgeThickness).toEqual({
      top: 30,
      bottom: 70,
      left: 50,
      right: 0,
    })
    expect(layout.computedWorkArea).toEqual({
      x: 50,
      y: 30,
      width: 1920 - 50,
      height: 1040 - 30 - 70,
    })
  })

  it('does not double-subtract a native AppBar already reflected by Windows work area', () => {
    const topBar = createMockReservation({
      id: 'native-top',
      edge: 'top',
      rect: { x: 0, y: 0, width: 1920, height: 40 },
      effectiveRect: { x: 0, y: 0, width: 1920, height: 40 },
    })

    const windowsWorkArea: PhysicalPixelRect = {
      x: 0,
      y: 40,
      width: 1920,
      height: 1000,
    }

    expect(getUnreflectedReservationDepth(topBar, windowsWorkArea)).toBe(0)

    const layout = computeMonitorLayout(
      'mon-1',
      bounds,
      windowsWorkArea,
      [topBar],
    )

    expect(layout.edgeThickness.top).toBe(40)
    expect(layout.computedWorkArea).toEqual(windowsWorkArea)
  })

  it('applies only the native reservation delta that Windows has not reflected yet', () => {
    const updatedTopBar = createMockReservation({
      id: 'native-top-update',
      edge: 'top',
      rect: { x: 0, y: 0, width: 1920, height: 52 },
      effectiveRect: {
        x: 0,
        y: 0,
        width: 1920,
        height: 52,
      },
    })

    const transitioningWorkArea: PhysicalPixelRect = {
      x: 0,
      y: 40,
      width: 1920,
      height: 1000,
    }

    expect(getUnreflectedReservationDepth(updatedTopBar, transitioningWorkArea)).toBe(12)

    const layout = computeMonitorLayout(
      'mon-1',
      bounds,
      transitioningWorkArea,
      [updatedTopBar],
    )

    expect(layout.edgeThickness.top).toBe(52)
    expect(layout.computedWorkArea).toEqual({
      x: 0,
      y: 52,
      width: 1920,
      height: 988,
    })
  })

  it('clamps work area dimensions when reservations exceed monitor bounds', () => {
    const giantTop = createMockReservation({
      id: 'giant-top',
      edge: 'top',
      rect: { x: 0, y: 0, width: 1920, height: 600 },
    })
    const giantBottom = createMockReservation({
      id: 'giant-bottom',
      edge: 'bottom',
      rect: { x: 0, y: 480, width: 1920, height: 600 },
    })

    const layout = computeMonitorLayout('mon-1', bounds, bounds, [giantTop, giantBottom])

    expect(layout.computedWorkArea.height).toBe(0)
    expect(layout.computedWorkArea.width).toBe(1920)
    expect(layout.computedWorkArea.height).toBeGreaterThanOrEqual(0)
    expect(layout.computedWorkArea.width).toBeGreaterThanOrEqual(0)
  })

  it('ignores floating and non-affecting reservations when calculating work area', () => {
    const floating = createMockReservation({
      id: 'float-panel',
      kind: 'floating',
      rect: { x: 500, y: 500, width: 400, height: 300 },
      affectsWorkArea: false,
    })
    const hiddenEdge = createMockReservation({
      id: 'hidden-bar',
      edge: 'top',
      rect: { x: 0, y: 0, width: 1920, height: 50 },
      visible: false,
    })
    const workAreaExemptEdge = createMockReservation({
      id: 'overlay-bar',
      edge: 'bottom',
      rect: { x: 0, y: 1000, width: 1920, height: 80 },
      affectsWorkArea: false,
    })

    const layout = computeMonitorLayout('mon-1', bounds, originalWorkArea, [
      floating,
      hiddenEdge,
      workAreaExemptEdge,
    ])

    expect(layout.edgeThickness).toEqual({ top: 0, bottom: 0, left: 0, right: 0 })
    expect(layout.computedWorkArea).toEqual(originalWorkArea)
  })

  it('suspends eligible reservations during fullscreen without mutating persistent intent', () => {
    const dock = createMockReservation({
      id: 'fullscreen-dock',
      edge: 'bottom',
      rect: { x: 0, y: 980, width: 1920, height: 60 },
      suspendInFullscreen: true,
    })

    const suspended = computeMonitorLayout(
      'mon-1',
      bounds,
      originalWorkArea,
      [dock],
      true,
    )

    expect(suspended.edgeThickness.bottom).toBe(0)
    expect(suspended.computedWorkArea).toEqual(originalWorkArea)
    expect(suspended.reservations).toHaveLength(0)
    expect(dock.visible).toBe(true)

    const persistent = createMockReservation({
      id: 'persistent-edge',
      edge: 'top',
      rect: { x: 0, y: 0, width: 1920, height: 20 },
      suspendInFullscreen: false,
    })

    const retained = computeMonitorLayout(
      'mon-1',
      bounds,
      originalWorkArea,
      [persistent],
      true,
    )

    expect(retained.edgeThickness.top).toBe(20)
  })
})
