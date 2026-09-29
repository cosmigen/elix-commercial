import { SurfaceInstance } from '@deepseek-ai/dsh-surface'
import { describe, expect, it } from 'vitest'
import { HomeSurfaceInstance } from '../src/index.ts'
import { createMockSurfaceRuntime } from './test-runtime.ts'

describe('HomeSurfaceInstance', () => {
  it('delegates visibility, reload, bounds, and teardown to Surface Core', async () => {
    const runtime = createMockSurfaceRuntime()
    const snapshot = await runtime.bridge.surface.create({
      id: 'surface-home-monitor-a',
      monitorId: 'monitor-a',
      bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
      focusPolicy: 'noActivate',
      zOrderPolicy: 'bottom',
    })
    const native = new SurfaceInstance(snapshot, runtime.bridge)
    const states: string[] = []
    const surface = new HomeSurfaceInstance('monitor-a', native, (_monitorId, state) => states.push(state))

    expect(surface.surfaceId).toBe('surface-home-monitor-a')
    expect(surface.windowHandle).toBeGreaterThan(0)
    expect(surface.isReady).toBe(true)
    await expect(surface.whenReady()).resolves.toBe(native)

    await surface.show()
    expect(runtime.show).toHaveBeenCalledWith(surface.surfaceId)
    expect(surface.isVisible).toBe(true)

    await surface.hide()
    expect(runtime.hide).toHaveBeenCalledWith(surface.surfaceId)
    expect(surface.isVisible).toBe(false)

    await surface.updateGeometry({ x: -1600, y: -900, width: 1600, height: 900 })
    expect(surface.getBounds()).toEqual({ x: -1600, y: -900, width: 1600, height: 900 })

    await surface.restart()
    expect(runtime.reload).toHaveBeenCalledWith(surface.surfaceId)

    await surface.destroy()
    expect(runtime.destroy).toHaveBeenCalledWith(surface.surfaceId)
    expect(surface.state).toBe('DISPOSED')
    expect(states).toEqual(['active', 'suspended', 'suspended', 'disposed'])
  })

  it('uses Surface Core current-generation readiness after native recreation', async () => {
    const runtime = createMockSurfaceRuntime()
    const snapshot = await runtime.bridge.surface.create({
      id: 'surface-home-monitor-a',
      bounds: { x: 0, y: 0, width: 800, height: 600 },
    })
    const native = new SurfaceInstance(snapshot, runtime.bridge)
    const surface = new HomeSurfaceInstance('monitor-a', native)

    native._handleRecreation({ ...snapshot, hwnd: snapshot.hwnd + 1, state: 'NATIVE_CREATED' })
    expect(surface.isReady).toBe(false)
    let resolved = false
    const ready = surface.whenReady().then(() => {
      resolved = true
    })
    await Promise.resolve()
    expect(resolved).toBe(false)

    native._handleNativeReady(snapshot.hwnd + 1)
    native._handleRendererReady()
    await ready
    expect(surface.isReady).toBe(true)
    expect(surface.windowHandle).toBe(snapshot.hwnd + 1)
  })
})
