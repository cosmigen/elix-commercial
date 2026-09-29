import { Context } from '@deepseek-ai/cordis'
import type { MonitorId, WindowsContextService, WindowsMonitor } from '@deepseek-ai/dsh-windows-context'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ShellLayoutService } from '../src/index.ts'

const testMonitor: WindowsMonitor = {
  id: 'disp-main' as MonitorId,
  deviceName: String.raw`\\.\DISPLAY1`,
  bounds: { x: 0, y: 0, width: 2560, height: 1440 },
  workArea: { x: 0, y: 0, width: 2560, height: 1400 }, // baseline with 40px taskbar
  dpiX: 120,
  dpiY: 120,
  scaleFactor: 1.25,
  isPrimary: true,
}

describe('Shell Layout - Work Area Policy and Fullscreen', () => {
  let ctx: Context
  let layout: ShellLayoutService
  let foregroundFullscreen = false

  beforeEach(async () => {
    ctx = new Context()
    foregroundFullscreen = false

    ctx.provide('windowsContext')
    ctx.windowsContext = {
      getMonitors: () => [testMonitor],
      getMonitor: (id: string) => (id === 'disp-main' ? testMonitor : undefined),
      getPrimaryMonitor: () => testMonitor,
      getForegroundContext: () => ({
        hwnd: 12345,
        title: 'App',
        processName: 'app.exe',
        monitorId: 'disp-main' as MonitorId,
        rect: { x: 0, y: 0, width: 2560, height: 1440 },
        isMaximized: false,
        isFullscreen: foregroundFullscreen,
        timestamp: Date.now(),
      }),
    } as unknown as WindowsContextService

    await ctx.plugin(ShellLayoutService, { enabled: true })
    layout = ctx.shellLayout
  })

  afterEach(async () => {
    await ctx.fiber.dispose()
  })

  it('preserves original work area when no shell reservations exist', () => {
    const computed = layout.getWorkArea('disp-main')
    expect(computed).toEqual(testMonitor.workArea)
  })

  it('subtracts multiple edge reservations from the work area', () => {
    // Top status bar 32px
    layout.registerReservation({
      id: 'top-bar',
      monitorId: 'disp-main',
      ownerId: 'bar',
      kind: 'edge',
      edge: 'top',
      rect: { x: 0, y: 0, width: 2560, height: 32 },
    })

    // Bottom dock 80px
    layout.registerReservation({
      id: 'dock',
      monitorId: 'disp-main',
      ownerId: 'dock',
      kind: 'edge',
      edge: 'bottom',
      rect: { x: 0, y: 1360, width: 2560, height: 80 },
    })

    // Left launcher 60px
    layout.registerReservation({
      id: 'launcher',
      monitorId: 'disp-main',
      ownerId: 'launcher',
      kind: 'edge',
      edge: 'left',
      rect: { x: 0, y: 0, width: 60, height: 1440 },
    })

    // Right inspector 300px
    layout.registerReservation({
      id: 'inspector',
      monitorId: 'disp-main',
      ownerId: 'panel',
      kind: 'edge',
      edge: 'right',
      rect: { x: 2260, y: 0, width: 300, height: 1440 },
    })

    const computed = layout.getWorkArea('disp-main')
    expect(computed).toEqual({
      x: 60,
      y: 32,
      width: 2560 - 60 - 300,
      height: 1400 - 32 - 80,
    })
  })

  it('does not shrink work area when reservations are hidden or exempt', () => {
    layout.registerReservation({
      id: 'hidden-dock',
      monitorId: 'disp-main',
      ownerId: 'dock',
      kind: 'edge',
      edge: 'bottom',
      rect: { x: 0, y: 1360, width: 2560, height: 80 },
      visible: false,
    })

    layout.registerReservation({
      id: 'overlay-bar',
      monitorId: 'disp-main',
      ownerId: 'overlay',
      kind: 'edge',
      edge: 'top',
      rect: { x: 0, y: 0, width: 2560, height: 40 },
      affectsWorkArea: false,
    })

    expect(layout.getWorkArea('disp-main')).toEqual(testMonitor.workArea)
  })

  it('reports fullscreen active and shell occlusion policy when foreground is fullscreen', () => {
    expect(layout.isFullscreenActive('disp-main')).toBe(false)
    expect(layout.getFullscreenPolicy('disp-main')).toEqual({
      isFullscreen: false,
      occludesShellSurfaces: false,
    })

    foregroundFullscreen = true

    expect(layout.isFullscreenActive('disp-main')).toBe(true)
    expect(layout.getFullscreenPolicy('disp-main')).toEqual({
      isFullscreen: true,
      occludesShellSurfaces: true,
    })
  })
})
