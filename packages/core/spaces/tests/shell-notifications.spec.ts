import { Context } from '@deepseek-ai/cordis'
import type { NativeBridgeClient } from '@deepseek-ai/dsh-native-core'
import type {
  WindowId,
  WindowRegistrySnapshot,
  WindowRegistrySource,
  WindowSnapshot,
} from '@deepseek-ai/dsh-window-registry'
import { expect, it, vi } from 'vitest'
import SpacesService, { type SpaceId } from '../src/index.ts'

const SPACE_A_GUID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const SPACE_B_GUID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const SPACE_A = `space:${SPACE_A_GUID}` as SpaceId
const SPACE_B = `space:${SPACE_B_GUID}` as SpaceId

class EmptyRegistry implements WindowRegistrySource {
  getSnapshot(): WindowRegistrySnapshot {
    return { generation: 1, revision: 1, windows: [], capturedAt: Date.now() }
  }

  getWindows(): readonly WindowSnapshot[] {
    return []
  }

  getWindow(_id: WindowId): WindowSnapshot | undefined {
    return undefined
  }

  getByHwnd(_hwnd: number): WindowSnapshot | undefined {
    return undefined
  }

  getByProcessId(_pid: number): readonly WindowSnapshot[] {
    return []
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

it('reconciles an external desktop switch when the native notification generation changes', async () => {
  let currentDesktopId = SPACE_A_GUID
  let generation = 1

  const shellSnapshot = () => ({
    provider: 'windows-shell-virtual-desktop' as const,
    backendVersion: 'test-shell',
    spaces: [
      { desktopId: SPACE_A_GUID, index: 0, name: 'Desktop 1', isCurrent: currentDesktopId === SPACE_A_GUID },
      { desktopId: SPACE_B_GUID, index: 1, name: 'Desktop 2', isCurrent: currentDesktopId === SPACE_B_GUID },
    ],
    currentDesktopId,
    nativeNotifications: true,
    notificationGeneration: generation,
  })

  const sendRequest = vi.fn(async (method: string) => {
    if (method === 'spaces/shellSnapshot') return shellSnapshot()
    if (method === 'spaces/shellNotificationStatus') {
      return { generation, active: true }
    }
    throw new Error(`unexpected method ${method}`)
  })

  const ctx = new Context()
  ctx.provide('windowRegistry')
  ctx.windowRegistry = new EmptyRegistry() as unknown as typeof ctx.windowRegistry
  ctx.plugin(SpacesService, {
    enabled: true,
    bridge: { sendRequest } as unknown as NativeBridgeClient,
    shellChangePollMs: 200,
  })

  await new Promise(resolve => setTimeout(resolve, 30))
  await ctx.spaces.refresh()
  expect(ctx.spaces.getCurrentSpaceId()).toBe(SPACE_A)

  const listener = vi.fn()
  const unsubscribe = ctx.spaces.subscribe(listener)
  currentDesktopId = SPACE_B_GUID
  generation++

  await new Promise(resolve => setTimeout(resolve, 320))

  expect(ctx.spaces.getCurrentSpaceId()).toBe(SPACE_B)
  expect(ctx.spaces.getSnapshot().spaces.find(space => space.id === SPACE_B)?.isCurrent).toBe(true)
  expect(listener).toHaveBeenCalled()
  expect(sendRequest).toHaveBeenCalledWith('spaces/shellNotificationStatus', {})

  unsubscribe()
  await ctx.fiber.dispose()
})
