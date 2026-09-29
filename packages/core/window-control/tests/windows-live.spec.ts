import { spawn, type ChildProcess } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import {
  createNativeBridge,
  NativeBridgeError,
  type NativeBridgeClient,
} from '@deepseek-ai/dsh-native-core'
import WindowRegistryService, {
  type WindowId,
  type WindowSnapshot,
} from '@deepseek-ai/dsh-window-registry'
import WindowsContextService from '@deepseek-ai/dsh-windows-context'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WindowControlService from '../src/index.ts'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function waitForNewNotepad(
  registry: WindowRegistryService,
  existingIds: ReadonlySet<WindowId>,
): Promise<WindowSnapshot> {
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    await registry.refresh()
    const candidate = registry.getWindows().find(window =>
      !existingIds.has(window.id)
      && window.classification === 'APPLICATION'
      && window.executableName?.toLowerCase() === 'notepad.exe'
      && window.isVisible
      && window.bounds.width > 0
      && window.bounds.height > 0,
    )
    if (candidate) return candidate
    await sleep(50)
  }
  throw new Error('Timed out waiting for a dedicated Notepad APPLICATION window')
}

async function waitForWindowState(
  registry: WindowRegistryService,
  windowId: WindowId,
  predicate: (window: WindowSnapshot | undefined) => boolean,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const current = registry.getWindow(windowId)
    if (predicate(current)) return
    await sleep(25)
  }
  throw new Error(`Timed out waiting for Window Registry state for ${windowId}`)
}

async function waitForBridgeRecovery(
  bridge: NativeBridgeClient,
  previousHostGeneration: number,
  timeoutMs = 7_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (bridge.getHostGeneration() > previousHostGeneration && bridge.isReady()) return
    await sleep(50)
  }
  throw new Error('Timed out waiting for Native Bridge host recovery')
}

async function waitForRegistryRecovery(
  registry: WindowRegistryService,
  previousRegistryGeneration: number,
  timeoutMs = 7_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (registry.getSnapshot().generation > previousRegistryGeneration) return
    await sleep(50)
  }
  throw new Error('Timed out waiting for Window Registry recovery generation')
}

describe('Window Control real Cordis-service acceptance', () => {
  if (process.platform !== 'win32') {
    it.skip('requires a real Windows desktop', () => {})
    return
  }

  let bridge: NativeBridgeClient
  let ctx: Context
  let child: ChildProcess | null = null
  let targetId: WindowId | undefined

  beforeAll(async () => {
    bridge = createNativeBridge()
    await bridge.connect()

    ctx = new Context()
    ctx.plugin(WindowsContextService, { enabled: true, bridge })
    ctx.plugin(WindowRegistryService, { enabled: true, bridge })
    ctx.plugin(WindowControlService, { enabled: true, bridge })
    await sleep(300)
  })

  afterAll(async () => {
    if (targetId && ctx.windowRegistry.getWindow(targetId)) {
      await ctx.windowControl.close(targetId).catch(() => undefined)
      await sleep(150)
    }
    if (child?.exitCode === null) child.kill()
    await ctx.fiber.dispose()
    await bridge.dispose()
  })

  it('controls one real Notepad across native-host recovery and rejects the stale WindowId after close', async () => {
    expect(bridge.getCapabilities()?.windowControl).toBe(true)

    const existingIds = new Set(ctx.windowRegistry.getWindows().map(window => window.id))
    child = spawn('notepad.exe', [], { stdio: 'ignore' })

    const target = await waitForNewNotepad(ctx.windowRegistry, existingIds)
    targetId = target.id

    const minimized = await ctx.windowControl.minimize(target.id)
    expect(minimized.accepted).toBe(true)
    expect(minimized.completed).toBe(true)
    expect(minimized.observation.minimized).toBe(true)
    await waitForWindowState(ctx.windowRegistry, target.id, window => window?.state === 'minimized')

    const restored = await ctx.windowControl.restore(target.id)
    expect(restored.accepted).toBe(true)
    expect(restored.completed).toBe(true)
    expect(restored.observation.minimized).toBe(false)
    expect(restored.observation.maximized).toBe(false)
    await waitForWindowState(ctx.windowRegistry, target.id, window => window?.state === 'normal')

    const current = ctx.windowRegistry.getWindow(target.id)
    expect(current).toBeDefined()
    const monitor = current?.monitorId
      ? ctx.windowsContext.getMonitor(current.monitorId)
      : ctx.windowsContext.getPrimaryMonitor()
    expect(monitor).toBeDefined()

    const width = Math.min(current!.bounds.width, monitor!.workArea.width)
    const height = Math.min(current!.bounds.height, monitor!.workArea.height)
    const desired = {
      x: monitor!.workArea.x + Math.max(0, Math.min(40, monitor!.workArea.width - width)),
      y: monitor!.workArea.y + Math.max(0, Math.min(40, monitor!.workArea.height - height)),
      width,
      height,
    }
    const moved = await ctx.windowControl.setBounds(target.id, desired)
    expect(moved.accepted).toBe(true)
    expect(moved.completed).toBe(true)
    expect(moved.observation.bounds).toBeDefined()

    const maximized = await ctx.windowControl.maximize(target.id)
    expect(maximized.accepted).toBe(true)
    expect(maximized.completed).toBe(true)
    expect(maximized.observation.maximized).toBe(true)

    const restoredAgain = await ctx.windowControl.restore(target.id)
    expect(restoredAgain.accepted).toBe(true)
    expect(restoredAgain.completed).toBe(true)

    try {
      const activation = await ctx.windowControl.activate(target.id)
      expect(activation.accepted).toBe(true)
      if (activation.completed) {
        expect(activation.observation.foreground).toBe(true)
      }
    } catch (error) {
      expect(error).toBeInstanceOf(NativeBridgeError)
      expect((error as NativeBridgeError).code).toBe('FOREGROUND_DENIED')
      expect((error as NativeBridgeError).retryable).toBe(true)
    }

    const previousHostGeneration = bridge.getHostGeneration()
    const previousRegistryGeneration = ctx.windowRegistry.getSnapshot().generation
    await bridge.sendRequest('bridge/crash', {}).catch(() => undefined)
    await waitForBridgeRecovery(bridge, previousHostGeneration)
    await waitForRegistryRecovery(ctx.windowRegistry, previousRegistryGeneration)

    const recovered = ctx.windowRegistry.getWindow(target.id)
    expect(recovered).toBeDefined()
    expect(recovered?.id).toBe(target.id)
    expect(recovered?.hwnd).toBe(target.hwnd)
    expect(recovered?.processId).toBe(target.processId)

    const postRecoveryMinimize = await ctx.windowControl.minimize(target.id)
    expect(postRecoveryMinimize.accepted).toBe(true)
    expect(postRecoveryMinimize.completed).toBe(true)
    await waitForWindowState(ctx.windowRegistry, target.id, window => window?.state === 'minimized')

    const postRecoveryRestore = await ctx.windowControl.restore(target.id)
    expect(postRecoveryRestore.accepted).toBe(true)
    expect(postRecoveryRestore.completed).toBe(true)
    await waitForWindowState(ctx.windowRegistry, target.id, window => window?.state === 'normal')

    const closed = await ctx.windowControl.close(target.id)
    expect(closed.accepted).toBe(true)

    await waitForWindowState(ctx.windowRegistry, target.id, window => window === undefined, 5_000)
    await expect(ctx.windowControl.activate(target.id)).rejects.toMatchObject({
      code: 'STALE_WINDOW_ID',
    })

    targetId = undefined
  }, 35_000)
})
