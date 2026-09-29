import { Context } from '@deepseek-ai/cordis'
import type { NativeBridgeClient } from '@deepseek-ai/dsh-native-core'
import type {
  WindowId,
  WindowRegistrySource,
  WindowSnapshot,
} from '@deepseek-ai/dsh-window-registry'
import type {
  MonitorId,
  PhysicalPixelRect,
  WindowsContextSource,
  WindowsMonitor,
} from '@deepseek-ai/dsh-windows-context'
import { describe, expect, it, vi } from 'vitest'
import WindowControlService, { WindowControlAction, WindowControlError } from '../src/index.ts'

const WINDOW_ID = 'win_test_1' as WindowId

function windowSnapshot(overrides: Partial<WindowSnapshot> = {}): WindowSnapshot {
  return {
    id: WINDOW_ID,
    hwnd: 0x1234,
    processId: 400,
    threadId: 500,
    processCreationTime: 123456789,
    executablePath: 'C:/Windows/System32/notepad.exe',
    executableName: 'notepad.exe',
    title: 'Untitled - Notepad',
    className: 'Notepad',
    bounds: { x: 100, y: 120, width: 800, height: 600 },
    classification: 'APPLICATION',
    state: 'normal',
    monitorId: 'monitor:1' as MonitorId,
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
    ...overrides,
  }
}

function registryFor(window: WindowSnapshot | undefined): WindowRegistrySource {
  const windows = window ? [window] : []
  return {
    getSnapshot: () => ({
      generation: 1,
      revision: 1,
      windows,
      capturedAt: 1,
    }),
    getWindows: () => windows,
    getWindow: id => id === window?.id ? window : undefined,
    getByHwnd: hwnd => window?.hwnd === hwnd ? window : undefined,
    getByProcessId: pid => window?.processId === pid ? windows : [],
    getForegroundWindow: () => window?.isForeground ? window : undefined,
    getWindowsForMonitor: monitorId => window?.monitorId === monitorId ? windows : [],
    refresh: async () => ({
      generation: 1,
      revision: 1,
      windows,
      capturedAt: 1,
    }),
    subscribe: () => () => {},
  }
}

const monitors: WindowsMonitor[] = [
  {
    id: 'monitor:1' as MonitorId,
    deviceName: String.raw`\\.\DISPLAY1`,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    dpiX: 96,
    dpiY: 96,
    scaleFactor: 1,
    isPrimary: true,
  },
  {
    id: 'monitor:2' as MonitorId,
    deviceName: String.raw`\\.\DISPLAY2`,
    bounds: { x: 1920, y: 0, width: 1280, height: 1024 },
    workArea: { x: 1920, y: 0, width: 1280, height: 984 },
    dpiX: 144,
    dpiY: 144,
    scaleFactor: 1.5,
    isPrimary: false,
  },
  {
    id: 'monitor:3' as MonitorId,
    deviceName: String.raw`\\.\DISPLAY3`,
    bounds: { x: -1280, y: 0, width: 1280, height: 1024 },
    workArea: { x: -1280, y: 0, width: 1280, height: 984 },
    dpiX: 120,
    dpiY: 120,
    scaleFactor: 1.25,
    isPrimary: false,
  },
]

function windowsContext(): WindowsContextSource {
  return {
    getSnapshot: () => ({
      revision: 1,
      monitors,
      primaryMonitorId: monitors[0]!.id,
      foreground: null,
      capturedAt: 1,
    }),
    getMonitors: () => monitors,
    getMonitor: id => monitors.find(monitor => monitor.id === id),
    getPrimaryMonitor: () => monitors[0]!,
    getForegroundContext: () => null,
    refresh: async () => ({
      revision: 1,
      monitors,
      primaryMonitorId: monitors[0]!.id,
      foreground: null,
      capturedAt: 1,
    }),
    subscribe: () => () => {},
  }
}

interface MockControlRequest {
  readonly action: WindowControlAction
  readonly target: { readonly hwnd: number }
  readonly bounds?: PhysicalPixelRect | undefined
}

async function setup(window = windowSnapshot()) {
  const sendRequest = vi.fn(async (_method: string, request: MockControlRequest) => ({
    action: request.action,
    hwnd: request.target.hwnd,
    accepted: true,
    completed: true,
    observation: {
      exists: request.action !== 'close',
      visible: true,
      minimized: request.action === 'minimize',
      maximized: request.action === 'maximize',
      foreground: request.action === 'activate',
      ...(request.bounds ? { bounds: request.bounds } : {}),
    },
  }))
  const bridge = { sendRequest } as unknown as NativeBridgeClient
  const ctx = new Context()
  ctx.provide('windowRegistry')
  ctx.windowRegistry = registryFor(window) as typeof ctx.windowRegistry
  ctx.provide('windowsContext')
  ctx.windowsContext = windowsContext() as typeof ctx.windowsContext
  ctx.plugin(WindowControlService, { enabled: true, bridge })
  await new Promise(resolve => setTimeout(resolve, 10))
  return { ctx, sendRequest }
}

describe('WindowControlService', () => {
  it('dispatches WindowId commands with full lifetime evidence instead of raw HWND authority', async () => {
    const { ctx, sendRequest } = await setup()
    const result = await ctx.windowControl.activate(WINDOW_ID)

    expect(result.completed).toBe(true)
    expect(result.windowId).toBe(WINDOW_ID)
    expect(sendRequest).toHaveBeenCalledWith('windowControl/execute', {
      action: 'activate',
      target: {
        hwnd: 0x1234,
        processId: 400,
        threadId: 500,
        processCreationTime: 123456789,
        className: 'Notepad',
      },
    })

    await ctx.fiber.dispose()
  })

  it('rejects stale WindowIds and non-APPLICATION classifications before native mutation', async () => {
    const { ctx, sendRequest } = await setup()

    await expect(ctx.windowControl.activate('win_missing' as WindowId)).rejects.toMatchObject({
      code: 'STALE_WINDOW_ID',
    })
    expect(sendRequest).not.toHaveBeenCalled()
    await ctx.fiber.dispose()

    const shell = windowSnapshot({ classification: 'SHELL' })
    const second = await setup(shell)
    await expect(second.ctx.windowControl.close(WINDOW_ID)).rejects.toMatchObject({
      code: 'TARGET_NOT_APPLICATION',
    })
    expect(second.sendRequest).not.toHaveBeenCalled()
    await second.ctx.fiber.dispose()
  })

  it('supports move and resize only through validated restored physical-pixel bounds', async () => {
    const { ctx, sendRequest } = await setup()

    await ctx.windowControl.move(WINDOW_ID, -200, 300)
    expect(sendRequest).toHaveBeenLastCalledWith('windowControl/execute', expect.objectContaining({
      action: 'setBounds',
      bounds: { x: -200, y: 300, width: 800, height: 600 },
    }))

    await ctx.windowControl.resize(WINDOW_ID, 1000, 700)
    expect(sendRequest).toHaveBeenLastCalledWith('windowControl/execute', expect.objectContaining({
      action: 'setBounds',
      bounds: { x: 100, y: 120, width: 1000, height: 700 },
    }))

    await expect(ctx.windowControl.resize(WINDOW_ID, 0, 700)).rejects.toBeInstanceOf(WindowControlError)
    await ctx.fiber.dispose()

    const minimized = await setup(windowSnapshot({
      state: 'minimized',
      isMinimized: true,
    }))
    await expect(minimized.ctx.windowControl.setBounds(WINDOW_ID, {
      x: 0, y: 0, width: 500, height: 400,
    })).rejects.toMatchObject({ code: 'WINDOW_NOT_NORMAL' })
    expect(minimized.sendRequest).not.toHaveBeenCalled()
    await minimized.ctx.fiber.dispose()
  })

  it('rejects non-finite and out-of-range geometry before native dispatch', async () => {
    const { ctx, sendRequest } = await setup()
    const invalidBounds = [
      { x: Number.NaN, y: 0, width: 800, height: 600 },
      { x: 1_000_001, y: 0, width: 800, height: 600 },
      { x: 0, y: -1_000_001, width: 800, height: 600 },
      { x: 0, y: 0, width: 100_001, height: 600 },
      { x: 0, y: 0, width: 800, height: 100_001 },
    ]

    for (const bounds of invalidBounds) {
      await expect(ctx.windowControl.setBounds(WINDOW_ID, bounds)).rejects.toMatchObject({
        code: 'INVALID_BOUNDS',
      })
    }
    expect(sendRequest).not.toHaveBeenCalled()

    await ctx.fiber.dispose()
  })

  it('moves across monitors using Windows Context work areas without duplicating monitor discovery', async () => {
    const { ctx, sendRequest } = await setup(windowSnapshot({
      bounds: { x: 1700, y: 700, width: 800, height: 600 },
    }))

    await ctx.windowControl.moveToMonitor(WINDOW_ID, 'monitor:2' as MonitorId)
    expect(sendRequest).toHaveBeenLastCalledWith('windowControl/execute', expect.objectContaining({
      action: 'setBounds',
      bounds: { x: 2400, y: 384, width: 800, height: 600 },
    }))

    await ctx.windowControl.moveToMonitor(WINDOW_ID, 'monitor:2' as MonitorId, {
      placement: 'center',
    })
    expect(sendRequest).toHaveBeenLastCalledWith('windowControl/execute', expect.objectContaining({
      bounds: { x: 2160, y: 192, width: 800, height: 600 },
    }))

    await expect(
      ctx.windowControl.moveToMonitor(WINDOW_ID, 'monitor:missing' as MonitorId),
    ).rejects.toMatchObject({ code: 'UNKNOWN_MONITOR' })

    await ctx.fiber.dispose()
  })

  it('preserves valid negative virtual-screen coordinates for monitors left of primary', async () => {
    const { ctx, sendRequest } = await setup()

    await ctx.windowControl.moveToMonitor(WINDOW_ID, 'monitor:3' as MonitorId)
    expect(sendRequest).toHaveBeenLastCalledWith('windowControl/execute', expect.objectContaining({
      action: 'setBounds',
      bounds: { x: -1180, y: 120, width: 800, height: 600 },
    }))

    await ctx.windowControl.moveToMonitor(WINDOW_ID, 'monitor:3' as MonitorId, {
      placement: 'center',
    })
    expect(sendRequest).toHaveBeenLastCalledWith('windowControl/execute', expect.objectContaining({
      action: 'setBounds',
      bounds: { x: -1040, y: 192, width: 800, height: 600 },
    }))

    await ctx.fiber.dispose()
  })

  it('allows close for a hidden APPLICATION but blocks activation of hidden state', async () => {
    const { ctx, sendRequest } = await setup(windowSnapshot({
      state: 'hidden',
      isVisible: false,
    }))

    await expect(ctx.windowControl.activate(WINDOW_ID)).rejects.toMatchObject({
      code: 'WINDOW_NOT_VISIBLE',
    })
    expect(sendRequest).not.toHaveBeenCalled()

    const close = await ctx.windowControl.close(WINDOW_ID)
    expect(close.action).toBe('close')
    expect(sendRequest).toHaveBeenCalledTimes(1)

    await ctx.fiber.dispose()
  })

  it('never dispatches a native mutation when the service is disabled', async () => {
    const sendRequest = vi.fn()
    const bridge = { sendRequest } as unknown as NativeBridgeClient
    const ctx = new Context()
    ctx.provide('windowRegistry')
    ctx.windowRegistry = registryFor(windowSnapshot()) as typeof ctx.windowRegistry
    ctx.provide('windowsContext')
    ctx.windowsContext = windowsContext() as typeof ctx.windowsContext
    ctx.plugin(WindowControlService, { enabled: false, bridge })
    await new Promise(resolve => setTimeout(resolve, 10))

    await expect(ctx.windowControl.activate(WINDOW_ID)).rejects.toMatchObject({
      code: 'WINDOW_CONTROL_DISABLED',
    })
    expect(sendRequest).not.toHaveBeenCalled()

    await ctx.fiber.dispose()
  })
})
