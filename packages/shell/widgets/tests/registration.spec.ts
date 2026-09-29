import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { WidgetService } from '../src/service.ts'
import type { WidgetDefinition } from '../src/types.ts'

describe('WidgetDefinitionRegistry & Authoritative Sovereignty', () => {
  it('registers valid widget definitions and enforces geometry validation', () => {
    const ctx = new Context()
    const service = new WidgetService(ctx)
    service[WidgetService.init]()

    const def: WidgetDefinition = {
      id: 'test-widget',
      ownerId: 'test-plugin',
      title: 'Test Widget',
      version: '1.0.0',
      defaultSize: { width: 300, height: 200 },
      minSize: { width: 200, height: 150 },
      maxSize: { width: 500, height: 400 },
      renderer: { type: 'component', componentName: 'test-comp' },
    }

    const unregister = service.register(def)
    expect(service.hasDefinition('test-widget')).toBe(true)
    expect(service.getDefinition('test-widget')?.title).toBe('Test Widget')

    // Clean unregister
    expect(unregister()).toBe(true)
    expect(service.hasDefinition('test-widget')).toBe(false)
  })

  it('rejects definitions with invalid or inverted size constraints', () => {
    const ctx = new Context()
    const service = new WidgetService(ctx)
    service[WidgetService.init]()

    // defaultSize smaller than minSize
    expect(() => {
      service.register({
        id: 'bad-size-1',
        ownerId: 'test-plugin',
        title: 'Bad Size',
        version: '1.0.0',
        defaultSize: { width: 100, height: 100 },
        minSize: { width: 200, height: 200 },
        renderer: { type: 'html', html: '<div></div>' },
      })
    }).toThrow(/cannot be smaller than minSize/)

    // maxSize smaller than minSize
    expect(() => {
      service.register({
        id: 'bad-size-2',
        ownerId: 'test-plugin',
        title: 'Bad Max Size',
        version: '1.0.0',
        defaultSize: { width: 250, height: 250 },
        minSize: { width: 200, height: 200 },
        maxSize: { width: 150, height: 150 },
        renderer: { type: 'html', html: '<div></div>' },
      })
    }).toThrow(/maxSize.*cannot be smaller than minSize/)

    // empty ID
    expect(() => {
      service.register({
        id: '',
        ownerId: 'test-plugin',
        title: 'Empty ID',
        version: '1.0.0',
        defaultSize: { width: 200, height: 200 },
        minSize: { width: 200, height: 200 },
        renderer: { type: 'html', html: '<div></div>' },
      })
    }).toThrow(/must be a non-empty string/)
  })

  it('strictly rejects duplicate registration with differing ownerId', () => {
    const ctx = new Context()
    const service = new WidgetService(ctx)
    service[WidgetService.init]()

    service.register({
      id: 'owned-widget',
      ownerId: 'original-owner',
      title: 'Original Widget',
      version: '1.0.0',
      defaultSize: { width: 200, height: 200 },
      minSize: { width: 200, height: 200 },
      renderer: { type: 'html', html: '<div></div>' },
    })

    // Hostile or competing plugin attempts to claim same ID
    expect(() => {
      service.register({
        id: 'owned-widget',
        ownerId: 'imposter-owner',
        title: 'Imposter Widget',
        version: '1.0.0',
        defaultSize: { width: 200, height: 200 },
        minSize: { width: 200, height: 200 },
        renderer: { type: 'html', html: '<div></div>' },
      })
    }).toThrow(/already registered by owner 'original-owner'\. Owner 'imposter-owner' cannot claim it/)
  })

  it('guarantees stale disposers cannot delete newer definition replacements', () => {
    const ctx = new Context()
    const service = new WidgetService(ctx)
    service[WidgetService.init]()

    // First version registered by owner
    const disposer1 = service.register({
      id: 'versioned-widget',
      ownerId: 'my-owner',
      title: 'Version 1',
      version: '1.0.0',
      defaultSize: { width: 200, height: 200 },
      minSize: { width: 200, height: 200 },
      renderer: { type: 'html', html: '<div>v1</div>' },
    })

    // Second version updated by same owner
    const disposer2 = service.register({
      id: 'versioned-widget',
      ownerId: 'my-owner',
      title: 'Version 2',
      version: '1.1.0',
      defaultSize: { width: 200, height: 200 },
      minSize: { width: 200, height: 200 },
      renderer: { type: 'html', html: '<div>v2</div>' },
    })

    expect(service.getDefinition('versioned-widget')?.title).toBe('Version 2')

    // Calling stale disposer1 must be a no-op and return false
    expect(disposer1()).toBe(false)
    expect(service.hasDefinition('versioned-widget')).toBe(true)
    expect(service.getDefinition('versioned-widget')?.title).toBe('Version 2')

    // Calling fresh disposer2 removes the definition
    expect(disposer2()).toBe(true)
    expect(service.hasDefinition('versioned-widget')).toBe(false)
  })

  it('removes all definitions registered by a specific owner', () => {
    const ctx = new Context()
    const service = new WidgetService(ctx)
    service[WidgetService.init]()

    service.register({
      id: 'owner-widget-1',
      ownerId: 'bulk-owner',
      title: 'Widget 1',
      version: '1.0.0',
      defaultSize: { width: 200, height: 200 },
      minSize: { width: 200, height: 200 },
      renderer: { type: 'html', html: '<div>1</div>' },
    })

    service.register({
      id: 'owner-widget-2',
      ownerId: 'bulk-owner',
      title: 'Widget 2',
      version: '1.0.0',
      defaultSize: { width: 200, height: 200 },
      minSize: { width: 200, height: 200 },
      renderer: { type: 'html', html: '<div>2</div>' },
    })

    const definitions = service.listDefinitions()
    expect(definitions.some(d => d.id === 'owner-widget-1')).toBe(true)
    expect(definitions.some(d => d.id === 'owner-widget-2')).toBe(true)

    service.removeByOwner('bulk-owner')
    expect(service.hasDefinition('owner-widget-1')).toBe(false)
    expect(service.hasDefinition('owner-widget-2')).toBe(false)
  })
})
