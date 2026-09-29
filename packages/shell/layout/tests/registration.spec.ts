import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ShellLayoutService } from '../src/index.ts'
import type { ShellReservation, ShellReservationSpec } from '../src/types.ts'

describe('ShellLayoutService - Registration and Mutation', () => {
  let ctx: Context
  let layout: ShellLayoutService

  beforeEach(async () => {
    ctx = new Context()
    await ctx.plugin(ShellLayoutService, { enabled: true, syncNativeWorkArea: false })
    layout = ctx.shellLayout
  })

  afterEach(async () => {
    await ctx.fiber.dispose()
  })

  it('registers an edge reservation and returns a stable handle', () => {
    const spec: ShellReservationSpec = {
      id: 'dock-bottom',
      monitorId: 'monitor-1',
      ownerId: 'dock',
      kind: 'edge',
      edge: 'bottom',
      rect: { x: 0, y: 1000, width: 1920, height: 80 },
    }

    const handle = layout.registerReservation(spec)
    expect(handle.id).toBe('dock-bottom')

    const stored = layout.getReservation('dock-bottom')
    expect(stored).toBeDefined()
    expect(stored?.id).toBe('dock-bottom')
    expect(stored?.monitorId).toBe('monitor-1')
    expect(stored?.kind).toBe('edge')
    expect(stored?.edge).toBe('bottom')
    expect(stored?.rect).toEqual({ x: 0, y: 1000, width: 1920, height: 80 })
    expect(stored?.affectsWorkArea).toBe(true) // edge defaults to true
    expect(stored?.affectsHomeLayout).toBe(true) // defaults to true
    expect(stored?.visible).toBe(true)
    expect(stored?.priority).toBe(0)
  })

  it('registers a floating reservation with expected defaults', () => {
    const spec: ShellReservationSpec = {
      id: 'control-center',
      monitorId: 'monitor-1',
      ownerId: 'quick-settings',
      kind: 'floating',
      rect: { x: 1500, y: 50, width: 380, height: 450 },
    }

    const handle = layout.registerReservation(spec)
    const stored = handle.get()

    expect(stored).toBeDefined()
    expect(stored?.kind).toBe('floating')
    expect(stored?.edge).toBeUndefined()
    expect(stored?.affectsWorkArea).toBe(false) // floating defaults to false
    expect(stored?.affectsHomeLayout).toBe(true) // defaults to true
  })

  it('emits lifecycle events on reservation registration', () => {
    const registeredList: ShellReservation[] = []
    const onChange = vi.fn()

    ctx.on('shell-layout/reservation-registered', res => registeredList.push(res))
    layout.subscribe(onChange)

    layout.registerReservation({
      id: 'top-bar',
      monitorId: 'monitor-primary',
      ownerId: 'status-bar',
      kind: 'edge',
      edge: 'top',
      rect: { x: 0, y: 0, width: 1920, height: 32 },
    })

    expect(registeredList).toHaveLength(1)
    expect(registeredList[0]?.id).toBe('top-bar')

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'registered',
        reservationId: 'top-bar',
        monitorId: 'monitor-primary',
        affectedMonitorIds: ['monitor-primary'],
      }),
    )
  })

  it('updates reservation via handle and service methods', () => {
    const onUpdated = vi.fn()
    ctx.on('shell-layout/reservation-updated', onUpdated)

    const handle = layout.registerReservation({
      id: 'dock-1',
      monitorId: 'monitor-1',
      ownerId: 'dock',
      kind: 'edge',
      edge: 'bottom',
      rect: { x: 0, y: 1000, width: 1920, height: 80 },
    })

    // Update via handle
    const updated1 = handle.update({
      rect: { x: 0, y: 1010, width: 1920, height: 70 },
      priority: 10,
    })

    expect(updated1.rect.height).toBe(70)
    expect(updated1.priority).toBe(10)
    expect(onUpdated).toHaveBeenCalledTimes(1)

    // Update via service
    const updated2 = layout.updateReservation('dock-1', {
      visible: false,
    })

    expect(updated2.visible).toBe(false)
    expect(onUpdated).toHaveBeenCalledTimes(2)
  })

  it('provides stale-disposer protection when reservation is replaced', () => {
    const handle1 = layout.registerReservation({
      id: 'exclusive-bar',
      monitorId: 'monitor-1',
      ownerId: 'bar-v1',
      kind: 'edge',
      edge: 'top',
      rect: { x: 0, y: 0, width: 1920, height: 30 },
    })

    // Replace with same ID but different spec
    const handle2 = layout.registerReservation({
      id: 'exclusive-bar',
      monitorId: 'monitor-1',
      ownerId: 'bar-v2',
      kind: 'edge',
      edge: 'top',
      rect: { x: 0, y: 0, width: 1920, height: 40 },
    })

    // Stale handle1 dispose must return false and NOT remove the active reservation
    const disposed1 = handle1.dispose()
    expect(disposed1).toBe(false)
    expect(layout.getReservation('exclusive-bar')).toBeDefined()
    expect(layout.getReservation('exclusive-bar')?.ownerId).toBe('bar-v2')

    // Valid handle2 dispose returns true and removes the reservation
    const disposed2 = handle2.dispose()
    expect(disposed2).toBe(true)
    expect(layout.getReservation('exclusive-bar')).toBeUndefined()
  })

  it('unregisters reservations and emits removed events', () => {
    const onRemoved = vi.fn()
    ctx.on('shell-layout/reservation-removed', onRemoved)

    const handle = layout.registerReservation({
      id: 'temp-bar',
      monitorId: 'monitor-1',
      ownerId: 'temp',
      kind: 'edge',
      edge: 'left',
      rect: { x: 0, y: 0, width: 50, height: 1080 },
    })

    expect(layout.getReservations()).toHaveLength(1)

    const removed = handle.dispose()
    expect(removed).toBe(true)
    expect(layout.getReservations()).toHaveLength(0)
    expect(onRemoved).toHaveBeenCalledWith('temp-bar')

    // Subsequent removal returns false
    expect(layout.removeReservation('temp-bar')).toBe(false)
  })

  it('validates reservation spec and throws on invalid inputs', () => {
    // Empty ID
    expect(() =>
      layout.registerReservation({
        id: '',
        monitorId: 'mon-1',
        ownerId: 'test',
        kind: 'edge',
        edge: 'top',
        rect: { x: 0, y: 0, width: 100, height: 100 },
      }),
    ).toThrow(TypeError)

    // Edge kind without edge
    expect(() =>
      layout.registerReservation({
        id: 'bad-edge',
        monitorId: 'mon-1',
        ownerId: 'test',
        kind: 'edge',
        rect: { x: 0, y: 0, width: 100, height: 100 },
      }),
    ).toThrow(TypeError)

    // Negative dimensions
    expect(() =>
      layout.registerReservation({
        id: 'bad-dim',
        monitorId: 'mon-1',
        ownerId: 'test',
        kind: 'floating',
        rect: { x: 0, y: 0, width: -10, height: 100 },
      }),
    ).toThrow(RangeError)

    // Floating kind with monitorId 'all' must throw
    expect(() =>
      layout.registerReservation({
        id: 'bad-floating-all',
        monitorId: 'all',
        ownerId: 'test',
        kind: 'floating',
        rect: { x: 100, y: 100, width: 200, height: 200 },
      }),
    ).toThrow(TypeError)
  })

  it('reconciles native approved rect without invalidating handles or mutating desired rect', async () => {
    const handle = layout.registerReservation({
      id: 'adjusted-bar',
      monitorId: 'mon-1',
      ownerId: 'test',
      kind: 'edge',
      edge: 'top',
      rect: { x: 0, y: 0, width: 1920, height: 40 },
    })

    const initial = handle.get()
    expect(initial?.rect).toEqual({ x: 0, y: 0, width: 1920, height: 40 })
    expect(initial?.effectiveRect).toBeUndefined()

    // Simulate native reconciliation callback
    const reconciledEvents: unknown[] = []
    layout.subscribe((ev) => {
      if (ev.type === 'reconciled') reconciledEvents.push(ev)
    })

    layout.reconcileNativeApprovedRect('adjusted-bar', {
      x: 0,
      y: 30, // Windows adjusted top offset because of existing bar
      width: 1920,
      height: 40,
    })

    const updated = handle.get()
    expect(updated).toBeDefined()
    // Desired rect is preserved
    expect(updated?.rect).toEqual({ x: 0, y: 0, width: 1920, height: 40 })
    // Effective rect contains Windows approved geometry
    expect(updated?.effectiveRect).toEqual({ x: 0, y: 30, width: 1920, height: 40 })

    expect(reconciledEvents).toHaveLength(1)

    // Handle is still valid and can mutate
    const patched = handle.update({ priority: 10 })
    expect(patched.priority).toBe(10)
    expect(patched.effectiveRect).toEqual({ x: 0, y: 30, width: 1920, height: 40 })

    expect(handle.dispose()).toBe(true)
  })
})
