import { Context } from '@deepseek-ai/cordis'
import type { NativeAppBarSpec, NativeBridgeClient } from '@deepseek-ai/dsh-native-core'
import type {
  ForegroundWindowContext,
  MonitorId,
  WindowsContextChange,
  WindowsContextService,
  WindowsMonitor,
} from '@deepseek-ai/dsh-windows-context'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NativeWorkAreaSync, ShellLayoutService } from '../src/index.ts'

const monitor: WindowsMonitor = {
  id: 'native-authority-monitor' as MonitorId,
  deviceName: String.raw`\\.\DISPLAY1`,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
  dpiX: 96,
  dpiY: 96,
  scaleFactor: 1,
  isPrimary: true,
}

function foreground(isFullscreen: boolean): ForegroundWindowContext {
  return {
    nativeId: 'hwnd:1234',
    processId: 123,
    threadId: 456,
    monitorId: monitor.id,
    bounds: { ...monitor.bounds },
    isVisible: true,
    isMinimized: false,
    isCloaked: false,
    isToolWindow: false,
    isShellWindow: false,
    isFullscreen,
    ...(isFullscreen ? { fullscreenReason: 'test' } : {}),
  }
}

function change(revision: number, isFullscreen: boolean): WindowsContextChange {
  return {
    revision,
    reason: 'fullscreen',
    snapshot: {
      revision,
      monitors: [monitor],
      primaryMonitorId: monitor.id,
      foreground: foreground(isFullscreen),
      capturedAt: Date.now(),
    },
  }
}

describe('Shell Layout - Native Authority and Recovery', () => {
  let ctx: Context
  let bridge: NativeBridgeClient
  let currentForeground: ForegroundWindowContext | null

  beforeEach(() => {
    ctx = new Context()
    currentForeground = foreground(false)

    ctx.provide('windowsContext')
    ctx.windowsContext = {
      getMonitors: () => [monitor],
      getMonitor: (id: MonitorId) => (id === monitor.id ? monitor : undefined),
      getPrimaryMonitor: () => monitor,
      getForegroundContext: () => currentForeground,
    } as unknown as WindowsContextService

    bridge = {
      appBar: {
        register: vi.fn(async (spec: NativeAppBarSpec) => ({ ...spec.rect })),
        unregister: vi.fn(async () => true),
        getRegistered: vi.fn(async () => []),
      },
    } as unknown as NativeBridgeClient
  })

  afterEach(async () => {
    await ctx.fiber.dispose()
  })

  it('overlay mode releases native AppBar ownership and coexistence reacquires it once', async () => {
    await ctx.plugin(ShellLayoutService, {
      enabled: true,
      syncNativeWorkArea: true,
      bridge,
    })
    const layout = ctx.shellLayout

    layout.registerReservation({
      id: 'native-mode-dock',
      monitorId: monitor.id,
      ownerId: 'dock',
      ownerGeneration: 1,
      kind: 'edge',
      edge: 'bottom',
      rect: { x: 0, y: 992, width: 1920, height: 48 },
    })

    await new Promise(resolve => setTimeout(resolve, 20))
    expect(bridge.appBar.register).toHaveBeenCalledTimes(1)

    layout.setShellMode('overlay')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(bridge.appBar.unregister).toHaveBeenCalledWith('native-mode-dock')

    layout.setShellMode('coexistence')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(bridge.appBar.register).toHaveBeenCalledTimes(2)
  })

  it('fullscreen suspends native ownership and restores exactly once without changing desired visibility', async () => {
    await ctx.plugin(ShellLayoutService, {
      enabled: true,
      syncNativeWorkArea: true,
      bridge,
    })
    const layout = ctx.shellLayout

    layout.registerReservation({
      id: 'fullscreen-native-dock',
      monitorId: monitor.id,
      ownerId: 'dock',
      ownerGeneration: 1,
      kind: 'edge',
      edge: 'bottom',
      rect: { x: 0, y: 992, width: 1920, height: 48 },
      suspendInFullscreen: true,
    })

    await new Promise(resolve => setTimeout(resolve, 20))
    expect(bridge.appBar.register).toHaveBeenCalledTimes(1)

    currentForeground = foreground(true)
    ctx.emit('windows-context/change', change(2, true))
    await new Promise(resolve => setTimeout(resolve, 30))

    expect(bridge.appBar.unregister).toHaveBeenCalledWith('fullscreen-native-dock')
    expect(layout.getReservation('fullscreen-native-dock')?.visible).toBe(true)
    expect(layout.getWorkArea(monitor.id)).toEqual(monitor.workArea)

    currentForeground = foreground(false)
    ctx.emit('windows-context/change', change(3, false))
    await new Promise(resolve => setTimeout(resolve, 30))

    expect(bridge.appBar.register).toHaveBeenCalledTimes(2)
    expect(layout.getReservation('fullscreen-native-dock')?.visible).toBe(true)
  })

  it('native reconciliation unregisters stale tracked IDs before reapplying the desired set', async () => {
    const nativeSync = new NativeWorkAreaSync(bridge, true)

    await nativeSync.syncReservation({
      id: 'stale-native-id',
      edge: 'top',
      rect: { x: 0, y: 0, width: 1920, height: 20 },
      affectsWorkArea: true,
      visible: true,
      kind: 'edge',
    })

    expect(nativeSync.getActiveIds()).toEqual(['stale-native-id'])

    await nativeSync.reconcileAll([])

    expect(bridge.appBar.unregister).toHaveBeenCalledWith('stale-native-id')
    expect(nativeSync.getActiveIds()).toEqual([])
    await nativeSync.dispose()
  })

  it('serializes rapid updates so an older completion cannot remove the latest reservation', async () => {
    let resolveFirst: ((rect: NativeAppBarSpec['rect']) => void) | undefined
    const register = vi.fn()
      .mockImplementationOnce(() => new Promise<NativeAppBarSpec['rect']>((resolve) => {
        resolveFirst = resolve
      }))
      .mockImplementationOnce(async (spec: NativeAppBarSpec) => ({ ...spec.rect }))
    bridge.appBar.register = register
    const approved = vi.fn()
    const nativeSync = new NativeWorkAreaSync(bridge, true, approved)

    const first = nativeSync.syncReservation({
      id: 'rapid-update',
      edge: 'top',
      rect: { x: 0, y: 0, width: 1920, height: 40 },
      affectsWorkArea: true,
      visible: true,
      kind: 'edge',
    })
    await Promise.resolve()
    expect(register).toHaveBeenCalledTimes(1)

    const second = nativeSync.syncReservation({
      id: 'rapid-update',
      edge: 'top',
      rect: { x: 0, y: 0, width: 1920, height: 52 },
      affectsWorkArea: true,
      visible: true,
      kind: 'edge',
    })

    resolveFirst?.({ x: 0, y: 0, width: 1920, height: 40 })
    await expect(first).resolves.toBeUndefined()
    await expect(second).resolves.toEqual({ x: 0, y: 0, width: 1920, height: 52 })
    expect(register).toHaveBeenCalledTimes(2)
    expect(bridge.appBar.unregister).not.toHaveBeenCalled()
    expect(approved).toHaveBeenCalledOnce()
    expect(approved).toHaveBeenCalledWith('rapid-update', { x: 0, y: 0, width: 1920, height: 52 })
    expect(nativeSync.getActiveIds()).toEqual(['rapid-update'])
    await nativeSync.dispose()
  })

  it('reconcileBoundaries is idempotent for one valid owner-generation lease', async () => {
    await ctx.plugin(ShellLayoutService, {
      enabled: true,
      syncNativeWorkArea: true,
      bridge,
    })
    const layout = ctx.shellLayout

    layout.registerReservation({
      id: 'reconcile-native-dock',
      monitorId: monitor.id,
      ownerId: 'dock',
      ownerGeneration: 9,
      kind: 'edge',
      edge: 'bottom',
      rect: { x: 0, y: 992, width: 1920, height: 48 },
    })

    await layout.reconcileBoundaries()
    await layout.reconcileBoundaries()

    expect(layout.getReservations()).toHaveLength(1)
    expect(layout.getReservation('reconcile-native-dock')?.ownerGeneration).toBe(9)
    expect(layout.getBoundaryConflicts()).toEqual([])
  })
})
