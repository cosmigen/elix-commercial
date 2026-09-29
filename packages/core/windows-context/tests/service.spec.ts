import { Context } from '@deepseek-ai/cordis'
import type {
  NativeBridgeClient,
  NativeBridgeError,
  NativeWindowsContextChange,
  NativeWindowsContextSnapshot,
} from '@deepseek-ai/dsh-native-core'
import { describe, expect, it, vi } from 'vitest'
import WindowsContextService from '../src/index.ts'

const initial: NativeWindowsContextSnapshot = {
  revision: 1,
  monitors: [{
    id: 'monitor:test' as NativeWindowsContextSnapshot['monitors'][number]['id'],
    deviceName: String.raw`\\.\DISPLAY1`,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    dpiX: 96,
    dpiY: 96,
    scaleFactor: 1,
    isPrimary: true,
  }],
  primaryMonitorId: 'monitor:test' as NativeWindowsContextSnapshot['primaryMonitorId'],
  capturedAt: 1,
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_500): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  expect(predicate()).toBe(true)
}

function observerFault(code = 'OBSERVER_RUNTIME_FAILED'): NativeBridgeError {
  return Object.assign(new Error('observer fault'), {
    domain: 'windows-context',
    code,
  })
}

describe('WindowsContextService', () => {
  it('registers ctx.windowsContext, emits immutable snapshots, and stops observation on disposal', async () => {
    let listener: ((event: NativeWindowsContextChange) => void) | undefined
    const dispose = vi.fn(async () => true)
    const bridge = {
      windowsContext: {
        start: vi.fn(async (callback: (event: NativeWindowsContextChange) => void) => {
          listener = callback
          callback({ reason: 'initial', snapshot: initial })
          return { dispose }
        }),
        refresh: vi.fn(async () => {
          const refreshed = { ...initial, revision: 2, capturedAt: 2 }
          listener?.({ reason: 'refresh', snapshot: refreshed })
          return refreshed
        }),
      },
    } as unknown as NativeBridgeClient
    const ctx = new Context()
    const changes: number[] = []
    ctx.on('windows-context/change', change => changes.push(change.revision))
    ctx.plugin(WindowsContextService, { enabled: true, bridge })
    await new Promise(resolve => setTimeout(resolve, 25))

    expect(ctx.windowsContext.getPrimaryMonitor().id).toBe('monitor:test')
    expect(ctx.windowsContext.getForegroundContext()).toBeNull()
    await ctx.windowsContext.refresh()
    expect(changes).toEqual([1, 2])
    expect(ctx.windowsContext.getSnapshot().revision).toBe(2)

    await ctx.fiber.dispose()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('waits for a faulting observer to actually die before restarting it', async () => {
    let onFault: ((error: NativeBridgeError) => void) | undefined
    let statusChecks = 0
    let replacementStarted = false
    const firstDispose = vi.fn(async () => true)
    const replacementDispose = vi.fn(async () => true)
    const start = vi.fn(async (
      onEvent: (event: NativeWindowsContextChange) => void,
      fault?: (error: NativeBridgeError) => void,
    ) => {
      onFault = fault
      if (start.mock.calls.length === 1) {
        onEvent({ reason: 'initial', snapshot: initial })
        return { dispose: firstDispose }
      }
      replacementStarted = true
      onEvent({ reason: 'initial', snapshot: { ...initial, revision: 2, capturedAt: 2 } })
      return { dispose: replacementDispose }
    })
    const getStatus = vi.fn(async () => {
      statusChecks++
      // The native fault callback runs on the dying observer thread, so its first liveness probe
      // may still report alive. The second probe models the thread having reached quiescence.
      const threadAlive = statusChecks === 1
      return { observing: threadAlive, threadAlive }
    })
    const bridge = {
      windowsContext: {
        start,
        getStatus,
        refresh: vi.fn(),
      },
    } as unknown as NativeBridgeClient
    const ctx = new Context()
    ctx.plugin(WindowsContextService, { enabled: true, bridge })
    await waitUntil(() => start.mock.calls.length === 1)

    onFault?.(observerFault())

    await waitUntil(() => replacementStarted)
    expect(getStatus.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(start).toHaveBeenCalledTimes(2)
    expect(ctx.windowsContext.getSnapshot().capturedAt).toBe(2)

    await ctx.fiber.dispose()
    expect(replacementDispose).toHaveBeenCalledOnce()
  })

  it('retains a healthy observer after a recoverable capture fault', async () => {
    let onFault: ((error: NativeBridgeError) => void) | undefined
    const dispose = vi.fn(async () => true)
    const start = vi.fn(async (
      onEvent: (event: NativeWindowsContextChange) => void,
      fault?: (error: NativeBridgeError) => void,
    ) => {
      onFault = fault
      onEvent({ reason: 'initial', snapshot: initial })
      return { dispose }
    })
    const getStatus = vi.fn(async () => ({ observing: true, threadAlive: true }))
    const bridge = {
      windowsContext: {
        start,
        getStatus,
        refresh: vi.fn(),
      },
    } as unknown as NativeBridgeClient
    const ctx = new Context()
    ctx.plugin(WindowsContextService, { enabled: true, bridge })
    await waitUntil(() => start.mock.calls.length === 1)

    onFault?.(observerFault('WINDOWS_ERROR_TRANSIENT'))
    await waitUntil(() => getStatus.mock.calls.length >= 3)

    expect(start).toHaveBeenCalledTimes(1)
    expect(ctx.windowsContext.getSnapshot().capturedAt).toBe(1)

    await ctx.fiber.dispose()
    expect(dispose).toHaveBeenCalledOnce()
  })
})
