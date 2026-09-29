import { Context } from '@deepseek-ai/cordis'
import { HomeLayoutEngine, type HomeService } from '@deepseek-ai/dsh-home'
import type { PhysicalPixelRect } from '@deepseek-ai/dsh-windows-context'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ShellLayoutService } from '../src/index.ts'

interface MockExclusionZone {
  readonly id: string
  readonly monitorId: string
  readonly rect: PhysicalPixelRect
}

describe('Shell Layout - Home Exclusion Publishing', () => {
  let ctx: Context
  let layout: ShellLayoutService
  let homeEngine: HomeLayoutEngine
  let registerMock: (zone: MockExclusionZone) => () => void
  let unregisterMock: (id: string) => boolean

  beforeEach(async () => {
    ctx = new Context()
    homeEngine = new HomeLayoutEngine()

    unregisterMock = vi.fn((id: string) => homeEngine.unregisterExclusionZone(id))
    registerMock = vi.fn((zone: MockExclusionZone) => {
      const realDispose = homeEngine.registerExclusionZone(zone)
      return () => {
        realDispose()
        unregisterMock(zone.id)
      }
    })

    // Mount mock Home service on ctx
    ctx.provide('home')
    ctx.home = {
      layout: {
        registerExclusionZone: registerMock,
        unregisterExclusionZone: unregisterMock,
      },
    } as unknown as HomeService

    await ctx.plugin(ShellLayoutService, { enabled: true })
    layout = ctx.shellLayout
  })

  afterEach(async () => {
    await ctx.fiber.dispose()
  })

  it('publishes active reservation to Home exclusion zones', () => {
    const handle = layout.registerReservation({
      id: 'dock-bottom',
      monitorId: 'mon-1',
      ownerId: 'dock',
      kind: 'edge',
      edge: 'bottom',
      rect: { x: 0, y: 1000, width: 1920, height: 80 },
      affectsHomeLayout: true,
    })

    expect(registerMock).toHaveBeenCalledWith({
      id: 'dock-bottom',
      monitorId: 'mon-1',
      rect: { x: 0, y: 1000, width: 1920, height: 80 },
    })

    const zones = homeEngine.getExclusionZones('mon-1')
    expect(zones).toHaveLength(1)
    expect(zones[0]?.id).toBe('dock-bottom')

    handle.dispose()
    expect(unregisterMock).toHaveBeenCalledWith('dock-bottom')
    expect(homeEngine.getExclusionZones('mon-1')).toHaveLength(0)
  })

  it('does not publish reservation when affectsHomeLayout is false', () => {
    layout.registerReservation({
      id: 'invisible-bar',
      monitorId: 'mon-1',
      ownerId: 'test',
      kind: 'edge',
      edge: 'top',
      rect: { x: 0, y: 0, width: 1920, height: 30 },
      affectsHomeLayout: false,
    })

    expect(registerMock).not.toHaveBeenCalled()
    expect(homeEngine.getExclusionZones('mon-1')).toHaveLength(0)
  })

  it('unpublishes exclusion zone when reservation visibility is set to false', () => {
    const handle = layout.registerReservation({
      id: 'autohide-dock',
      monitorId: 'mon-1',
      ownerId: 'dock',
      kind: 'edge',
      edge: 'bottom',
      rect: { x: 0, y: 1000, width: 1920, height: 80 },
    })

    expect(homeEngine.getExclusionZones('mon-1')).toHaveLength(1)

    // Hide reservation
    handle.update({ visible: false })
    expect(homeEngine.getExclusionZones('mon-1')).toHaveLength(0)

    // Show reservation
    handle.update({ visible: true })
    expect(homeEngine.getExclusionZones('mon-1')).toHaveLength(1)
  })

  it('synchronizes all active reservations when Home is mounted late', async () => {
    const lateCtx = new Context()
    await lateCtx.plugin(ShellLayoutService, { enabled: true })
    const lateLayout = lateCtx.shellLayout

    // Register before Home is available
    lateLayout.registerReservation({
      id: 'early-bar',
      monitorId: 'mon-1',
      ownerId: 'bar',
      kind: 'edge',
      edge: 'top',
      rect: { x: 0, y: 0, width: 1920, height: 40 },
    })

    const lateHomeEngine = new HomeLayoutEngine()
    const lateRegisterMock = vi.fn((zone: MockExclusionZone) => lateHomeEngine.registerExclusionZone(zone))
    const lateUnregisterMock = vi.fn((id: string) => lateHomeEngine.unregisterExclusionZone(id))

    lateCtx.provide('home')
    lateCtx.home = {
      layout: {
        registerExclusionZone: lateRegisterMock,
        unregisterExclusionZone: lateUnregisterMock,
      },
    } as unknown as HomeService

    // Emit home/ready to trigger synchronization
    lateCtx.emit('home/ready', undefined)

    expect(lateHomeEngine.getExclusionZones('mon-1')).toHaveLength(1)
    expect(lateHomeEngine.getExclusionZones('mon-1')[0]?.id).toBe('early-bar')
  })

  it('removes stale exclusion when monitor changes and leaves only one active exclusion per reservation', () => {
    const handle = layout.registerReservation({
      id: 'migrating-dock',
      monitorId: 'mon-1',
      ownerId: 'dock',
      kind: 'edge',
      edge: 'bottom',
      rect: { x: 0, y: 1000, width: 1920, height: 80 },
    })

    expect(homeEngine.getExclusionZones('mon-1')).toHaveLength(1)
    expect(homeEngine.getExclusionZones('mon-2')).toHaveLength(0)

    // Update to different monitor
    handle.update({
      monitorId: 'mon-2',
      rect: { x: 1920, y: 1000, width: 1920, height: 80 },
    })

    // Old monitor exclusion must not survive
    expect(homeEngine.getExclusionZones('mon-1')).toHaveLength(0)
    // Exactly one active exclusion on the new monitor
    const zonesMon2 = homeEngine.getExclusionZones('mon-2')
    expect(zonesMon2).toHaveLength(1)
    expect(zonesMon2[0]?.id).toBe('migrating-dock')

    // Update geometry on same monitor
    handle.update({
      rect: { x: 1920, y: 1020, width: 1920, height: 60 },
    })
    const updatedZones = homeEngine.getExclusionZones('mon-2')
    expect(updatedZones).toHaveLength(1)
    expect(updatedZones[0]?.rect.height).toBe(60)

    handle.dispose()
    expect(homeEngine.getExclusionZones('mon-2')).toHaveLength(0)
  })
})
