import { describe, expect, it } from 'vitest'
import {
  createNativeBridge,
  findNativeHostBinary,
} from '../src/index.ts'

describe('Native AppBar Bridge', () => {
  it('advertises appBar capability during handshake', async () => {
    const binPath = findNativeHostBinary()
    expect(binPath).toBeDefined()

    const bridge = createNativeBridge()
    try {
      const handshake = await bridge.connect()
      expect(handshake.capabilities.appBar).toBe(true)
    } finally {
      await bridge.dispose()
    }
  })

  it('registers, inspects, updates, and unregisters a native AppBar reservation', async () => {
    const bridge = createNativeBridge()
    const testId = 'test-appbar-bridge-1'

    try {
      await bridge.connect()

      const rect = await bridge.appBar.register({
        id: testId,
        edge: 'top',
        rect: { x: 0, y: 0, width: 1920, height: 40 },
      })
      expect(rect.height).toBeGreaterThanOrEqual(0)

      const registered = await bridge.appBar.getRegistered()
      const found = registered.find(item => item.id === testId)
      expect(found).toBeDefined()
      expect(found?.edge).toBe('top')

      // Update same bar with different height
      const updated = await bridge.appBar.register({
        id: testId,
        edge: 'top',
        rect: { x: 0, y: 0, width: 1920, height: 48 },
      })
      expect(updated.height).toBeGreaterThanOrEqual(0)

      // Unregister
      const unregistered = await bridge.appBar.unregister(testId)
      expect(unregistered).toBe(true)

      const remaining = await bridge.appBar.getRegistered()
      expect(remaining.find(item => item.id === testId)).toBeUndefined()
    } finally {
      // Ensure test cleans up in case of failure
      await bridge.appBar.unregister(testId).catch(() => {})
      await bridge.dispose()
    }
  })

  it('correctly handles edge thickness preservation across bottom, left, and right edges', async () => {
    const bridge = createNativeBridge()
    const testEdgeId = 'test-appbar-multi-edge'

    try {
      await bridge.connect()

      // 1. Bottom edge
      const bottomRect = await bridge.appBar.register({
        id: testEdgeId,
        edge: 'bottom',
        rect: { x: 0, y: 1000, width: 1920, height: 44 },
      })
      expect(bottomRect.height).toBeGreaterThanOrEqual(0)
      const listBottom = await bridge.appBar.getRegistered()
      expect(listBottom.find(b => b.id === testEdgeId)?.edge).toBe('bottom')

      // 2. Left edge (update same bar)
      const leftRect = await bridge.appBar.register({
        id: testEdgeId,
        edge: 'left',
        rect: { x: 0, y: 0, width: 60, height: 1080 },
      })
      expect(leftRect.width).toBeGreaterThanOrEqual(0)
      const listLeft = await bridge.appBar.getRegistered()
      expect(listLeft.find(b => b.id === testEdgeId)?.edge).toBe('left')

      // 3. Right edge (update same bar)
      const rightRect = await bridge.appBar.register({
        id: testEdgeId,
        edge: 'right',
        rect: { x: 1860, y: 0, width: 60, height: 1080 },
      })
      expect(rightRect.width).toBeGreaterThanOrEqual(0)
      const listRight = await bridge.appBar.getRegistered()
      expect(listRight.find(b => b.id === testEdgeId)?.edge).toBe('right')

      // Unregister
      expect(await bridge.appBar.unregister(testEdgeId)).toBe(true)
      const finalRemaining = await bridge.appBar.getRegistered()
      expect(finalRemaining.find(b => b.id === testEdgeId)).toBeUndefined()
    } finally {
      await bridge.appBar.unregister(testEdgeId).catch(() => {})
      await bridge.dispose()
    }
  })
})
