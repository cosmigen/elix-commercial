import { Context } from '@deepseek-ai/cordis'
import { createNativeBridge, NativeBridgeClient } from '@deepseek-ai/dsh-native-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WindowRegistryService from '../src/index.ts'

describe('WindowRegistryService Live Acceptance', () => {
  if (process.platform !== 'win32') {
    it.skip('Skipping Windows live tests on non-Windows platform', () => {})
    return
  }

  let bridge: NativeBridgeClient
  let ctx: Context

  beforeAll(async () => {
    bridge = createNativeBridge()
    await bridge.connect()
    ctx = new Context()
    ctx.plugin(WindowRegistryService, { enabled: true, bridge })

    // Wait for ready event
    await new Promise(resolve => setTimeout(resolve, 100))
  })

  afterAll(async () => {
    await ctx.fiber.dispose()
    await bridge.dispose()
  })

  it('populates live registry with real windows and functional classifications', () => {
    const snapshot = ctx.windowRegistry.getSnapshot()
    expect(snapshot.windows.length).toBeGreaterThan(0)
    expect(snapshot.revision).toBeGreaterThanOrEqual(1)

    const windows = ctx.windowRegistry.getWindows()
    expect(windows.length).toBe(snapshot.windows.length)

    // At least one window should have valid classification
    const classifications = new Set(windows.map(w => w.classification))
    expect(classifications.size).toBeGreaterThan(0)

    // Verify WindowId != HWND invariant
    for (const w of windows) {
      expect(w.id).not.toBe(String(w.hwnd))
      expect(w.id.startsWith('win_')).toBe(true)
      expect(w.hwnd).toBeGreaterThan(0)
    }

    expect(windows.length).toBeGreaterThanOrEqual(1)
  })

  it('preserves WindowId across live refresh', async () => {
    const before = ctx.windowRegistry.getWindows()
    const idMapBefore = new Map(before.map(w => [w.hwnd, w.id]))

    const afterSnapshot = await ctx.windowRegistry.refresh()
    const after = afterSnapshot.windows

    // Windows that still exist should keep the EXACT same WindowId
    for (const w of after) {
      const priorId = idMapBefore.get(w.hwnd)
      if (priorId) {
        expect(w.id).toBe(priorId)
      }
    }
  })
})
