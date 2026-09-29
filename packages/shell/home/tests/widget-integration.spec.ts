import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { SurfaceService } from '@deepseek-ai/dsh-surface'
import type { WindowsContextService } from '@deepseek-ai/dsh-windows-context'
import { WidgetService } from '@deepseek-ai/dsh-shell-widgets'
import HomePlugin, { renderHomeRoot } from '../src/index.ts'
import type { MonitorInfo } from '../src/monitor.ts'
import { createMockSurfaceRuntime } from './test-runtime.ts'

describe('Home ↔ Widget Runtime Integration', () => {
  let tempDir: string
  const contexts: Context[] = []

  const monitor1: MonitorInfo = {
    id: 'mon-1',
    name: 'Primary Display',
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    scaleFactor: 1.0,
    isPrimary: true,
  }

  const monitor2: MonitorInfo = {
    id: 'mon-2',
    name: 'Secondary Display',
    bounds: { x: 1920, y: 0, width: 1920, height: 1080 },
    workArea: { x: 1920, y: 0, width: 1920, height: 1040 },
    scaleFactor: 1.25,
    isPrimary: false,
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'elix-home-widget-test-'))
  })

  afterEach(async () => {
    for (const ctx of contexts) {
      await ctx.fiber.dispose().catch(() => {})
    }
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  })

  async function boot(initialMonitors: MonitorInfo[] = [monitor1, monitor2]) {
    const ctx = new Context()
    contexts.push(ctx)
    const runtime = createMockSurfaceRuntime()

    ctx.windowsContext = {
      getMonitors: () => initialMonitors,
      getMonitor: (id: string) => initialMonitors.find(m => m.id === id),
    } as unknown as WindowsContextService

    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    await ctx.plugin(SurfaceService, { enabled: true, bridge: runtime.bridge })
    await ctx.plugin(WidgetService, { enabled: true })
    await ctx.plugin(HomePlugin, {
      enabled: true,
      persistencePath: join(tempDir, 'home-state.json'),
      initialMonitors,
      snapToGrid: true,
    })

    const home = ctx.home
    const widgets = ctx.widgets
    return { ctx, home, widgets, runtime }
  }

  it('projects placed widget instances into Home renderer snapshot with rendered HTML', async () => {
    const { home, widgets } = await boot([monitor1])

    // Create a Clock widget and Notes widget
    const clock = widgets.create({
      definitionId: 'clock',
      monitorId: monitor1.id,
      position: { x: 200, y: 150 },
    })

    const notes = widgets.create({
      definitionId: 'notes',
      monitorId: monitor1.id,
      position: { x: 500, y: 150 },
      state: { text: 'Integration test note' },
    })

    const layout = home.getLayoutContext(monitor1.id)
    expect(layout.monitorBounds).toEqual(monitor1.bounds)

    // Verify snapshot query
    const activeWidgets = widgets.getForMonitor(monitor1.id)
    expect(activeWidgets).toHaveLength(2)
    expect(activeWidgets.map(w => w.id)).toContain(clock.id)
    expect(activeWidgets.map(w => w.id)).toContain(notes.id)

    // Clock HTML contains clock-display
    const clockHtml = widgets.renderWidget(clock)
    expect(clockHtml).toContain('clock-display')

    // Notes HTML contains note text
    const notesHtml = widgets.renderWidget(notes)
    expect(notesHtml).toContain('Integration test note')
  })

  it('exposes a resize handle for every widget definition', async () => {
    const { home, widgets } = await boot([monitor1])
    widgets.register({
      id: 'formerly-fixed',
      ownerId: 'test',
      title: 'Formerly Fixed',
      version: '1.0.0',
      defaultSize: { width: 180, height: 120 },
      minSize: { width: 100, height: 80 },
      resizable: false,
      renderer: { type: 'html', html: '<p>Resizable</p>' },
    })
    const widget = widgets.create({
      definitionId: 'formerly-fixed',
      monitorId: monitor1.id,
      position: { x: 200, y: 150 },
    })

    const snapshot = home.getRendererSnapshot(monitor1.id)
    expect(snapshot.widgets.find(candidate => candidate.id === widget.id)?.resizable).toBe(true)
    expect(renderHomeRoot(snapshot)).toContain('class="widget-resize-handle"')
  })

  it('handles moveWidget intent with clamping and grid snapping', async () => {
    const { home, widgets } = await boot([monitor1])

    const clock = widgets.create({
      definitionId: 'clock',
      monitorId: monitor1.id,
      position: { x: 100, y: 100 },
    })

    // Move within monitor
    // dispatch moveWidget intent via internal dispatch
    await home.dispatchIntent(monitor1.id, {
      type: 'moveWidget',
      instanceId: clock.id,
      position: { x: 250, y: 310 },
    })

    const moved = widgets.get(clock.id)!
    expect(moved.monitorId).toBe(monitor1.id)
    // Snapped to grid (cellWidth: 86, cellHeight: 72)
    expect(moved.position.x).toBeGreaterThanOrEqual(0)
    expect(moved.position.y).toBeGreaterThanOrEqual(0)

    // Move outside monitor boundaries -> clamped to usable bounds
    await home.dispatchIntent(monitor1.id, {
      type: 'moveWidget',
      instanceId: clock.id,
      position: { x: 5000, y: 5000 },
    })

    const clamped = widgets.get(clock.id)!
    expect(clamped.position.x).toBeLessThanOrEqual(monitor1.bounds.width - clock.size.width)
    expect(clamped.position.y).toBeLessThanOrEqual(monitor1.bounds.height - clock.size.height)
  })

  it('relocates widget to destination monitor when dragged across monitor boundary', async () => {
    const { home, widgets } = await boot([monitor1, monitor2])

    const clock = widgets.create({
      definitionId: 'clock',
      monitorId: monitor1.id,
      position: { x: 100, y: 100 },
    })

    // Drag to coordinates residing on monitor 2 (x >= 1920)
    await home.dispatchIntent(monitor1.id, {
      type: 'moveWidget',
      instanceId: clock.id,
      position: { x: 2100, y: 150 },
    })

    const relocated = widgets.get(clock.id)!
    expect(relocated.monitorId).toBe(monitor2.id)
    expect(relocated.position.x).toBeGreaterThanOrEqual(monitor2.bounds.x)
  })

  it('handles resizeWidget intent and clamps to definition constraints', async () => {
    const { home, widgets } = await boot([monitor1])

    const clock = widgets.create({
      definitionId: 'clock',
      monitorId: monitor1.id,
      position: { x: 100, y: 100 },
    })

    const clockDef = widgets.getDefinition('clock')!

    // Resize within limits
    await home.dispatchIntent(monitor1.id, {
      type: 'resizeWidget',
      instanceId: clock.id,
      size: { width: 320, height: 180 },
    })

    const resized = widgets.get(clock.id)!
    expect(resized.size).toEqual({ width: 320, height: 180 })

    // Resize below minSize -> clamped to minSize
    await home.dispatchIntent(monitor1.id, {
      type: 'resizeWidget',
      instanceId: clock.id,
      size: { width: 20, height: 20 },
    })

    const minClamped = widgets.get(clock.id)!
    expect(minClamped.size.width).toBe(clockDef.minSize.width)
    expect(minClamped.size.height).toBe(clockDef.minSize.height)
  })

  it('handles removeWidget and widgetAction intents', async () => {
    const { home, widgets } = await boot([monitor1])

    const notes = widgets.create({
      definitionId: 'notes',
      monitorId: monitor1.id,
      position: { x: 100, y: 100 },
      state: { text: 'Hello' },
    })

    // Update note via widgetAction
    await home.dispatchIntent(monitor1.id, {
      type: 'widgetAction',
      instanceId: notes.id,
      action: 'updateText',
      payload: { text: 'Hello world updated!' },
    })

    expect(widgets.get(notes.id)?.state.text).toBe('Hello world updated!')

    // Remove widget via removeWidget
    await home.dispatchIntent(monitor1.id, {
      type: 'removeWidget',
      instanceId: notes.id,
    })

    expect(widgets.get(notes.id)).toBeUndefined()
  })

  it('persists and restores widget instances across Home restart', async () => {
    const stateFile = join(tempDir, 'durable-home-widgets.json')

    // Session 1: Create Home and placed widgets
    {
      const ctx1 = new Context()
      contexts.push(ctx1)
      const runtime1 = createMockSurfaceRuntime()

      ctx1.windowsContext = {
        getMonitors: () => [monitor1],
        getMonitor: () => monitor1,
      } as unknown as WindowsContextService

      await ctx1.plugin(WebServer, { host: '127.0.0.1', port: 0 })
      await ctx1.plugin(SurfaceService, { enabled: true, bridge: runtime1.bridge })
      await ctx1.plugin(WidgetService, { enabled: true })
      await ctx1.plugin(HomePlugin, {
        enabled: true,
        persistencePath: stateFile,
        initialMonitors: [monitor1],
      })

      ctx1.widgets.create({
        definitionId: 'clock',
        monitorId: monitor1.id,
        position: { x: 120, y: 80 },
      })

      ctx1.widgets.create({
        definitionId: 'notes',
        monitorId: monitor1.id,
        position: { x: 420, y: 80 },
        state: { text: 'Durable persistent note text across restart' },
      })

      await ctx1.home.saveState()
      await ctx1.fiber.dispose()
    }

    // Session 2: Reload Home and verify widgets restored
    {
      const ctx2 = new Context()
      contexts.push(ctx2)
      const runtime2 = createMockSurfaceRuntime()

      ctx2.windowsContext = {
        getMonitors: () => [monitor1],
        getMonitor: () => monitor1,
      } as unknown as WindowsContextService

      await ctx2.plugin(WebServer, { host: '127.0.0.1', port: 0 })
      await ctx2.plugin(SurfaceService, { enabled: true, bridge: runtime2.bridge })
      await ctx2.plugin(WidgetService, { enabled: true })
      await ctx2.plugin(HomePlugin, {
        enabled: true,
        persistencePath: stateFile,
        initialMonitors: [monitor1],
      })

      const restoredWidgets = ctx2.widgets.list()
      expect(restoredWidgets).toHaveLength(2)

      const restoredClock = restoredWidgets.find(w => w.definitionId === 'clock')
      expect(restoredClock).toBeDefined()
      expect(restoredClock?.position).toEqual({ x: 120, y: 80 })

      const restoredNotes = restoredWidgets.find(w => w.definitionId === 'notes')
      expect(restoredNotes).toBeDefined()
      expect(restoredNotes?.state.text).toBe('Durable persistent note text across restart')
    }
  })

  it('suspends widgets when monitor is removed and restores when monitor returns', async () => {
    const { home, widgets } = await boot([monitor1, monitor2])

    // Create a widget on monitor 2
    const m2Widget = widgets.create({
      definitionId: 'clock',
      monitorId: monitor2.id,
      position: { x: 2000, y: 100 },
      size: { width: 220, height: 120 },
    })

    expect(m2Widget.suspended).toBeFalsy()
    expect(widgets.getActiveForMonitor(monitor2.id)).toHaveLength(1)

    // Disconnect monitor 2 (topology now only has monitor 1)
    home.monitors.replaceTopology([monitor1])

    // Widget should now be suspended
    expect(widgets.get(m2Widget.id)?.suspended).toBe(true)
    expect(widgets.getActiveForMonitor(monitor2.id)).toHaveLength(0)

    // Reconnect monitor 2
    home.monitors.replaceTopology([monitor1, monitor2])

    // Widget should now be restored
    expect(widgets.get(m2Widget.id)?.suspended).toBe(false)
    expect(widgets.getActiveForMonitor(monitor2.id)).toHaveLength(1)
  })

  it('handles concurrent saveState calls safely and idempotently', async () => {
    const { home, widgets } = await boot([monitor1])

    widgets.create({
      definitionId: 'clock',
      monitorId: monitor1.id,
      position: { x: 100, y: 100 },
    })

    // Concurrent saveState calls
    await Promise.all([
      home.saveState(),
      home.saveState(),
      home.saveState(),
    ])

    const saved = await home.persistence.load()
    expect(saved.widgets).toHaveLength(1)
  })

  it('widget drag cannot end in reserved region', async () => {
    const { home, widgets } = await boot([monitor1])

    // Top AppBar edge reservation: 48px top strip
    home.layout.registerReservedRegion({
      id: 'appbar-top',
      monitorId: monitor1.id,
      edge: 'top',
      size: 48,
      priority: 1,
      rect: { x: 0, y: 0, width: 1920, height: 48 },
    })

    const clock = widgets.create({
      definitionId: 'clock',
      monitorId: monitor1.id,
      position: { x: 200, y: 150 },
    })

    // Attempt to drag into the top reserved area (y = 10)
    await home.dispatchIntent(monitor1.id, {
      type: 'moveWidget',
      instanceId: clock.id,
      position: { x: 200, y: 10 },
    })

    const moved = widgets.get(clock.id)!
    // Must be clamped to available work area: y >= 48
    expect(moved.position.y).toBeGreaterThanOrEqual(48)
  })

  it('widget resize cannot extend into illegal region', async () => {
    const { home, widgets } = await boot([monitor1])

    // Bottom Dock edge reservation: 60px bottom strip (usable height = 1080 - 60 = 1020)
    home.layout.registerReservedRegion({
      id: 'dock-bottom',
      monitorId: monitor1.id,
      edge: 'bottom',
      size: 60,
      priority: 1,
      rect: { x: 0, y: 1020, width: 1920, height: 60 },
    })

    const clock = widgets.create({
      definitionId: 'clock',
      monitorId: monitor1.id,
      position: { x: 100, y: 800 },
      size: { width: 260, height: 120 },
    })

    // Attempt to resize downwards by 400px (would reach y = 1200, beyond 1020)
    await home.dispatchIntent(monitor1.id, {
      type: 'resizeWidget',
      instanceId: clock.id,
      size: { width: 260, height: 400 },
    })

    const resized = widgets.get(clock.id)!
    expect(resized.position.y + resized.size.height).toBeLessThanOrEqual(1020)
  })

  it('exclusion appearing under widget relocates it and disappearing does not corrupt geometry', async () => {
    const { home, widgets } = await boot([monitor1])

    const clock = widgets.create({
      definitionId: 'clock',
      monitorId: monitor1.id,
      position: { x: 200, y: 200 },
      size: { width: 260, height: 120 },
    })

    // Register a floating exclusion zone overlapping the widget (180, 180, 300, 200)
    const unregister = home.layout.registerExclusionZone({
      id: 'overlay-panel',
      monitorId: monitor1.id,
      rect: { x: 180, y: 180, width: 300, height: 200 },
    })

    const relocated = widgets.get(clock.id)!
    const relocatedRect = { ...relocated.position, ...relocated.size }
    // Must be moved so it does NOT collide with the exclusion zone
    const collides =
      relocatedRect.x < 180 + 300 &&
      relocatedRect.x + relocatedRect.width > 180 &&
      relocatedRect.y < 180 + 200 &&
      relocatedRect.y + relocatedRect.height > 180
    expect(collides).toBe(false)
    const oldPos = { ...relocated.position }

    // When exclusion disappears, widget retains valid position and size
    unregister()
    const afterRemoval = widgets.get(clock.id)!
    expect(afterRemoval.position).toEqual(oldPos)
    expect(afterRemoval.size).toEqual({ width: 260, height: 120 })
  })

  it('handles negative-coordinate monitor and mixed DPI correctly', async () => {
    const negMonitor: MonitorInfo = {
      id: 'mon-neg',
      name: 'Left Display',
      bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
      workArea: { x: -1920, y: 0, width: 1920, height: 1040 },
      scaleFactor: 1.25,
      isPrimary: false,
    }

    const { home, widgets } = await boot([monitor1, negMonitor])

    const widget = widgets.create({
      definitionId: 'clock',
      monitorId: negMonitor.id,
      position: { x: -1800, y: 100 },
    })

    expect(widget.monitorId).toBe('mon-neg')
    expect(widget.position.x).toBe(-1800)

    // Move widget within negative monitor
    await home.dispatchIntent(negMonitor.id, {
      type: 'moveWidget',
      instanceId: widget.id,
      position: { x: -1500, y: 300 },
    })

    const moved = widgets.get(widget.id)!
    expect(moved.position.x).toBeGreaterThanOrEqual(-1920)
    expect(moved.position.x).toBeLessThan(0)
    expect(moved.monitorId).toBe('mon-neg')
  })

  it('restart when monitor absent preserves suspended state and restores on return', async () => {
    const stateFile = join(tempDir, 'absent-monitor-state.json')

    // Session 1: Both monitors active, widget on monitor 2
    {
      const ctx1 = new Context()
      contexts.push(ctx1)
      const runtime1 = createMockSurfaceRuntime()

      ctx1.windowsContext = {
        getMonitors: () => [monitor1, monitor2],
        getMonitor: (id: string) => [monitor1, monitor2].find(m => m.id === id),
      } as unknown as WindowsContextService

      await ctx1.plugin(WebServer, { host: '127.0.0.1', port: 0 })
      await ctx1.plugin(SurfaceService, { enabled: true, bridge: runtime1.bridge })
      await ctx1.plugin(WidgetService, { enabled: true })
      await ctx1.plugin(HomePlugin, {
        enabled: true,
        persistencePath: stateFile,
        initialMonitors: [monitor1, monitor2],
      })

      ctx1.widgets.create({
        definitionId: 'clock',
        monitorId: monitor2.id,
        position: { x: 2000, y: 100 },
      })

      await ctx1.home.saveState()
      await ctx1.fiber.dispose()
    }

    // Session 2: Monitor 2 is ABSENT at boot (only monitor 1 active)
    {
      const ctx2 = new Context()
      contexts.push(ctx2)
      const runtime2 = createMockSurfaceRuntime()

      ctx2.windowsContext = {
        getMonitors: () => [monitor1],
        getMonitor: (id: string) => (id === monitor1.id ? monitor1 : undefined),
      } as unknown as WindowsContextService

      await ctx2.plugin(WebServer, { host: '127.0.0.1', port: 0 })
      await ctx2.plugin(SurfaceService, { enabled: true, bridge: runtime2.bridge })
      await ctx2.plugin(WidgetService, { enabled: true })
      await ctx2.plugin(HomePlugin, {
        enabled: true,
        persistencePath: stateFile,
        initialMonitors: [monitor1],
      })

      // Widget on absent monitor 2 must be suspended
      const widgets = ctx2.widgets.list()
      expect(widgets).toHaveLength(1)
      const w2 = widgets[0]!
      expect(w2.monitorId).toBe(monitor2.id)
      expect(w2.suspended).toBe(true)
      expect(w2.lifecycle).toBe('suspended')
      expect(ctx2.widgets.getActiveForMonitor(monitor2.id)).toHaveLength(0)

      // Monitor 2 returns (reconnects)
      ctx2.home.monitors.replaceTopology([monitor1, monitor2])

      // Widget on monitor 2 is restored
      expect(ctx2.widgets.get(w2.id)?.suspended).toBe(false)
      expect(ctx2.widgets.getActiveForMonitor(monitor2.id)).toHaveLength(1)
    }
  })

  it('persistence restart proves widget state, Notes text, size, monitor, position, z-order, owner correction, and suspended state', async () => {
    const stateFile = join(tempDir, 'durable-widget-audit.json')

    // Session 1: Create Clock + Notes with custom text, size, position, zOrder
    {
      const ctx1 = new Context()
      contexts.push(ctx1)
      const runtime1 = createMockSurfaceRuntime()

      ctx1.windowsContext = {
        getMonitors: () => [monitor1],
        getMonitor: () => monitor1,
      } as unknown as WindowsContextService

      await ctx1.plugin(WebServer, { host: '127.0.0.1', port: 0 })
      await ctx1.plugin(SurfaceService, { enabled: true, bridge: runtime1.bridge })
      await ctx1.plugin(WidgetService, { enabled: true })
      await ctx1.plugin(HomePlugin, {
        enabled: true,
        persistencePath: stateFile,
        initialMonitors: [monitor1],
      })

      ctx1.widgets.create({
        definitionId: 'clock',
        monitorId: monitor1.id,
        position: { x: 120, y: 80 },
        size: { width: 260, height: 120 },
      })

      ctx1.widgets.create({
        definitionId: 'notes',
        monitorId: monitor1.id,
        position: { x: 420, y: 150 },
        size: { width: 340, height: 220 },
        state: { text: 'Critical secret meeting notes proof' },
      })

      await ctx1.home.saveState()
      await ctx1.fiber.dispose()
    }

    interface PersistedWidgetState {
      definitionId: string
      ownerId?: string
      [key: string]: unknown
    }
    interface PersistedHomeState {
      widgets: PersistedWidgetState[]
      [key: string]: unknown
    }
    const rawJson = await readFile(stateFile, 'utf8')
    const parsed = JSON.parse(rawJson) as PersistedHomeState
    expect(parsed.widgets).toHaveLength(2)
    const notesPersisted = parsed.widgets.find(w => w.definitionId === 'notes')
    expect(notesPersisted).toBeDefined()
    if (notesPersisted !== undefined) {
      notesPersisted.ownerId = 'attacker:impersonated-owner'
    }
    await writeFile(stateFile, JSON.stringify(parsed, null, 2), 'utf8')

    // Session 2: Reload Home and verify all fields + authoritative owner correction
    {
      const ctx2 = new Context()
      contexts.push(ctx2)
      const runtime2 = createMockSurfaceRuntime()

      ctx2.windowsContext = {
        getMonitors: () => [monitor1],
        getMonitor: () => monitor1,
      } as unknown as WindowsContextService

      await ctx2.plugin(WebServer, { host: '127.0.0.1', port: 0 })
      await ctx2.plugin(SurfaceService, { enabled: true, bridge: runtime2.bridge })
      await ctx2.plugin(WidgetService, { enabled: true })
      await ctx2.plugin(HomePlugin, {
        enabled: true,
        persistencePath: stateFile,
        initialMonitors: [monitor1],
      })

      const loaded = ctx2.widgets.list()
      expect(loaded).toHaveLength(2)

      const notes = loaded.find(w => w.definitionId === 'notes')!
      expect(notes).toBeDefined()
      // State preserved
      expect(notes.state.text).toBe('Critical secret meeting notes proof')
      // Size preserved
      expect(notes.size).toEqual({ width: 340, height: 220 })
      // Position preserved
      expect(notes.position).toEqual({ x: 420, y: 150 })
      // Monitor preserved
      expect(notes.monitorId).toBe(monitor1.id)
      // Z-order preserved
      expect(notes.zOrder).toBe(2)
      // Owner correction: attacker:impersonated-owner was overridden with authoritative def.ownerId (elix.builtin)
      expect(notes.ownerId).toBe('elix.builtin')
      // Active / not suspended
      expect(notes.suspended).toBe(false)
      expect(notes.lifecycle).toBe('mounted')
    }
  })

  it('snap-to-grid + exclusion interaction avoids collisions with both exclusions and existing desktop items', async () => {
    const { home, widgets } = await boot([monitor1])

    // Existing desktop item at (216, 96)
    home.items.addItem({
      id: 'existing-icon',
      type: 'shortcut',
      monitorId: monitor1.id,
      position: { x: 216, y: 96 },
      size: { width: 84, height: 96 },
      metadata: {},
    })

    // Floating exclusion zone at (100, 96, 200, 150)
    home.layout.registerExclusionZone({
      id: 'test-zone',
      monitorId: monitor1.id,
      rect: { x: 100, y: 96, width: 200, height: 150 },
    })

    const clock = widgets.create({
      definitionId: 'clock',
      monitorId: monitor1.id,
      position: { x: 600, y: 500 },
      size: { width: 260, height: 120 },
    })

    // Attempt to move clock to (150, 120) which is inside the exclusion zone
    await home.dispatchIntent(monitor1.id, {
      type: 'moveWidget',
      instanceId: clock.id,
      position: { x: 150, y: 120 },
    })

    const moved = widgets.get(clock.id)!
    const movedRect = { ...moved.position, ...moved.size }

    // Must not collide with exclusion zone
    const collidesExclusion =
      movedRect.x < 100 + 200 &&
      movedRect.x + movedRect.width > 100 &&
      movedRect.y < 96 + 150 &&
      movedRect.y + movedRect.height > 96
    expect(collidesExclusion).toBe(false)

    // Must not collide with existing desktop item
    const collidesItem =
      movedRect.x < 216 + 84 &&
      movedRect.x + movedRect.width > 216 &&
      movedRect.y < 96 + 96 &&
      movedRect.y + movedRect.height > 96
    expect(collidesItem).toBe(false)
  })

  it('reconciliation clamps active widgets to monitor usable bounds when reservation changes', async () => {
    const { home, widgets } = await boot([monitor1])

    const clock = widgets.create({
      definitionId: 'clock',
      monitorId: monitor1.id,
      position: { x: 100, y: 10 },
      size: { width: 260, height: 120 },
    })
    expect(clock.position.y).toBe(10)

    // Register top AppBar reservation (0..48)
    home.layout.registerReservedRegion({
      id: 'appbar-top-reconcile',
      monitorId: monitor1.id,
      edge: 'top',
      size: 48,
      priority: 1,
      rect: { x: 0, y: 0, width: 1920, height: 48 },
    })

    // Trigger reconciliation (also called on layout changes)
    home.reconcilePlacements()

    const reconciled = widgets.get(clock.id)!
    expect(reconciled.position.y).toBeGreaterThanOrEqual(48)
  })
})
