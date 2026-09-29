import { Context } from '@deepseek-ai/cordis'
import type { NativeBridgeClient } from '@deepseek-ai/dsh-native-core'
import type {
  WindowId,
  WindowRegistrySnapshot,
  WindowRegistrySource,
  WindowSnapshot,
} from '@deepseek-ai/dsh-window-registry'
import { describe, expect, it, vi } from 'vitest'
import SpacesService, { type SpaceId } from '../src/index.ts'

const SPACE_A_GUID = '11111111-1111-1111-1111-111111111111'
const SPACE_B_GUID = '22222222-2222-2222-2222-222222222222'
const SPACE_C_GUID = '33333333-3333-3333-3333-333333333333'
const SPACE_D_GUID = '44444444-4444-4444-4444-444444444444'
const SPACE_A = `space:${SPACE_A_GUID}` as SpaceId
const SPACE_B = `space:${SPACE_B_GUID}` as SpaceId
const SPACE_C = `space:${SPACE_C_GUID}` as SpaceId
const WINDOW_A = 'win_shell_a' as WindowId
const WINDOW_B = 'win_shell_b' as WindowId

function windowSnapshot(id: WindowId, hwnd: number): WindowSnapshot {
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
  }
}

class Registry implements WindowRegistrySource {
  private readonly windows = [windowSnapshot(WINDOW_A, 100), windowSnapshot(WINDOW_B, 200)]

  getSnapshot(): WindowRegistrySnapshot {
    return { generation: 1, revision: 1, windows: this.windows, capturedAt: Date.now() }
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
    return undefined
  }

  getWindowsForMonitor(): readonly WindowSnapshot[] {
    return []
  }

  async refresh(): Promise<WindowRegistrySnapshot> {
    return this.getSnapshot()
  }

  subscribe(): () => void {
    return () => undefined
  }
}

interface FakeSpace {
  desktopId: string
  index: number
  name: string
}

interface Membership {
  desktopId: string
  onCurrentDesktop: boolean
}

function createShellBridge() {
  const spaces: FakeSpace[] = [
    { desktopId: SPACE_A_GUID, index: 0, name: 'Desktop 1' },
    { desktopId: SPACE_B_GUID, index: 1, name: 'Work' },
    { desktopId: SPACE_C_GUID, index: 2, name: 'Empty' },
  ]
  let currentDesktopId = SPACE_A_GUID
  let notificationGeneration = 1
  let shellAvailable = true
  const memberships = new Map<number, Membership>([
    [100, { desktopId: SPACE_A_GUID, onCurrentDesktop: true }],
    [200, { desktopId: SPACE_B_GUID, onCurrentDesktop: false }],
  ])

  const normalize = () => {
    spaces.forEach((space, index) => {
      space.index = index
    })
    for (const membership of memberships.values()) {
      membership.onCurrentDesktop = membership.desktopId === currentDesktopId
    }
  }

  const shellSnapshot = () => ({
    provider: 'windows-shell-virtual-desktop' as const,
    backendVersion: 'test-shell',
    spaces: spaces.map(space => ({
      ...space,
      isCurrent: space.desktopId === currentDesktopId,
    })),
    currentDesktopId,
    nativeNotifications: true,
    notificationGeneration,
  })

  const sendRequest = vi.fn(async (method: string, rawRequest: unknown) => {
    const request = (rawRequest ?? {}) as Record<string, unknown>

    if (method.startsWith('spaces/shell') && !shellAvailable) {
      throw Object.assign(new Error('shell unavailable'), { code: 'SHELL_ENUMERATION_FAILED' })
    }

    if (method === 'spaces/shellSnapshot') return shellSnapshot()
    if (method === 'spaces/shellNotificationStatus') {
      return { generation: notificationGeneration, active: true }
    }

    if (method === 'spaces/queryWindow') {
      const target = request.target as { hwnd: number }
      const membership = memberships.get(target.hwnd)
      if (!membership) throw Object.assign(new Error('stale window'), { code: 'STALE_WINDOW_ID' })
      return {
        hwnd: target.hwnd,
        desktopId: membership.desktopId,
        onCurrentDesktop: membership.onCurrentDesktop,
      }
    }

    if (method === 'spaces/shellSwitch') {
      const desktopId = String(request.desktopId)
      if (!spaces.some(space => space.desktopId === desktopId)) {
        throw Object.assign(new Error('stale desktop'), { code: 'STALE_SPACE_ID' })
      }
      currentDesktopId = desktopId
      notificationGeneration++
      normalize()
      return shellSnapshot()
    }

    if (method === 'spaces/shellCreate') {
      const created: FakeSpace = {
        desktopId: SPACE_D_GUID,
        index: spaces.length,
        name: typeof request.name === 'string' ? request.name : '',
      }
      spaces.push(created)
      notificationGeneration++
      normalize()
      return { ...created, isCurrent: false }
    }

    if (method === 'spaces/shellRename') {
      const desktopId = String(request.desktopId)
      const space = spaces.find(candidate => candidate.desktopId === desktopId)
      if (!space) throw Object.assign(new Error('stale desktop'), { code: 'STALE_SPACE_ID' })
      space.name = String(request.name)
      notificationGeneration++
      return { ...space, isCurrent: desktopId === currentDesktopId }
    }

    if (method === 'spaces/shellRemove') {
      const desktopId = String(request.desktopId)
      const fallbackDesktopId = String(request.fallbackDesktopId)
      const targetIndex = spaces.findIndex(space => space.desktopId === desktopId)
      if (targetIndex < 0 || !spaces.some(space => space.desktopId === fallbackDesktopId)) {
        throw Object.assign(new Error('stale desktop'), { code: 'STALE_SPACE_ID' })
      }
      spaces.splice(targetIndex, 1)
      for (const membership of memberships.values()) {
        if (membership.desktopId === desktopId) membership.desktopId = fallbackDesktopId
      }
      if (currentDesktopId === desktopId) currentDesktopId = fallbackDesktopId
      notificationGeneration++
      normalize()
      return shellSnapshot()
    }

    if (method === 'spaces/shellMoveWindow') {
      const target = request.target as { hwnd: number }
      const desktopId = String(request.desktopId)
      const membership = memberships.get(target.hwnd)
      if (!membership) throw Object.assign(new Error('stale window'), { code: 'STALE_WINDOW_ID' })
      membership.desktopId = desktopId
      notificationGeneration++
      normalize()
      return {
        hwnd: target.hwnd,
        desktopId,
        onCurrentDesktop: membership.onCurrentDesktop,
      }
    }

    throw new Error(`unexpected method ${method}`)
  })

  return {
    bridge: { sendRequest } as unknown as NativeBridgeClient,
    sendRequest,
    spaces,
    memberships,
    setShellAvailable: (available: boolean) => {
      shellAvailable = available
    },
    getCurrentDesktopId: () => currentDesktopId,
  }
}

async function setup() {
  const native = createShellBridge()
  const registry = new Registry()
  const ctx = new Context()
  ctx.provide('windowRegistry')
  ctx.windowRegistry = registry as unknown as typeof ctx.windowRegistry
  ctx.plugin(SpacesService, {
    enabled: true,
    bridge: native.bridge,
    shellChangePollMs: 60_000,
  })
  await new Promise(resolve => setTimeout(resolve, 20))
  await ctx.spaces.refresh()
  return { ctx, registry, ...native }
}

describe('SpacesService shell provider', () => {
  it('upgrades to the full runtime-qualified capability set and includes empty desktops', async () => {
    const { ctx } = await setup()

    expect(ctx.spaces.getCapabilities()).toEqual({
      provider: 'windows-shell-virtual-desktop',
      windowMembership: true,
      currentWindowMembership: true,
      moveWindow: true,
      enumerateSpaces: true,
      switchSpace: true,
      createSpace: true,
      removeSpace: true,
      renameSpace: true,
      nativeNotifications: true,
    })

    const snapshot = ctx.spaces.getSnapshot()
    expect(snapshot.completeness).toBe('complete-shell-enumeration')
    expect(snapshot.currentSpaceId).toBe(SPACE_A)
    expect(snapshot.spaces).toEqual([
      { id: SPACE_A, index: 0, name: 'Desktop 1', windowIds: [WINDOW_A], isCurrent: true },
      { id: SPACE_B, index: 1, name: 'Work', windowIds: [WINDOW_B], isCurrent: false },
      { id: SPACE_C, index: 2, name: 'Empty', windowIds: [], isCurrent: false },
    ])

    await ctx.fiber.dispose()
  })

  it('switches the real current Space and verifies the committed snapshot', async () => {
    const { ctx, getCurrentDesktopId, sendRequest } = await setup()

    const snapshot = await ctx.spaces.switchSpace(SPACE_B)
    expect(getCurrentDesktopId()).toBe(SPACE_B_GUID)
    expect(snapshot.currentSpaceId).toBe(SPACE_B)
    expect(snapshot.spaces.find(space => space.id === SPACE_B)?.isCurrent).toBe(true)
    expect(sendRequest).toHaveBeenCalledWith('spaces/shellSwitch', { desktopId: SPACE_B_GUID })

    await ctx.fiber.dispose()
  })

  it('creates, renames, and removes a Space with explicit verification', async () => {
    const { ctx } = await setup()

    const created = await ctx.spaces.createSpace('ELIX Test')
    const createdId = `space:${SPACE_D_GUID}` as SpaceId
    expect(created).toMatchObject({ id: createdId, name: 'ELIX Test' })

    const renamed = await ctx.spaces.renameSpace(createdId, 'ELIX Renamed')
    expect(renamed.name).toBe('ELIX Renamed')

    const afterRemove = await ctx.spaces.removeSpace(createdId, SPACE_A)
    expect(afterRemove.spaces.some(space => space.id === createdId)).toBe(false)
    expect(afterRemove.spaces).toHaveLength(3)

    await ctx.fiber.dispose()
  })

  it('moves an arbitrary application window through the Shell provider and re-fences it', async () => {
    const { ctx, memberships, sendRequest } = await setup()

    const result = await ctx.spaces.moveWindowToSpace(WINDOW_B, SPACE_A)
    expect(result.spaceId).toBe(SPACE_A)
    expect(result.onCurrentSpace).toBe(true)
    expect(memberships.get(200)?.desktopId).toBe(SPACE_A_GUID)
    expect(sendRequest).toHaveBeenCalledWith('spaces/shellMoveWindow', {
      target: {
        hwnd: 200,
        processId: 1200,
        threadId: 2200,
        processCreationTime: 3200,
        className: 'Notepad',
      },
      desktopId: SPACE_A_GUID,
    })

    await ctx.fiber.dispose()
  })

  it('falls back to documented membership when Shell probing fails and upgrades after recovery', async () => {
    const { ctx, setShellAvailable } = await setup()
    expect(ctx.spaces.getCapabilities().provider).toBe('windows-shell-virtual-desktop')

    setShellAvailable(false)
    const fallback = await ctx.spaces.refresh()
    expect(fallback.capabilities.provider).toBe('windows-public-virtual-desktop-manager')
    expect(fallback.completeness).toBe('observed-application-windows')
    expect(fallback.capabilities.moveWindow).toBe(false)
    expect(fallback.currentSpaceId).toBe(SPACE_A)

    setShellAvailable(true)
    const recovered = await ctx.spaces.refresh()
    expect(recovered.capabilities.provider).toBe('windows-shell-virtual-desktop')
    expect(recovered.completeness).toBe('complete-shell-enumeration')
    expect(recovered.spaces).toHaveLength(3)

    await ctx.fiber.dispose()
  })
})
