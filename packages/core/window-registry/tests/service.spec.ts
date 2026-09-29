import { Context } from '@deepseek-ai/cordis'
import type {
  NativeBridgeClient,
  NativeBridgeError,
  NativeRawWindow,
  NativeWindowRegistryChange,
  NativeWindowRegistrySnapshot,
} from '@deepseek-ai/dsh-native-core'
import type { MonitorId, WindowsMonitor } from '@deepseek-ai/dsh-windows-context'
import { describe, expect, it, vi } from 'vitest'
import WindowRegistryService from '../src/index.ts'
import type {
  WindowChange,
  WindowForegroundChangeEvent,
  WindowPropertyChange,
  WindowSnapshot,
  WindowState,
} from '../src/types.ts'

function mockRawWindow(overrides: Partial<NativeRawWindow> = {}): NativeRawWindow {
  return {
    hwnd: 0x1000,
    processId: 100,
    threadId: 200,
    processCreationTime: 1000,
    title: 'Visual Studio Code',
    className: 'Chrome_WidgetWin_1',
    bounds: { x: 100, y: 100, width: 800, height: 600 },
    isVisible: true,
    isMinimized: false,
    isMaximized: false,
    isCloaked: false,
    isToolWindow: false,
    isShellWindow: false,
    isEnabled: true,
    isForeground: false,
    ...overrides,
  }
}

describe('WindowRegistryService', () => {
  it('registers ctx.windowRegistry, initializes snapshot, and provides window query methods', async () => {
    const dispose = vi.fn(async () => true)

    const initialRaw = mockRawWindow({ hwnd: 0x100, processId: 1234, title: 'App 1' })
    const initialSnapshot: NativeWindowRegistrySnapshot = {
      revision: 1,
      windows: [initialRaw],
      foregroundHwnd: 0x100,
      capturedAt: Date.now(),
    }

    const bridge = {
      windowRegistry: {
        start: vi.fn(async (callback: (event: NativeWindowRegistryChange) => void) => {
          callback({ reason: 'initial', snapshot: initialSnapshot })
          return { dispose }
        }),
        refresh: vi.fn(async () => initialSnapshot),
      },
    } as unknown as NativeBridgeClient

    const ctx = new Context()
    let readyCalled = false
    ctx.on('window-registry/ready', () => {
      readyCalled = true
    })

    ctx.plugin(WindowRegistryService, { enabled: true, bridge })
    await new Promise(resolve => setTimeout(resolve, 25))

    expect(readyCalled).toBe(true)
    const snapshot = ctx.windowRegistry.getSnapshot()
    expect(snapshot.windows.length).toBe(1)
    expect(snapshot.revision).toBe(1)

    const win = snapshot.windows[0]!
    expect(win.hwnd).toBe(0x100)
    expect(win.title).toBe('App 1')
    expect(win.id.startsWith('win_')).toBe(true)

    // Check queries
    expect(ctx.windowRegistry.getWindow(win.id)).toBe(win)
    expect(ctx.windowRegistry.getByHwnd(0x100)).toBe(win)
    expect(ctx.windowRegistry.getByProcessId(1234)).toEqual([win])
    expect(ctx.windowRegistry.getForegroundWindow()).toBe(win)

    await ctx.fiber.dispose()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('emits fine-grained events for created, destroyed, and modified windows', async () => {
    let listener: ((event: NativeWindowRegistryChange) => void) | undefined
    const w1 = mockRawWindow({ hwnd: 0x10, processId: 10, title: 'Window 1' })

    const bridge = {
      windowRegistry: {
        start: vi.fn(async (callback: (event: NativeWindowRegistryChange) => void) => {
          listener = callback
          callback({
            reason: 'initial',
            snapshot: { revision: 1, windows: [w1], capturedAt: 1 },
          })
          return { dispose: vi.fn(async () => true) }
        }),
      },
    } as unknown as NativeBridgeClient

    const ctx = new Context()
    const createdEvents: WindowSnapshot[] = []
    const destroyedEvents: WindowSnapshot[] = []
    const changedEvents: WindowChange[] = []
    const titleChanges: WindowPropertyChange<string>[] = []
    const boundsChanges: WindowPropertyChange<unknown>[] = []
    const stateChanges: WindowPropertyChange<WindowState>[] = []
    const fgChanges: WindowForegroundChangeEvent[] = []

    ctx.on('window-registry/window-created', w => createdEvents.push(w))
    ctx.on('window-registry/window-destroyed', w => destroyedEvents.push(w))
    ctx.on('window-registry/window-changed', c => changedEvents.push(c))
    ctx.on('window-registry/window-title-changed', c => titleChanges.push(c))
    ctx.on('window-registry/window-bounds-changed', c => boundsChanges.push(c))
    ctx.on('window-registry/window-state-changed', c => stateChanges.push(c))
    ctx.on('window-registry/window-foreground-changed', e => fgChanges.push(e))

    ctx.plugin(WindowRegistryService, { enabled: true, bridge })
    await new Promise(resolve => setTimeout(resolve, 25))

    expect(createdEvents.length).toBe(1)
    expect(createdEvents[0]!.hwnd).toBe(0x10)

    // Step 2: w1 modifies title and bounds, w2 created, w1 becomes foreground
    const w1Modified = mockRawWindow({
      hwnd: 0x10,
      processId: 10,
      title: 'Window 1 - Renamed',
      bounds: { x: 200, y: 200, width: 900, height: 700 },
      isForeground: true,
    })
    const w2 = mockRawWindow({ hwnd: 0x20, processId: 20, title: 'Window 2' })

    listener!({
      reason: 'window_change',
      snapshot: {
        revision: 2,
        windows: [w1Modified, w2],
        foregroundHwnd: 0x10,
        capturedAt: 2,
      },
    })

    expect(createdEvents.length).toBe(2)
    expect(createdEvents[1]!.hwnd).toBe(0x20)
    expect(changedEvents.length).toBe(1)
    expect(changedEvents[0]!.changes).toContain('title')
    expect(changedEvents[0]!.changes).toContain('bounds')
    expect(changedEvents[0]!.changes).toContain('foreground')
    expect(titleChanges.length).toBe(1)
    expect(titleChanges[0]!.previous).toBe('Window 1')
    expect(titleChanges[0]!.current).toBe('Window 1 - Renamed')
    expect(boundsChanges.length).toBe(1)
    expect(fgChanges.length).toBe(1)
    expect(fgChanges[0]!.current?.hwnd).toBe(0x10)

    // Step 3: w1 destroyed
    listener!({
      reason: 'window_destroy',
      snapshot: {
        revision: 3,
        windows: [w2],
        capturedAt: 3,
      },
    })

    expect(destroyedEvents.length).toBe(1)
    expect(destroyedEvents[0]!.hwnd).toBe(0x10)
    expect(ctx.windowRegistry.getByHwnd(0x10)).toBeUndefined()
    expect(ctx.windowRegistry.getByHwnd(0x20)).toBeDefined()

    await ctx.fiber.dispose()
  })

  it('associates windows with monitors from ctx.windowsContext and updates on topology changes', async () => {
    const w1 = mockRawWindow({ hwnd: 0x10, bounds: { x: 100, y: 100, width: 500, height: 400 } })

    const bridge = {
      windowRegistry: {
        start: vi.fn(async (callback: (event: NativeWindowRegistryChange) => void) => {
          callback({
            reason: 'initial',
            snapshot: { revision: 1, windows: [w1], capturedAt: 1 },
          })
          return { dispose: vi.fn(async () => true) }
        }),
      },
    } as unknown as NativeBridgeClient

    const ctx = new Context()

    const mockMonitors: WindowsMonitor[] = [
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
    ]

    // Mock windowsContext service on ctx
    ctx.provide('windowsContext')
    ctx.windowsContext = {
      getMonitors: () => mockMonitors,
    } as unknown as typeof ctx.windowsContext

    ctx.plugin(WindowRegistryService, { enabled: true, bridge })
    await new Promise(resolve => setTimeout(resolve, 25))

    const win1 = ctx.windowRegistry.getByHwnd(0x10)!
    expect(win1.monitorId).toBe('monitor:1')
    expect(ctx.windowRegistry.getWindowsForMonitor('monitor:1' as MonitorId)).toEqual([win1])

    // Now monitor moves / topology updates
    const updatedMonitors: WindowsMonitor[] = [
      {
        id: 'monitor:2' as MonitorId,
        deviceName: String.raw`\\.\DISPLAY2`,
        bounds: { x: 0, y: 0, width: 2560, height: 1440 },
        workArea: { x: 0, y: 0, width: 2560, height: 1400 },
        dpiX: 96,
        dpiY: 96,
        scaleFactor: 1,
        isPrimary: true,
      },
    ]
    ctx.windowsContext.getMonitors = () => updatedMonitors

    // Trigger topology change
    ctx.emit('windows-context/change', {
      revision: 2,
      reason: 'topology',
      snapshot: {} as never,
    })

    const winUpdated = ctx.windowRegistry.getByHwnd(0x10)!
    expect(winUpdated.monitorId).toBe('monitor:2')

    await ctx.fiber.dispose()
  })

  it('classifies ELIX surfaces by querying ctx.surface', async () => {
    const rawSurface = mockRawWindow({ hwnd: 0x9999, className: 'ELIX_SurfaceClass' })

    const bridge = {
      windowRegistry: {
        start: vi.fn(async (callback: (event: NativeWindowRegistryChange) => void) => {
          callback({
            reason: 'initial',
            snapshot: { revision: 1, windows: [rawSurface], capturedAt: 1 },
          })
          return { dispose: vi.fn(async () => true) }
        }),
      },
    } as unknown as NativeBridgeClient

    const ctx = new Context()
    ctx.provide('surface')
    ctx.surface = {
      isSurfaceHwnd: (hwnd: number) => hwnd === 0x9999,
    } as unknown as typeof ctx.surface

    ctx.plugin(WindowRegistryService, { enabled: true, bridge })
    await new Promise(resolve => setTimeout(resolve, 25))

    const win = ctx.windowRegistry.getByHwnd(0x9999)!
    expect(win.classification).toBe('ELIX_SURFACE')

    await ctx.fiber.dispose()
  })

  it('handles host restart recovery without losing WindowIds for live windows', async () => {
    let listener: ((event: NativeWindowRegistryChange) => void) | undefined
    const w1 = mockRawWindow({ hwnd: 0x100, processId: 10, processCreationTime: 500, title: 'App' })

    const bridge = {
      windowRegistry: {
        start: vi.fn(async (callback: (event: NativeWindowRegistryChange) => void) => {
          listener = callback
          callback({
            reason: 'initial',
            snapshot: { revision: 1, windows: [w1], capturedAt: 1 },
          })
          return { dispose: vi.fn(async () => true) }
        }),
      },
    } as unknown as NativeBridgeClient

    const ctx = new Context()
    let recoveredFired = false
    ctx.on('window-registry/recovered', () => {
      recoveredFired = true
    })

    ctx.plugin(WindowRegistryService, { enabled: true, bridge })
    await new Promise(resolve => setTimeout(resolve, 25))

    const initialId = ctx.windowRegistry.getByHwnd(0x100)!.id

    // Simulate host crash and restart: NativeBridge delivers 'recovered' reason
    const w1AfterRestart = mockRawWindow({ hwnd: 0x100, processId: 10, processCreationTime: 500, title: 'App - Restored' })
    const w2New = mockRawWindow({ hwnd: 0x200, processId: 20, processCreationTime: 600, title: 'New App' })

    listener!({
      reason: 'recovered',
      snapshot: { revision: 1, windows: [w1AfterRestart, w2New], capturedAt: 10 },
    })

    expect(recoveredFired).toBe(true)
    const win1Rehydrated = ctx.windowRegistry.getByHwnd(0x100)!
    // WindowId must be preserved across the restart!
    expect(win1Rehydrated.id).toBe(initialId)
    expect(win1Rehydrated.title).toBe('App - Restored')

    expect(ctx.windowRegistry.getByHwnd(0x200)).toBeDefined()

    await ctx.fiber.dispose()
  })

  it('recovers dead observer when native fault occurs', async () => {
    let faultHandler: ((err: NativeBridgeError) => void) | undefined
    let startCallCount = 0
    let statusChecks = 0

    const initialRaw = mockRawWindow({ hwnd: 0x10 })
    const start = vi.fn(async (
      callback: (event: NativeWindowRegistryChange) => void,
      onFault?: (err: NativeBridgeError) => void,
    ) => {
      startCallCount++
      faultHandler = onFault
      callback({
        reason: 'initial',
        snapshot: { revision: startCallCount, windows: [initialRaw], capturedAt: startCallCount },
      })
      return { dispose: vi.fn(async () => true) }
    })

    const getStatus = vi.fn(async () => {
      statusChecks++
      // First check reports thread dead
      return { observing: false, threadAlive: false }
    })

    const bridge = {
      windowRegistry: {
        start,
        getStatus,
      },
    } as unknown as NativeBridgeClient

    const ctx = new Context()
    let faultEmitted = false
    ctx.on('window-registry/fault', () => {
      faultEmitted = true
    })

    ctx.plugin(WindowRegistryService, { enabled: true, bridge })
    await new Promise(resolve => setTimeout(resolve, 25))

    expect(startCallCount).toBe(1)

    // Simulate observer fault
    faultHandler!(Object.assign(new Error('Thread crash'), { domain: 'windowRegistry', code: 'THREAD_CRASH' }))
    expect(faultEmitted).toBe(true)

    // Wait for recovery loop to trigger replacement start
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(statusChecks).toBeGreaterThanOrEqual(1)
    expect(startCallCount).toBeGreaterThanOrEqual(2)

    await ctx.fiber.dispose()
  })

  it('includes generation, firstSeen, and updatedRevision on snapshots and updates updatedRevision on change', async () => {
    let listener: ((event: NativeWindowRegistryChange) => void) | undefined
    const w1 = mockRawWindow({ hwnd: 0x10, processId: 10, title: 'Original' })
    const w2 = mockRawWindow({ hwnd: 0x20, processId: 20, title: 'Static' })

    const bridge = {
      windowRegistry: {
        start: vi.fn(async (callback: (event: NativeWindowRegistryChange) => void) => {
          listener = callback
          callback({
            reason: 'initial',
            snapshot: { revision: 1, windows: [w1, w2], capturedAt: 100 },
          })
          return { dispose: vi.fn(async () => true) }
        }),
      },
    } as unknown as NativeBridgeClient

    const ctx = new Context()
    ctx.plugin(WindowRegistryService, { enabled: true, bridge })
    await new Promise(resolve => setTimeout(resolve, 25))

    const snap1 = ctx.windowRegistry.getSnapshot()
    expect(snap1.generation).toBe(1)
    expect(snap1.revision).toBe(1)

    const win1Initial = ctx.windowRegistry.getByHwnd(0x10)!
    const win2Initial = ctx.windowRegistry.getByHwnd(0x20)!
    expect(win1Initial.generation).toBe(1)
    expect(win1Initial.firstSeen).toBeGreaterThan(0)
    expect(win1Initial.updatedRevision).toBe(1)
    expect(win2Initial.updatedRevision).toBe(1)

    // Now update w1 title only; w2 remains identical
    const w1Renamed = mockRawWindow({ hwnd: 0x10, processId: 10, title: 'Renamed' })
    listener!({
      reason: 'window_change',
      snapshot: { revision: 2, windows: [w1Renamed, w2], capturedAt: 200 },
    })

    const snap2 = ctx.windowRegistry.getSnapshot()
    expect(snap2.revision).toBe(2)

    const win1Updated = ctx.windowRegistry.getByHwnd(0x10)!
    const win2Unchanged = ctx.windowRegistry.getByHwnd(0x20)!
    // w1's updatedRevision updated to 2
    expect(win1Updated.updatedRevision).toBe(2)
    expect(win1Updated.title).toBe('Renamed')
    expect(win1Updated.firstSeen).toBe(win1Initial.firstSeen) // firstSeen preserved!

    // w2's updatedRevision stays at 1
    expect(win2Unchanged.updatedRevision).toBe(1)
    expect(win2Unchanged.firstSeen).toBe(win2Initial.firstSeen)

    await ctx.fiber.dispose()
  })

  it('preserves destroyed window snapshot as previous in WindowForegroundChangeEvent when foreground window is closed', async () => {
    let listener: ((event: NativeWindowRegistryChange) => void) | undefined
    const w1 = mockRawWindow({ hwnd: 0x10, processId: 10, title: 'Closing Active App', isForeground: true })

    const bridge = {
      windowRegistry: {
        start: vi.fn(async (callback: (event: NativeWindowRegistryChange) => void) => {
          listener = callback
          callback({
            reason: 'initial',
            snapshot: { revision: 1, windows: [w1], foregroundHwnd: 0x10, capturedAt: 1 },
          })
          return { dispose: vi.fn(async () => true) }
        }),
      },
    } as unknown as NativeBridgeClient

    const ctx = new Context()
    const fgEvents: WindowForegroundChangeEvent[] = []
    ctx.on('window-registry/window-foreground-changed', e => fgEvents.push(e))

    ctx.plugin(WindowRegistryService, { enabled: true, bridge })
    await new Promise(resolve => setTimeout(resolve, 25))

    expect(ctx.windowRegistry.getForegroundWindow()?.hwnd).toBe(0x10)

    // Now w1 is destroyed, and no window is foreground
    listener!({
      reason: 'window_destroy',
      snapshot: { revision: 2, windows: [], foregroundHwnd: undefined, capturedAt: 2 },
    })

    expect(fgEvents.length).toBe(2)
    // First event was initial foreground acquisition
    expect(fgEvents[0]!.previous).toBeNull()
    expect(fgEvents[0]!.current?.hwnd).toBe(0x10)

    // Second event was destruction: previous MUST NOT be null; it must record the window that was closed!
    expect(fgEvents[1]!.previous).toBeDefined()
    expect(fgEvents[1]!.previous?.hwnd).toBe(0x10)
    expect(fgEvents[1]!.previous?.title).toBe('Closing Active App')
    expect(fgEvents[1]!.current).toBeNull()

    expect(ctx.windowRegistry.getForegroundWindow()).toBeUndefined()

    await ctx.fiber.dispose()
  })

  it('handles minimize and bounds arriving close together without spurious bounds changes', async () => {
    let listener: ((event: NativeWindowRegistryChange) => void) | undefined
    const initialBounds = { x: 150, y: 150, width: 800, height: 600 }
    const w1 = mockRawWindow({ hwnd: 0x10, processId: 10, bounds: initialBounds, isMinimized: false })

    const bridge = {
      windowRegistry: {
        start: vi.fn(async (callback: (event: NativeWindowRegistryChange) => void) => {
          listener = callback
          callback({
            reason: 'initial',
            snapshot: { revision: 1, windows: [w1], capturedAt: 1 },
          })
          return { dispose: vi.fn(async () => true) }
        }),
      },
    } as unknown as NativeBridgeClient

    const ctx = new Context()
    const boundsChanges: WindowPropertyChange<unknown>[] = []
    const stateChanges: WindowPropertyChange<WindowState>[] = []
    ctx.on('window-registry/window-bounds-changed', b => boundsChanges.push(b))
    ctx.on('window-registry/window-state-changed', s => stateChanges.push(s))

    ctx.plugin(WindowRegistryService, { enabled: true, bridge })
    await new Promise(resolve => setTimeout(resolve, 25))

    // Window minimizes; normal bounds preserved (no negative parking coords)
    const w1Minimized = mockRawWindow({
      hwnd: 0x10,
      processId: 10,
      bounds: initialBounds,
      isMinimized: true,
    })

    listener!({
      reason: 'state',
      snapshot: { revision: 2, windows: [w1Minimized], capturedAt: 2 },
    })

    // Exactly one state change event: normal -> minimized
    expect(stateChanges.length).toBe(1)
    expect(stateChanges[0]!.previous).toBe('normal')
    expect(stateChanges[0]!.current).toBe('minimized')

    // Zero bounds change events emitted!
    expect(boundsChanges.length).toBe(0)

    const win = ctx.windowRegistry.getByHwnd(0x10)!
    expect(win.state).toBe('minimized')
    expect(win.bounds.x).toBe(150)
    expect(win.bounds.y).toBe(150)

    await ctx.fiber.dispose()
  })

  it('suppresses duplicate events and redundant snapshot emissions when nothing changed', async () => {
    let listener: ((event: NativeWindowRegistryChange) => void) | undefined
    const w1 = mockRawWindow({ hwnd: 0x10, processId: 10, title: 'App' })

    const bridge = {
      windowRegistry: {
        start: vi.fn(async (callback: (event: NativeWindowRegistryChange) => void) => {
          listener = callback
          callback({
            reason: 'initial',
            snapshot: { revision: 1, windows: [w1], capturedAt: 1 },
          })
          return { dispose: vi.fn(async () => true) }
        }),
      },
    } as unknown as NativeBridgeClient

    const ctx = new Context()
    const snapshotEvents: unknown[] = []
    ctx.on('window-registry/snapshot', s => snapshotEvents.push(s))

    ctx.plugin(WindowRegistryService, { enabled: true, bridge })
    await new Promise(resolve => setTimeout(resolve, 25))

    expect(snapshotEvents.length).toBe(1)
    const initialRev = ctx.windowRegistry.getSnapshot().revision

    // Send duplicate event with identical properties but newer native revision
    listener!({
      reason: 'window_change',
      snapshot: { revision: 2, windows: [w1], capturedAt: 2 },
    })

    // Since nothing changed in the registry, snapshot event is suppressed and revision is NOT bumped
    expect(snapshotEvents.length).toBe(1)
    expect(ctx.windowRegistry.getSnapshot().revision).toBe(initialRev)

    await ctx.fiber.dispose()
  })
})
