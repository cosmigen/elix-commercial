import { Context } from '@deepseek-ai/cordis'
import type { MonitorId, WindowsMonitor } from '@deepseek-ai/dsh-windows-context'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ShellLayoutService } from '../src/index.ts'

const monitor: WindowsMonitor = {
  id: 'authority-monitor' as MonitorId,
  deviceName: String.raw`\\.\DISPLAY_AUTHORITY`,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
  dpiX: 96,
  dpiY: 96,
  scaleFactor: 1,
  isPrimary: true,
}

describe('Shell Layout - Boundary Authority', () => {
  let ctx: Context
  let layout: ShellLayoutService

  beforeEach(async () => {
    ctx = new Context()
    await ctx.plugin(ShellLayoutService, {
      enabled: true,
      syncNativeWorkArea: false,
    })
    layout = ctx.shellLayout
    layout.registerSyntheticMonitor(monitor)
  })

  afterEach(async () => {
    await ctx.fiber.dispose()
  })

  it('captures owner generation on leases while preserving legacy generation zero', () => {
    const legacy = layout.registerReservation({
      id: 'legacy-edge',
      monitorId: 'authority-monitor',
      ownerId: 'legacy-owner',
      kind: 'edge',
      edge: 'top',
      rect: { x: 0, y: 0, width: 1920, height: 30 },
    })

    expect(legacy.ownerGeneration).toBe(0)
    expect(legacy.get()?.ownerGeneration).toBe(0)
    expect(layout.getOwnerGeneration('legacy-owner')).toBe(0)
  })

  it('advancing an owner generation releases old leases and rejects stale handles', () => {
    const oldHandle = layout.registerReservation({
      id: 'dock-old',
      monitorId: 'authority-monitor',
      ownerId: 'dock',
      ownerGeneration: 4,
      kind: 'edge',
      edge: 'bottom',
      rect: { x: 0, y: 1000, width: 1920, height: 40 },
    })

    const newHandle = layout.registerReservation({
      id: 'dock-new',
      monitorId: 'authority-monitor',
      ownerId: 'dock',
      ownerGeneration: 5,
      kind: 'edge',
      edge: 'bottom',
      rect: { x: 0, y: 988, width: 1920, height: 52 },
    })

    expect(layout.getReservation('dock-old')).toBeUndefined()
    expect(layout.getReservation('dock-new')).toBeDefined()
    expect(layout.getOwnerGeneration('dock')).toBe(5)
    expect(oldHandle.get()).toBeUndefined()
    expect(oldHandle.dispose()).toBe(false)
    expect(() => oldHandle.update({ visible: false })).toThrow(/stale/i)
    expect(newHandle.get()?.ownerGeneration).toBe(5)
  })

  it('rejects stale owner generations after a newer generation became authoritative', () => {
    layout.registerReservation({
      id: 'status-current',
      monitorId: 'authority-monitor',
      ownerId: 'status',
      ownerGeneration: 7,
      kind: 'edge',
      edge: 'top',
      rect: { x: 0, y: 0, width: 1920, height: 32 },
    })

    expect(() => layout.registerReservation({
      id: 'status-stale',
      monitorId: 'authority-monitor',
      ownerId: 'status',
      ownerGeneration: 6,
      kind: 'edge',
      edge: 'top',
      rect: { x: 0, y: 0, width: 1920, height: 24 },
    })).toThrow(/stale shell boundary lease/i)
  })

  it('releases exactly one owner generation and leaves unrelated owners untouched', () => {
    layout.registerReservation({
      id: 'owner-a-1',
      monitorId: 'authority-monitor',
      ownerId: 'owner-a',
      ownerGeneration: 3,
      kind: 'edge',
      edge: 'left',
      rect: { x: 0, y: 0, width: 30, height: 1080 },
    })
    layout.registerReservation({
      id: 'owner-a-2',
      monitorId: 'authority-monitor',
      ownerId: 'owner-a',
      ownerGeneration: 3,
      kind: 'floating',
      rect: { x: 200, y: 200, width: 200, height: 200 },
    })
    layout.registerReservation({
      id: 'owner-b',
      monitorId: 'authority-monitor',
      ownerId: 'owner-b',
      ownerGeneration: 1,
      kind: 'edge',
      edge: 'right',
      rect: { x: 1890, y: 0, width: 30, height: 1080 },
    })

    expect(layout.releaseOwner('owner-a', 3)).toBe(2)
    expect(layout.getReservation('owner-a-1')).toBeUndefined()
    expect(layout.getReservation('owner-a-2')).toBeUndefined()
    expect(layout.getReservation('owner-b')).toBeDefined()
  })

  it('allows stackable edge claims but rejects exclusive edge ownership conflicts', () => {
    layout.registerReservation({
      id: 'stack-a',
      monitorId: 'authority-monitor',
      ownerId: 'stack-a',
      kind: 'edge',
      edge: 'top',
      rect: { x: 0, y: 0, width: 1920, height: 20 },
      conflictPolicy: 'stack',
    })

    layout.registerReservation({
      id: 'stack-b',
      monitorId: 'authority-monitor',
      ownerId: 'stack-b',
      kind: 'edge',
      edge: 'top',
      rect: { x: 0, y: 20, width: 1920, height: 20 },
      conflictPolicy: 'stack',
    })

    expect(layout.getReservations()).toHaveLength(2)

    expect(() => layout.registerReservation({
      id: 'exclusive-top',
      monitorId: 'authority-monitor',
      ownerId: 'exclusive',
      kind: 'edge',
      edge: 'top',
      rect: { x: 0, y: 0, width: 1920, height: 40 },
      conflictPolicy: 'exclusive',
    })).toThrow(/shell edge conflict/i)
  })

  it('overlay mode preserves claims but stops shrinking the authoritative work area', () => {
    layout.registerReservation({
      id: 'overlay-test',
      monitorId: 'authority-monitor',
      ownerId: 'dock',
      kind: 'edge',
      edge: 'bottom',
      rect: { x: 0, y: 980, width: 1920, height: 60 },
    })

    expect(layout.getWorkArea('authority-monitor')).toEqual({
      x: 0,
      y: 0,
      width: 1920,
      height: 980,
    })

    layout.setShellMode('overlay')

    expect(layout.getShellMode()).toBe('overlay')
    expect(layout.getReservation('overlay-test')).toBeDefined()
    expect(layout.getWorkArea('authority-monitor')).toEqual(monitor.workArea)
  })

  it('replacement mode fails closed without platform enablement and recovery supervision', () => {
    layout.setRecoveryGuardianReady(true)
    expect(() => {
      layout.setShellMode('replacement')
    }).toThrow(/not enabled/i)
    expect(layout.getShellMode()).toBe('coexistence')
  })

  it('publishes a minimal recovery snapshot and reconciles boundaries idempotently', async () => {
    layout.registerReservation({
      id: 'recovery-dock',
      monitorId: 'authority-monitor',
      ownerId: 'dock',
      ownerGeneration: 2,
      kind: 'edge',
      edge: 'bottom',
      rect: { x: 0, y: 992, width: 1920, height: 48 },
      conflictPolicy: 'exclusive',
    })

    const snapshot = layout.getRecoverySnapshot()
    expect(snapshot.shellMode).toBe('coexistence')
    expect(snapshot.reservations).toEqual([
      expect.objectContaining({
        id: 'recovery-dock',
        ownerId: 'dock',
        ownerGeneration: 2,
        monitorId: 'authority-monitor',
        edge: 'bottom',
      }),
    ])

    await expect(layout.reconcileBoundaries()).resolves.toBeUndefined()
    expect(layout.getReservation('recovery-dock')).toBeDefined()
  })
})
