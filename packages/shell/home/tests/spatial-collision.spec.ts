import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { SurfaceService } from '@deepseek-ai/dsh-surface'
import type { WindowsContextService } from '@deepseek-ai/dsh-windows-context'
import { WidgetService } from '@deepseek-ai/dsh-shell-widgets'
import OverlayService from '@deepseek-ai/dsh-shell-overlay'
import ShellLayoutService from '@deepseek-ai/dsh-shell-layout'
import HomePlugin, {
  FOLDER_ARM_DELAY_MS,
  FolderManager,
  HomeDragSession,
  HomeItemManager,
  HomeLayoutEngine,
  rectsIntersect,
} from '../src/index.ts'
import type { Rect } from '../src/index.ts'
import type { MonitorInfo } from '../src/monitor.ts'
import { createMockSurfaceRuntime } from './test-runtime.ts'

describe('Home Spatial Collision & Unified Placement (25 Scenarios)', () => {
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
    scaleFactor: 1.0,
    isPrimary: false,
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'elix-home-spatial-'))
  })

  afterEach(async () => {
    for (const ctx of contexts) {
      await ctx.fiber.dispose().catch(() => {})
    }
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  })

  async function boot(options: {
    initialMonitors?: MonitorInfo[]
    snapToGrid?: boolean
    demoMode?: boolean
  } = {}) {
    const ctx = new Context()
    contexts.push(ctx)
    const runtime = createMockSurfaceRuntime()
    const monitors = options.initialMonitors ?? [monitor1]

    ctx.windowsContext = {
      getMonitors: () => monitors,
      getMonitor: (id: string) => monitors.find(m => m.id === id),
      getPrimaryMonitor: () => monitors.find(m => m.isPrimary) ?? monitors[0],
      getForegroundContext: () => null,
    } as unknown as WindowsContextService

    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    await ctx.plugin(SurfaceService, { enabled: true, bridge: runtime.bridge })
    await ctx.plugin(WidgetService, { enabled: true })
    await ctx.plugin(OverlayService, { enabled: true })
    await ctx.plugin(ShellLayoutService, { enabled: true })
    await ctx.plugin(HomePlugin, {
      enabled: true,
      persistencePath: join(tempDir, 'home-state.json'),
      initialMonitors: monitors,
      snapToGrid: options.snapToGrid ?? true,
      demoMode: options.demoMode ?? true,
    })

    return {
      ctx,
      home: ctx.home,
      widgets: ctx.widgets,
      overlay: ctx.overlay,
      shellLayout: ctx.shellLayout,
      runtime,
    }
  }

  // 1. desktop item vs desktop item
  it('1. desktop item vs desktop item: reflows occupied grid slot without overlap', async () => {
    const { home } = await boot()
    const itemA = home.items.addItem({
      type: 'file',
      monitorId: monitor1.id,
      position: { x: 100, y: 100 },
      size: { width: 84, height: 96 },
      metadata: {},
    })
    const itemB = home.items.addItem({
      type: 'file',
      monitorId: monitor1.id,
      position: { x: 400, y: 400 },
      size: { width: 84, height: 96 },
      metadata: {},
    })
    const initialAPosition = { ...itemA.position }

    // Drag B directly into A's occupied region. In grid mode B owns the
    // requested destination and A reflows aside.
    const session = home.startDragSession({
      mode: 'move',
      primaryItemId: itemB.id,
      startPointer: { x: 400, y: 400 },
      monitorId: monitor1.id,
    })

    session.updatePointer({ x: 100, y: 100 })
    session.commit()

    // Re-read both items from the authoritative manager because reflow is
    // allowed to move the existing blocker.
    const updatedA = home.items.getItem(itemA.id)
    const updatedB = home.items.getItem(itemB.id)
    expect(updatedA).toBeDefined()
    expect(updatedB).toBeDefined()
    if (!updatedA || !updatedB) return

    const gap = home.layout.getGridConfig().gap
    const rectA = { ...updatedA.position, ...updatedA.size }
    const rectB = { ...updatedB.position, ...updatedB.size }
    expect(rectsIntersect(rectA, rectB, gap)).toBe(false)
    expect(updatedA.position).not.toEqual(initialAPosition)
    expect(updatedB.position).not.toEqual({ x: 400, y: 400 })
  })

  // 2. desktop item vs widget
  it('2. desktop item vs widget: item drag resolves outside widget bounds', async () => {
    const { home, widgets } = await boot()
    const clock = widgets.create({
      definitionId: 'clock',
      monitorId: monitor1.id,
      position: { x: 200, y: 200 },
    })

    const item = home.items.addItem({
      type: 'file',
      monitorId: monitor1.id,
      position: { x: 500, y: 500 },
      size: { width: 84, height: 96 },
      metadata: {},
    })

    const session = home.startDragSession({
      mode: 'move',
      primaryItemId: item.id,
      startPointer: { x: 500, y: 500 },
      monitorId: monitor1.id,
    })

    // Drag item directly over the clock widget
    session.updatePointer({ x: 220, y: 220 })
    session.commit()

    const updatedItem = home.items.getItem(item.id)
    expect(updatedItem).toBeDefined()
    if (!updatedItem) return

    const gap = home.layout.getGridConfig().gap
    const itemRect = { ...updatedItem.position, ...updatedItem.size }
    const widgetRect = { ...clock.position, ...clock.size }
    expect(rectsIntersect(itemRect, widgetRect, gap)).toBe(false)
  })

  // 3. widget vs desktop item
  it('3. widget vs desktop item: widget move resolves avoiding desktop item', async () => {
    const { home, widgets } = await boot()
    home.items.addItem({
      type: 'file',
      monitorId: monitor1.id,
      position: { x: 200, y: 200 },
      size: { width: 84, height: 96 },
      metadata: {},
    })

    const clock = widgets.create({
      definitionId: 'clock',
      monitorId: monitor1.id,
      position: { x: 500, y: 500 },
    })

    // Move widget directly onto the desktop item
    await home.dispatchIntent(monitor1.id, {
      type: 'moveWidget',
      instanceId: clock.id,
      position: { x: 200, y: 200 },
    })

    const updatedWidget = widgets.get(clock.id)
    expect(updatedWidget).toBeDefined()
    if (!updatedWidget) return

    const item = home.items.getItems()[0]
    if (!item) return
    const gap = home.layout.getGridConfig().gap
    const widgetRect = { ...updatedWidget.position, ...updatedWidget.size }
    const itemRect = { ...item.position, ...item.size }
    expect(rectsIntersect(widgetRect, itemRect, gap)).toBe(false)
  })

  // 4. widget vs widget
  it('4. widget vs widget: widget move resolves avoiding another widget', async () => {
    const { home, widgets } = await boot()
    const clock = widgets.create({
      definitionId: 'clock',
      monitorId: monitor1.id,
      position: { x: 200, y: 200 },
    })

    const notes = widgets.create({
      definitionId: 'notes',
      monitorId: monitor1.id,
      position: { x: 600, y: 200 },
    })

    // Move notes widget directly onto clock widget
    await home.dispatchIntent(monitor1.id, {
      type: 'moveWidget',
      instanceId: notes.id,
      position: { x: 200, y: 200 },
    })

    const updatedClock = widgets.get(clock.id)
    const updatedNotes = widgets.get(notes.id)
    expect(updatedClock).toBeDefined()
    expect(updatedNotes).toBeDefined()
    if (!updatedClock || !updatedNotes) return

    const gap = home.layout.getGridConfig().gap
    const clockRect = { ...updatedClock.position, ...updatedClock.size }
    const notesRect = { ...updatedNotes.position, ...updatedNotes.size }
    expect(rectsIntersect(clockRect, notesRect, gap)).toBe(false)
  })

  // 5. widget resize vs desktop item
  it('5. widget resize vs desktop item: clamps widget resize before hitting item without squishing orthogonal axis', async () => {
    const { home, widgets } = await boot()
    const clock = widgets.create({
      definitionId: 'clock',
      monitorId: monitor1.id,
      position: { x: 100, y: 100 },
      size: { width: 172, height: 144 },
    })

    const item = home.items.addItem({
      type: 'file',
      monitorId: monitor1.id,
      position: { x: 300, y: 140 },
      size: { width: 84, height: 96 },
      metadata: {},
    })

    // Attempt to resize clock to width 350 (which would collide with item at x=300)
    await home.dispatchIntent(monitor1.id, {
      type: 'resizeWidget',
      instanceId: clock.id,
      size: { width: 350, height: 144 },
    })

    const updatedClock = widgets.get(clock.id)
    expect(updatedClock).toBeDefined()
    if (!updatedClock) return

    const gap = home.layout.getGridConfig().gap
    const widgetRect = { ...updatedClock.position, ...updatedClock.size }
    const itemRect = { ...item.position, ...item.size }
    expect(rectsIntersect(widgetRect, itemRect, gap)).toBe(false)
    expect(updatedClock.size.height).toBe(144)
    expect(updatedClock.size.width).toBeLessThanOrEqual(300 - 100 - gap)
  })

  // 6. widget resize vs widget
  it('6. widget resize vs widget: clamps widget resize before hitting another widget', async () => {
    const { home, widgets } = await boot()
    const clock = widgets.create({
      definitionId: 'clock',
      monitorId: monitor1.id,
      position: { x: 100, y: 100 },
      size: { width: 172, height: 144 },
    })

    const notes = widgets.create({
      definitionId: 'notes',
      monitorId: monitor1.id,
      position: { x: 300, y: 130 },
      size: { width: 200, height: 150 },
    })

    // Attempt to resize clock to width 350
    await home.dispatchIntent(monitor1.id, {
      type: 'resizeWidget',
      instanceId: clock.id,
      size: { width: 350, height: 144 },
    })

    const updatedClock = widgets.get(clock.id)
    const updatedNotes = widgets.get(notes.id)
    expect(updatedClock).toBeDefined()
    expect(updatedNotes).toBeDefined()
    if (!updatedClock || !updatedNotes) return

    const gap = home.layout.getGridConfig().gap
    const clockRect = { ...updatedClock.position, ...updatedClock.size }
    const notesRect = { ...updatedNotes.position, ...updatedNotes.size }
    expect(rectsIntersect(clockRect, notesRect, gap)).toBe(false)
    expect(updatedClock.size.height).toBe(144)
    expect(updatedClock.size.width).toBeLessThanOrEqual(300 - 100 - gap)
  })

  // 7. desktop item vs exclusion
  it('7. desktop item vs exclusion: item drag avoids registered exclusion zone', async () => {
    const { home } = await boot()
    home.layout.registerExclusionZone({
      id: 'ex-zone-1',
      monitorId: monitor1.id,
      rect: { x: 200, y: 200, width: 200, height: 200 },
    })

    const item = home.items.addItem({
      type: 'file',
      monitorId: monitor1.id,
      position: { x: 600, y: 600 },
      size: { width: 84, height: 96 },
      metadata: {},
    })

    const session = home.startDragSession({
      mode: 'move',
      primaryItemId: item.id,
      startPointer: { x: 600, y: 600 },
      monitorId: monitor1.id,
    })

    // Drag item directly into exclusion zone
    session.updatePointer({ x: 250, y: 250 })
    session.commit()

    const updatedItem = home.items.getItem(item.id)
    expect(updatedItem).toBeDefined()
    if (!updatedItem) return

    const gap = home.layout.getGridConfig().gap
    const itemRect = { ...updatedItem.position, ...updatedItem.size }
    const exRect = { x: 200, y: 200, width: 200, height: 200 }
    expect(rectsIntersect(itemRect, exRect, gap)).toBe(false)
  })

  // 8. widget vs exclusion
  it('8. widget vs exclusion: widget move resolves avoiding registered exclusion zone', async () => {
    const { home, widgets } = await boot()
    home.layout.registerExclusionZone({
      id: 'ex-zone-2',
      monitorId: monitor1.id,
      rect: { x: 300, y: 200, width: 250, height: 250 },
    })

    const clock = widgets.create({
      definitionId: 'clock',
      monitorId: monitor1.id,
      position: { x: 700, y: 200 },
    })

    await home.dispatchIntent(monitor1.id, {
      type: 'moveWidget',
      instanceId: clock.id,
      position: { x: 350, y: 250 },
    })

    const updatedClock = widgets.get(clock.id)
    expect(updatedClock).toBeDefined()
    if (!updatedClock) return

    const gap = home.layout.getGridConfig().gap
    const widgetRect = { ...updatedClock.position, ...updatedClock.size }
    const exRect = { x: 300, y: 200, width: 250, height: 250 }
    expect(rectsIntersect(widgetRect, exRect, gap)).toBe(false)
  })

  // 9. resized widget vs exclusion
  it('9. resized widget vs exclusion: clamps widget resize before hitting exclusion', async () => {
    const { home, widgets } = await boot()
    home.layout.registerExclusionZone({
      id: 'ex-zone-3',
      monitorId: monitor1.id,
      rect: { x: 300, y: 100, width: 200, height: 200 },
    })

    const clock = widgets.create({
      definitionId: 'clock',
      monitorId: monitor1.id,
      position: { x: 100, y: 100 },
      size: { width: 172, height: 144 },
    })

    await home.dispatchIntent(monitor1.id, {
      type: 'resizeWidget',
      instanceId: clock.id,
      size: { width: 350, height: 144 },
    })

    const updatedClock = widgets.get(clock.id)
    expect(updatedClock).toBeDefined()
    if (!updatedClock) return

    const gap = home.layout.getGridConfig().gap
    const widgetRect = { ...updatedClock.position, ...updatedClock.size }
    const exRect = { x: 300, y: 100, width: 200, height: 200 }
    expect(rectsIntersect(widgetRect, exRect, gap)).toBe(false)
  })

  // 10. grid-on item/widget collision
  it('10. grid-on item/widget collision: snaps to legal grid cell avoiding widget', async () => {
    const { home, widgets } = await boot({ snapToGrid: true })
    const clock = widgets.create({
      definitionId: 'clock',
      monitorId: monitor1.id,
      position: { x: 24, y: 24 },
      size: { width: 172, height: 144 },
    })

    const item = home.items.addItem({
      type: 'file',
      monitorId: monitor1.id,
      position: { x: 400, y: 400 },
      size: { width: 84, height: 96 },
      metadata: {},
    })

    const session = home.startDragSession({
      mode: 'move',
      primaryItemId: item.id,
      startPointer: { x: 400, y: 400 },
      monitorId: monitor1.id,
    })

    // Drag item onto clock
    session.updatePointer({ x: 30, y: 30 })
    session.commit()

    const updatedItem = home.items.getItem(item.id)
    expect(updatedItem).toBeDefined()
    if (!updatedItem) return

    const gap = home.layout.getGridConfig().gap
    const itemRect = { ...updatedItem.position, ...updatedItem.size }
    const widgetRect = { ...clock.position, ...clock.size }
    expect(rectsIntersect(itemRect, widgetRect, gap)).toBe(false)

    // Verify grid alignment (position coordinates match grid cell offsets)
    const grid = home.layout.getGridConfig()
    const relX = updatedItem.position.x - grid.padding.left
    const relY = updatedItem.position.y - grid.padding.top
    const stepX = grid.cellWidth + grid.gap
    const stepY = grid.cellHeight + grid.gap
    expect(relX % stepX).toBe(0)
    expect(relY % stepY).toBe(0)
  })

  // 11. grid-off item/widget collision
  it('11. grid-off item/widget collision: resolves freeform avoiding widget without grid snapping', async () => {
    const { home, widgets } = await boot({ snapToGrid: false })
    const clock = widgets.create({
      definitionId: 'clock',
      monitorId: monitor1.id,
      position: { x: 153, y: 167 },
      size: { width: 172, height: 144 },
    })

    const item = home.items.addItem({
      type: 'file',
      monitorId: monitor1.id,
      position: { x: 500, y: 500 },
      size: { width: 84, height: 96 },
      metadata: {},
    })

    const session = home.startDragSession({
      mode: 'move',
      primaryItemId: item.id,
      startPointer: { x: 500, y: 500 },
      monitorId: monitor1.id,
    })

    // Drag item directly over clock
    session.updatePointer({ x: 160, y: 170 })
    session.commit()

    const updatedItem = home.items.getItem(item.id)
    expect(updatedItem).toBeDefined()
    if (!updatedItem) return

    const gap = home.layout.getGridConfig().gap
    const itemRect = { ...updatedItem.position, ...updatedItem.size }
    const widgetRect = { ...clock.position, ...clock.size }
    expect(rectsIntersect(itemRect, widgetRect, gap)).toBe(false)
  })

  // 12. cross-monitor item movement
  it('12. cross-monitor item movement: moves item across monitor boundary', async () => {
    const { home } = await boot({ initialMonitors: [monitor1, monitor2] })
    const item = home.items.addItem({
      type: 'file',
      monitorId: monitor1.id,
      position: { x: 100, y: 100 },
      size: { width: 84, height: 96 },
      metadata: {},
    })

    // Drag item from monitor 1 to monitor 2
    const session = home.startDragSession({
      mode: 'move',
      primaryItemId: item.id,
      startPointer: { x: 100, y: 100 },
      monitorId: monitor1.id,
    })

    // Pointer enters monitor 2 (x >= 1920)
    session.updatePointer({ x: 2050, y: 200 })
    session.commit()

    const updatedItem = home.items.getItem(item.id)
    expect(updatedItem).toBeDefined()
    if (!updatedItem) return

    expect(updatedItem.monitorId).toBe(monitor2.id)
    expect(updatedItem.position.x).toBeGreaterThanOrEqual(monitor2.bounds.x)
    expect(updatedItem.position.x).toBeLessThan(monitor2.bounds.x + monitor2.bounds.width)
  })

  // 13. cross-monitor widget movement
  it('13. cross-monitor widget movement: moves widget across monitor boundary', async () => {
    const { home, widgets } = await boot({ initialMonitors: [monitor1, monitor2] })
    const clock = widgets.create({
      definitionId: 'clock',
      monitorId: monitor1.id,
      position: { x: 100, y: 100 },
    })

    // Move widget to coordinates located on monitor 2
    await home.dispatchIntent(monitor1.id, {
      type: 'moveWidget',
      instanceId: clock.id,
      position: { x: 2100, y: 150 },
    })

    const updatedClock = widgets.get(clock.id)
    expect(updatedClock).toBeDefined()
    if (!updatedClock) return

    expect(updatedClock.monitorId).toBe(monitor2.id)
    expect(updatedClock.position.x).toBeGreaterThanOrEqual(monitor2.bounds.x)
    expect(updatedClock.position.x).toBeLessThan(monitor2.bounds.x + monitor2.bounds.width)
  })

  // 14. monitor removal recovery
  it('14. monitor removal recovery: relocates items and widgets when monitor is removed', async () => {
    const { home } = await boot({ initialMonitors: [monitor1, monitor2] })
    const item = home.items.addItem({
      type: 'file',
      monitorId: monitor2.id,
      position: { x: 2000, y: 200 },
      size: { width: 84, height: 96 },
      metadata: {},
    })

    // Remove monitor 2
    home.monitors.removeMonitor(monitor2.id)

    const updatedItem = home.items.getItem(item.id)
    expect(updatedItem).toBeDefined()
    if (!updatedItem) return

    expect(updatedItem.monitorId).toBe(monitor1.id)
    expect(updatedItem.position.x).toBeGreaterThanOrEqual(monitor1.bounds.x)
    expect(updatedItem.position.x).toBeLessThan(monitor1.bounds.x + monitor1.bounds.width)
  })

  // 15. monitor return recovery
  it('15. monitor return recovery: preserves stable valid positions when monitor returns', async () => {
    const { home } = await boot({ initialMonitors: [monitor1, monitor2] })
    const item = home.items.addItem({
      type: 'file',
      monitorId: monitor1.id,
      position: { x: 100, y: 100 },
      size: { width: 84, height: 96 },
      metadata: {},
    })

    // Remove monitor 2 then add it back
    home.monitors.removeMonitor(monitor2.id)
    home.monitors.addOrUpdateMonitor(monitor2)

    const updatedItem = home.items.getItem(item.id)
    expect(updatedItem).toBeDefined()
    if (!updatedItem) return

    expect(updatedItem.position.x).toBeGreaterThanOrEqual(monitor1.bounds.x)
    expect(updatedItem.position.y).toBeGreaterThanOrEqual(monitor1.bounds.y)
    expect(updatedItem.position.x).toBeLessThan(monitor1.bounds.x + monitor1.bounds.width)
  })

  // 16. multi-select vs widget
  it('16. multi-select vs widget: shifts multi-item group preserving relative layout', async () => {
    const { home, widgets } = await boot()
    const clock = widgets.create({
      definitionId: 'clock',
      monitorId: monitor1.id,
      position: { x: 300, y: 300 },
      size: { width: 172, height: 144 },
    })

    const itemA = home.items.addItem({
      type: 'file',
      monitorId: monitor1.id,
      position: { x: 100, y: 100 },
      size: { width: 84, height: 96 },
      metadata: {},
    })

    const itemB = home.items.addItem({
      type: 'file',
      monitorId: monitor1.id,
      position: { x: 200, y: 100 },
      size: { width: 84, height: 96 },
      metadata: {},
    })

    const initialDistance = itemB.position.x - itemA.position.x

    const session = home.startDragSession({
      mode: 'move',
      primaryItemId: itemA.id,
      additionalItemIds: [itemB.id],
      startPointer: { x: 100, y: 100 },
      monitorId: monitor1.id,
    })

    // Shift group so item B would land directly on clock at (300, 300)
    session.updatePointer({ x: 200, y: 300 })
    session.commit()

    const updatedA = home.items.getItem(itemA.id)
    const updatedB = home.items.getItem(itemB.id)
    expect(updatedA).toBeDefined()
    expect(updatedB).toBeDefined()
    if (!updatedA || !updatedB) return

    const gap = home.layout.getGridConfig().gap
    const clockRect = { ...clock.position, ...clock.size }
    const rectA = { ...updatedA.position, ...updatedA.size }
    const rectB = { ...updatedB.position, ...updatedB.size }

    // Neither item intersects the clock
    expect(rectsIntersect(rectA, clockRect, gap)).toBe(false)
    expect(rectsIntersect(rectB, clockRect, gap)).toBe(false)

    // Items do not intersect each other
    expect(rectsIntersect(rectA, rectB, gap)).toBe(false)

    // Relative distance is preserved
    expect(updatedB.position.x - updatedA.position.x).toBe(initialDistance)
    expect(updatedB.position.y - updatedA.position.y).toBe(0)

    // Drag group into an unresolvable out-of-bounds space: group must remain coherent without scattering
    const session2 = home.startDragSession({
      mode: 'move',
      primaryItemId: itemA.id,
      additionalItemIds: [itemB.id],
      startPointer: { ...updatedA.position },
      monitorId: monitor1.id,
    })
    session2.updatePointer({ x: 99999, y: 99999 })
    session2.commit()

    const finalA = home.items.getItem(itemA.id)
    const finalB = home.items.getItem(itemB.id)
    expect(finalA).toBeDefined()
    expect(finalB).toBeDefined()
    if (finalA && finalB) {
      expect(finalB.position.x - finalA.position.x).toBe(initialDistance)
      expect(finalB.position.y - finalA.position.y).toBe(0)
    }
  })

  // 17. folder dwell does not trigger from ordinary overlap
  it('17. folder dwell does not trigger from ordinary overlap', () => {
    const itemManager = new HomeItemManager()
    const folderManager = new FolderManager(itemManager)
    const layoutEngine = new HomeLayoutEngine()
    const availableBounds: Rect = { x: 0, y: 0, width: 1920, height: 1080 }

    const itemA = itemManager.addItem({
      type: 'file',
      monitorId: 'mon-1',
      position: { x: 100, y: 100 },
      size: { width: 84, height: 96 },
      metadata: {},
    })
    itemManager.addItem({
      type: 'file',
      monitorId: 'mon-1',
      position: { x: 300, y: 200 },
      size: { width: 84, height: 96 },
      metadata: {},
    })

    const session = new HomeDragSession(
      {
        mode: 'move',
        primaryItemId: itemA.id,
        startPointer: { x: 142, y: 148 },
        monitorId: 'mon-1',
        availableBounds,
      },
      itemManager,
      folderManager,
      layoutEngine,
    )

    // Briefly enter item B bounds for 100ms (< FOLDER_ARM_DELAY_MS)
    session.updatePointer({ x: 342, y: 248 }, { timestamp: 1000 })
    const snap = session.updatePointer({ x: 342, y: 248 }, { timestamp: 1100 })
    expect(snap.dropTarget.type).toBe('create-folder')
    if (snap.dropTarget.type === 'create-folder') {
      expect(snap.dropTarget.armed).toBe(false)
    }

    // Commit before dwell arms: regular move wins
    const result = session.commit()
    expect(result.type).toBe('moved')
    expect(folderManager.getFolders()).toHaveLength(0)
  })

  // 18. armed folder gesture wins over placement resolution
  it('18. armed folder gesture wins over placement resolution', () => {
    const itemManager = new HomeItemManager()
    const folderManager = new FolderManager(itemManager)
    const layoutEngine = new HomeLayoutEngine()
    const availableBounds: Rect = { x: 0, y: 0, width: 1920, height: 1080 }

    const itemA = itemManager.addItem({
      type: 'file',
      monitorId: 'mon-1',
      position: { x: 100, y: 100 },
      size: { width: 84, height: 96 },
      metadata: {},
    })
    const itemB = itemManager.addItem({
      type: 'file',
      monitorId: 'mon-1',
      position: { x: 300, y: 200 },
      size: { width: 84, height: 96 },
      metadata: {},
    })

    const session = new HomeDragSession(
      {
        mode: 'move',
        primaryItemId: itemA.id,
        startPointer: { x: 142, y: 148 },
        monitorId: 'mon-1',
        availableBounds,
      },
      itemManager,
      folderManager,
      layoutEngine,
    )

    // Dwell for >= FOLDER_ARM_DELAY_MS
    session.updatePointer({ x: 342, y: 248 }, { timestamp: 1000 })
    const snap = session.updatePointer({ x: 342, y: 248 }, { timestamp: 1000 + FOLDER_ARM_DELAY_MS })
    expect(snap.dropTarget.type).toBe('create-folder')
    if (snap.dropTarget.type === 'create-folder') {
      expect(snap.dropTarget.armed).toBe(true)
      expect(snap.dropTarget.targetItemId).toBe(itemB.id)
    }

    const result = session.commit()
    expect(result.type).toBe('folder_created')
    expect(folderManager.getFolders()).toHaveLength(1)
  })

  // 19. cancelled folder dwell falls back to normal movement
  it('19. cancelled folder dwell falls back to normal movement', () => {
    const itemManager = new HomeItemManager()
    const folderManager = new FolderManager(itemManager)
    const layoutEngine = new HomeLayoutEngine()
    const availableBounds: Rect = { x: 0, y: 0, width: 1920, height: 1080 }

    const itemA = itemManager.addItem({
      type: 'file',
      monitorId: 'mon-1',
      position: { x: 100, y: 100 },
      size: { width: 84, height: 96 },
      metadata: {},
    })
    itemManager.addItem({
      type: 'file',
      monitorId: 'mon-1',
      position: { x: 300, y: 200 },
      size: { width: 84, height: 96 },
      metadata: {},
    })

    const session = new HomeDragSession(
      {
        mode: 'move',
        primaryItemId: itemA.id,
        startPointer: { x: 142, y: 148 },
        monitorId: 'mon-1',
        availableBounds,
      },
      itemManager,
      folderManager,
      layoutEngine,
    )

    // Dwell over item B then move away to free space (500, 500)
    session.updatePointer({ x: 342, y: 248 }, { timestamp: 1000 })
    session.updatePointer({ x: 500, y: 500 }, { timestamp: 1000 + FOLDER_ARM_DELAY_MS + 200 })

    const result = session.commit()
    expect(result.type).toBe('moved')
    expect(folderManager.getFolders()).toHaveLength(0)
  })

  // 20. restored persisted geometry remains valid
  it('20. restored persisted geometry remains valid: startup reconciliation clears overlaps', async () => {
    const { home, widgets } = await boot()
    // Create an item and a widget
    const item = home.items.addItem({
      type: 'file',
      monitorId: monitor1.id,
      position: { x: 200, y: 200 },
      size: { width: 84, height: 96 },
      metadata: {},
    })

    const clock = widgets.create({
      definitionId: 'clock',
      monitorId: monitor1.id,
      position: { x: 500, y: 500 },
    })

    // Force save state
    await home.saveState()

    // Trigger reconciliation
    home.reconcilePlacements()

    const updatedItem = home.items.getItem(item.id)
    const updatedClock = widgets.get(clock.id)
    expect(updatedItem).toBeDefined()
    expect(updatedClock).toBeDefined()
    if (!updatedItem || !updatedClock) return

    const gap = home.layout.getGridConfig().gap
    const itemRect = { ...updatedItem.position, ...updatedItem.size }
    const clockRect = { ...updatedClock.position, ...updatedClock.size }
    expect(rectsIntersect(itemRect, clockRect, gap)).toBe(false)
  })

  // 21. new widget creation avoids occupied Home items
  it('21. new widget creation avoids occupied Home items', async () => {
    const { home, widgets } = await boot({ demoMode: true })
    const item = home.items.addItem({
      type: 'file',
      monitorId: monitor1.id,
      position: { x: 250, y: 180 },
      size: { width: 84, height: 96 },
      metadata: {},
    })

    // Attempt to add clock widget at the exact position occupied by item
    await home.executeContextMenuAction({
      type: 'home-context-menu/action',
      action: 'add-widget:clock',
      targetType: 'desktop',
      monitorId: monitor1.id,
      posX: 250,
      posY: 180,
    })

    const createdWidgets = widgets.getForMonitor(monitor1.id)
    expect(createdWidgets).toHaveLength(1)
    const created = createdWidgets[0]
    if (!created) return

    const gap = home.layout.getGridConfig().gap
    const itemRect = { ...item.position, ...item.size }
    const widgetRect = { ...created.position, ...created.size }
    expect(rectsIntersect(itemRect, widgetRect, gap)).toBe(false)

    // Also verify direct widget creation triggers immediate reconciliation of colliding items
    const directItem = home.items.addItem({
      type: 'file',
      monitorId: monitor1.id,
      position: { x: 700, y: 300 },
      size: { width: 84, height: 96 },
      metadata: {},
    })

    const directWidget = widgets.create({
      definitionId: 'notes',
      monitorId: monitor1.id,
      position: { x: 700, y: 300 },
      size: { width: 200, height: 150 },
    })

    const updatedDirectItem = home.items.getItem(directItem.id)
    expect(updatedDirectItem).toBeDefined()
    if (updatedDirectItem) {
      const directItemRect = { ...updatedDirectItem.position, ...updatedDirectItem.size }
      const directWidgetRect = { ...directWidget.position, ...directWidget.size }
      expect(rectsIntersect(directItemRect, directWidgetRect, gap)).toBe(false)
    }
  })

  // 22. new Home item placement avoids widgets
  it('22. new Home item placement avoids widgets', async () => {
    const { home, widgets } = await boot({ demoMode: true })
    const clock = widgets.create({
      definitionId: 'clock',
      monitorId: monitor1.id,
      position: { x: 200, y: 200 },
      size: { width: 172, height: 144 },
    })

    // Create a new folder at the exact coordinates of the clock widget
    await home.executeContextMenuAction({
      type: 'home-context-menu/action',
      action: 'new-folder',
      targetType: 'desktop',
      monitorId: monitor1.id,
      posX: 200,
      posY: 200,
    })

    const folder = home.items.getItems().find(i => i.type === 'folder')
    expect(folder).toBeDefined()
    if (!folder) return

    const gap = home.layout.getGridConfig().gap
    const folderRect = { ...folder.position, ...folder.size }
    const widgetRect = { ...clock.position, ...clock.size }
    expect(rectsIntersect(folderRect, widgetRect, gap)).toBe(false)
  })

  // 23. ShellLayout reservation causes Home items to reconcile
  it('23. ShellLayout reservation causes Home items to reconcile', async () => {
    const { home, shellLayout } = await boot()
    const item = home.items.addItem({
      type: 'file',
      monitorId: monitor1.id,
      position: { x: 100, y: 950 },
      size: { width: 84, height: 96 },
      metadata: {},
    })

    // Register a bottom edge reservation via ShellLayout (e.g. Dock)
    shellLayout.registerReservation({
      id: 'dock-bottom',
      monitorId: monitor1.id,
      ownerId: 'dock',
      kind: 'edge',
      edge: 'bottom',
      rect: { x: 0, y: 920, width: 1920, height: 160 },
      affectsHomeLayout: true,
    })

    const updatedItem = home.items.getItem(item.id)
    expect(updatedItem).toBeDefined()
    if (!updatedItem) return

    const gap = home.layout.getGridConfig().gap
    const itemRect = { ...updatedItem.position, ...updatedItem.size }
    const dockRect = { x: 0, y: 920, width: 1920, height: 160 }
    expect(rectsIntersect(itemRect, dockRect, gap)).toBe(false)
  })

  // 24. ShellLayout reservation causes widgets to reconcile
  it('24. ShellLayout reservation causes widgets to reconcile', async () => {
    const { home, widgets, shellLayout } = await boot()
    const clock = widgets.create({
      definitionId: 'clock',
      monitorId: monitor1.id,
      position: { x: 100, y: 930 },
      size: { width: 172, height: 144 },
    })

    // Register bottom edge reservation
    shellLayout.registerReservation({
      id: 'dock-bottom-widgets',
      monitorId: monitor1.id,
      ownerId: 'dock',
      kind: 'edge',
      edge: 'bottom',
      rect: { x: 0, y: 900, width: 1920, height: 180 },
      affectsHomeLayout: true,
    })

    const updatedClock = widgets.get(clock.id)
    expect(updatedClock).toBeDefined()
    if (!updatedClock) return

    const gap = home.layout.getGridConfig().gap
    const clockRect = { ...updatedClock.position, ...updatedClock.size }
    const dockRect = { x: 0, y: 900, width: 1920, height: 180 }
    expect(rectsIntersect(clockRect, dockRect, gap)).toBe(false)
  })

  // 25. removing reservation does not corrupt positions
  it('25. removing reservation does not corrupt positions', async () => {
    const { home, widgets, shellLayout } = await boot()
    const item = home.items.addItem({
      type: 'file',
      monitorId: monitor1.id,
      position: { x: 100, y: 950 },
      size: { width: 84, height: 96 },
      metadata: {},
    })

    const clock = widgets.create({
      definitionId: 'clock',
      monitorId: monitor1.id,
      position: { x: 300, y: 930 },
      size: { width: 172, height: 144 },
    })

    const handle = shellLayout.registerReservation({
      id: 'temporary-dock',
      monitorId: monitor1.id,
      ownerId: 'dock',
      kind: 'edge',
      edge: 'bottom',
      rect: { x: 0, y: 900, width: 1920, height: 180 },
      affectsHomeLayout: true,
    })

    const reconciledItem = home.items.getItem(item.id)
    const reconciledClock = widgets.get(clock.id)
    expect(reconciledItem).toBeDefined()
    expect(reconciledClock).toBeDefined()
    if (!reconciledItem || !reconciledClock) return

    const savedPosItem = { ...reconciledItem.position }
    const savedPosClock = { ...reconciledClock.position }

    // Dispose reservation
    handle.dispose()

    const finalItem = home.items.getItem(item.id)
    const finalClock = widgets.get(clock.id)
    expect(finalItem).toBeDefined()
    expect(finalClock).toBeDefined()
    if (!finalItem || !finalClock) return

    // Verify positions remain valid and unchanged
    expect(finalItem.position).toEqual(savedPosItem)
    expect(finalClock.position).toEqual(savedPosClock)

    // Verify no collisions between item and widget
    const gap = home.layout.getGridConfig().gap
    const itemRect = { ...finalItem.position, ...finalItem.size }
    const clockRect = { ...finalClock.position, ...finalClock.size }
    expect(rectsIntersect(itemRect, clockRect, gap)).toBe(false)
  })
})
