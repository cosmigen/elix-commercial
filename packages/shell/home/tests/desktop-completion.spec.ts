import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { SurfaceService } from '@deepseek-ai/dsh-surface'
import type { WindowsContextService } from '@deepseek-ai/dsh-windows-context'
import { WidgetService } from '@deepseek-ai/dsh-shell-widgets'
import OverlayService from '@deepseek-ai/dsh-shell-overlay'
import HomePlugin from '../src/index.ts'
import type { MonitorInfo } from '../src/monitor.ts'
import { createMockSurfaceRuntime } from './test-runtime.ts'

describe('Complete Home Desktop Features (Rename, Delete, Overlay Context Menu)', () => {
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

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'elix-home-completion-test-'))
  })

  afterEach(async () => {
    for (const ctx of contexts) {
      await ctx.fiber.dispose().catch(() => {})
    }
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  })

  async function boot() {
    const ctx = new Context()
    contexts.push(ctx)
    const runtime = createMockSurfaceRuntime()

    ctx.windowsContext = {
      getMonitors: () => [monitor1],
      getMonitor: () => monitor1,
      getPrimaryMonitor: () => monitor1,
    } as unknown as WindowsContextService

    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    await ctx.plugin(SurfaceService, { enabled: true, bridge: runtime.bridge })
    await ctx.plugin(WidgetService, { enabled: true })
    await ctx.plugin(OverlayService, { enabled: true })
    await ctx.plugin(HomePlugin, {
      enabled: true,
      persistencePath: join(tempDir, 'home-state.json'),
      initialMonitors: [monitor1],
    })

    return { ctx, home: ctx.home, widgets: ctx.widgets, overlay: ctx.overlay, runtime }
  }

  it('handles renameItem intent to perform inline rename of desktop items', async () => {
    const { home } = await boot()

    const item = home.items.addItem({
      type: 'file',
      monitorId: monitor1.id,
      position: { x: 100, y: 100 },
      metadata: { name: 'Document.txt' },
    })

    const initialMeta = home.items.getItem(item.id)?.metadata as Record<string, unknown> | undefined
    expect(initialMeta?.['name']).toBe('Document.txt')

    // Dispatch rename intent
    await home.dispatchIntent(monitor1.id, {
      type: 'renameItem',
      itemId: item.id,
      newName: 'Final Report.txt',
    })

    const renamedMeta = home.items.getItem(item.id)?.metadata as Record<string, unknown> | undefined
    expect(renamedMeta?.['name']).toBe('Final Report.txt')
  })

  it('handles deleteItem intent to remove items from desktop', async () => {
    const { home } = await boot()

    const item = home.items.addItem({
      type: 'file',
      monitorId: monitor1.id,
      position: { x: 120, y: 120 },
      metadata: { name: 'Temp.txt' },
    })

    expect(home.items.getItem(item.id)).toBeDefined()

    await home.dispatchIntent(monitor1.id, {
      type: 'deleteItem',
      itemId: item.id,
    })

    expect(home.items.getItem(item.id)).toBeUndefined()
  })

  it('does not open context menu for empty desktop right-click, but opens Overlay Core context menu for items', async () => {
    const { home, overlay } = await boot()

    const events: Array<{ position: { x: number; y: number }; targetType: string }> = []
    const unbind = home.onContextMenuRequest((req) => {
      events.push({ position: req.position, targetType: req.targetType })
    })

    // Right-click empty desktop: event emitted to listeners, but NO overlay instance is opened
    await home.dispatchIntent(monitor1.id, {
      type: 'contextMenu',
      targetType: 'desktop',
      position: { x: 350, y: 220 },
    })

    expect(events).toHaveLength(1)
    expect(events[0]?.position).toEqual({ x: 350, y: 220 })
    expect(events[0]?.targetType).toBe('desktop')
    expect(overlay.getActive().length).toBe(0)

    // Right-click desktop item: entity-specific overlay menu MUST open
    const item = home.items.addItem({
      type: 'file',
      monitorId: monitor1.id,
      position: { x: 300, y: 200 },
      metadata: { name: 'Report.txt' },
    })

    await home.dispatchIntent(monitor1.id, {
      type: 'contextMenu',
      targetType: 'item',
      itemId: item.id,
      position: { x: 350, y: 220 },
    })

    expect(events).toHaveLength(2)
    expect(events[1]?.targetType).toBe('item')

    const activeOverlays = overlay.getActive()
    expect(activeOverlays.length).toBeGreaterThanOrEqual(1)
    const menuOverlay = activeOverlays.find(o => o.definitionId === 'home-context-menu')
    expect(menuOverlay).toBeDefined()
    expect(menuOverlay?.actualBounds.x).toBe(350)
    unbind()
  })

  it('dismisses the context menu when an App Folder opens or Home restarts', async () => {
    const { home, overlay } = await boot()
    const item = home.items.addItem({
      type: 'file',
      monitorId: monitor1.id,
      position: { x: 300, y: 200 },
      metadata: { name: 'Report.txt' },
    })
    const folder = home.folders.createFolder({
      monitorId: monitor1.id,
      position: { x: 420, y: 200 },
      name: 'Utilities',
    })
    const openMenu = () => home.dispatchIntent(monitor1.id, {
      type: 'contextMenu',
      targetType: 'item',
      itemId: item.id,
      position: { x: 350, y: 220 },
    })

    await openMenu()
    expect(overlay.getActive()).toHaveLength(1)

    home.folders.openFolder(folder.id)
    await vi.waitFor(() => expect(overlay.getActive()).toHaveLength(0))

    await openMenu()
    expect(overlay.getActive()).toHaveLength(1)
    await home.restart()
    expect(overlay.getActive()).toHaveLength(0)
  })

  it('executes context menu actions through surface message dispatch', async () => {
    const { home, widgets } = await boot()

    // Simulate clicking "Add Clock Widget" from context menu
    await home.executeContextMenuAction({
      type: 'home-context-menu/action',
      action: 'add-widget:clock',
      targetType: 'desktop',
      monitorId: monitor1.id,
      posX: 250,
      posY: 180,
    })

    const instances = widgets.getForMonitor(monitor1.id)
    const clock = instances.find(w => w.definitionId === 'clock')
    expect(clock).toBeDefined()
    expect(clock?.position).toEqual({ x: 250, y: 180 })

    // Simulate clicking "New Folder"
    await home.executeContextMenuAction({
      type: 'home-context-menu/action',
      action: 'new-folder',
      targetType: 'desktop',
      monitorId: monitor1.id,
      posX: 100,
      posY: 100,
    })

    const folder = home.items.getItems().find(i => i.type === 'folder')
    expect(folder).toBeDefined()
    const folderMeta = folder?.metadata as Record<string, unknown> | undefined
    expect(folderMeta?.['name']).toBe('New Folder')
  })

  it('preserves item name if intent router rejects or returns failure on rename', async () => {
    const { ctx, home } = await boot()

    type MockRouterContext = {
      intentRouter?: {
        dispatch: ReturnType<typeof vi.fn>
      }
    }
    const routerCtx = ctx as unknown as MockRouterContext

    // Inject mock router that rejects
    routerCtx.intentRouter = {
      dispatch: vi.fn().mockRejectedValue(new Error('VFS write error')),
    }

    const item = home.items.addItem({
      type: 'file',
      monitorId: monitor1.id,
      position: { x: 50, y: 50 },
      metadata: { name: 'Important.txt' },
    })

    await home.dispatchIntent(monitor1.id, {
      type: 'renameItem',
      itemId: item.id,
      newName: 'Corrupted.txt',
    })

    // Name must be preserved as Important.txt
    const itemMeta = home.items.getItem(item.id)?.metadata as Record<string, unknown> | undefined
    expect(itemMeta?.['name']).toBe('Important.txt')

    // Also test router returning { success: false }
    routerCtx.intentRouter = {
      dispatch: vi.fn().mockResolvedValue({ success: false }),
    }

    await home.dispatchIntent(monitor1.id, {
      type: 'renameItem',
      itemId: item.id,
      newName: 'Rejected.txt',
    })

    const itemMeta2 = home.items.getItem(item.id)?.metadata as Record<string, unknown> | undefined
    expect(itemMeta2?.['name']).toBe('Important.txt')
  })

  it('preserves item if intent router rejects or returns failure on delete', async () => {
    const { ctx, home } = await boot()

    type MockRouterContext = {
      intentRouter?: {
        dispatch: ReturnType<typeof vi.fn>
      }
    }
    const routerCtx = ctx as unknown as MockRouterContext

    // Inject mock router that returns failure
    routerCtx.intentRouter = {
      dispatch: vi.fn().mockResolvedValue({ success: false }),
    }

    const item = home.items.addItem({
      type: 'file',
      monitorId: monitor1.id,
      position: { x: 80, y: 80 },
      metadata: { name: 'Protected.txt' },
    })

    await home.dispatchIntent(monitor1.id, {
      type: 'deleteItem',
      itemId: item.id,
    })

    // Item must not be deleted
    expect(home.items.getItem(item.id)).toBeDefined()

    // Router throwing error
    routerCtx.intentRouter = {
      dispatch: vi.fn().mockRejectedValue(new Error('Deletion permission denied')),
    }

    await home.dispatchIntent(monitor1.id, {
      type: 'deleteItem',
      itemId: item.id,
    })

    expect(home.items.getItem(item.id)).toBeDefined()
  })

  it('handles reset-position context menu action', async () => {
    const { home } = await boot()

    const item = home.items.addItem({
      type: 'file',
      monitorId: monitor1.id,
      position: { x: 800, y: 600 },
      metadata: { name: 'FarItem.txt' },
    })

    await home.executeContextMenuAction({
      type: 'home-context-menu/action',
      action: 'reset-position',
      targetType: 'item',
      itemId: item.id,
      monitorId: monitor1.id,
    })

    const resetItem = home.items.getItem(item.id)
    expect(resetItem?.position).toEqual({ x: 10, y: 10 })
  })

  it('handles cancelRename intent cleanly', async () => {
    const { home } = await boot()

    await expect(home.dispatchIntent(monitor1.id, {
      type: 'cancelRename',
    })).resolves.toBeUndefined()
  })
})
