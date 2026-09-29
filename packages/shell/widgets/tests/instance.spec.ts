import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { WidgetService } from '../src/service.ts'
import type { WidgetDefinition } from '../src/types.ts'

describe('Widget Instance Model & Lifecycle', () => {
  it('creates widget instance and strictly inherits ownerId from definition', () => {
    const ctx = new Context()
    const service = new WidgetService(ctx)
    service[WidgetService.init]()

    const def: WidgetDefinition = {
      id: 'custom-card',
      ownerId: 'trusted-plugin',
      title: 'Custom Card',
      version: '1.0.0',
      defaultSize: { width: 300, height: 200 },
      minSize: { width: 200, height: 150 },
      maxSize: { width: 600, height: 500 },
      defaultConfig: { theme: 'dark' },
      defaultState: { count: 0 },
      renderer: { type: 'html', html: '<div>Card</div>' },
    }
    service.register(def)

    const instance = service.create({
      definitionId: 'custom-card',
      monitorId: 'monitor-1',
      position: { x: 100, y: 150 },
    })

    expect(instance.id).toBeTruthy()
    expect(instance.definitionId).toBe('custom-card')
    // Authoritative check: ownerId MUST be inherited from definition, cannot be forged
    expect(instance.ownerId).toBe('trusted-plugin')
    expect(instance.monitorId).toBe('monitor-1')
    expect(instance.position).toEqual({ x: 100, y: 150 })
    expect(instance.size).toEqual({ width: 300, height: 200 })
    expect(instance.configuration).toEqual({ theme: 'dark' })
    expect(instance.state).toEqual({ count: 0 })
    expect(instance.lifecycle).toBe('mounted')

    expect(service.get(instance.id)).toBeDefined()
    expect(service.list().some(i => i.id === instance.id)).toBe(true)
  })

  it('rejects creating an instance for an unregistered widget definition', () => {
    const ctx = new Context()
    const service = new WidgetService(ctx)
    service[WidgetService.init]()

    expect(() => {
      service.create({
        definitionId: 'unknown-definition',
        monitorId: 'monitor-1',
        position: { x: 0, y: 0 },
      })
    }).toThrow(/Cannot create instance of unregistered widget definition "unknown-definition"/)
  })

  it('clamps requested instance size to definition minSize and maxSize', () => {
    const ctx = new Context()
    const service = new WidgetService(ctx)
    service[WidgetService.init]()

    service.register({
      id: 'constrained-widget',
      ownerId: 'owner',
      title: 'Constrained',
      version: '1.0.0',
      defaultSize: { width: 300, height: 200 },
      minSize: { width: 200, height: 150 },
      maxSize: { width: 500, height: 400 },
      renderer: { type: 'html', html: '<div></div>' },
    })

    // Too small -> clamped to minSize
    const smallInst = service.create({
      definitionId: 'constrained-widget',
      monitorId: 'monitor-1',
      position: { x: 0, y: 0 },
      size: { width: 50, height: 50 },
    })
    expect(smallInst.size).toEqual({ width: 200, height: 150 })

    // Too large -> clamped to maxSize
    const largeInst = service.create({
      definitionId: 'constrained-widget',
      monitorId: 'monitor-1',
      position: { x: 0, y: 0 },
      size: { width: 1000, height: 800 },
    })
    expect(largeInst.size).toEqual({ width: 500, height: 400 })

    // In bounds -> preserved
    const normalInst = service.create({
      definitionId: 'constrained-widget',
      monitorId: 'monitor-1',
      position: { x: 0, y: 0 },
      size: { width: 350, height: 250 },
    })
    expect(normalInst.size).toEqual({ width: 350, height: 250 })
  })

  it('updates geometry, position, size, and clamps size on resize', () => {
    const ctx = new Context()
    const service = new WidgetService(ctx)
    service[WidgetService.init]()

    service.register({
      id: 'resizable-box',
      ownerId: 'owner',
      title: 'Resizable',
      version: '1.0.0',
      defaultSize: { width: 300, height: 200 },
      minSize: { width: 150, height: 100 },
      maxSize: { width: 600, height: 500 },
      renderer: { type: 'html', html: '<div></div>' },
    })

    const inst = service.create({
      definitionId: 'resizable-box',
      monitorId: 'monitor-1',
      position: { x: 50, y: 50 },
    })

    // Drag move
    const moved = service.update(inst.id, {
      position: { x: 220, y: 340 },
    })
    expect(moved?.position).toEqual({ x: 220, y: 340 })

    // Move to secondary monitor
    const monitorMoved = service.update(inst.id, {
      monitorId: 'monitor-2',
      position: { x: 1920 + 100, y: 50 },
    })
    expect(monitorMoved?.monitorId).toBe('monitor-2')
    expect(monitorMoved?.position).toEqual({ x: 2020, y: 50 })

    // Resize within bounds
    const resized = service.update(inst.id, {
      size: { width: 400, height: 300 },
    })
    expect(resized?.size).toEqual({ width: 400, height: 300 })

    // Resize beyond maxSize -> clamped
    const clampedResize = service.update(inst.id, {
      size: { width: 9999, height: 9999 },
    })
    expect(clampedResize?.size).toEqual({ width: 600, height: 500 })
  })

  it('updates instance state and notifies via events', () => {
    const ctx = new Context()
    const service = new WidgetService(ctx)
    service[WidgetService.init]()

    const inst = service.create({
      definitionId: 'clock',
      monitorId: 'mon-1',
      position: { x: 0, y: 0 },
    })

    let stateEventCaptured: Record<string, unknown> | undefined
    ctx.on('widgets/instance-state-changed', (ev) => {
      if (ev.instance.id === inst.id) {
        stateEventCaptured = ev.state
      }
    })

    const updated = service.updateState(inst.id, { customTheme: 'glass', volume: 80 })
    expect(updated?.state.customTheme).toBe('glass')
    expect(updated?.state.volume).toBe(80)
    expect(stateEventCaptured?.customTheme).toBe('glass')
  })

  it('brings widget to front and updates z-order stacking', () => {
    const ctx = new Context()
    const service = new WidgetService(ctx)
    service[WidgetService.init]()

    const inst1 = service.create({ definitionId: 'clock', monitorId: 'mon-1', position: { x: 0, y: 0 } })
    const inst2 = service.create({ definitionId: 'calendar', monitorId: 'mon-1', position: { x: 100, y: 100 } })
    const inst3 = service.create({ definitionId: 'notes', monitorId: 'mon-1', position: { x: 200, y: 200 } })

    expect(inst1.zOrder).toBeLessThan(inst2.zOrder)
    expect(inst2.zOrder).toBeLessThan(inst3.zOrder)

    // Bring inst1 to front
    service.bringToFront(inst1.id)
    const refreshed1 = service.get(inst1.id)
    const refreshed2 = service.get(inst2.id)
    const refreshed3 = service.get(inst3.id)

    expect(refreshed1!.zOrder).toBeGreaterThan(refreshed2!.zOrder)
    expect(refreshed1!.zOrder).toBeGreaterThan(refreshed3!.zOrder)
  })

  it('cascades instance cleanup when definition or owner is unregistered', () => {
    const ctx = new Context()
    const service = new WidgetService(ctx)
    service[WidgetService.init]()

    service.register({
      id: 'plugin-widget-1',
      ownerId: 'plugin-x',
      title: 'Plugin Widget 1',
      version: '1.0.0',
      defaultSize: { width: 200, height: 200 },
      minSize: { width: 200, height: 200 },
      renderer: { type: 'html', html: '<div>1</div>' },
    })

    service.register({
      id: 'plugin-widget-2',
      ownerId: 'plugin-x',
      title: 'Plugin Widget 2',
      version: '1.0.0',
      defaultSize: { width: 200, height: 200 },
      minSize: { width: 200, height: 200 },
      renderer: { type: 'html', html: '<div>2</div>' },
    })

    const inst1 = service.create({ definitionId: 'plugin-widget-1', monitorId: 'mon-1', position: { x: 0, y: 0 } })
    const inst2 = service.create({ definitionId: 'plugin-widget-2', monitorId: 'mon-1', position: { x: 10, y: 10 } })

    expect(service.get(inst1.id)).toBeDefined()
    expect(service.get(inst2.id)).toBeDefined()

    // Plugin unloads -> removeByOwner cleans up both definitions and instances
    service.removeByOwner('plugin-x')
    expect(service.get(inst1.id)).toBeUndefined()
    expect(service.get(inst2.id)).toBeUndefined()
    expect(service.hasDefinition('plugin-widget-1')).toBe(false)
    expect(service.hasDefinition('plugin-widget-2')).toBe(false)
  })

  it('restores instances from persistent state', () => {
    const ctx = new Context()
    const service = new WidgetService(ctx)
    service[WidgetService.init]()

    const saved = [
      {
        id: 'persisted-1',
        definitionId: 'clock',
        ownerId: 'elix.builtin',
        monitorId: 'primary-monitor',
        position: { x: 150, y: 120 },
        size: { width: 260, height: 120 },
        zOrder: 1,
        configuration: {},
        state: { custom: true },
        lifecycle: 'mounted' as const,
        createdAt: 1000,
        updatedAt: 1200,
      },
    ]

    service.restoreInstances(saved)
    const loaded = service.get('persisted-1')
    expect(loaded).toBeDefined()
    expect(loaded?.position).toEqual({ x: 150, y: 120 })
    expect(loaded?.state.custom).toBe(true)
  })

  it('corrects persisted wrong owner to authoritative definition owner', () => {
    const ctx = new Context()
    const service = new WidgetService(ctx)
    service[WidgetService.init]()

    // Persisted record claims malicious custom owner for built-in clock
    const saved = [
      {
        id: 'clock-tampered',
        definitionId: 'clock',
        ownerId: 'malicious.actor',
        monitorId: 'primary-monitor',
        position: { x: 100, y: 100 },
        size: { width: 260, height: 130 },
        zOrder: 1,
        configuration: {},
        state: {},
        lifecycle: 'mounted' as const,
        createdAt: 1000,
        updatedAt: 1200,
      },
    ]

    service.restoreInstances(saved)
    const restored = service.get('clock-tampered')
    expect(restored).toBeDefined()
    expect(restored?.ownerId).toBe('elix.builtin')
    expect(restored?.ownerId).not.toBe('malicious.actor')
  })

  it('updates restored authority correctly when definition owner changes', () => {
    const ctx = new Context()
    const service = new WidgetService(ctx)
    service[WidgetService.init]()

    // Register dynamic definition with owner A
    service.register({
      id: 'dynamic-widget',
      ownerId: 'plugin.version1',
      title: 'Dynamic Widget',
      version: '1.0.0',
      defaultSize: { width: 200, height: 100 },
      minSize: { width: 100, height: 50 },
      renderer: { type: 'html', html: '<div>v1</div>' },
    })

    const saved = [
      {
        id: 'dynamic-instance',
        definitionId: 'dynamic-widget',
        ownerId: 'plugin.version1',
        monitorId: 'primary-monitor',
        position: { x: 50, y: 50 },
        size: { width: 200, height: 100 },
        zOrder: 1,
        configuration: {},
        state: {},
        lifecycle: 'mounted' as const,
        createdAt: 1000,
        updatedAt: 1200,
      },
    ]

    // Now unregister owner A and register with owner B (e.g. upgraded plugin)
    service.unregister('dynamic-widget')
    service.register({
      id: 'dynamic-widget',
      ownerId: 'plugin.version2',
      title: 'Dynamic Widget Updated',
      version: '2.0.0',
      defaultSize: { width: 200, height: 100 },
      minSize: { width: 100, height: 50 },
      renderer: { type: 'html', html: '<div>v2</div>' },
    })

    service.restoreInstances(saved)
    const restored = service.get('dynamic-instance')
    expect(restored).toBeDefined()
    expect(restored?.ownerId).toBe('plugin.version2')
  })

  it('clamps invalid size to definition min/max on restore', () => {
    const ctx = new Context()
    const service = new WidgetService(ctx)
    service[WidgetService.init]()

    // Clock minSize is 180x90, maxSize is 440x240
    const saved = [
      {
        id: 'clock-undersized',
        definitionId: 'clock',
        ownerId: 'elix.builtin',
        monitorId: 'primary-monitor',
        position: { x: 100, y: 100 },
        size: { width: 50, height: 20 }, // Too small!
        zOrder: 1,
        configuration: {},
        state: {},
        lifecycle: 'mounted' as const,
        createdAt: 1000,
        updatedAt: 1000,
      },
      {
        id: 'clock-oversized',
        definitionId: 'clock',
        ownerId: 'elix.builtin',
        monitorId: 'primary-monitor',
        position: { x: 100, y: 100 },
        size: { width: 9000, height: 9000 }, // Too large!
        zOrder: 2,
        configuration: {},
        state: {},
        lifecycle: 'mounted' as const,
        createdAt: 1000,
        updatedAt: 1000,
      },
    ]

    service.restoreInstances(saved)
    const undersized = service.get('clock-undersized')
    expect(undersized?.size.width).toBe(180)
    expect(undersized?.size.height).toBe(90)

    const oversized = service.get('clock-oversized')
    expect(oversized?.size.width).toBe(440)
    expect(oversized?.size.height).toBe(240)
  })

  it('normalizes malformed geometry safely on restore', () => {
    const ctx = new Context()
    const service = new WidgetService(ctx)
    service[WidgetService.init]()

    const saved = [
      {
        id: 'nan-geometry',
        definitionId: 'clock',
        ownerId: 'elix.builtin',
        monitorId: 'primary-monitor',
        position: { x: Number.NaN, y: Number.POSITIVE_INFINITY },
        size: { width: -100, height: Number.NaN },
        zOrder: Number.NaN,
        configuration: null as unknown as Record<string, unknown>,
        state: null as unknown as Record<string, unknown>,
        lifecycle: 'invalid-status' as unknown as 'mounted',
        createdAt: Number.NaN,
        updatedAt: Number.NaN,
      },
    ]

    service.restoreInstances(saved)
    const normalized = service.get('nan-geometry')
    expect(normalized).toBeDefined()
    expect(normalized?.position).toEqual({ x: 0, y: 0 })
    expect(normalized?.size).toEqual({ width: 260, height: 120 }) // clock defaultSize
    expect(normalized?.zOrder).toBe(1)
    expect(normalized?.lifecycle).toBe('mounted')
    expect(normalized?.suspended).toBe(false)
  })

  it('handles unknown definitions deterministically without granting privileged authority', () => {
    const ctx = new Context()
    const service = new WidgetService(ctx)
    service[WidgetService.init]()

    const saved = [
      {
        id: 'unknown-widget-1',
        definitionId: 'third-party-unloaded',
        ownerId: 'elix.builtin', // Attempted impersonation
        monitorId: 'primary-monitor',
        position: { x: 50, y: 50 },
        size: { width: 200, height: 150 },
        zOrder: 1,
        configuration: { customKey: 'val' },
        state: { userText: 'saved' },
        lifecycle: 'mounted' as const,
        createdAt: 1000,
        updatedAt: 1000,
      },
    ]

    service.restoreInstances(saved)
    const restored = service.get('unknown-widget-1')
    expect(restored).toBeDefined()
    expect(restored?.ownerId).toBe('unresolved')
    expect(restored?.ownerId).not.toBe('elix.builtin')
    expect(restored?.state.userText).toBe('saved')
  })

  it('preserves suspended state across restart when monitor is absent and restores when monitor reconnects', () => {
    const ctx = new Context()
    const service = new WidgetService(ctx)
    service[WidgetService.init]()

    const saved = [
      {
        id: 'widget-primary',
        definitionId: 'clock',
        ownerId: 'elix.builtin',
        monitorId: 'mon-primary',
        position: { x: 100, y: 100 },
        size: { width: 260, height: 130 },
        zOrder: 1,
        configuration: {},
        state: {},
        lifecycle: 'mounted' as const,
        createdAt: 1000,
        updatedAt: 1000,
      },
      {
        id: 'widget-secondary',
        definitionId: 'notes',
        ownerId: 'elix.builtin',
        monitorId: 'mon-secondary',
        position: { x: 200, y: 200 },
        size: { width: 260, height: 200 },
        zOrder: 2,
        configuration: {},
        state: { text: 'Note on absent monitor' },
        lifecycle: 'suspended' as const,
        suspended: true,
        createdAt: 1000,
        updatedAt: 1000,
      },
    ]

    // Restore with only 'mon-primary' present
    service.restoreInstances(saved, { activeMonitorIds: ['mon-primary'] })

    const primaryWidget = service.get('widget-primary')
    expect(primaryWidget?.lifecycle).toBe('mounted')
    expect(primaryWidget?.suspended).toBe(false)

    // Absent monitor widget MUST remain suspended!
    const secondaryWidget = service.get('widget-secondary')
    expect(secondaryWidget?.lifecycle).toBe('suspended')
    expect(secondaryWidget?.suspended).toBe(true)

    // Active widgets on absent monitor is empty
    expect(service.getActiveForMonitor('mon-secondary')).toHaveLength(0)

    // Now monitor reconnects: restoreForMonitor
    const restored = service.restoreForMonitor('mon-secondary', { x: 1920, y: 0, width: 1920, height: 1080 })
    expect(restored).toHaveLength(1)
    const firstRestored = restored[0]!
    expect(firstRestored.id).toBe('widget-secondary')
    expect(firstRestored.lifecycle).toBe('mounted')
    expect(firstRestored.suspended).toBe(false)
    expect(firstRestored.state.text).toBe('Note on absent monitor')
  })

  it('stale persisted lifecycle does not create invalid runtime state', () => {
    const ctx = new Context()
    const service = new WidgetService(ctx)
    service[WidgetService.init]()

    const saved = [
      {
        id: 'destroyed-widget',
        definitionId: 'clock',
        ownerId: 'elix.builtin',
        monitorId: 'primary',
        position: { x: 100, y: 100 },
        size: { width: 260, height: 120 },
        zOrder: 1,
        configuration: {},
        state: {},
        lifecycle: 'destroyed' as const, // Should be dropped completely
      },
      {
        id: 'unmounted-widget',
        definitionId: 'calendar',
        ownerId: 'elix.builtin',
        monitorId: 'primary',
        position: { x: 200, y: 200 },
        size: { width: 280, height: 260 },
        zOrder: 2,
        configuration: {},
        state: {},
        lifecycle: 'unmounted' as const, // Should remain unmounted
      },
      {
        id: 'corrupt-lifecycle-widget',
        definitionId: 'notes',
        ownerId: 'elix.builtin',
        monitorId: 'primary',
        position: { x: 300, y: 300 },
        size: { width: 260, height: 200 },
        zOrder: 3,
        configuration: {},
        state: {},
        lifecycle: 'unknown_bogus_lifecycle_state' as unknown as 'mounted', // Should normalize to mounted
      },
    ]

    service.restoreInstances(saved)

    // Destroyed widget must not be resurrected
    expect(service.get('destroyed-widget')).toBeUndefined()

    // Unmounted widget should restore safely as unmounted
    const unmounted = service.get('unmounted-widget')
    expect(unmounted).toBeDefined()
    expect(unmounted?.lifecycle).toBe('unmounted')
    expect(unmounted?.suspended).toBe(false)

    // Corrupt lifecycle widget should be normalized safely to mounted
    const normalized = service.get('corrupt-lifecycle-widget')
    expect(normalized).toBeDefined()
    expect(normalized?.lifecycle).toBe('mounted')
    expect(normalized?.suspended).toBe(false)
  })

  it('unresolved definition owner is strictly unprivileged "unresolved" regardless of claimed ownerId', () => {
    const ctx = new Context()
    const service = new WidgetService(ctx)
    service[WidgetService.init]()

    const saved = [
      {
        id: 'spoofed-admin-widget',
        definitionId: 'unregistered-system-card',
        ownerId: 'system.administrator', // Maliciously claimed privilege
        monitorId: 'primary',
        position: { x: 50, y: 50 },
        size: { width: 200, height: 150 },
        zOrder: 1,
        configuration: {},
        state: {},
        lifecycle: 'mounted' as const,
      },
    ]

    service.restoreInstances(saved)
    const restored = service.get('spoofed-admin-widget')
    expect(restored).toBeDefined()
    // Must strictly be 'unresolved', never trusting the persisted ownerId
    expect(restored?.ownerId).toBe('unresolved')
  })
})
