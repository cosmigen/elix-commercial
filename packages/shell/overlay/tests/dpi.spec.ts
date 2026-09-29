import { describe, expect, it } from 'vitest'
import type { MonitorId, WindowsMonitor } from '@deepseek-ai/dsh-windows-context'
import {
  createTestEnvironment,
  SAMPLE_MENU_DEF,
} from './test-utils.ts'
import type { OverlayPlacementChangedEvent } from '../src/types.ts'

describe('Overlay Synthetic DPI Scaling (100%, 125%, 150%, 200%)', () => {
  // 100% scaling: 96 DPI, 1920x1080
  const MONITOR_100: WindowsMonitor = {
    id: 'mon-100' as MonitorId,
    deviceName: 'DISPLAY-100',
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    dpiX: 96,
    dpiY: 96,
    scaleFactor: 1.0,
    isPrimary: true,
  }

  // 125% scaling: 120 DPI, 2400x1350
  const MONITOR_125: WindowsMonitor = {
    id: 'mon-125' as MonitorId,
    deviceName: 'DISPLAY-125',
    bounds: { x: 1920, y: 0, width: 2400, height: 1350 },
    workArea: { x: 1920, y: 0, width: 2400, height: 1300 },
    dpiX: 120,
    dpiY: 120,
    scaleFactor: 1.25,
    isPrimary: false,
  }

  // 150% scaling: 144 DPI, 2880x1620
  const MONITOR_150: WindowsMonitor = {
    id: 'mon-150' as MonitorId,
    deviceName: 'DISPLAY-150',
    bounds: { x: 4320, y: 0, width: 2880, height: 1620 },
    workArea: { x: 4320, y: 0, width: 2880, height: 1560 },
    dpiX: 144,
    dpiY: 144,
    scaleFactor: 1.5,
    isPrimary: false,
  }

  // 200% scaling: 192 DPI, 3840x2160 (4K display)
  const MONITOR_200: WindowsMonitor = {
    id: 'mon-200' as MonitorId,
    deviceName: 'DISPLAY-200',
    bounds: { x: 7200, y: 0, width: 3840, height: 2160 },
    workArea: { x: 7200, y: 0, width: 3840, height: 2080 },
    dpiX: 192,
    dpiY: 192,
    scaleFactor: 2.0,
    isPrimary: false,
  }

  it('correctly places overlays across heterogeneous displays with 100%, 125%, 150%, and 200% DPI without double scaling', async () => {
    const { ctx } = await createTestEnvironment([
      MONITOR_100,
      MONITOR_125,
      MONITOR_150,
      MONITOR_200,
    ])
    ctx.overlay.register(SAMPLE_MENU_DEF)

    // 1. Open on 100% monitor (scale 1.0)
    const inst100 = await ctx.overlay.open({
      definitionId: SAMPLE_MENU_DEF.id,
      anchor: { type: 'point', x: 500, y: 500 },
    })
    expect(inst100.monitorId).toBe('mon-100')
    expect(inst100.actualBounds.x).toBe(500)
    expect(inst100.actualBounds.y).toBe(504)
    expect(inst100.actualBounds.width).toBe(220)
    expect(inst100.actualBounds.height).toBe(300)

    // 2. Open on 125% monitor (scale 1.25)
    const inst125 = await ctx.overlay.open({
      definitionId: SAMPLE_MENU_DEF.id,
      anchor: { type: 'point', x: 2500, y: 600 },
    })
    expect(inst125.monitorId).toBe('mon-125')
    expect(inst125.actualBounds.x).toBe(2500)
    expect(inst125.actualBounds.y).toBe(604)
    expect(inst125.actualBounds.width).toBe(220)
    expect(inst125.actualBounds.height).toBe(300)

    // 3. Open on 150% monitor (scale 1.5)
    const inst150 = await ctx.overlay.open({
      definitionId: SAMPLE_MENU_DEF.id,
      anchor: { type: 'point', x: 5000, y: 700 },
    })
    expect(inst150.monitorId).toBe('mon-150')
    expect(inst150.actualBounds.x).toBe(5000)
    expect(inst150.actualBounds.y).toBe(704)
    expect(inst150.actualBounds.width).toBe(220)
    expect(inst150.actualBounds.height).toBe(300)

    // 4. Open on 200% 4K monitor (scale 2.0)
    const inst200 = await ctx.overlay.open({
      definitionId: SAMPLE_MENU_DEF.id,
      anchor: { type: 'point', x: 8000, y: 800 },
    })
    expect(inst200.monitorId).toBe('mon-200')
    expect(inst200.actualBounds.x).toBe(8000)
    expect(inst200.actualBounds.y).toBe(804)
    expect(inst200.actualBounds.width).toBe(220)
    expect(inst200.actualBounds.height).toBe(300)

    await ctx.overlay.closeAll()
  })

  it('repositions overlays safely when monitor DPI changes dynamically on the fly', async () => {
    const { ctx, setMonitors } = await createTestEnvironment([MONITOR_100])
    ctx.overlay.register(SAMPLE_MENU_DEF)

    const events: OverlayPlacementChangedEvent[] = []
    ctx.on('overlay/placement-changed', ev => events.push(ev))

    // Open popup near bottom right of 100% monitor (1920x1080)
    const inst = await ctx.overlay.open({
      definitionId: SAMPLE_MENU_DEF.id,
      anchor: { type: 'point', x: 1800, y: 800 },
      placement: 'bottom-start',
    })

    // At 100%: maxY = 1040. 800 + 4 + 300 = 1104 > 1040, so it flips to top: 800 - 4 - 300 = 496
    // And x: 1800 + 220 = 2020 > 1920, so shifts left to 1700
    expect(inst.actualBounds.y).toBe(496)
    expect(inst.actualBounds.x).toBe(1700)

    // Simulate display scaling change: resolution changes to 4K at 200% (bounds 3840x2160, workArea 3840x2080)
    const updatedMonitor200: WindowsMonitor = {
      ...MONITOR_100,
      bounds: { x: 0, y: 0, width: 3840, height: 2160 },
      workArea: { x: 0, y: 0, width: 3840, height: 2080 },
      dpiX: 192,
      dpiY: 192,
      scaleFactor: 2.0,
    }

    setMonitors([updatedMonitor200])

    ctx.emit('windows-context/change', {
      revision: 2,
      reason: 'dpi',
      snapshot: {
        revision: 2,
        monitors: [updatedMonitor200],
        primaryMonitorId: updatedMonitor200.id,
        foreground: null,
        capturedAt: Date.now(),
      },
    })

    // Wait for microtask reposition
    await new Promise(r => setTimeout(r, 20))

    const refreshed = ctx.overlay.getInstance(inst.instanceId)
    expect(refreshed).toBeDefined()
    expect(events.length).toBeGreaterThanOrEqual(1)

    // On 4K display, at x=1800, y=800:
    // spaceBelow = 2080 - (800 + 0 + 4) = 1276 >= 300, so it no longer needs to flip to top!
    // And x=1800: 1800 + 220 = 2020 <= 3840, so it no longer needs to shift left!
    expect(refreshed?.actualBounds.x).toBe(1800)
    expect(refreshed?.actualBounds.y).toBe(804)

    await ctx.overlay.closeAll()
  })
})
