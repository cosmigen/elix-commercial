import { Context } from '@deepseek-ai/cordis'
import type { NativeBridgeClient } from '@deepseek-ai/dsh-native-core'
import type {
  WindowId,
  WindowRegistrySnapshot,
  WindowRegistrySource,
  WindowSnapshot,
} from '@deepseek-ai/dsh-window-registry'
import { describe, expect, it, vi } from 'vitest'
import SpacesService, { SpacesError, type SpaceId } from '../src/index.ts'

const SPACE_A_GUID = '11111111-1111-1111-1111-111111111111'
const SPACE_B_GUID = '22222222-2222-2222-2222-222222222222'
const SPACE_A = `space:${SPACE_A_GUID}` as SpaceId
const SPACE_B = `space:${SPACE_B_GUID}` as SpaceId
const WINDOW_A = 'win_space_a' as WindowId
const WINDOW_B = 'win_space_b' as WindowId

function windowSnapshot(
  id: WindowId,
  hwnd: number,
  overrides: Partial<WindowSnapshot> = {},
): WindowSnapshot {
  return {
    id,
    hwnd,
    processId: hwnd + 1000,
    threadId: hwnd + 2000,
    processCreationTime: hwnd + 3000,
    executablePath: 'C:/Windows/System32/notepad.exe',
    executableName: 'notepad.exe',
    title: `Window ${id}`,
    className: 'Notepad',
    bounds: { x: 100, y: 100, width: 800, height: 600 },
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

class MutableRegistry implements WindowRegistrySource {
  private windows: WindowSnapshot[]
  private readonly listeners = new Set<(snapshot: WindowRegistrySnapshot) => void>()
  private revision = 1

  constructor(windows: WindowSnapshot[]) {
    this.windows = windows
  }

  setWindows(windows: WindowSnapshot[]): void {
    this.windows = windows
    this.revision++
    const snapshot = this.getSnapshot()
    for (const listener of [...this.listeners]) listener(snapshot)
  }

  getSnapshot(): WindowRegistrySnapshot {
    return {
      generation: 1,
      revision: this.revision,
      windows: this.windows,
      capturedAt: Date.now(),
    }
  }

  getWindows(): readonly WindowSnapshot[] {
    return this.windows
  }

  getWindow(id: WindowId): WindowSnapshot | undefined {
    return this.windows.find(window => window.id === id)
  }

  getByHwnd(hwnd: number): WindowSnapshot | undefined {
    return this.windows.find(window => window.hwnd === hwnd)
  }

  getByProcessId(pid: number): readonly WindowSnapshot[] {
    return this.windows.filter(window => window.processId === pid)
  }

  getForegroundWindow(): WindowSnapshot | undefined {
    return this.windows.find(window => window.isForeground)
  }

  getWindowsForMonitor(): readonly WindowSnapshot[] {
    return []
  }

  async refresh(): Promise<WindowRegistrySnapshot> {
    return this.getSnapshot()
  }

  subscribe(listener: (snapshot: WindowRegistrySnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

interface MembershipState {
  desktopId: string
  onCurrentDesktop: boolean
}

interface NativeRequest {
  readonly target: {
    readonly hwnd: number
    readonly processId: number
    readonly threadId: number
    readonly processCreationTime: number
    readonly className: string
  }
  readonly desktopId?: string | undefined
}

function createBridge(
  memberships: Map<number, MembershipState>,
  onRequest?: (method: string, request: NativeRequest) => Promise<void> | void,
) {
  const sendRequest = vi.fn(async (method: string, request: NativeRequest) => {
    await onRequest?.(method, request)
    const state = memberships.get(request.target.hwnd)
    if (!state) {
      const error = new Error('stale native window') as Error & { code: string }
      error.code = 'STALE_WINDOW_ID'
      throw error
    }

    if (method === 'spaces/queryWindow') {
      return {
        hwnd: request.target.hwnd,
        desktopId: state.desktopId,
        onCurrentDesktop: state.onCurrentDesktop,
      }
    }
    throw new Error(`unexpected method ${method}`)
  })
  return {
    bridge: { sendRequest } as unknown as NativeBridgeClient,
    sendRequest,
  }
}

async function setup(
  windows = [windowSnapshot(WINDOW_A, 100), windowSnapshot(WINDOW_B, 200)],
  memberships = new Map<number, MembershipState>([
    [100, { desktopId: SPACE_A_GUID, onCurrentDesktop: true }],
    [200, { desktopId: SPACE_B_GUID, onCurrentDesktop: false }],
  ]),
  onRequest?: (method: string, request: NativeRequest) => Promise<void> | void,
) {
  const registry = new MutableRegistry(windows)
  const native = createBridge(memberships, onRequest)
  const ctx = new Context()
  ctx.provide('windowRegistry')
  ctx.windowRegistry = registry as unknown as typeof ctx.windowRegistry
  ctx.plugin(SpacesService, { enabled: true, bridge: native.bridge })
  await new Promise(resolve => setTimeout(resolve, 20))
  return { ctx, registry, memberships, ...native }
}

describe('SpacesService', () => {
  it('reports only the documented cross-process Windows capabilities', async () => {
    const { ctx } = await setup()
    expect(ctx.spaces.getCapabilities()).toEqual({
      provider: 'windows-public-virtual-desktop-manager',
      windowMembership: true,
      currentWindowMembership: true,
      moveWindow: false,
      enumerateSpaces: false,
      switchSpace: false,
      createSpace: false,
      removeSpace: false,
      renameSpace: false,
      nativeNotifications: false,
    })
    await ctx.fiber.dispose()
  })

  it('queries membership with complete Window Registry lifetime evidence and opaque SpaceId', async () => {
    const { ctx, sendRequest } = await setup()
    const membership = await ctx.spaces.getWindowSpace(WINDOW_A)

    expect(membership).toMatchObject({
      windowId: WINDOW_A,
      spaceId: SPACE_A,
      onCurrentSpace: true,
    })
    expect(sendRequest).toHaveBeenLastCalledWith('spaces/queryWindow', {
      target: {
        hwnd: 100,
        processId: 1100,
        threadId: 2100,
        processCreationTime: 3100,
        className: 'Notepad',
      },
    })
    await ctx.fiber.dispose()
  })

  it('reconciles only observed application-backed spaces and derives the current SpaceId', async () => {
    const { ctx } = await setup()
    const snapshot = await ctx.spaces.refresh()

    expect(snapshot.completeness).toBe('observed-application-windows')
    expect(snapshot.currentSpaceId).toBe(SPACE_A)
    expect(snapshot.unresolvedWindowIds).toEqual([])
    expect(snapshot.spaces).toEqual([
      { id: SPACE_A, windowIds: [WINDOW_A], isCurrent: true },
      { id: SPACE_B, windowIds: [WINDOW_B], isCurrent: false },
    ])
    await ctx.fiber.dispose()
  })

  it('rejects stale WindowIds and non-APPLICATION windows before native access', async () => {
    const { ctx, sendRequest } = await setup()
    const callsBefore = sendRequest.mock.calls.length
    await expect(ctx.spaces.getWindowSpace('missing' as WindowId)).rejects.toMatchObject({
      code: 'STALE_WINDOW_ID',
    })
    expect(sendRequest.mock.calls.length).toBe(callsBefore)
    await ctx.fiber.dispose()

    const shell = windowSnapshot(WINDOW_A, 100, { classification: 'SHELL' })
    const second = await setup([shell])
    const secondCalls = second.sendRequest.mock.calls.length
    await expect(second.ctx.spaces.getWindowSpace(WINDOW_A)).rejects.toMatchObject({
      code: 'TARGET_NOT_APPLICATION',
    })
    expect(second.sendRequest.mock.calls.length).toBe(secondCalls)
    await second.ctx.fiber.dispose()
  })

  it('records per-window reconciliation failures without inventing space membership', async () => {
    const windows = [windowSnapshot(WINDOW_A, 100), windowSnapshot(WINDOW_B, 200)]
    const memberships = new Map<number, MembershipState>([
      [100, { desktopId: SPACE_A_GUID, onCurrentDesktop: true }],
    ])
    const { ctx } = await setup(windows, memberships)
    const snapshot = await ctx.spaces.refresh()

    expect(snapshot.currentSpaceId).toBe(SPACE_A)
    expect(snapshot.spaces).toEqual([
      { id: SPACE_A, windowIds: [WINDOW_A], isCurrent: true },
    ])
    expect(snapshot.unresolvedWindowIds).toContain(WINDOW_B)
    await ctx.fiber.dispose()
  })

  it('rejects arbitrary window moves before native access when the provider lacks that capability', async () => {
    const { ctx, sendRequest } = await setup()
    await ctx.spaces.refresh()
    const callsBefore = sendRequest.mock.calls.length

    await expect(ctx.spaces.moveWindowToSpace(WINDOW_A, SPACE_B)).rejects.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
      retryable: false,
    })
    expect(sendRequest.mock.calls.length).toBe(callsBefore)
    expect(sendRequest.mock.calls.some(call => call[0] === 'spaces/moveWindow')).toBe(false)
    await ctx.fiber.dispose()
  })

  it('re-fences WindowId lifetime after native I/O', async () => {
    let registry: MutableRegistry | undefined
    let mutated = false
    const initial = windowSnapshot(WINDOW_A, 100)
    const nativeMemberships = new Map<number, MembershipState>([
      [100, { desktopId: SPACE_A_GUID, onCurrentDesktop: true }],
    ])
    const setupResult = await setup([initial], nativeMemberships, method => {
      if (method === 'spaces/queryWindow' && registry && !mutated) {
        mutated = true
        registry.setWindows([
          windowSnapshot(WINDOW_A, 101, {
            processId: 9999,
            threadId: 9998,
            processCreationTime: 9997,
          }),
        ])
      }
    })
    registry = setupResult.registry

    await expect(setupResult.ctx.spaces.getWindowSpace(WINDOW_A)).rejects.toMatchObject({
      code: 'STALE_WINDOW_ID',
    })
    await setupResult.ctx.fiber.dispose()
  })

  it('coalesces registry-driven reconciliation and publishes observed changes', async () => {
    const { ctx, registry, memberships } = await setup()
    const listener = vi.fn()
    ctx.spaces.subscribe(listener)

    memberships.get(200)!.desktopId = SPACE_A_GUID
    memberships.get(200)!.onCurrentDesktop = true
    registry.setWindows([
      windowSnapshot(WINDOW_A, 100),
      windowSnapshot(WINDOW_B, 200, { updatedRevision: 2 }),
    ])
    await new Promise(resolve => setTimeout(resolve, 30))

    const snapshot = ctx.spaces.getSnapshot()
    expect(snapshot.spaces).toEqual([
      { id: SPACE_A, windowIds: [WINDOW_A, WINDOW_B], isCurrent: true },
    ])
    expect(listener).toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('completes overlapping refresh requests without recursive rescheduling', async () => {
    const { ctx } = await setup()
    const snapshots = await Promise.all(
      Array.from({ length: 64 }, () => ctx.spaces.refresh()),
    )

    expect(snapshots).toHaveLength(64)
    expect(snapshots.every(snapshot => snapshot.currentSpaceId === SPACE_A)).toBe(true)
    expect(ctx.spaces.getSnapshot().spaces).toHaveLength(2)
    await ctx.fiber.dispose()
  })

  it('contains consumer listener exceptions', async () => {
    const { ctx } = await setup()
    ctx.spaces.subscribe(() => {
      throw new Error('consumer bug')
    })
    await expect(ctx.spaces.refresh()).resolves.toMatchObject({
      completeness: 'observed-application-windows',
    })
    await ctx.fiber.dispose()
  })

  it('exposes stable SpacesError instances for callers', () => {
    const error = new SpacesError('STALE_SPACE_ID', 'stale')
    expect(error.name).toBe('SpacesError')
    expect(error.retryable).toBe(false)
  })
})
