import { SurfaceInstance, type SurfaceCreateOptions, type SurfaceService } from '@deepseek-ai/dsh-surface'
import { describe, expect, it, vi } from 'vitest'
import { HomeSurfaceManager, MonitorManager } from '../src/index.ts'
import type { MonitorInfo } from '../src/index.ts'
import { createMockSurfaceRuntime } from './test-runtime.ts'

const primary: MonitorInfo = {
  id: 'display-primary',
  name: 'Primary',
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
  scaleFactor: 1,
  isPrimary: true,
}

const leftMixedDpi: MonitorInfo = {
  id: 'display-left',
  name: 'Left 150%',
  bounds: { x: -2560, y: -360, width: 2560, height: 1440 },
  workArea: { x: -2560, y: -360, width: 2560, height: 1400 },
  scaleFactor: 1.5,
  isPrimary: false,
}

function createManager(monitors: MonitorManager) {
  const runtime = createMockSurfaceRuntime()
  const create = async (options: SurfaceCreateOptions): Promise<SurfaceInstance> => {
    const snapshot = await runtime.bridge.surface.create(options)
    return new SurfaceInstance(snapshot, runtime.bridge, options)
  }
  const service = { create } as SurfaceService
  const manager = new HomeSurfaceManager(monitors, {
    getSurfaceService: () => service,
    rendererUrl: monitorId => 'http://127.0.0.1:8123/home/' + monitorId,
    autoShowOnReady: false,
  })
  return { manager, runtime }
}

describe('HomeSurfaceManager multi-monitor reconciliation', () => {
  it('creates one independent Surface Core instance per monitor', async () => {
    const monitors = new MonitorManager([primary, leftMixedDpi])
    const { manager, runtime } = createManager(monitors)
    await manager.reconcile()

    expect(manager.getSurfaces()).toHaveLength(2)
    expect(manager.getSurfaceForMonitor(primary.id)?.surfaceId).not.toBe(
      manager.getSurfaceForMonitor(leftMixedDpi.id)?.surfaceId,
    )
    expect(manager.getSurfaceForMonitor(primary.id)?.getBounds()).toEqual(primary.bounds)
    expect(manager.getSurfaceForMonitor(leftMixedDpi.id)?.getBounds()).toEqual(leftMixedDpi.bounds)
    expect(runtime.createOptions.map(options => options.monitorId)).toEqual([
      primary.id,
      leftMixedDpi.id,
    ])
    expect(runtime.createOptions.every(options => options.focusPolicy === 'noActivate')).toBe(true)
    expect(runtime.createOptions.every(options => options.zOrderPolicy === 'bottom')).toBe(true)
  })

  it('serializes rapid topology reconciliation without duplicate monitor surfaces', async () => {
    const monitors = new MonitorManager([primary])
    const { manager, runtime } = createManager(monitors)
    const first = manager.reconcile()
    monitors.addOrUpdateMonitor(leftMixedDpi)
    const second = manager.reconcile()
    const third = manager.reconcile()
    await Promise.all([first, second, third])

    expect(manager.getSurfaces()).toHaveLength(2)
    expect(runtime.createOptions.filter(options => options.monitorId === primary.id)).toHaveLength(1)
    expect(runtime.createOptions.filter(options => options.monitorId === leftMixedDpi.id)).toHaveLength(1)
  })

  it('retains successful monitor ownership and retries only a failed surface creation', async () => {
    const monitors = new MonitorManager([primary, leftMixedDpi])
    const runtime = createMockSurfaceRuntime()
    let rejectLeft = true
    const create = vi.fn(async (options: SurfaceCreateOptions): Promise<SurfaceInstance> => {
      if (options.monitorId === leftMixedDpi.id && rejectLeft) {
        rejectLeft = false
        throw new Error('injected surface creation failure')
      }
      const snapshot = await runtime.bridge.surface.create(options)
      return new SurfaceInstance(snapshot, runtime.bridge, options)
    })
    const manager = new HomeSurfaceManager(monitors, {
      getSurfaceService: () => ({ create } as unknown as SurfaceService),
      rendererUrl: monitorId => 'http://127.0.0.1:8123/home/' + monitorId,
      autoShowOnReady: false,
    })

    await expect(manager.reconcile()).rejects.toThrow('injected surface creation failure')
    expect(manager.getSurfaces().map(surface => surface.monitorId)).toEqual([primary.id])

    await manager.reconcile()
    expect(manager.getSurfaces().map(surface => surface.monitorId)).toEqual([primary.id, leftMixedDpi.id])
    expect(create.mock.calls.filter(([options]) => options.monitorId === primary.id)).toHaveLength(1)
    expect(create.mock.calls.filter(([options]) => options.monitorId === leftMixedDpi.id)).toHaveLength(2)
  })

  it('updates physical bounds and destroys only a removed monitor surface', async () => {
    const monitors = new MonitorManager([primary, leftMixedDpi])
    const { manager, runtime } = createManager(monitors)
    await manager.reconcile()
    const removed = manager.getSurfaceForMonitor(leftMixedDpi.id)!

    monitors.addOrUpdateMonitor({
      ...primary,
      bounds: { x: 0, y: 0, width: 2560, height: 1440 },
      scaleFactor: 1.5,
    })
    monitors.removeMonitor(leftMixedDpi.id)
    await manager.reconcile()

    expect(manager.getSurfaces()).toHaveLength(1)
    expect(manager.getSurfaceForMonitor(primary.id)?.getBounds()).toEqual({
      x: 0,
      y: 0,
      width: 2560,
      height: 1440,
    })
    expect(removed.state).toBe('DISPOSED')
    expect(runtime.destroy).toHaveBeenCalledWith(removed.surfaceId)
  })

  it('awaits every native teardown and clears listeners during shutdown', async () => {
    const monitors = new MonitorManager([primary, leftMixedDpi])
    const { manager, runtime } = createManager(monitors)
    await manager.reconcile()
    const observed: number[] = []
    manager.onChange(surfaces => observed.push(surfaces.length))

    await manager.shutdownAll()
    expect(manager.getSurfaces()).toHaveLength(0)
    expect(runtime.destroy).toHaveBeenCalledTimes(2)
    expect(observed.at(-1)).toBe(0)
  })
})
