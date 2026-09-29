import { Context } from '@deepseek-ai/cordis'
import type { NativeBridgeClient } from '@deepseek-ai/dsh-native-core'
import type {
  WindowId,
  WindowRegistrySource,
  WindowSnapshot,
} from '@deepseek-ai/dsh-window-registry'
import type { WindowsContextSource } from '@deepseek-ai/dsh-windows-context'
import { describe, expect, it, vi } from 'vitest'
import WindowControlService from '../src/index.ts'

const WINDOW_ID = 'window:placement-constraints' as WindowId

const WINDOW: WindowSnapshot = {
  id: WINDOW_ID,
  hwnd: 0x4567,
  processId: 700,
  threadId: 701,
  processCreationTime: 987654321,
  executableName: 'fixture.exe',
  title: 'Constraint fixture',
  className: 'ConstraintFixture',
  bounds: { x: -200, y: 100, width: 900, height: 650 },
  classification: 'APPLICATION',
  state: 'normal',
  monitorId: 'monitor:1' as never,
  isVisible: true,
  isMinimized: false,
  isMaximized: false,
  isCloaked: false,
  isToolWindow: false,
  isShellWindow: false,
  isEnabled: true,
  isForeground: false,
  firstSeen: 1,
  updatedRevision: 1,
  generation: 1,
  capturedAt: 1,
}

function registry(getCurrent: () => WindowSnapshot | undefined = () => WINDOW): WindowRegistrySource {
  const currentWindows = () => {
    const current = getCurrent()
    return current ? [current] : []
  }
  return {
    getSnapshot: () => ({ generation: 1, revision: 1, windows: currentWindows(), capturedAt: 1 }),
    getWindows: currentWindows,
    getWindow: id => id === WINDOW_ID ? getCurrent() : undefined,
    getByHwnd: hwnd => currentWindows().find(window => window.hwnd === hwnd),
    getByProcessId: pid => currentWindows().filter(window => window.processId === pid),
    getForegroundWindow: () => undefined,
    getWindowsForMonitor: () => currentWindows(),
    refresh: async () => ({ generation: 1, revision: 1, windows: currentWindows(), capturedAt: 1 }),
    subscribe: () => () => {},
  }
}

function windowsContext(): WindowsContextSource {
  const monitor = {
    id: 'monitor:1' as never,
    deviceName: String.raw`\\.\DISPLAY1`,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    dpiX: 96,
    dpiY: 96,
    scaleFactor: 1,
    isPrimary: true,
  }
  return {
    getSnapshot: () => ({
      revision: 1,
      monitors: [monitor],
      primaryMonitorId: monitor.id,
      foreground: null,
      capturedAt: 1,
    }),
    getMonitors: () => [monitor],
    getMonitor: id => id === monitor.id ? monitor : undefined,
    getPrimaryMonitor: () => monitor,
    getForegroundContext: () => null,
    refresh: async () => ({
      revision: 1,
      monitors: [monitor],
      primaryMonitorId: monitor.id,
      foreground: null,
      capturedAt: 1,
    }),
    subscribe: () => () => {},
  }
}

async function setup(
  nativeResponse: unknown,
  options: {
    readonly getCurrent?: () => WindowSnapshot | undefined
    readonly onRequest?: () => void
  } = {},
) {
  const sendRequest = vi.fn(async () => {
    options.onRequest?.()
    return nativeResponse
  })
  const bridge = { sendRequest } as unknown as NativeBridgeClient
  const ctx = new Context()
  ctx.provide('windowRegistry')
  ctx.windowRegistry = registry(options.getCurrent) as typeof ctx.windowRegistry
  ctx.provide('windowsContext')
  ctx.windowsContext = windowsContext() as typeof ctx.windowsContext
  ctx.plugin(WindowControlService, { enabled: true, bridge })
  await new Promise(resolve => setTimeout(resolve, 10))
  return { ctx, sendRequest }
}

describe('WindowControl placement constraints', () => {
  it('queries through the same fully fenced WindowId lifetime evidence', async () => {
    const fixture = await setup({
      action: 'queryPlacementConstraints',
      hwnd: WINDOW.hwnd,
      accepted: true,
      completed: true,
      observation: {
        exists: true,
        visible: true,
        minimized: false,
        maximized: false,
        foreground: false,
        bounds: WINDOW.bounds,
      },
      placementConstraints: {
        resizable: true,
        visibleBounds: WINDOW.bounds,
        appConstraintsObserved: false,
      },
    })

    const constraints = await fixture.ctx.windowControl.getPlacementConstraints(WINDOW_ID)
    expect(constraints).toEqual({
      resizable: true,
      visibleBounds: WINDOW.bounds,
      appConstraintsObserved: false,
    })
    expect(fixture.sendRequest).toHaveBeenCalledWith('windowControl/execute', {
      action: 'queryPlacementConstraints',
      target: {
        hwnd: WINDOW.hwnd,
        processId: WINDOW.processId,
        threadId: WINDOW.threadId,
        processCreationTime: WINDOW.processCreationTime,
        className: WINDOW.className,
      },
    })

    await fixture.ctx.fiber.dispose()
  })

  it('accepts optional app min/max evidence only when native actually supplies it', async () => {
    const fixture = await setup({
      action: 'queryPlacementConstraints',
      hwnd: WINDOW.hwnd,
      accepted: true,
      completed: true,
      observation: {
        exists: true,
        visible: true,
        minimized: false,
        maximized: false,
        foreground: false,
      },
      placementConstraints: {
        resizable: true,
        minTrackWidth: 640,
        minTrackHeight: 480,
        maxTrackWidth: 1600,
        maxTrackHeight: 1200,
        visibleBounds: WINDOW.bounds,
        appConstraintsObserved: true,
      },
    })

    await expect(fixture.ctx.windowControl.getPlacementConstraints(WINDOW_ID)).resolves.toMatchObject({
      minTrackWidth: 640,
      minTrackHeight: 480,
      maxTrackWidth: 1600,
      maxTrackHeight: 1200,
      appConstraintsObserved: true,
    })

    await fixture.ctx.fiber.dispose()
  })

  it('rejects a placement query response after the WindowId lifetime changes', async () => {
    let current: WindowSnapshot | undefined = WINDOW
    const recycled: WindowSnapshot = {
      ...WINDOW,
      hwnd: WINDOW.hwnd + 1,
      processId: WINDOW.processId + 1,
      threadId: WINDOW.threadId + 1,
      processCreationTime: WINDOW.processCreationTime + 1,
      generation: WINDOW.generation + 1,
    }
    const fixture = await setup({
      action: 'queryPlacementConstraints',
      hwnd: WINDOW.hwnd,
      accepted: true,
      completed: true,
      observation: {
        exists: true,
        visible: true,
        minimized: false,
        maximized: false,
        foreground: false,
      },
      placementConstraints: {
        resizable: true,
        minTrackWidth: 640,
        minTrackHeight: 480,
        visibleBounds: WINDOW.bounds,
        appConstraintsObserved: true,
      },
    }, {
      getCurrent: () => current,
      onRequest: () => {
        current = recycled
      },
    })

    await expect(
      fixture.ctx.windowControl.getPlacementConstraints(WINDOW_ID),
    ).rejects.toMatchObject({ code: 'STALE_WINDOW_ID', retryable: true })

    await fixture.ctx.fiber.dispose()
  })

  it('rejects malformed native constraint evidence instead of guessing around it', async () => {
    const fixture = await setup({
      action: 'queryPlacementConstraints',
      hwnd: WINDOW.hwnd,
      accepted: true,
      completed: true,
      observation: {
        exists: true,
        visible: true,
        minimized: false,
        maximized: false,
        foreground: false,
      },
      placementConstraints: {
        resizable: true,
        minTrackWidth: 0,
        visibleBounds: { x: 0, y: 0, width: 0, height: 600 },
        appConstraintsObserved: true,
      },
    })

    await expect(
      fixture.ctx.windowControl.getPlacementConstraints(WINDOW_ID),
    ).rejects.toMatchObject({ code: 'PLACEMENT_CONSTRAINTS_INVALID' })

    await fixture.ctx.fiber.dispose()
  })
})
