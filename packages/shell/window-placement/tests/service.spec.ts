import { Context } from '@deepseek-ai/cordis'
import type {
  WindowControlResult,
  WindowControlSource,
  WindowPlacementConstraints,
} from '@deepseek-ai/dsh-window-control'
import type {
  WindowChange,
  WindowId,
  WindowRegistrySnapshot,
  WindowRegistrySource,
  WindowSnapshot,
} from '@deepseek-ai/dsh-window-registry'
import type {
  MonitorId,
  PhysicalPixelRect,
  WindowsContextSnapshot,
  WindowsContextSource,
  WindowsMonitor,
} from '@deepseek-ai/dsh-windows-context'
import { describe, expect, it, vi } from 'vitest'
import WindowPlacementService from '../src/index.ts'

const WINDOW_A = 'window:a' as WindowId
const WINDOW_MISSING = 'window:missing' as WindowId
const MONITOR_1 = 'monitor:1' as MonitorId
const MONITOR_2 = 'monitor:2' as MonitorId

const MONITORS: WindowsMonitor[] = [
  {
    id: MONITOR_1,
    deviceName: String.raw`\\.\DISPLAY1`,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    dpiX: 96,
    dpiY: 96,
    scaleFactor: 1,
    isPrimary: true,
  },
  {
    id: MONITOR_2,
    deviceName: String.raw`\\.\DISPLAY2`,
    bounds: { x: -1280, y: 0, width: 1280, height: 1024 },
    workArea: { x: -1280, y: 0, width: 1280, height: 984 },
    dpiX: 144,
    dpiY: 144,
    scaleFactor: 1.5,
    isPrimary: false,
  },
]

function windowSnapshot(overrides: Partial<WindowSnapshot> = {}): WindowSnapshot {
  return {
    id: WINDOW_A,
    hwnd: 0x1234,
    processId: 400,
    threadId: 500,
    processCreationTime: 123456789,
    executableName: 'notepad.exe',
    title: 'Placement fixture',
    className: 'Notepad',
    bounds: { x: 100, y: 120, width: 800, height: 600 },
    classification: 'APPLICATION',
    state: 'normal',
    monitorId: MONITOR_1,
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

class MutableRegistry implements WindowRegistrySource {
  private readonly windows = new Map<WindowId, WindowSnapshot>()
  private revision = 1

  constructor(initial: readonly WindowSnapshot[]) {
    for (const window of initial) this.windows.set(window.id, window)
  }

  getSnapshot(): WindowRegistrySnapshot {
    return {
      generation: 1,
      revision: this.revision,
      windows: this.getWindows(),
      capturedAt: Date.now(),
    }
  }

  getWindows(): readonly WindowSnapshot[] {
    return [...this.windows.values()]
  }

  getWindow(id: WindowId): WindowSnapshot | undefined {
    return this.windows.get(id)
  }

  getByHwnd(hwnd: number): WindowSnapshot | undefined {
    return this.getWindows().find(window => window.hwnd === hwnd)
  }

  getByProcessId(pid: number): readonly WindowSnapshot[] {
    return this.getWindows().filter(window => window.processId === pid)
  }

  getForegroundWindow(): WindowSnapshot | undefined {
    return this.getWindows().find(window => window.isForeground)
  }

  getWindowsForMonitor(monitorId: MonitorId): readonly WindowSnapshot[] {
    return this.getWindows().filter(window => window.monitorId === monitorId)
  }

  async refresh(): Promise<WindowRegistrySnapshot> {
    this.revision++
    return this.getSnapshot()
  }

  subscribe(_listener: (snapshot: WindowRegistrySnapshot) => void): () => void {
    return () => {}
  }

  update(id: WindowId, patch: Partial<WindowSnapshot>): WindowSnapshot {
    const current = this.windows.get(id)
    if (!current) throw new Error(`Missing fixture ${id}`)
    const next: WindowSnapshot = {
      ...current,
      ...patch,
      updatedRevision: this.revision + 1,
      capturedAt: Date.now(),
    }
    this.windows.set(id, next)
    return next
  }
}

class MutableWindowsContext implements WindowsContextSource {
  revision = 1
  monitors: WindowsMonitor[] = MONITORS.map(monitor => ({ ...monitor }))

  getSnapshot(): WindowsContextSnapshot {
    return {
      revision: this.revision,
      monitors: this.monitors,
      primaryMonitorId: this.monitors.find(monitor => monitor.isPrimary)?.id ?? this.monitors[0]!.id,
      foreground: null,
      capturedAt: Date.now(),
    }
  }

  getMonitors(): readonly WindowsMonitor[] {
    return this.monitors
  }

  getMonitor(id: MonitorId): WindowsMonitor | undefined {
    return this.monitors.find(monitor => monitor.id === id)
  }

  getPrimaryMonitor(): WindowsMonitor {
    return this.getMonitor(this.getSnapshot().primaryMonitorId) ?? this.monitors[0]!
  }

  getForegroundContext(): null {
    return null
  }

  async refresh(): Promise<WindowsContextSnapshot> {
    return this.getSnapshot()
  }

  subscribe(_listener: Parameters<WindowsContextSource['subscribe']>[0]): () => void {
    return () => {}
  }
}

class MutableLayout {
  workAreas = new Map<MonitorId, PhysicalPixelRect>([
    [MONITOR_1, { x: 0, y: 0, width: 1920, height: 1040 }],
    [MONITOR_2, { x: -1280, y: 0, width: 1280, height: 984 }],
  ])

  getWorkArea(id: string): PhysicalPixelRect | undefined {
    return this.workAreas.get(id as MonitorId)
  }
}

interface ControlOptions {
  readonly constraints?: WindowPlacementConstraints | undefined
  readonly restoreBounds?: PhysicalPixelRect | undefined
  readonly adjustBounds?: ((requested: PhysicalPixelRect) => PhysicalPixelRect) | undefined
  readonly refuseBounds?: boolean | undefined
  readonly afterSetBounds?: (() => void) | undefined
}

function nativeResult(
  windowId: WindowId,
  action: WindowControlResult['action'],
  hwnd: number,
  observationPatch: Partial<WindowControlResult['observation']>,
): WindowControlResult {
  return {
    windowId,
    action,
    hwnd,
    accepted: true,
    completed: true,
    observation: {
      exists: true,
      visible: true,
      minimized: false,
      maximized: false,
      foreground: false,
      ...observationPatch,
    },
  }
}

function controlFor(registry: MutableRegistry, options: ControlOptions = {}) {
  const constraints: WindowPlacementConstraints = options.constraints ?? {
    resizable: true,
    visibleBounds: registry.getWindow(WINDOW_A)?.bounds ?? { x: 0, y: 0, width: 800, height: 600 },
    appConstraintsObserved: false,
  }

  const setBounds = vi.fn(async (windowId: WindowId, requested: PhysicalPixelRect) => {
    const current = registry.getWindow(windowId)
    if (!current) throw Object.assign(new Error('stale'), { code: 'STALE_WINDOW_ID' })
    const applied = options.refuseBounds
      ? current.bounds
      : options.adjustBounds?.(requested) ?? requested
    if (!options.refuseBounds) {
      registry.update(windowId, {
        bounds: applied,
        state: 'normal',
        isMinimized: false,
        isMaximized: false,
      })
    }
    options.afterSetBounds?.()
    return nativeResult(windowId, 'setBounds', current.hwnd, { bounds: applied })
  })

  const restore = vi.fn(async (windowId: WindowId) => {
    const current = registry.getWindow(windowId)
    if (!current) throw Object.assign(new Error('stale'), { code: 'STALE_WINDOW_ID' })
    const bounds = options.restoreBounds ?? current.bounds
    registry.update(windowId, {
      bounds,
      state: 'normal',
      isMinimized: false,
      isMaximized: false,
    })
    return nativeResult(windowId, 'restore', current.hwnd, { bounds })
  })

  const maximize = vi.fn(async (windowId: WindowId) => {
    const current = registry.getWindow(windowId)
    if (!current) throw Object.assign(new Error('stale'), { code: 'STALE_WINDOW_ID' })
    registry.update(windowId, { state: 'maximized', isMaximized: true, isMinimized: false })
    return nativeResult(windowId, 'maximize', current.hwnd, { maximized: true, bounds: current.bounds })
  })

  const minimize = vi.fn(async (windowId: WindowId) => {
    const current = registry.getWindow(windowId)
    if (!current) throw Object.assign(new Error('stale'), { code: 'STALE_WINDOW_ID' })
    registry.update(windowId, { state: 'minimized', isMinimized: true, isMaximized: false })
    return nativeResult(windowId, 'minimize', current.hwnd, { minimized: true, bounds: current.bounds })
  })

  const control = {
    setBounds,
    restore,
    maximize,
    minimize,
    getPlacementConstraints: vi.fn(async () => constraints),
    activate: vi.fn(),
    close: vi.fn(),
    move: vi.fn(),
    resize: vi.fn(),
    moveToMonitor: vi.fn(),
  } as unknown as WindowControlSource

  return { control, setBounds, restore, maximize }
}

async function setup(
  initial: WindowSnapshot = windowSnapshot(),
  options: ControlOptions = {},
) {
  const registry = new MutableRegistry([initial])
  const windowsContext = new MutableWindowsContext()
  const layout = new MutableLayout()
  const native = controlFor(registry, options)
  const ctx = new Context()
  ctx.provide('windowRegistry')
  ctx.windowRegistry = registry as unknown as typeof ctx.windowRegistry
  ctx.provide('windowControl')
  ctx.windowControl = native.control as typeof ctx.windowControl
  ctx.provide('windowsContext')
  ctx.windowsContext = windowsContext as unknown as typeof ctx.windowsContext
  ctx.provide('shellLayout')
  ctx.shellLayout = layout as unknown as typeof ctx.shellLayout
  ctx.plugin(WindowPlacementService, { enabled: true, maxDisplayReplans: 2 })
  await new Promise(resolve => setTimeout(resolve, 10))
  return { ctx, registry, windowsContext, layout, ...native }
}

describe('WindowPlacementService', () => {
  it('places into negotiated Shell Layout work area and records original geometry', async () => {
    const fixture = await setup()

    const placed = await fixture.ctx.windowPlacement.place(WINDOW_A, { kind: 'left-half' })

    expect(placed).toMatchObject({
      status: 'applied',
      requestedRect: { x: 0, y: 0, width: 960, height: 1040 },
      appliedRect: { x: 0, y: 0, width: 960, height: 1040 },
      monitorId: MONITOR_1,
    })
    expect(fixture.setBounds).toHaveBeenCalledWith(
      WINDOW_A,
      { x: 0, y: 0, width: 960, height: 1040 },
    )
    expect(fixture.ctx.windowPlacement.getPlacementRecord(WINDOW_A)).toMatchObject({
      originalBounds: { x: 100, y: 120, width: 800, height: 600 },
      originalState: 'normal',
      lastAppliedBounds: { x: 0, y: 0, width: 960, height: 1040 },
    })

    await fixture.ctx.fiber.dispose()
  })

  it('preserves the first restore target across repeated ELIX placements', async () => {
    const fixture = await setup()

    await fixture.ctx.windowPlacement.place(WINDOW_A, { kind: 'left-half' })
    await fixture.ctx.windowPlacement.place(WINDOW_A, { kind: 'right-half' })

    expect(fixture.ctx.windowPlacement.getPlacementRecord(WINDOW_A)?.originalBounds).toEqual({
      x: 100,
      y: 120,
      width: 800,
      height: 600,
    })

    const restored = await fixture.ctx.windowPlacement.restorePlacement(WINDOW_A)
    expect(restored.status).toBe('applied')
    expect(fixture.setBounds).toHaveBeenLastCalledWith(
      WINDOW_A,
      { x: 100, y: 120, width: 800, height: 600 },
    )
    expect(fixture.ctx.windowPlacement.getPlacementRecord(WINDOW_A)).toBeUndefined()

    await fixture.ctx.fiber.dispose()
  })

  it('ignores Shell Layout notifications when the negotiated work area is unchanged', async () => {
    let fixture: Awaited<ReturnType<typeof setup>>
    fixture = await setup(windowSnapshot(), {
      afterSetBounds: () => {
        fixture.ctx.emit('shell-layout/change', {
          type: 'reconciled',
          affectedMonitorIds: [MONITOR_1],
        })
      },
    })

    await fixture.ctx.windowPlacement.place(WINDOW_A, { kind: 'left-half' })
    await fixture.ctx.windowPlacement.place(WINDOW_A, { kind: 'right-half' })
    const restored = await fixture.ctx.windowPlacement.restorePlacement(WINDOW_A)

    expect(restored.status).toBe('applied')
    expect(fixture.setBounds).toHaveBeenLastCalledWith(
      WINDOW_A,
      { x: 100, y: 120, width: 800, height: 600 },
    )

    await fixture.ctx.fiber.dispose()
  })

  it('rejects resize zones for nonresizable windows before native geometry mutation', async () => {
    const fixture = await setup(windowSnapshot(), {
      constraints: {
        resizable: false,
        visibleBounds: { x: 100, y: 120, width: 800, height: 600 },
        appConstraintsObserved: false,
      },
    })

    const placed = await fixture.ctx.windowPlacement.place(WINDOW_A, { kind: 'fill' })
    expect(placed).toMatchObject({ status: 'rejected', reason: 'nonresizable-window' })
    expect(fixture.setBounds).not.toHaveBeenCalled()

    await fixture.ctx.fiber.dispose()
  })

  it('reports application-adjusted geometry instead of pretending the request was exact', async () => {
    const fixture = await setup(windowSnapshot(), {
      adjustBounds: requested => ({ ...requested, width: requested.width + 40 }),
    })

    const placed = await fixture.ctx.windowPlacement.place(WINDOW_A, { kind: 'left-half' })
    expect(placed.status).toBe('adjusted')
    expect(placed.adjustments).toContain('window-adjusted-geometry')
    expect(placed.appliedRect?.width).toBe(1000)

    await fixture.ctx.fiber.dispose()
  })

  it('keeps the requested identity when rejecting a stale WindowId', async () => {
    const fixture = await setup()

    const placed = await fixture.ctx.windowPlacement.place(WINDOW_MISSING, { kind: 'left-half' })
    expect(placed).toMatchObject({
      windowId: WINDOW_MISSING,
      status: 'rejected',
      reason: 'stale-window-id',
    })
    expect(fixture.setBounds).not.toHaveBeenCalled()

    await fixture.ctx.fiber.dispose()
  })

  it('ignores delayed echoes of ELIX geometry but invalidates a real external move', async () => {
    const fixture = await setup()
    await fixture.ctx.windowPlacement.place(WINDOW_A, { kind: 'left-half' })
    const current = fixture.registry.getWindow(WINDOW_A)!
    const previous = windowSnapshot()

    const echo: WindowChange = {
      id: WINDOW_A,
      window: current,
      previous,
      changes: ['bounds'],
    }
    fixture.ctx.emit('window-registry/window-changed', echo)
    expect(fixture.ctx.windowPlacement.getPlacementRecord(WINDOW_A)).toBeDefined()

    const externallyMoved = fixture.registry.update(WINDOW_A, {
      bounds: { x: 300, y: 200, width: 900, height: 700 },
    })
    fixture.ctx.emit('window-registry/window-changed', {
      id: WINDOW_A,
      window: externallyMoved,
      previous: current,
      changes: ['bounds'],
    })
    expect(fixture.ctx.windowPlacement.getPlacementRecord(WINDOW_A)).toBeUndefined()

    await fixture.ctx.fiber.dispose()
  })

  it('restores a maximized starting window to normal geometry and later re-maximizes it', async () => {
    const normalBounds = { x: 120, y: 140, width: 900, height: 650 }
    const fixture = await setup(windowSnapshot({
      state: 'maximized',
      isMaximized: true,
      bounds: { x: 0, y: 0, width: 1920, height: 1040 },
    }), { restoreBounds: normalBounds })

    const placed = await fixture.ctx.windowPlacement.place(WINDOW_A, { kind: 'right-half' })
    expect(placed.status).toBe('applied')
    expect(fixture.restore).toHaveBeenCalledTimes(1)
    expect(fixture.ctx.windowPlacement.getPlacementRecord(WINDOW_A)).toMatchObject({
      originalBounds: normalBounds,
      originalState: 'maximized',
    })

    const restored = await fixture.ctx.windowPlacement.restorePlacement(WINDOW_A)
    expect(restored.status).toBe('applied')
    expect(fixture.setBounds).toHaveBeenLastCalledWith(WINDOW_A, normalBounds)
    expect(fixture.maximize).toHaveBeenCalledTimes(1)
    expect(fixture.registry.getWindow(WINDOW_A)?.state).toBe('maximized')

    await fixture.ctx.fiber.dispose()
  })

  it('replans against the newest work area when display revision changes in flight', async () => {
    let fixture: Awaited<ReturnType<typeof setup>>
    let first = true
    fixture = await setup(windowSnapshot(), {
      afterSetBounds: () => {
        if (!first) return
        first = false
        fixture.windowsContext.revision = 2
        fixture.layout.workAreas.set(MONITOR_1, { x: 0, y: 0, width: 1600, height: 900 })
      },
    })

    const placed = await fixture.ctx.windowPlacement.place(WINDOW_A, { kind: 'left-half' })
    expect(fixture.setBounds).toHaveBeenCalledTimes(2)
    expect(fixture.setBounds).toHaveBeenLastCalledWith(
      WINDOW_A,
      { x: 0, y: 0, width: 800, height: 900 },
    )
    expect(placed).toMatchObject({
      status: 'applied',
      displayRevision: 2,
      appliedRect: { x: 0, y: 0, width: 800, height: 900 },
    })

    await fixture.ctx.fiber.dispose()
  })

  it('reports named-layout failures per window and rejects duplicate WindowIds', async () => {
    const fixture = await setup()

    const layoutResult = await fixture.ctx.windowPlacement.applyNamedLayout({
      name: 'two-column',
      entries: [
        { windowId: WINDOW_A, target: { kind: 'left-half' } },
        { windowId: WINDOW_MISSING, target: { kind: 'right-half' } },
        { windowId: WINDOW_A, target: { kind: 'right-half' } },
      ],
    })

    expect(layoutResult.applied).toBe(1)
    expect(layoutResult.rejected).toBe(2)
    expect(layoutResult.results[1]).toMatchObject({ reason: 'stale-window-id' })
    expect(layoutResult.results[2]).toMatchObject({ reason: 'duplicate-layout-target' })

    await fixture.ctx.fiber.dispose()
  })

  it('honors cancellation before any native mutation', async () => {
    const fixture = await setup()
    const controller = new AbortController()
    controller.abort()

    const placement = await fixture.ctx.windowPlacement.place(
      WINDOW_A,
      { kind: 'left-half' },
      { signal: controller.signal },
    )
    expect(placement.status).toBe('cancelled')
    expect(fixture.setBounds).not.toHaveBeenCalled()

    await fixture.ctx.fiber.dispose()
  })

  it('restores into a connected work area when the original monitor disappeared', async () => {
    const fixture = await setup(windowSnapshot({
      monitorId: MONITOR_2,
      bounds: { x: -1100, y: 100, width: 900, height: 700 },
    }))
    await fixture.ctx.windowPlacement.place(WINDOW_A, { kind: 'center', monitorId: MONITOR_2 })

    fixture.windowsContext.monitors = [MONITORS[0]!]
    fixture.windowsContext.revision++
    fixture.layout.workAreas.delete(MONITOR_2)
    fixture.registry.update(WINDOW_A, { monitorId: MONITOR_1 })

    const restored = await fixture.ctx.windowPlacement.restorePlacement(WINDOW_A)
    expect(restored.status).toBe('adjusted')
    expect(restored.adjustments).toContain('monitor-fallback')
    expect(restored.appliedRect!.x).toBeGreaterThanOrEqual(0)
    expect(restored.appliedRect!.y).toBeGreaterThanOrEqual(0)

    await fixture.ctx.fiber.dispose()
  })
})
