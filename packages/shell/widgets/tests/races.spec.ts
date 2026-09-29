import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { WidgetService } from '../src/service.ts'

describe('Widget Runtime Race Conditions & Robustness', () => {
  it('handles rapid create and remove sequences idempotently', () => {
    const ctx = new Context()
    const service = new WidgetService(ctx)
    service[WidgetService.init]()

    const instances = []
    for (let i = 0; i < 50; i++) {
      const inst = service.create({
        definitionId: 'clock',
        monitorId: 'mon-1',
        position: { x: i * 10, y: i * 10 },
      })
      instances.push(inst)
    }

    expect(service.list().length).toBe(50)

    for (const inst of instances) {
      expect(service.remove(inst.id)).toBe(true)
      // Second removal is safe and returns false
      expect(service.remove(inst.id)).toBe(false)
    }

    expect(service.list().length).toBe(0)
  })

  it('safely updates definition while instances exist', () => {
    const ctx = new Context()
    const service = new WidgetService(ctx)
    service[WidgetService.init]()

    service.register({
      id: 'dynamic-widget',
      ownerId: 'owner-a',
      title: 'Initial Title',
      version: '1.0.0',
      defaultSize: { width: 200, height: 100 },
      minSize: { width: 100, height: 50 },
      renderer: { type: 'html', html: '<div>v1</div>' },
    })

    const inst = service.create({
      definitionId: 'dynamic-widget',
      monitorId: 'mon-1',
      position: { x: 0, y: 0 },
    })

    expect(service.renderWidget(inst)).toBe('<div>v1</div>')

    // Replace definition with v2
    service.register({
      id: 'dynamic-widget',
      ownerId: 'owner-a',
      title: 'Updated Title',
      version: '2.0.0',
      defaultSize: { width: 200, height: 100 },
      minSize: { width: 100, height: 50 },
      renderer: { type: 'html', html: '<div>v2</div>' },
    })

    // Existing instance now renders with updated definition v2
    expect(service.renderWidget(inst)).toBe('<div>v2</div>')
  })

  it('handles intent gracefully when widget was removed concurrently', async () => {
    const ctx = new Context()
    const service = new WidgetService(ctx)
    service[WidgetService.init]()

    const inst = service.create({
      definitionId: 'notes',
      monitorId: 'mon-1',
      position: { x: 0, y: 0 },
    })

    // Remove widget before or during intent
    service.remove(inst.id)

    // Handling intent on non-existent instance must not crash
    await expect(service.handleIntent(inst.id, 'updateText', { text: 'late' })).resolves.toBeUndefined()
  })

  it('disposes cleanly and idempotently', () => {
    const ctx = new Context()
    const service = new WidgetService(ctx)
    service[WidgetService.init]()

    service.create({ definitionId: 'clock', monitorId: 'mon-1', position: { x: 0, y: 0 } })
    expect(service.list().length).toBe(1)

    service.dispose()
    expect(service.list().length).toBe(0)
    expect(service.listDefinitions().length).toBe(0)

    // Second dispose is safe
    service.dispose()
    expect(service.list().length).toBe(0)
  })

  it('rejects creation when ownerId does not match definition ownerId', () => {
    const ctx = new Context()
    const service = new WidgetService(ctx)
    service[WidgetService.init]()

    service.register({
      id: 'owned-widget',
      ownerId: 'owner-alpha',
      title: 'Alpha Widget',
      version: '1.0.0',
      defaultSize: { width: 200, height: 100 },
      minSize: { width: 100, height: 50 },
      renderer: { type: 'html', html: '<div>alpha</div>' },
    })

    // Matches ownerId -> succeeds
    const inst = service.create({
      definitionId: 'owned-widget',
      ownerId: 'owner-alpha',
      monitorId: 'mon-1',
      position: { x: 0, y: 0 },
    })
    expect(inst.id).toBeDefined()

    // Mismatched ownerId -> throws Error
    expect(() => {
      service.create({
        definitionId: 'owned-widget',
        ownerId: 'owner-beta',
        monitorId: 'mon-1',
        position: { x: 0, y: 0 },
      })
    }).toThrow(/owner/)
  })

  it('emits accurate definitionId and monitorId on instance-removed when removed by definition or owner', () => {
    const ctx = new Context()
    const service = new WidgetService(ctx)
    service[WidgetService.init]()

    service.register({
      id: 'custom-widget-1',
      ownerId: 'owner-1',
      title: 'Custom 1',
      version: '1.0.0',
      defaultSize: { width: 100, height: 100 },
      minSize: { width: 50, height: 50 },
      renderer: { type: 'html', html: '<div>1</div>' },
    })

    const inst1 = service.create({
      definitionId: 'custom-widget-1',
      monitorId: 'mon-a',
      position: { x: 10, y: 10 },
    })

    const inst2 = service.create({
      definitionId: 'custom-widget-1',
      monitorId: 'mon-b',
      position: { x: 20, y: 20 },
    })

    const removedEvents: { instanceId: string; definitionId: string; monitorId: string }[] = []
    service.onInstanceRemoved((evt) => {
      removedEvents.push(evt)
    })

    // Remove by definition
    service.removeByDefinition('custom-widget-1')

    expect(removedEvents).toHaveLength(2)
    const event1 = removedEvents.find(e => e.instanceId === inst1.id)
    const event2 = removedEvents.find(e => e.instanceId === inst2.id)
    expect(event1).toBeDefined()
    expect(event1?.definitionId).toBe('custom-widget-1')
    expect(event1?.monitorId).toBe('mon-a')
    expect(event2).toBeDefined()
    expect(event2?.definitionId).toBe('custom-widget-1')
    expect(event2?.monitorId).toBe('mon-b')
  })

  it('suspends and restores widgets on monitor disconnect and reconnect', () => {
    const ctx = new Context()
    const service = new WidgetService(ctx)
    service[WidgetService.init]()

    const inst = service.create({
      definitionId: 'clock',
      monitorId: 'mon-2',
      position: { x: 500, y: 400 },
      size: { width: 200, height: 120 },
    })

    expect(inst.suspended).toBeFalsy()

    // Monitor disconnected
    service.suspendForMonitor('mon-2')
    expect(service.get(inst.id)?.suspended).toBe(true)

    // Active query ignores suspended widgets
    const active = service.getActiveForMonitor('mon-2')
    expect(active).toHaveLength(0)
    // Full list still includes it
    expect(service.getForMonitor('mon-2')).toHaveLength(1)

    // Monitor reconnected with smaller bounds: 400x300
    service.restoreForMonitor('mon-2', { width: 400, height: 300 })
    const restored = service.get(inst.id)!
    expect(restored.suspended).toBe(false)
    // Clamped so it fits in 400x300
    expect(restored.position.x + restored.size.width).toBeLessThanOrEqual(400)
    expect(restored.position.y + restored.size.height).toBeLessThanOrEqual(300)
  })
})
