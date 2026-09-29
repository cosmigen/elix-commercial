import { spawn, type ChildProcess } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createNativeBridge,
  NativeBridgeClient,
  NativeBridgeError,
} from '../src/index.ts'
import type { NativeRawWindow } from '../src/types.ts'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

interface NativeControlResult {
  action: string
  hwnd: number
  accepted: boolean
  completed: boolean
  observation: {
    exists: boolean
    visible: boolean
    minimized: boolean
    maximized: boolean
    foreground: boolean
    bounds?: { x: number; y: number; width: number; height: number }
  }
}

function target(window: NativeRawWindow) {
  return {
    hwnd: window.hwnd,
    processId: window.processId,
    threadId: window.threadId,
    processCreationTime: window.processCreationTime,
    className: window.className,
  }
}

async function waitForBridgeRecovery(
  bridge: NativeBridgeClient,
  previousGeneration: number,
): Promise<void> {
  const deadline = Date.now() + 7000
  while (Date.now() < deadline) {
    if (bridge.getHostGeneration() > previousGeneration && bridge.isReady()) return
    await sleep(50)
  }
  throw new Error('Timed out waiting for native host recovery')
}

describe('Native Window Control Live Acceptance', () => {
  if (process.platform !== 'win32') {
    it.skip('Skipping Windows live tests on non-Windows platform', () => {})
    return
  }

  let bridge: NativeBridgeClient
  let child: ChildProcess | null = null
  let window: NativeRawWindow | undefined

  beforeAll(async () => {
    bridge = createNativeBridge()
    await bridge.connect()
  })

  afterAll(async () => {
    if (window) {
      await bridge.sendRequest('windowControl/execute', {
        action: 'close',
        target: target(window),
      }).catch(() => undefined)
    }
    if (child?.exitCode === null) child.kill()
    await bridge.dispose()
  })

  it('advertises windowControl capability', () => {
    const caps = bridge.getCapabilities()
    expect(caps?.windowControl).toBe(true)
  })

  it('controls a dedicated real Notepad, survives host recovery, and rejects stale evidence', async () => {
    const before = await bridge.windowRegistry.getSnapshot()
    const existing = new Set(before.windows.map(item => item.hwnd))
    child = spawn('notepad.exe', [], { stdio: 'ignore' })

    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const snapshot = await bridge.windowRegistry.refresh()
      window = snapshot.windows.find(item =>
        !existing.has(item.hwnd)
        && item.executableName?.toLowerCase() === 'notepad.exe'
        && item.isVisible
        && item.bounds.width > 0
        && item.bounds.height > 0,
      )
      if (window) break
      await sleep(50)
    }
    expect(window).toBeDefined()
    const original = window!

    const minimize = await bridge.sendRequest<NativeControlResult>('windowControl/execute', {
      action: 'minimize',
      target: target(original),
    })
    expect(minimize.accepted).toBe(true)
    expect(minimize.completed).toBe(true)
    expect(minimize.observation.minimized).toBe(true)

    const restore = await bridge.sendRequest<NativeControlResult>('windowControl/execute', {
      action: 'restore',
      target: target(original),
    })
    expect(restore.accepted).toBe(true)
    expect(restore.completed).toBe(true)
    expect(restore.observation.minimized).toBe(false)
    expect(restore.observation.maximized).toBe(false)

    const bounds = {
      x: original.bounds.x + 30,
      y: original.bounds.y + 20,
      width: Math.max(500, original.bounds.width - 40),
      height: Math.max(350, original.bounds.height - 40),
    }
    const moved = await bridge.sendRequest<NativeControlResult>('windowControl/execute', {
      action: 'setBounds',
      target: target(original),
      bounds,
    })
    expect(moved.accepted).toBe(true)
    expect(moved.completed).toBe(true)
    expect(moved.observation.bounds).toBeDefined()

    const maximize = await bridge.sendRequest<NativeControlResult>('windowControl/execute', {
      action: 'maximize',
      target: target(original),
    })
    expect(maximize.accepted).toBe(true)
    expect(maximize.completed).toBe(true)
    expect(maximize.observation.maximized).toBe(true)

    await bridge.sendRequest<NativeControlResult>('windowControl/execute', {
      action: 'restore',
      target: target(original),
    })

    try {
      const activation = await bridge.sendRequest<NativeControlResult>('windowControl/execute', {
        action: 'activate',
        target: target(original),
      })
      expect(activation.accepted).toBe(true)
      expect(activation.observation.foreground).toBe(true)
    } catch (error) {
      expect(error).toBeInstanceOf(NativeBridgeError)
      expect((error as NativeBridgeError).code).toBe('FOREGROUND_DENIED')
      expect((error as NativeBridgeError).retryable).toBe(true)
    }

    await expect(
      bridge.sendRequest('windowControl/execute', {
        action: 'minimize',
        target: {
          ...target(original),
          processId: original.processId + 1,
        },
      }),
    ).rejects.toMatchObject({ code: 'STALE_WINDOW' })

    const generationBeforeCrash = bridge.getHostGeneration()
    await bridge.sendRequest('bridge/crash', {}).catch(() => undefined)
    await waitForBridgeRecovery(bridge, generationBeforeCrash)

    const recoveredSnapshot = await bridge.windowRegistry.refresh()
    const recovered = recoveredSnapshot.windows.find(item =>
      item.hwnd === original.hwnd
      && item.processId === original.processId
      && item.threadId === original.threadId,
    )
    expect(recovered).toBeDefined()
    window = recovered

    const postRecoveryMinimize = await bridge.sendRequest<NativeControlResult>(
      'windowControl/execute',
      {
        action: 'minimize',
        target: target(recovered!),
      },
    )
    expect(postRecoveryMinimize.accepted).toBe(true)
    expect(postRecoveryMinimize.completed).toBe(true)
    expect(postRecoveryMinimize.observation.minimized).toBe(true)

    const postRecoveryRestore = await bridge.sendRequest<NativeControlResult>(
      'windowControl/execute',
      {
        action: 'restore',
        target: target(recovered!),
      },
    )
    expect(postRecoveryRestore.accepted).toBe(true)
    expect(postRecoveryRestore.completed).toBe(true)

    const closed = await bridge.sendRequest<NativeControlResult>('windowControl/execute', {
      action: 'close',
      target: target(recovered!),
    })
    expect(closed.accepted).toBe(true)

    const closeDeadline = Date.now() + 2500
    while (Date.now() < closeDeadline) {
      const snapshot = await bridge.windowRegistry.refresh()
      if (!snapshot.windows.some(item => item.hwnd === recovered!.hwnd)) break
      await sleep(50)
    }
    const finalSnapshot = await bridge.windowRegistry.refresh()
    expect(finalSnapshot.windows.some(item => item.hwnd === recovered!.hwnd)).toBe(false)
    window = undefined
  }, 25000)
})
