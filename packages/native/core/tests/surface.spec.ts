import { describe, expect, it } from 'vitest'
import {
  createNativeBridge,
  findNativeHostBinary,
  type NativeSurfaceEvent,
} from '../src/index.ts'

describe('Native Surface Bridge', () => {
  it('advertises surface capability during handshake', async () => {
    const binPath = findNativeHostBinary()
    expect(binPath).toBeDefined()

    const bridge = createNativeBridge()
    try {
      const handshake = await bridge.connect()
      expect(handshake.capabilities.surface).toBe(true)
    } finally {
      await bridge.dispose()
    }
  })

  it('queries host WebView2 runtime status', async () => {
    const bridge = createNativeBridge()
    try {
      await bridge.connect()
      const status = await bridge.surface.runtimeStatus()
      expect(status.available).toBe(true)
      expect(typeof status.version).toBe('string')
      expect(status.version?.length).toBeGreaterThan(0)
    } finally {
      await bridge.dispose()
    }
  })

  it('creates, inspects, updates bounds/z-order, and destroys a native surface', async () => {
    const bridge = createNativeBridge()
    const receivedEvents: NativeSurfaceEvent[] = []

    try {
      await bridge.connect()
      const sub = bridge.surface.onEvent((ev) => {
        receivedEvents.push(ev)
      })

      const surfaceId = 'test-surface-bridge-1'
      const initialBounds = { x: 200, y: 150, width: 600, height: 400 }

      const snapshot = await bridge.surface.create({
        id: surfaceId,
        bounds: initialBounds,
        focusPolicy: 'noActivate',
        zOrderPolicy: 'topmost',
        visible: false,
      })

      expect(snapshot.id).toBe(surfaceId)
      expect(snapshot.hwnd).toBeGreaterThan(0)
      expect(snapshot.visible).toBe(false)
      expect(snapshot.bounds).toEqual(initialBounds)
      expect(snapshot.zOrderPolicy).toBe('topmost')
      expect(snapshot.focusPolicy).toBe('noActivate')

      // Query surface
      const queried = await bridge.surface.query(surfaceId)
      expect(queried.id).toBe(surfaceId)
      expect(queried.hwnd).toBe(snapshot.hwnd)

      // List surfaces
      const list = await bridge.surface.list()
      expect(list.some(s => s.id === surfaceId)).toBe(true)

      // Update physical bounds
      const newBounds = { x: 250, y: 180, width: 700, height: 450 }
      const moved = await bridge.surface.setBounds(surfaceId, newBounds)
      expect(moved.bounds).toEqual(newBounds)

      // Update z-order
      const zOrdered = await bridge.surface.setZOrder(surfaceId, 'normal')
      expect(zOrdered.zOrderPolicy).toBe('normal')

      // Destroy
      const destroyed = await bridge.surface.destroy(surfaceId)
      expect(destroyed).toBe(true)

      // Destroyed surface should not be in list
      const afterList = await bridge.surface.list()
      expect(afterList.some(s => s.id === surfaceId)).toBe(false)

      // Verify lifecycle events were streamed cleanly
      expect(receivedEvents.some(e => e.type === 'created')).toBe(true)
      expect(receivedEvents.some(e => e.type === 'boundsChanged')).toBe(true)
      expect(receivedEvents.some(e => e.type === 'destroyed')).toBe(true)

      await sub.dispose()
    } finally {
      await bridge.dispose()
    }
  })

  it('declaratively restores surfaces across native host restarts', async () => {
    const bridge = createNativeBridge({
      supervisor: {
        autoRestart: true,
        initialBackoffMs: 50,
        maxBackoffMs: 200,
      },
    })

    try {
      await bridge.connect()
      const gen1 = bridge.getHostGeneration()

      const surfaceId = 'test-surface-restore'
      const bounds = { x: 100, y: 100, width: 500, height: 350 }

      const s1 = await bridge.surface.create({
        id: surfaceId,
        bounds,
        visible: false,
      })
      expect(s1.hwnd).toBeGreaterThan(0)
      expect(bridge.getActiveSurfacesCount()).toBe(1)

      // Force crash of native host
      await bridge.crashHost()

      // Wait for supervisor to detect exit and perform reconnect
      const start = Date.now()
      while (bridge.getStatus() !== 'ready' && Date.now() - start < 4000) {
        await new Promise(r => setTimeout(r, 50))
      }

      expect(bridge.getStatus()).toBe('ready')
      expect(bridge.getHostGeneration()).toBeGreaterThan(gen1)

      // Verify that surface was declaratively restored in the new native host
      const restored = await bridge.surface.query(surfaceId)
      expect(restored.id).toBe(surfaceId)
      expect(restored.hwnd).toBeGreaterThan(0)
      expect(restored.bounds).toEqual(bounds)

      await bridge.surface.destroy(surfaceId)
      expect(bridge.getActiveSurfacesCount()).toBe(0)
    } finally {
      await bridge.dispose()
    }
  })
})
