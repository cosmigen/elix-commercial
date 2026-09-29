import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SurfaceService } from '@deepseek-ai/dsh-surface'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import type { WindowsContextService } from '@deepseek-ai/dsh-windows-context'
import { WidgetService } from '@deepseek-ai/dsh-shell-widgets'
import HomePlugin, {
  gridSpanToSize,
  sizeToGridSpan,
  widgetDefinitionFromManifest,
} from '../src/index.ts'
import { createMockSurfaceRuntime } from './test-runtime.ts'

describe('Single Authoritative Widget Subsystem (Phase 12 Hardening)', () => {
  it('delegates Home widget authority strictly to ctx.widgets without competing registry', async () => {
    const ctx = new Context()
    const runtime = createMockSurfaceRuntime()

    const mockMonitor = {
      id: 'mon-test',
      name: 'Primary Display',
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      workArea: { x: 0, y: 0, width: 1920, height: 1040 },
      scaleFactor: 1.0,
      isPrimary: true,
    }

    ctx.windowsContext = {
      getMonitors: () => [mockMonitor],
      getMonitor: () => mockMonitor,
    } as unknown as WindowsContextService

    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    await ctx.plugin(SurfaceService, { enabled: true, bridge: runtime.bridge })
    await ctx.plugin(WidgetService, { enabled: true })
    await ctx.plugin(HomePlugin, {
      enabled: true,
      initialMonitors: [mockMonitor],
    })

    const home = ctx.home
    const widgets = ctx.widgets

    // 1. Home does not own an independent competing registry
    expect(home.widgets !== undefined).toBe(true)
    expect(home.widgetService !== undefined).toBe(true)
    expect(home.widgets instanceof WidgetService || home.widgets === ctx.get('widgets') || home.widgets === widgets).toBe(true)
    expect(home.widgets?.hasDefinition('clock')).toBe(true)

    // 2. Authoritative built-in widgets come exclusively from ctx.widgets
    expect(widgets.hasDefinition('clock')).toBe(true)
    expect(widgets.hasDefinition('calendar')).toBe(true)
    expect(widgets.hasDefinition('notes')).toBe(true)

    // 3. Spawning a widget in ctx.widgets does NOT create duplicate items in HomeItemManager
    const instance = widgets.create({
      definitionId: 'clock',
      monitorId: mockMonitor.id,
      position: { x: 100, y: 100 },
    })

    expect(widgets.get(instance.id)).toBeDefined()
    expect(home.items.getItem(instance.id)).toBeUndefined()
    expect(home.items.getItems().filter(it => it.type === 'widget')).toHaveLength(0)

    await ctx.fiber.dispose()
  })

  it('converts legacy widget manifests into authoritative WidgetDefinitions via compatibility adapter', () => {
    const manifest = {
      id: 'weather-radar',
      name: 'Live Weather',
      version: '2.1.0',
      ownerId: 'plugins.weather',
      minimumSize: { w: 2, h: 2 },
      defaultLayout: { w: 4, h: 3 },
      memory: {
        defaultValue: { city: 'Tokyo', units: 'metric' },
      },
    }

    const def = widgetDefinitionFromManifest(manifest)
    expect(def.id).toBe('weather-radar')
    expect(def.title).toBe('Live Weather')
    expect(def.version).toBe('2.1.0')
    expect(def.ownerId).toBe('plugins.weather')
    expect(def.defaultSize).toEqual({ width: 4 * 86, height: 3 * 72 })
    expect(def.minSize).toEqual({ width: 2 * 86, height: 2 * 72 })
    expect(def.defaultConfig).toEqual({ city: 'Tokyo', units: 'metric' })
    expect(def.renderer).toEqual({ type: 'component', componentName: 'weather-radar' })
  })

  it('provides bijective gridSpanToSize and sizeToGridSpan conversion utilities', () => {
    const span = { w: 3, h: 2 }
    const size = gridSpanToSize(span, 100, 80)
    expect(size).toEqual({ width: 300, height: 160 })

    const backSpan = sizeToGridSpan(size, 100, 80)
    expect(backSpan).toEqual(span)
  })
})
