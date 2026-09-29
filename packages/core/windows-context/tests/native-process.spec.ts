import { describe, expect, it } from 'vitest'
import {
  createNativeBridge,
  type NativeWindowsContextChange,
} from '@deepseek-ai/dsh-native-core'

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!await predicate() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  expect(await predicate()).toBe(true)
}

describe('Windows Context native-host process integration', () => {
  it('negotiates capability, starts once, and returns a coherent live snapshot', async () => {
    const bridge = createNativeBridge()
    const events: NativeWindowsContextChange[] = []
    try {
      const handshake = await bridge.connect()
      expect(handshake.capabilities.windowsContext).toBe(true)
      const first = await bridge.windowsContext.start(event => events.push(event))
      const second = await bridge.windowsContext.start(event => events.push(event))
      const status = await bridge.windowsContext.getStatus()
      const snapshot = await bridge.windowsContext.getSnapshot()
      expect(status).toEqual({ observing: true, threadAlive: true })
      expect(snapshot.monitors.length).toBeGreaterThan(0)
      expect(snapshot.monitors.filter(monitor => monitor.isPrimary)).toHaveLength(1)
      expect(snapshot.primaryMonitorId).toBe(snapshot.monitors.find(monitor => monitor.isPrimary)?.id)
      for (const monitor of snapshot.monitors) {
        expect(monitor.bounds.width).toBeGreaterThan(0)
        expect(monitor.bounds.height).toBeGreaterThan(0)
        expect(monitor.dpiX).toBeGreaterThanOrEqual(96)
        expect(monitor.scaleFactor).toBeCloseTo(monitor.dpiX / 96, 8)
      }
      expect(events.length).toBeGreaterThan(0)
      expect(bridge.getWindowsContextListenerCountForTest()).toBe(2)
      await first.dispose()
      expect((await bridge.windowsContext.getStatus()).observing).toBe(true)
      await second.dispose()
      expect(await bridge.windowsContext.getStatus()).toEqual({ observing: false, threadAlive: false })
    } finally {
      await bridge.dispose()
    }
  })

  it('restores observation after a host crash and publishes a recovered replacement', async () => {
    const bridge = createNativeBridge({
      supervisor: { autoRestart: true, initialBackoffMs: 20, maxBackoffMs: 50 },
    })
    const events: NativeWindowsContextChange[] = []
    try {
      const subscription = await bridge.windowsContext.start(event => events.push(event))
      const firstGeneration = bridge.getHostGeneration()
      await bridge.crashHost()
      await waitUntil(() => bridge.getStatus() === 'ready' && bridge.getHostGeneration() > firstGeneration)
      await waitUntil(() => events.some(event => event.reason === 'recovered'))
      expect(await bridge.windowsContext.getStatus()).toEqual({ observing: true, threadAlive: true })
      await subscription.dispose()
    } finally {
      await bridge.dispose()
    }
  })

  it('rejects stale-generation events before Windows Context dispatch', async () => {
    const bridge = createNativeBridge()
    let calls = 0
    try {
      const subscription = await bridge.windowsContext.start(() => { calls++ })
      const currentGeneration = bridge.getHostGeneration()
      const snapshot = await bridge.windowsContext.getSnapshot()
      const before = calls
      bridge.handleIncomingLineForTest(JSON.stringify({
        event: 'windowsContext/change',
        payload: { reason: 'topology', snapshot: { ...snapshot, revision: snapshot.revision + 100 } },
      }), currentGeneration - 1)
      expect(calls).toBe(before)
      expect(bridge.getDiscardedStaleFrameCountForTest()).toBeGreaterThan(0)
      await subscription.dispose()
    } finally {
      await bridge.dispose()
    }
  })

  it('surfaces startup and runtime event-thread failure and can restart observation', async () => {
    const bridge = createNativeBridge()
    const faults: Error[] = []
    try {
      await bridge.connect()
      await bridge.sendRequest('windowsContext/testFailNextStart')
      await expect(bridge.windowsContext.start(() => {}, error => faults.push(error))).rejects.toMatchObject({
        code: 'OBSERVER_START_FAILED',
      })
      const subscription = await bridge.windowsContext.start(() => {}, error => faults.push(error))
      await bridge.sendRequest('windowsContext/testFailRuntime')
      await waitUntil(() => faults.some(error => (
        error as Error & { code?: string }
      ).code === 'OBSERVER_RUNTIME_FAILED'))
      await waitUntil(async () => !(await bridge.windowsContext.getStatus()).threadAlive)
      const replacement = await bridge.windowsContext.start(() => {}, error => faults.push(error))
      expect((await bridge.windowsContext.getStatus()).threadAlive).toBe(true)
      await replacement.dispose()
      await subscription.dispose()
    } finally {
      await bridge.dispose()
    }
  })

  it('isolates callbacks and disposal during reconnect cannot resurrect observation', async () => {
    const bridge = createNativeBridge({
      supervisor: { autoRestart: true, initialBackoffMs: 100, maxBackoffMs: 100 },
    })
    let healthyCalls = 0
    try {
      const bad = await bridge.windowsContext.start(() => { throw new Error('consumer failure') })
      const healthy = await bridge.windowsContext.start(() => { healthyCalls++ })
      await bridge.windowsContext.refresh()
      expect(healthyCalls).toBeGreaterThan(0)
      await bridge.crashHost()
      await bad.dispose()
      await healthy.dispose()
      await bridge.dispose()
      await new Promise(resolve => setTimeout(resolve, 150))
      expect(bridge.getStatus()).toBe('closed')
      expect(bridge.getWindowsContextListenerCountForTest()).toBe(0)
    } finally {
      await bridge.dispose()
    }
  })
})
