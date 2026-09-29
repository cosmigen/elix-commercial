import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createNativeBridge,
  NativeBridgeClient,
} from '../src/index.ts'
import type { NativeWindowRegistryChange } from '../src/types.ts'

describe('Native Core Window Registry Live Acceptance', () => {
  if (process.platform !== 'win32') {
    it.skip('Skipping Windows live tests on non-Windows platform', () => {})
    return
  }

  let bridge: NativeBridgeClient

  beforeAll(async () => {
    bridge = createNativeBridge()
    await bridge.connect()
  })

  afterAll(async () => {
    await bridge.dispose()
  })

  it('negotiates window_registry capability during handshake', () => {
    const caps = bridge.getCapabilities()
    expect(caps).toBeDefined()
    expect(caps?.windowRegistry).toBe(true)
  })

  it('retrieves point-in-time snapshot with real Windows top-level windows', async () => {
    const snapshot = await bridge.windowRegistry.getSnapshot()
    expect(snapshot.revision).toBeGreaterThanOrEqual(1)
    expect(Array.isArray(snapshot.windows)).toBe(true)
    expect(snapshot.windows.length).toBeGreaterThan(0)

    // Verify raw window structure on real windows
    const first = snapshot.windows[0]!
    expect(first.hwnd).toBeGreaterThan(0)
    expect(first.processId).toBeGreaterThan(0)
    expect(typeof first.title).toBe('string')
    expect(typeof first.className).toBe('string')
    expect(first.bounds).toBeDefined()
    expect(typeof first.bounds.x).toBe('number')
    expect(typeof first.bounds.y).toBe('number')
    expect(typeof first.bounds.width).toBe('number')
    expect(typeof first.bounds.height).toBe('number')
    expect(typeof first.isVisible).toBe('boolean')
    expect(typeof first.isMinimized).toBe('boolean')
    expect(typeof first.isMaximized).toBe('boolean')
    expect(typeof first.isCloaked).toBe('boolean')
    expect(typeof first.isToolWindow).toBe('boolean')
    expect(typeof first.isShellWindow).toBe('boolean')
  })

  it('starts continuous observation, receives initial event, and allows refresh', async () => {
    const receivedEvents: NativeWindowRegistryChange[] = []
    const sub = await bridge.windowRegistry.start((event) => {
      receivedEvents.push(event)
    })

    try {
      expect(receivedEvents.length).toBeGreaterThanOrEqual(1)
      expect(receivedEvents[0]!.snapshot.windows.length).toBeGreaterThan(0)

      const status = await bridge.windowRegistry.getStatus()
      expect(status.observing).toBe(true)
      expect(status.threadAlive).toBe(true)

      const refreshed = await bridge.windowRegistry.refresh()
      expect(refreshed.windows.length).toBeGreaterThan(0)
      expect(receivedEvents.length).toBeGreaterThanOrEqual(2)
    } finally {
      await sub.dispose()
    }
  })

  it('observes ELIX surfaces created by the same native host process', async () => {
    const events: NativeWindowRegistryChange[] = []
    const sub = await bridge.windowRegistry.start((event) => {
      events.push(event)
    })

    const surfaceId = `window-registry-own-process-${Date.now()}`
    let surfaceHwnd: number | undefined

    try {
      const surface = await bridge.surface.create({
        id: surfaceId,
        bounds: { x: 120, y: 120, width: 320, height: 180 },
        focusPolicy: 'noActivate',
        zOrderPolicy: 'normal',
        visible: false,
      })
      surfaceHwnd = surface.hwnd
      expect(surfaceHwnd).toBeGreaterThan(0)

      const deadline = Date.now() + 2500
      let observed = false
      while (Date.now() < deadline) {
        const snapshot = await bridge.windowRegistry.getSnapshot()
        if (snapshot.windows.some(window => window.hwnd === surfaceHwnd)) {
          observed = true
          break
        }
        await new Promise(resolve => setTimeout(resolve, 25))
      }

      expect(observed).toBe(true)
      expect(events.some(event => event.snapshot.windows.some(window => window.hwnd === surfaceHwnd))).toBe(true)

      const destroyed = await bridge.surface.destroy(surfaceId)
      expect(destroyed).toBe(true)

      const destroyDeadline = Date.now() + 2500
      let removed = false
      while (Date.now() < destroyDeadline) {
        const snapshot = await bridge.windowRegistry.getSnapshot()
        if (!snapshot.windows.some(window => window.hwnd === surfaceHwnd)) {
          removed = true
          break
        }
        await new Promise(resolve => setTimeout(resolve, 25))
      }

      expect(removed).toBe(true)
    } finally {
      if (surfaceHwnd !== undefined) {
        await bridge.surface.destroy(surfaceId).catch(() => false)
      }
      await sub.dispose()
    }
  })

  it('declaratively restores window registry observer across host crash', async () => {
    const events: NativeWindowRegistryChange[] = []
    const sub = await bridge.windowRegistry.start((event) => {
      events.push(event)
    })

    try {
      const initialGen = bridge.getHostGeneration()
      expect(bridge.getWindowRegistryListenerCountForTest()).toBe(1)

      // Crash native host
      await bridge.crashHost()

      // Wait for supervisor to detect exit and complete reconnect to ready state
      const start = Date.now()
      while (
        (bridge.getStatus() !== 'ready' || bridge.getHostGeneration() === initialGen) &&
        Date.now() - start < 4000
      ) {
        await new Promise(r => setTimeout(r, 50))
      }

      expect(bridge.getHostGeneration()).toBeGreaterThan(initialGen)
      expect(bridge.getStatus()).toBe('ready')
      expect(bridge.isReady()).toBe(true)

      // Observer should have been re-established
      const status = await bridge.windowRegistry.getStatus()
      expect(status.observing).toBe(true)
      expect(status.threadAlive).toBe(true)

      // Reconnection emits recovered event
      expect(events.some(e => e.reason === 'recovered')).toBe(true)
    } finally {
      await sub.dispose()
    }
  })
})
