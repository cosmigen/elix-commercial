import { Context } from '@deepseek-ai/cordis'
import type {
  NativeBridgeClient,
  NativeSurfaceEvent,
  NativeSurfaceSnapshot,
} from '@deepseek-ai/dsh-native-core'
import type { WindowsContextService } from '@deepseek-ai/dsh-windows-context'
import { describe, expect, it, vi } from 'vitest'
import { SurfaceService } from '../src/index.ts'
import type {
  PhysicalBounds,
  SurfaceCreateOptions,
  SurfaceZOrderPolicy,
} from '../src/types.ts'

function mockSnapshot(overrides?: Partial<NativeSurfaceSnapshot>): NativeSurfaceSnapshot {
  return {
    id: 'test-surface',
    hwnd: 12345,
    bounds: { x: 100, y: 100, width: 800, height: 600 },
    state: 'NATIVE_CREATED',
    visible: false,
    dpi: 96,
    scaleFactor: 1.0,
    focusPolicy: 'normal',
    zOrderPolicy: 'normal',
    monitorId: 'primary-monitor',
    ...overrides,
  }
}

describe('SurfaceService', () => {
  it('registers ctx.surface, creates surfaces, and cleans up on disposal', async () => {
    let eventListener: ((event: NativeSurfaceEvent) => void) | undefined
    const disposeSub = vi.fn(async () => true)

    const mockBridge = {
      surface: {
        onEvent: vi.fn((listener: (event: NativeSurfaceEvent) => void) => {
          eventListener = listener
          return { dispose: disposeSub }
        }),
        create: vi.fn(async (opts: SurfaceCreateOptions) => {
          return mockSnapshot({ id: opts.id, bounds: opts.bounds })
        }),
        show: vi.fn(async (id: string) => {
          return mockSnapshot({ id, visible: true, state: 'VISIBLE' })
        }),
        hide: vi.fn(async (id: string) => {
          return mockSnapshot({ id, visible: false, state: 'HIDDEN' })
        }),
        setBounds: vi.fn(async (id: string, bounds: PhysicalBounds) => {
          return mockSnapshot({ id, bounds })
        }),
        setZOrder: vi.fn(async (id: string, zOrderPolicy: SurfaceZOrderPolicy) => {
          return mockSnapshot({ id, zOrderPolicy })
        }),
        navigate: vi.fn(async (id: string) => {
          return mockSnapshot({ id })
        }),
        reload: vi.fn(async (id: string) => {
          return mockSnapshot({ id })
        }),
        markReady: vi.fn(async (id: string) => {
          return mockSnapshot({ id, state: 'READY' })
        }),
        destroy: vi.fn(async () => true),
        runtimeStatus: vi.fn(async () => ({ available: true, version: '152.0.4191.66' })),
      },
    } as unknown as NativeBridgeClient

    const ctx = new Context()
    const createdEvents: string[] = []
    const readyEvents: string[] = []
    const shownEvents: string[] = []

    ctx.on('surface/created', s => createdEvents.push(s.id))
    ctx.on('surface/ready', s => readyEvents.push(s.id))
    ctx.on('surface/shown', s => shownEvents.push(s.id))

    ctx.plugin(SurfaceService, { enabled: true, bridge: mockBridge })
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(ctx.surface).toBeDefined()

    const runtimeStatus = await ctx.surface.getRuntimeStatus()
    expect(runtimeStatus.available).toBe(true)
    expect(runtimeStatus.version).toBe('152.0.4191.66')

    // Create a surface
    const surface = await ctx.surface.create({
      id: 'surf-1',
      bounds: { x: 50, y: 50, width: 640, height: 480 },
    })

    expect(surface.id).toBe('surf-1')
    expect(surface.bounds).toEqual({ x: 50, y: 50, width: 640, height: 480 })
    expect(surface.isVisible).toBe(false)
    expect(createdEvents).toEqual(['surf-1'])
    expect(ctx.surface.list()).toHaveLength(1)
    expect(ctx.surface.get('surf-1')).toBe(surface)

    // Simulate nativeReady and rendererReady events from bridge
    eventListener?.({ type: 'nativeReady', id: 'surf-1', hwnd: 99999 })
    expect(surface.hwnd).toBe(99999)
    expect(surface.isReady()).toBe(false)

    eventListener?.({ type: 'rendererReady', id: 'surf-1' })
    expect(surface.isReady()).toBe(true)
    expect(readyEvents).toEqual(['surf-1'])

    // Show surface
    await surface.show()
    eventListener?.({ type: 'shown', id: 'surf-1' })
    expect(surface.isVisible).toBe(true)
    expect(shownEvents).toEqual(['surf-1'])

    // Update bounds
    await surface.setBounds({ x: 100, y: 100, width: 1024, height: 768 })
    expect(mockBridge.surface.setBounds).toHaveBeenCalledWith('surf-1', {
      x: 100,
      y: 100,
      width: 1024,
      height: 768,
    })

    // Destroy
    const destroyed = await ctx.surface.destroy('surf-1')
    expect(destroyed).toBe(true)

    // Teardown context
    await ctx.fiber.dispose()
    expect(disposeSub).toHaveBeenCalledOnce()
  })

  it('enforces ready-before-show contract by waiting for readiness before showing', async () => {
    let showCalled = false
    const mockBridge = {
      surface: {
        onEvent: vi.fn(() => ({ dispose: async () => true })),
        create: vi.fn(async (opts: SurfaceCreateOptions) => {
          return mockSnapshot({ id: opts.id, state: 'NATIVE_CREATED', visible: false })
        }),
        show: vi.fn(async (id: string) => {
          showCalled = true
          return mockSnapshot({ id, visible: true, state: 'VISIBLE' })
        }),
        destroy: vi.fn(async () => true),
        markReady: vi.fn(async (id: string) => {
          return mockSnapshot({ id, state: 'READY' })
        }),
      },
    } as unknown as NativeBridgeClient

    const ctx = new Context()
    ctx.plugin(SurfaceService, { enabled: true, bridge: mockBridge })
    await new Promise(resolve => setTimeout(resolve, 25))

    const surface = await ctx.surface.create({
      id: 'surf-delayed',
      bounds: { x: 0, y: 0, width: 500, height: 500 },
    })

    expect(surface.isReady()).toBe(false)

    // Call show() asynchronously while surface is not yet ready
    let showCompleted = false
    const showPromise = surface.show().then(() => {
      showCompleted = true
    })

    // Give microtasks a turn: show() must not have completed yet
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(showCalled).toBe(false)
    expect(showCompleted).toBe(false)

    // Signal readiness
    surface._handleNativeReady(55555)
    surface._handleRendererReady()

    await showPromise
    expect(showCalled).toBe(true)
    expect(showCompleted).toBe(true)

    await ctx.fiber.dispose()
  })

  it('propagates DPI change events and suggested physical bounds', async () => {
    let eventListener: ((event: NativeSurfaceEvent) => void) | undefined
    const mockBridge = {
      surface: {
        onEvent: vi.fn((l: (event: NativeSurfaceEvent) => void) => {
          eventListener = l
          return { dispose: async () => true }
        }),
        create: vi.fn(async (opts: SurfaceCreateOptions) => mockSnapshot({ id: opts.id })),
        destroy: vi.fn(async () => true),
      },
    } as unknown as NativeBridgeClient

    const ctx = new Context()
    const dpiChanges: Array<{ dpi: number; scaleFactor: number }> = []

    ctx.on('surface/dpi-changed', (ev) => {
      dpiChanges.push({ dpi: ev.dpi, scaleFactor: ev.scaleFactor })
    })

    ctx.plugin(SurfaceService, { enabled: true, bridge: mockBridge })
    await new Promise(resolve => setTimeout(resolve, 25))

    const surface = await ctx.surface.create({
      id: 'surf-dpi',
      bounds: { x: 0, y: 0, width: 800, height: 600 },
    })

    // Simulate DPI change event from Windows WM_DPICHANGED (e.g. moved from 100% to 150% monitor)
    eventListener?.({
      type: 'dpiChanged',
      id: 'surf-dpi',
      dpi: 144,
      scaleFactor: 1.5,
      suggestedBounds: { x: 0, y: 0, width: 1200, height: 900 },
    })

    expect(surface.dpi).toBe(144)
    expect(surface.scaleFactor).toBe(1.5)
    expect(surface.bounds).toEqual({ x: 0, y: 0, width: 1200, height: 900 })
    expect(dpiChanges).toEqual([{ dpi: 144, scaleFactor: 1.5 }])

    await ctx.fiber.dispose()
  })

  it('integrates with ctx.windowsContext for monitor validation and createOnMonitor', async () => {
    const mockBridge = {
      surface: {
        onEvent: vi.fn(() => ({ dispose: async () => true })),
        create: vi.fn(async (opts: SurfaceCreateOptions) => {
          return mockSnapshot({ id: opts.id, monitorId: opts.monitorId, bounds: opts.bounds })
        }),
        destroy: vi.fn(async () => true),
      },
    } as unknown as NativeBridgeClient

    const mockWindowsContext = {
      getMonitors: vi.fn(() => [
        {
          id: 'MONITOR:MAIN',
          deviceName: '\\\\.\\DISPLAY1',
          isPrimary: true,
          bounds: { x: 0, y: 0, width: 1920, height: 1200 },
          workArea: { x: 0, y: 0, width: 1920, height: 1152 },
          dpiX: 120,
          dpiY: 120,
          scaleFactor: 1.25,
        },
      ]),
      getMonitor: vi.fn((id: string) => {
        if (id === 'MONITOR:MAIN') {
          return {
            id: 'MONITOR:MAIN',
            deviceName: '\\\\.\\DISPLAY1',
            isPrimary: true,
            bounds: { x: 0, y: 0, width: 1920, height: 1200 },
            workArea: { x: 0, y: 0, width: 1920, height: 1152 },
            dpiX: 120,
            dpiY: 120,
            scaleFactor: 1.25,
          }
        }
        return undefined
      }),
    }

    const ctx = new Context()
    ctx.provide('windowsContext', mockWindowsContext as unknown as WindowsContextService)

    ctx.plugin(SurfaceService, { enabled: true, bridge: mockBridge })
    await new Promise(resolve => setTimeout(resolve, 25))

    // Valid monitor
    const surface = await ctx.surface.createOnMonitor('MONITOR:MAIN', {
      id: 'surface-on-main',
    })
    expect(surface.monitorId).toBe('MONITOR:MAIN')
    expect(surface.bounds).toEqual({ x: 0, y: 0, width: 1920, height: 1200 })

    // Unknown monitor rejects with structured error
    await expect(
      ctx.surface.create({
        id: 'surface-invalid-monitor',
        bounds: { x: 0, y: 0, width: 500, height: 500 },
        monitorId: 'MONITOR:NON_EXISTENT',
      }),
    ).rejects.toThrow(/Cannot create surface on unknown monitor/)

    await ctx.fiber.dispose()
  })

  it('resets readiness generation on native recreation so whenReady waits for generation-2 readiness', async () => {
    const mockBridge = {
      surface: {
        onEvent: vi.fn(() => ({ dispose: async () => true })),
        create: vi.fn(async (opts: SurfaceCreateOptions) => mockSnapshot({ id: opts.id })),
        destroy: vi.fn(async () => true),
        markReady: vi.fn(async (id: string) => mockSnapshot({ id, state: 'READY' })),
      },
    } as unknown as NativeBridgeClient

    const ctx = new Context()
    ctx.plugin(SurfaceService, { enabled: true, bridge: mockBridge })
    await new Promise(resolve => setTimeout(resolve, 25))

    const surface = await ctx.surface.create({
      id: 'surf-recov',
      bounds: { x: 0, y: 0, width: 600, height: 400 },
    })

    // Generation 1: becomes ready
    surface._handleNativeReady(11111)
    expect(surface.isReady()).toBe(false)
    surface._handleRendererReady()
    expect(surface.isReady()).toBe(true)
    await expect(surface.whenReady()).resolves.toBe(surface)

    // Crash / Host restart: generation 2 recreated surface delivered
    surface._handleRecreation(mockSnapshot({ id: 'surf-recov', hwnd: 22222, state: 'READY' }))

    // Must NOT be ready anymore! Generation 1 readiness must be completely cleared.
    expect(surface.isReady()).toBe(false)
    expect(surface.state).toBe('NATIVE_CREATED')

    // whenReady() must wait for generation 2
    let gen2ReadyResolved = false
    const gen2WaitPromise = surface.whenReady().then(() => {
      gen2ReadyResolved = true
    })

    await new Promise(resolve => setTimeout(resolve, 20))
    expect(gen2ReadyResolved).toBe(false)

    // Generation 2 NativeReady arrives
    surface._handleNativeReady(22222)
    expect(surface.hwnd).toBe(22222)
    expect(surface.isReady()).toBe(false)
    expect(gen2ReadyResolved).toBe(false)

    // Generation 2 RendererReady arrives
    surface._handleRendererReady()
    expect(surface.isReady()).toBe(true)
    expect(surface.state).toBe('READY')

    await gen2WaitPromise
    expect(gen2ReadyResolved).toBe(true)

    await ctx.fiber.dispose()
  })

  it('rejects whenReady when surface faults and prevents show on faulted surface', async () => {
    const mockBridge = {
      surface: {
        onEvent: vi.fn(() => ({ dispose: async () => true })),
        create: vi.fn(async (opts: SurfaceCreateOptions) => mockSnapshot({ id: opts.id })),
        destroy: vi.fn(async () => true),
      },
    } as unknown as NativeBridgeClient

    const ctx = new Context()
    ctx.plugin(SurfaceService, { enabled: true, bridge: mockBridge })
    await new Promise(resolve => setTimeout(resolve, 25))

    const surface = await ctx.surface.create({
      id: 'surf-fault-test',
      bounds: { x: 0, y: 0, width: 400, height: 300 },
    })

    const readyWait = surface.whenReady()

    // Emit fault
    const faultErr = new Error('[ENV_CREATION_FAILED] WebView2 environment failed to initialize')
    surface._handleFault(faultErr)

    await expect(readyWait).rejects.toThrow(/ENV_CREATION_FAILED/)
    expect(surface.state).toBe('FAULTED')
    expect(surface.isReady()).toBe(false)

    // show() on faulted surface must reject immediately
    await expect(surface.show()).rejects.toThrow(/surface is FAULTED/)

    await ctx.fiber.dispose()
  })

  it('queries focus state and foreground HWND on SurfaceService and SurfaceInstance', async () => {
    const mockFocusState = {
      id: 'surf-focus-test',
      hwnd: 12345,
      isForeground: true,
      foregroundHwnd: 12345,
      hasKeyboardFocus: true,
    }

    const mockBridge = {
      surface: {
        onEvent: vi.fn(() => ({ dispose: async () => true })),
        create: vi.fn(async (opts: SurfaceCreateOptions) => mockSnapshot({ id: opts.id, hwnd: 12345 })),
        getFocusState: vi.fn(async (_id: string) => mockFocusState),
        getForegroundHwnd: vi.fn(async () => ({ hwnd: 12345 })),
        destroy: vi.fn(async () => true),
      },
    } as unknown as NativeBridgeClient

    const ctx = new Context()
    ctx.plugin(SurfaceService, { enabled: true, bridge: mockBridge })
    await new Promise(resolve => setTimeout(resolve, 25))

    const surface = await ctx.surface.create({
      id: 'surf-focus-test',
      bounds: { x: 0, y: 0, width: 400, height: 300 },
    })

    const stateFromService = await ctx.surface.getFocusState('surf-focus-test')
    expect(stateFromService).toEqual(mockFocusState)

    const stateFromInstance = await surface.getFocusState()
    expect(stateFromInstance).toEqual(mockFocusState)

    expect(await surface.isForeground()).toBe(true)
    expect(await surface.hasKeyboardFocus()).toBe(true)

    const fgHwnd = await ctx.surface.getForegroundHwnd()
    expect(fgHwnd).toBe(12345)

    await ctx.fiber.dispose()
  })

  it('handles focus query failures safely for non-existent surface', async () => {
    const mockBridge = {
      surface: {
        onEvent: vi.fn(() => ({ dispose: async () => true })),
        getFocusState: vi.fn(async (id: string) => {
          throw new Error(`Surface '${id}' not found`)
        }),
      },
    } as unknown as NativeBridgeClient

    const ctx = new Context()
    ctx.plugin(SurfaceService, { enabled: true, bridge: mockBridge })
    await new Promise(resolve => setTimeout(resolve, 25))

    await expect(ctx.surface.getFocusState('unknown-surface')).rejects.toThrow(/not found/)
    await ctx.fiber.dispose()
  })
})
