import { Context } from '@deepseek-ai/cordis'
import { HomeLayoutEngine, type HomeService } from '@deepseek-ai/dsh-home'
import type { MonitorId, WindowsContextChange, WindowsMonitor } from '@deepseek-ai/dsh-windows-context'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ShellLayoutService } from '../src/index.ts'

const primaryMonitor: WindowsMonitor = {
  id: 'disp-primary' as MonitorId,
  deviceName: String.raw`\\.\DISPLAY1`,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
  dpiX: 96,
  dpiY: 96,
  scaleFactor: 1,
  isPrimary: true,
}

const leftSecondaryMonitor: WindowsMonitor = {
  id: 'disp-left-secondary' as MonitorId,
  deviceName: String.raw`\\.\DISPLAY2`,
  bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
  workArea: { x: -1920, y: 0, width: 1920, height: 1080 },
  dpiX: 144,
  dpiY: 144,
  scaleFactor: 1.5,
  isPrimary: false,
}

describe('Shell Layout - Multi-Monitor and Negative Coordinates', () => {
  let ctx: Context
  let layout: ShellLayoutService

  beforeEach(async () => {
    ctx = new Context()
    await ctx.plugin(ShellLayoutService, { enabled: true })
    layout = ctx.shellLayout

    layout.registerSyntheticMonitor(primaryMonitor)
    layout.registerSyntheticMonitor(leftSecondaryMonitor)
  })

  afterEach(async () => {
    await ctx.fiber.dispose()
  })

  it('isolates reservations between separate monitors', () => {
    // Register dock only on primary monitor
    layout.registerReservation({
      id: 'primary-dock',
      monitorId: 'disp-primary',
      ownerId: 'dock',
      kind: 'edge',
      edge: 'bottom',
      rect: { x: 0, y: 980, width: 1920, height: 60 },
    })

    const primaryLayout = layout.getMonitorLayout('disp-primary')
    const secondaryLayout = layout.getMonitorLayout('disp-left-secondary')

    expect(primaryLayout).toBeDefined()
    expect(secondaryLayout).toBeDefined()

    // Primary has bottom dock reservation
    expect(primaryLayout?.edgeThickness.bottom).toBe(60)
    expect(primaryLayout?.computedWorkArea).toEqual({
      x: 0,
      y: 0,
      width: 1920,
      height: 1040 - 60,
    })

    // Secondary monitor is completely untouched
    expect(secondaryLayout?.edgeThickness.bottom).toBe(0)
    expect(secondaryLayout?.computedWorkArea).toEqual(leftSecondaryMonitor.workArea)
  })

  it('applies monitorId: "all" reservations across all connected displays with per-monitor derived geometry', () => {
    layout.registerReservation({
      id: 'global-status-bar',
      monitorId: 'all',
      ownerId: 'status-bar',
      kind: 'edge',
      edge: 'top',
      rect: { x: 0, y: 0, width: 1920, height: 32 },
    })

    const primaryLayout = layout.getMonitorLayout('disp-primary')
    const secondaryLayout = layout.getMonitorLayout('disp-left-secondary')

    expect(primaryLayout?.edgeThickness.top).toBe(32)
    expect(secondaryLayout?.edgeThickness.top).toBe(32)

    expect(primaryLayout?.computedWorkArea.y).toBe(32)
    expect(secondaryLayout?.computedWorkArea.y).toBe(32)

    // Crucial: Primary reservation rect is on primary monitor (x: 0)
    expect(primaryLayout?.reservations[0]?.rect).toEqual({ x: 0, y: 0, width: 1920, height: 32 })
    // Secondary reservation rect is derived from secondary monitor bounds (x: -1920)
    expect(secondaryLayout?.reservations[0]?.rect).toEqual({ x: -1920, y: 0, width: 1920, height: 32 })
  })

  it('suspends reservations when monitor is removed and restores deterministically when re-added', () => {
    // 1. Register reservation on secondary monitor
    layout.registerReservation({
      id: 'secondary-dock',
      monitorId: 'disp-left-secondary',
      ownerId: 'dock',
      kind: 'edge',
      edge: 'bottom',
      rect: { x: -1920, y: 1020, width: 1920, height: 60 },
    })

    // Register reservation on primary monitor
    layout.registerReservation({
      id: 'primary-dock',
      monitorId: 'disp-primary',
      ownerId: 'dock',
      kind: 'edge',
      edge: 'bottom',
      rect: { x: 0, y: 980, width: 1920, height: 60 },
    })

    expect(layout.getMonitorLayout('disp-left-secondary')?.edgeThickness.bottom).toBe(60)
    expect(layout.getMonitorLayout('disp-primary')?.edgeThickness.bottom).toBe(60)

    // 2. Remove secondary monitor
    layout.removeSyntheticMonitor('disp-left-secondary')

    // Disconnected monitor returns undefined layout
    expect(layout.getMonitorLayout('disp-left-secondary')).toBeUndefined()
    // Unaffected primary monitor is completely undisturbed
    expect(layout.getMonitorLayout('disp-primary')?.edgeThickness.bottom).toBe(60)
    // Desired state preserved in registry
    expect(layout.getReservation('secondary-dock')).toBeDefined()

    // 3. Re-add secondary monitor
    layout.registerSyntheticMonitor(leftSecondaryMonitor)

    // Restores deterministically
    const restoredSecondary = layout.getMonitorLayout('disp-left-secondary')
    expect(restoredSecondary).toBeDefined()
    expect(restoredSecondary?.edgeThickness.bottom).toBe(60)
    expect(restoredSecondary?.computedWorkArea.height).toBe(1080 - 60)
    // Primary still undisturbed
    expect(layout.getMonitorLayout('disp-primary')?.edgeThickness.bottom).toBe(60)
  })

  it('handles negative virtual-screen coordinates accurately', () => {
    // Secondary monitor is at x: -1920, y: 0
    // Place a left-dock on the secondary monitor (width 60)
    layout.registerReservation({
      id: 'secondary-left-bar',
      monitorId: 'disp-left-secondary',
      ownerId: 'launcher',
      kind: 'edge',
      edge: 'left',
      rect: { x: -1920, y: 0, width: 60, height: 1080 },
    })

    const secondaryLayout = layout.getMonitorLayout('disp-left-secondary')
    expect(secondaryLayout).toBeDefined()
    expect(secondaryLayout?.edgeThickness.left).toBe(60)

    // Inward shrinkage from x: -1920
    expect(secondaryLayout?.computedWorkArea).toEqual({
      x: -1920 + 60,
      y: 0,
      width: 1920 - 60,
      height: 1080,
    })
  })

  it('emits topology change events when monitors are added or removed', () => {
    const onLayoutChanged = vi.fn()
    layout.subscribe(onLayoutChanged)

    const thirdMonitor: WindowsMonitor = {
      id: 'disp-third' as MonitorId,
      deviceName: String.raw`\\.\DISPLAY3`,
      bounds: { x: 1920, y: 0, width: 1920, height: 1080 },
      workArea: { x: 1920, y: 0, width: 1920, height: 1080 },
      dpiX: 96,
      dpiY: 96,
      scaleFactor: 1,
      isPrimary: false,
    }

    // Add monitor
    layout.registerSyntheticMonitor(thirdMonitor)
    expect(onLayoutChanged).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'topology',
        monitorId: 'disp-third',
        affectedMonitorIds: ['disp-third'],
      }),
    )

    // Remove monitor
    layout.removeSyntheticMonitor('disp-third')
    expect(onLayoutChanged).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'topology',
        monitorId: 'disp-third',
        affectedMonitorIds: ['disp-third'],
      }),
    )
    expect(layout.getMonitorLayout('disp-third')).toBeUndefined()
  })

  it('does not leak physical coordinates across monitors when reconciling native approved rect for monitorId: all', () => {
    const homeEngine = new HomeLayoutEngine()
    ctx.provide('home')
    ctx.home = {
      layout: homeEngine,
    } as unknown as HomeService

    layout.registerReservation({
      id: 'global-bar',
      monitorId: 'all',
      ownerId: 'status-bar',
      kind: 'edge',
      edge: 'top',
      rect: { x: 0, y: 0, width: 1920, height: 32 },
    })

    // Simulate native reconciliation callback for secondary monitor (at x: -1920)
    layout.reconcileNativeApprovedRect('global-bar::disp-left-secondary', {
      x: -1920,
      y: 0,
      width: 1920,
      height: 40,
    })

    const zonesPrimary = homeEngine.getExclusionZones('disp-primary')
    const zonesSecondary = homeEngine.getExclusionZones('disp-left-secondary')

    expect(zonesPrimary).toHaveLength(1)
    expect(zonesSecondary).toHaveLength(1)

    // Primary monitor must NOT inherit x: -1920 from secondary monitor!
    expect(zonesPrimary[0]?.rect.x).toBe(0)
    expect(zonesPrimary[0]?.rect.height).toBe(40)

    // Secondary monitor has its correct origin
    expect(zonesSecondary[0]?.rect.x).toBe(-1920)
    expect(zonesSecondary[0]?.rect.height).toBe(40)
  })

  it('preserves synthetic monitors when a windows-context change event occurs', async () => {
    expect(layout.getMonitorLayout('disp-left-secondary')).toBeDefined()

    const contextChange: WindowsContextChange = {
      revision: 10,
      reason: 'foreground',
      snapshot: {
        revision: 10,
        monitors: [primaryMonitor],
        primaryMonitorId: primaryMonitor.id,
        foreground: null,
        capturedAt: Date.now(),
      },
    }

    ctx.emit('windows-context/change', contextChange)
    await new Promise(resolve => setTimeout(resolve, 30))

    // Synthetic monitor disp-left-secondary must still be preserved!
    expect(layout.getMonitorLayout('disp-left-secondary')).toBeDefined()
    expect(layout.getMonitorLayout('disp-primary')).toBeDefined()
  })

  it('re-derives monitorId: all reservation geometry when monitor bounds change', () => {
    layout.registerReservation({
      id: 'dynamic-bar',
      monitorId: 'all',
      ownerId: 'dock',
      kind: 'edge',
      edge: 'bottom',
      rect: { x: 0, y: 0, width: 1920, height: 50 },
    })

    const initialSecondary = layout.getMonitorLayout('disp-left-secondary')
    expect(initialSecondary?.edgeThickness.bottom).toBe(50)
    expect(initialSecondary?.reservations[0]?.rect.y).toBe(1080 - 50)

    // Re-register secondary monitor with 1440p height
    const resizedSecondary: WindowsMonitor = {
      ...leftSecondaryMonitor,
      bounds: { x: -1920, y: 0, width: 1920, height: 1440 },
      workArea: { x: -1920, y: 0, width: 1920, height: 1440 },
    }
    layout.registerSyntheticMonitor(resizedSecondary)

    const updatedSecondary = layout.getMonitorLayout('disp-left-secondary')
    expect(updatedSecondary?.edgeThickness.bottom).toBe(50)
    expect(updatedSecondary?.reservations[0]?.rect.y).toBe(1440 - 50)
  })
})
