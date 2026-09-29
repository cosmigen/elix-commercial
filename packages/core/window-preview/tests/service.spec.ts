import { Context } from '@deepseek-ai/cordis'
import type { NativeBridgeClient } from '@deepseek-ai/dsh-native-core'
import type { SurfaceInstance, SurfaceService } from '@deepseek-ai/dsh-surface'
import type {
  WindowId,
  WindowRegistryService,
  WindowRegistrySnapshot,
  WindowSnapshot,
} from '@deepseek-ai/dsh-window-registry'
import { describe, expect, it, vi } from 'vitest'
import { WindowPreviewService } from '../src/service.ts'
import type { NativePreviewSnapshot } from '../src/types.ts'

const WINDOW_A = 'window:a' as WindowId
const WINDOW_B = 'window:b' as WindowId

function windowSnapshot(
  id: WindowId,
  hwnd: number,
  overrides: Partial<WindowSnapshot> = {},
): WindowSnapshot {
  return {
    id,
    hwnd,
    processId: hwnd + 100,
    threadId: hwnd + 200,
    processCreationTime: hwnd + 300,
    title: `Window ${id}`,
    className: 'PreviewFixture',
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    classification: 'APPLICATION',
    state: 'normal',
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

class MutableRegistry {
  private windows = new Map<WindowId, WindowSnapshot>()
  private listeners = new Set<(snapshot: WindowRegistrySnapshot) => void>()
  private revision = 1

  constructor(windows: readonly WindowSnapshot[]) {
    for (const window of windows) this.windows.set(window.id, window)
  }

  getWindow(id: WindowId): WindowSnapshot | undefined {
    return this.windows.get(id)
  }

  subscribe(listener: (snapshot: WindowRegistrySnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  setWindow(window: WindowSnapshot): void {
    this.windows.set(window.id, window)
    this.publish()
  }

  remove(id: WindowId): void {
    this.windows.delete(id)
    this.publish()
  }

  private publish(): void {
    this.revision++
    const snapshot = {
      generation: 1,
      revision: this.revision,
      windows: Array.from(this.windows.values()),
      capturedAt: Date.now(),
    } as WindowRegistrySnapshot
    for (const listener of this.listeners) listener(snapshot)
  }
}

interface MutableSurface {
  id: string
  hwnd: number
  isVisible: boolean
  state: SurfaceInstance['state']
}

class SurfaceLookup {
  readonly values = new Map<string, MutableSurface>()

  get(id: string): SurfaceInstance | undefined {
    return this.values.get(id) as unknown as SurfaceInstance | undefined
  }
}

function createBridge() {
  const active = new Map<string, NativePreviewSnapshot>()
  const calls: string[] = []
  const registerCalls: Array<Record<string, unknown>> = []
  let denyNext = false
  let staleIdentityNext = false

  const sendRequest = vi.fn(async <T>(method: string, params?: unknown): Promise<T> => {
    calls.push(method)
    const input = params as Record<string, unknown> | undefined

    if (method === 'preview/register') {
      registerCalls.push({ ...input })
      if (denyNext) {
        denyNext = false
        throw { code: 'PREVIEW_ACCESS_DENIED', message: 'protected content' }
      }
      if (staleIdentityNext) {
        staleIdentityNext = false
        throw { code: 'PREVIEW_SOURCE_IDENTITY_STALE', message: 'stale window identity' }
      }
      const snapshot: NativePreviewSnapshot = {
        id: String(input?.id),
        sourceHwnd: Number(input?.sourceHwnd),
        destinationHwnd: Number(input?.destinationHwnd),
        sourceWidth: 1600,
        sourceHeight: 900,
        destinationRect: input?.destinationRect as NativePreviewSnapshot['destinationRect'],
        opacity: Number(input?.opacity),
        sourceClientAreaOnly: Boolean(input?.sourceClientAreaOnly),
        visible: Boolean(input?.visible),
        backend: 'dwm-thumbnail',
      }
      active.set(snapshot.id, snapshot)
      return snapshot as T
    }

    if (method === 'preview/update') {
      const existing = active.get(String(input?.id))
      if (!existing) throw { code: 'NOT_FOUND', message: 'missing preview' }
      const snapshot: NativePreviewSnapshot = {
        ...existing,
        destinationRect: (input?.destinationRect as NativePreviewSnapshot['destinationRect'])
          ?? existing.destinationRect,
        opacity: Number(input?.opacity ?? existing.opacity),
        sourceClientAreaOnly: Boolean(input?.sourceClientAreaOnly ?? existing.sourceClientAreaOnly),
        visible: Boolean(input?.visible ?? existing.visible),
      }
      active.set(snapshot.id, snapshot)
      return snapshot as T
    }

    if (method === 'preview/unregister') {
      const removed = active.delete(String(input?.id))
      return { unregistered: removed } as T
    }

    throw new Error(`Unexpected native method ${method}`)
  })

  return {
    bridge: { sendRequest } as unknown as NativeBridgeClient,
    active,
    calls,
    registerCalls,
    denyOnce: () => {
      denyNext = true
    },
    rejectIdentityOnce: () => {
      staleIdentityNext = true
    },
  }
}

async function setup(
  registry: MutableRegistry,
  surfaces: SurfaceLookup,
  bridge: NativeBridgeClient,
  maxLivePreviews = 12,
): Promise<Context> {
  const ctx = new Context()
  ctx.provide('windowRegistry')
  ctx.windowRegistry = registry as unknown as WindowRegistryService
  ctx.provide('surface')
  ctx.surface = surfaces as unknown as SurfaceService
  ctx.plugin(WindowPreviewService, { enabled: true, maxLivePreviews, bridge })
  await new Promise(resolve => setTimeout(resolve, 10))
  return ctx
}

function addSurface(
  surfaces: SurfaceLookup,
  id: string,
  hwnd: number,
  visible = true,
): MutableSurface {
  const surface: MutableSurface = {
    id,
    hwnd,
    isVisible: visible,
    state: visible ? 'VISIBLE' : 'HIDDEN',
  }
  surfaces.values.set(id, surface)
  return surface
}

const RECT = Object.freeze({ x: 10, y: 20, width: 400, height: 300 })

describe('WindowPreviewService', () => {
  it('creates independent live destination relationships and aspect-fits source content', async () => {
    const registry = new MutableRegistry([windowSnapshot(WINDOW_A, 1001)])
    const surfaces = new SurfaceLookup()
    addSurface(surfaces, 'dock', 2001)
    addSurface(surfaces, 'overview', 2002)
    const native = createBridge()
    const ctx = await setup(registry, surfaces, native.bridge)

    const dock = await ctx.windowPreview.acquirePreview({
      sourceWindowId: WINDOW_A,
      destinationSurfaceId: 'dock',
      destinationRect: RECT,
      consumerId: 'dock-hover',
      importance: 'high',
    })
    const overview = await ctx.windowPreview.acquirePreview({
      sourceWindowId: WINDOW_A,
      destinationSurfaceId: 'overview',
      destinationRect: RECT,
      consumerId: 'overview-grid',
    })

    expect(dock.state).toBe('live')
    expect(overview.state).toBe('live')
    expect(dock.effectiveRect).toEqual({ x: 10, y: 57, width: 400, height: 225 })
    expect(native.active.size).toBe(2)
    expect(ctx.windowPreview.getStats()).toMatchObject({ live: 2, nativeBindings: 2 })

    await ctx.fiber.dispose()
    expect(native.active.size).toBe(0)
  })

  it('pauses hidden destinations and resumes without restoring or activating the source', async () => {
    const registry = new MutableRegistry([windowSnapshot(WINDOW_A, 1001)])
    const surfaces = new SurfaceLookup()
    const dock = addSurface(surfaces, 'dock', 2001)
    const native = createBridge()
    const ctx = await setup(registry, surfaces, native.bridge)

    const lease = await ctx.windowPreview.acquirePreview({
      sourceWindowId: WINDOW_A,
      destinationSurfaceId: 'dock',
      destinationRect: RECT,
      consumerId: 'dock-hover',
    })
    expect(lease.state).toBe('live')

    dock.isVisible = false
    dock.state = 'HIDDEN'
    ctx.emit('surface/hidden', dock as unknown as SurfaceInstance)
    await ctx.windowPreview.refresh()
    expect(ctx.windowPreview.getLease(lease.id)).toMatchObject({
      state: 'paused',
      reason: 'consumer-hidden',
    })
    expect(native.active.size).toBe(0)

    dock.isVisible = true
    dock.state = 'VISIBLE'
    ctx.emit('surface/shown', dock as unknown as SurfaceInstance)
    await ctx.windowPreview.refresh()
    expect(ctx.windowPreview.getLease(lease.id)?.state).toBe('live')
    expect(native.active.size).toBe(1)

    await ctx.fiber.dispose()
  })

  it('retains live preview eligibility for minimized sources', async () => {
    const registry = new MutableRegistry([
      windowSnapshot(WINDOW_A, 1001, {
        isMinimized: true,
        state: 'minimized',
        isVisible: true,
        isCloaked: false,
      }),
    ])
    const surfaces = new SurfaceLookup()
    addSurface(surfaces, 'dock', 2001)
    const native = createBridge()
    const ctx = await setup(registry, surfaces, native.bridge)

    const lease = await ctx.windowPreview.acquirePreview({
      sourceWindowId: WINDOW_A,
      destinationSurfaceId: 'dock',
      destinationRect: RECT,
      consumerId: 'dock-hover',
    })
    expect(lease.state).toBe('live')
    expect(lease.backend).toBe('dwm-thumbnail')
    expect(native.active.size).toBe(1)

    await ctx.fiber.dispose()
  })

  it('uses fallback for cloaked sources while leaving native bindings at zero', async () => {
    const registry = new MutableRegistry([
      windowSnapshot(WINDOW_A, 1001, { isCloaked: true }),
    ])
    const surfaces = new SurfaceLookup()
    addSurface(surfaces, 'dock', 2001)
    const native = createBridge()
    const ctx = await setup(registry, surfaces, native.bridge)

    const lease = await ctx.windowPreview.acquirePreview({
      sourceWindowId: WINDOW_A,
      destinationSurfaceId: 'dock',
      destinationRect: RECT,
      consumerId: 'dock-hover',
    })
    expect(lease).toMatchObject({ state: 'unavailable', reason: 'source-not-composable' })
    expect(native.active.size).toBe(0)

    await ctx.fiber.dispose()
  })

  it('enforces live-preview budget on minimized sources', async () => {
    const registry = new MutableRegistry([
      windowSnapshot(WINDOW_A, 1001, { isMinimized: true, state: 'minimized' }),
      windowSnapshot(WINDOW_B, 1002, { isMinimized: true, state: 'minimized' }),
    ])
    const surfaces = new SurfaceLookup()
    addSurface(surfaces, 'one', 2001)
    addSurface(surfaces, 'two', 2002)
    const native = createBridge()
    const ctx = await setup(registry, surfaces, native.bridge, 1)

    const low = await ctx.windowPreview.acquirePreview({
      sourceWindowId: WINDOW_A,
      destinationSurfaceId: 'one',
      destinationRect: RECT,
      consumerId: 'background-overview',
      importance: 'low',
    })
    const high = await ctx.windowPreview.acquirePreview({
      sourceWindowId: WINDOW_B,
      destinationSurfaceId: 'two',
      destinationRect: RECT,
      consumerId: 'dock-hover',
      importance: 'critical',
    })

    expect(ctx.windowPreview.getLease(low.id)).toMatchObject({
      state: 'paused',
      reason: 'live-preview-budget',
    })
    expect(ctx.windowPreview.getLease(high.id)?.state).toBe('live')
    expect(native.active.size).toBe(1)

    await ctx.fiber.dispose()
  })

  it('pauses minimized source preview when destination surface becomes hidden', async () => {
    const registry = new MutableRegistry([
      windowSnapshot(WINDOW_A, 1001, { isMinimized: true, state: 'minimized' }),
    ])
    const surfaces = new SurfaceLookup()
    const dock = addSurface(surfaces, 'dock', 2001)
    const native = createBridge()
    const ctx = await setup(registry, surfaces, native.bridge)

    const lease = await ctx.windowPreview.acquirePreview({
      sourceWindowId: WINDOW_A,
      destinationSurfaceId: 'dock',
      destinationRect: RECT,
      consumerId: 'dock-hover',
    })
    expect(lease.state).toBe('live')
    expect(native.active.size).toBe(1)

    dock.isVisible = false
    dock.state = 'HIDDEN'
    ctx.emit('surface/hidden', dock as unknown as SurfaceInstance)
    await ctx.windowPreview.refresh()

    expect(ctx.windowPreview.getLease(lease.id)).toMatchObject({
      state: 'paused',
      reason: 'consumer-hidden',
    })
    expect(native.active.size).toBe(0)

    dock.isVisible = true
    dock.state = 'VISIBLE'
    ctx.emit('surface/shown', dock as unknown as SurfaceInstance)
    await ctx.windowPreview.refresh()

    expect(ctx.windowPreview.getLease(lease.id)?.state).toBe('live')
    expect(native.active.size).toBe(1)

    await ctx.fiber.dispose()
  })

  it('destroys lease and releases native relationship when minimized source is destroyed', async () => {
    const registry = new MutableRegistry([
      windowSnapshot(WINDOW_A, 1001, { isMinimized: true, state: 'minimized' }),
    ])
    const surfaces = new SurfaceLookup()
    addSurface(surfaces, 'dock', 2001)
    const native = createBridge()
    const ctx = await setup(registry, surfaces, native.bridge)

    const lease = await ctx.windowPreview.acquirePreview({
      sourceWindowId: WINDOW_A,
      destinationSurfaceId: 'dock',
      destinationRect: RECT,
      consumerId: 'dock-hover',
    })
    expect(lease.state).toBe('live')
    expect(native.active.size).toBe(1)

    registry.remove(WINDOW_A)
    await ctx.windowPreview.refresh()

    expect(ctx.windowPreview.getLease(lease.id)).toMatchObject({
      state: 'destroyed',
      reason: 'source-window-destroyed',
    })
    expect(native.active.size).toBe(0)

    await ctx.fiber.dispose()
  })

  it('enforces a priority-aware live budget and promotes a waiting lease after release', async () => {
    const registry = new MutableRegistry([
      windowSnapshot(WINDOW_A, 1001),
      windowSnapshot(WINDOW_B, 1002),
    ])
    const surfaces = new SurfaceLookup()
    addSurface(surfaces, 'one', 2001)
    addSurface(surfaces, 'two', 2002)
    const native = createBridge()
    const ctx = await setup(registry, surfaces, native.bridge, 1)

    const low = await ctx.windowPreview.acquirePreview({
      sourceWindowId: WINDOW_A,
      destinationSurfaceId: 'one',
      destinationRect: RECT,
      consumerId: 'background-overview',
      importance: 'low',
    })
    const high = await ctx.windowPreview.acquirePreview({
      sourceWindowId: WINDOW_B,
      destinationSurfaceId: 'two',
      destinationRect: RECT,
      consumerId: 'dock-hover',
      importance: 'critical',
    })

    expect(ctx.windowPreview.getLease(low.id)).toMatchObject({
      state: 'paused',
      reason: 'live-preview-budget',
    })
    expect(ctx.windowPreview.getLease(high.id)?.state).toBe('live')
    expect(native.active.size).toBe(1)

    await ctx.windowPreview.releasePreview(high.id)
    await ctx.windowPreview.refresh()
    expect(ctx.windowPreview.getLease(low.id)?.state).toBe('live')
    expect(native.active.size).toBe(1)

    await ctx.fiber.dispose()
  })

  it('releases every live binding while session is locked and restores it after unlock', async () => {
    const registry = new MutableRegistry([windowSnapshot(WINDOW_A, 1001)])
    const surfaces = new SurfaceLookup()
    addSurface(surfaces, 'dock', 2001)
    const native = createBridge()
    const ctx = await setup(registry, surfaces, native.bridge)

    const lease = await ctx.windowPreview.acquirePreview({
      sourceWindowId: WINDOW_A,
      destinationSurfaceId: 'dock',
      destinationRect: RECT,
      consumerId: 'dock-hover',
    })
    expect(lease.state).toBe('live')

    await ctx.windowPreview.setSessionLocked(true)
    expect(ctx.windowPreview.getLease(lease.id)).toMatchObject({
      state: 'paused',
      reason: 'session-locked',
    })
    expect(ctx.windowPreview.getStats().sessionLocked).toBe(true)
    expect(native.active.size).toBe(0)

    await ctx.windowPreview.setSessionLocked(false)
    expect(ctx.windowPreview.getLease(lease.id)?.state).toBe('live')
    expect(native.active.size).toBe(1)

    await ctx.fiber.dispose()
  })

  it('maps native capture restrictions to denied without bypass attempts', async () => {
    const registry = new MutableRegistry([windowSnapshot(WINDOW_A, 1001)])
    const surfaces = new SurfaceLookup()
    addSurface(surfaces, 'dock', 2001)
    const native = createBridge()
    native.denyOnce()
    const ctx = await setup(registry, surfaces, native.bridge)

    const lease = await ctx.windowPreview.acquirePreview({
      sourceWindowId: WINDOW_A,
      destinationSurfaceId: 'dock',
      destinationRect: RECT,
      consumerId: 'dock-hover',
    })
    expect(lease).toMatchObject({ state: 'denied', reason: 'PREVIEW_ACCESS_DENIED' })
    expect(native.active.size).toBe(0)

    await ctx.fiber.dispose()
  })

  it('coalesces resize storms to latest geometry and isolates subscriber failures', async () => {
    const registry = new MutableRegistry([windowSnapshot(WINDOW_A, 1001)])
    const surfaces = new SurfaceLookup()
    addSurface(surfaces, 'dock', 2001)
    const native = createBridge()
    const ctx = await setup(registry, surfaces, native.bridge)

    const lease = await ctx.windowPreview.acquirePreview({
      sourceWindowId: WINDOW_A,
      destinationSurfaceId: 'dock',
      destinationRect: RECT,
      consumerId: 'dock-hover',
    })
    ctx.windowPreview.subscribe(() => {
      throw new Error('consumer failure')
    })

    const updates: Promise<unknown>[] = []
    for (let index = 0; index < 40; index++) {
      updates.push(ctx.windowPreview.updateLease(lease.id, {
        destinationRect: { x: 10, y: 20, width: 400 + index, height: 300 + index },
      }))
    }
    await Promise.all(updates)

    expect(ctx.windowPreview.getLease(lease.id)?.destinationRect).toEqual({
      x: 10,
      y: 20,
      width: 439,
      height: 339,
    })
    expect(ctx.windowPreview.getLease(lease.id)?.state).toBe('live')
    expect(native.active.size).toBe(1)

    await ctx.fiber.dispose()
  })

  it('rebinds live leases after native-host recovery', async () => {
    const registry = new MutableRegistry([windowSnapshot(WINDOW_A, 1001)])
    const surfaces = new SurfaceLookup()
    addSurface(surfaces, 'dock', 2001)
    const native = createBridge()
    const ctx = await setup(registry, surfaces, native.bridge)

    const lease = await ctx.windowPreview.acquirePreview({
      sourceWindowId: WINDOW_A,
      destinationSurfaceId: 'dock',
      destinationRect: RECT,
      consumerId: 'dock-hover',
    })

    native.active.clear()
    const before = native.calls.filter(method => method === 'preview/register').length
    ctx.emit('window-registry/recovered')
    await ctx.windowPreview.refresh()
    const after = native.calls.filter(method => method === 'preview/register').length

    expect(after).toBeGreaterThan(before)
    expect(ctx.windowPreview.getLease(lease.id)?.state).toBe('live')
    expect(native.active.size).toBe(1)

    await ctx.fiber.dispose()
  })

  it('passes expected processId and processCreationTime to native preview/register', async () => {
    const windowA = windowSnapshot(WINDOW_A, 0x1000, { processId: 4321, processCreationTime: 987654321 })
    const registry = new MutableRegistry([windowA])
    const surfaces = new SurfaceLookup()
    addSurface(surfaces, 'dock', 0x5000)
    const native = createBridge()
    const ctx = await setup(registry, surfaces, native.bridge)

    const lease = await ctx.windowPreview.acquirePreview({
      sourceWindowId: WINDOW_A,
      destinationSurfaceId: 'dock',
      destinationRect: RECT,
      consumerId: 'dock-hover',
    })

    expect(lease.state).toBe('live')
    expect(native.registerCalls).toHaveLength(1)
    expect(native.registerCalls[0]).toMatchObject({
      id: lease.id,
      sourceHwnd: 0x1000,
      destinationHwnd: 0x5000,
      processId: 4321,
      processCreationTime: 987654321,
    })

    await ctx.fiber.dispose()
  })

  it('transitions to unavailable and unregisters when native rejects with PREVIEW_SOURCE_IDENTITY_STALE', async () => {
    const windowA = windowSnapshot(WINDOW_A, 0x1000)
    const registry = new MutableRegistry([windowA])
    const surfaces = new SurfaceLookup()
    addSurface(surfaces, 'dock', 0x5000)
    const native = createBridge()
    native.rejectIdentityOnce()
    const ctx = await setup(registry, surfaces, native.bridge)

    const lease = await ctx.windowPreview.acquirePreview({
      sourceWindowId: WINDOW_A,
      destinationSurfaceId: 'dock',
      destinationRect: RECT,
      consumerId: 'dock-hover',
    })

    expect(lease.state).toBe('unavailable')
    expect(lease.reason).toBe('PREVIEW_SOURCE_IDENTITY_STALE')
    expect(native.active.size).toBe(0)
    expect(ctx.windowPreview.getStats().nativeBindings).toBe(0)

    await ctx.fiber.dispose()
  })

  it('re-registers with new identity fence when processCreationTime changes (HWND recycling)', async () => {
    const windowA = windowSnapshot(WINDOW_A, 0x1000, { processId: 500, processCreationTime: 1000 })
    const registry = new MutableRegistry([windowA])
    const surfaces = new SurfaceLookup()
    addSurface(surfaces, 'dock', 0x5000)
    const native = createBridge()
    const ctx = await setup(registry, surfaces, native.bridge)

    const lease = await ctx.windowPreview.acquirePreview({
      sourceWindowId: WINDOW_A,
      destinationSurfaceId: 'dock',
      destinationRect: RECT,
      consumerId: 'dock-hover',
    })
    expect(lease.state).toBe('live')
    expect(native.registerCalls).toHaveLength(1)
    expect(native.registerCalls[0]?.processCreationTime).toBe(1000)

    // Simulate OS recycling HWND 0x1000 with a new process creation time
    const recycledWindowA = windowSnapshot(WINDOW_A, 0x1000, { processId: 500, processCreationTime: 2000 })
    registry.setWindow(recycledWindowA)
    await ctx.windowPreview.refresh()

    expect(native.registerCalls).toHaveLength(2)
    expect(native.registerCalls[1]?.processCreationTime).toBe(2000)
    expect(ctx.windowPreview.getLease(lease.id)?.state).toBe('live')
    expect(native.active.size).toBe(1)

    await ctx.fiber.dispose()
  })
})
