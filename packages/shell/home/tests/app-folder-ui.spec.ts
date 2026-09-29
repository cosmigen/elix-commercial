import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { SurfaceService } from '@deepseek-ai/dsh-surface'
import HomePlugin, { HomeService, renderHomeRoot } from '../src/index.ts'
import { FolderManager } from '../src/folder.ts'
import { HomeItemManager } from '../src/items.ts'
import { parseHomeRendererIntent } from '../src/renderer-protocol.ts'
import type { MonitorInfo } from '../src/monitor.ts'
import { createMockSurfaceRuntime } from './test-runtime.ts'

describe('ELIX Phase 12 App Folder UI and In-WebView Overlay', () => {
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
    tempDir = await mkdtemp(join(tmpdir(), 'elix-home-app-folder-ui-test-'))
  })

  afterEach(async () => {
    while (contexts.length > 0) {
      const ctx = contexts.pop()!
      await ctx.fiber.dispose()
    }
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  })

  async function createTestHome(options: { initialMonitors?: MonitorInfo[] } = {}): Promise<{ ctx: Context; home: HomeService }> {
    const ctx = new Context()
    contexts.push(ctx)

    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const surfaceRuntime = createMockSurfaceRuntime()
    await ctx.plugin(SurfaceService, { enabled: true, bridge: surfaceRuntime.bridge })

    await ctx.plugin(HomePlugin, {
      enabled: true,
      autoShowOnReady: false,
      snapToGrid: false,
      debugExclusions: false,
      persistencePath: join(tempDir, 'home-state.json'),
      initialMonitors: options.initialMonitors ?? [monitor1],
    })

    const home: HomeService = ctx.home
    return { ctx, home }
  }

  describe('1. Renderer Protocol Intent Parsing', () => {
    it('parses openFolder intent', () => {
      const intent = parseHomeRendererIntent({ type: 'openFolder', folderId: 'folder-123' })
      expect(intent).toEqual({ type: 'openFolder', folderId: 'folder-123' })
    })

    it('parses closeFolder intent with or without folderId', () => {
      const intentWithId = parseHomeRendererIntent({ type: 'closeFolder', folderId: 'folder-123' })
      expect(intentWithId).toEqual({ type: 'closeFolder', folderId: 'folder-123' })

      const intentWithoutId = parseHomeRendererIntent({ type: 'closeFolder' })
      expect(intentWithoutId).toEqual({ type: 'closeFolder' })
    })

    it('parses resizeItem intent with positive dimensions', () => {
      expect(parseHomeRendererIntent({
        type: 'resizeItem',
        itemId: 'item-123',
        size: { width: 128, height: 144 },
      })).toEqual({
        type: 'resizeItem',
        itemId: 'item-123',
        size: { width: 128, height: 144 },
      })
      expect(() => parseHomeRendererIntent({
        type: 'resizeItem',
        itemId: 'item-123',
        size: { width: 0, height: 144 },
      })).toThrow(/size.width must be a positive finite dimension/)
    })

    it('parses reorderFolderItems intent', () => {
      const intent = parseHomeRendererIntent({
        type: 'reorderFolderItems',
        folderId: 'folder-123',
        itemIds: ['item-a', 'item-b', 'item-c'],
      })
      expect(intent).toEqual({
        type: 'reorderFolderItems',
        folderId: 'folder-123',
        itemIds: ['item-a', 'item-b', 'item-c'],
      })
    })

    it('rejects reorderFolderItems with non-array or oversized itemIds', () => {
      expect(() => parseHomeRendererIntent({
        type: 'reorderFolderItems',
        folderId: 'folder-123',
        itemIds: 'invalid',
      })).toThrow(/itemIds must be an array/)

      const oversized = new Array(300).fill('id')
      expect(() => parseHomeRendererIntent({
        type: 'reorderFolderItems',
        folderId: 'folder-123',
        itemIds: oversized,
      })).toThrow(/itemIds must be an array of at most 256/)
    })

    it('parses addItemToFolder, removeItemFromFolder, and deleteFolder intents', () => {
      const addIntent = parseHomeRendererIntent({
        type: 'addItemToFolder',
        folderId: 'folder-1',
        itemId: 'item-1',
      })
      expect(addIntent).toEqual({ type: 'addItemToFolder', folderId: 'folder-1', itemId: 'item-1' })

      const removeIntent = parseHomeRendererIntent({
        type: 'removeItemFromFolder',
        folderId: 'folder-1',
        itemId: 'item-1',
      })
      expect(removeIntent).toEqual({ type: 'removeItemFromFolder', folderId: 'folder-1', itemId: 'item-1' })

      const deleteIntent = parseHomeRendererIntent({
        type: 'deleteFolder',
        folderId: 'folder-1',
      })
      expect(deleteIntent).toEqual({ type: 'deleteFolder', folderId: 'folder-1' })
    })
  })

  describe('2. FolderManager Open/Close & Single Active Folder Invariant', () => {
    it('manages single active open folder', () => {
      const itemManager = new HomeItemManager()
      const folderManager = new FolderManager(itemManager)

      const f1 = folderManager.createFolder({
        position: { x: 40, y: 40 },
        name: 'Folder 1',
      })
      const f2 = folderManager.createFolder({
        position: { x: 140, y: 40 },
        name: 'Folder 2',
      })

      expect(folderManager.getOpenFolder()).toBeUndefined()

      // Open f1
      expect(folderManager.openFolder(f1.id)).toBe(true)
      expect(folderManager.getOpenFolder()?.id).toBe(f1.id)

      // Open f2 -> f1 automatically closed
      expect(folderManager.openFolder(f2.id)).toBe(true)
      expect(folderManager.getOpenFolder()?.id).toBe(f2.id)
      expect(folderManager.getFolder(f1.id)?.metadata.isOpen).toBe(false)

      // Close all
      expect(folderManager.closeFolder()).toBe(true)
      expect(folderManager.getOpenFolder()).toBeUndefined()
    })
  })

  describe('3. Snapshot Projection: App Folder vs Filesystem Folder', () => {
    it('projects folderChildren and distinguishes App Folder from Filesystem Folder', async () => {
      const { home } = await createTestHome()

      // Create two apps
      const app1 = home.items.addItem({
        type: 'shortcut',
        monitorId: 'mon-1',
        position: { x: 40, y: 40 },
        metadata: { name: 'App 1', target: 'app1.exe' },
      })
      const app2 = home.items.addItem({
        type: 'shortcut',
        monitorId: 'mon-1',
        position: { x: 40, y: 140 },
        metadata: { name: 'App 2', target: 'app2.exe' },
      })

      // Create App Folder with app1 and app2
      const appFolder = home.folders.createFolder({
        monitorId: 'mon-1',
        position: { x: 140, y: 40 },
        name: 'Utilities',
        color: 'sky',
        initialItemIds: [app1.id, app2.id],
      })

      // Create Filesystem Folder
      const fsFolder = home.items.addItem({
        type: 'folder',
        monitorId: 'mon-1',
        position: { x: 240, y: 40 },
        metadata: { name: 'Documents', color: 'amber', isFilesystem: true, itemIds: [] },
      })

      const snapshot = home.getRendererSnapshot('mon-1')
      expect(snapshot).toBeDefined()
      expect(snapshot.openFolderId).toBeUndefined()

      // App folder projection
      const projAppFolder = snapshot.items.find(it => it.id === appFolder.id)
      expect(projAppFolder).toBeDefined()
      expect(projAppFolder?.isFilesystemFolder).toBe(false)
      expect(projAppFolder?.isOpen).toBe(false)
      expect(projAppFolder?.folderChildren).toHaveLength(2)
      expect(projAppFolder?.folderChildren?.[0]?.label).toBe('App 1')
      expect(projAppFolder?.folderChildren?.[1]?.label).toBe('App 2')

      // Filesystem folder projection
      const projFsFolder = snapshot.items.find(it => it.id === fsFolder.id)
      expect(projFsFolder).toBeDefined()
      expect(projFsFolder?.isFilesystemFolder).toBe(true)
      expect(projFsFolder?.folderChildren).toBeUndefined()

      // When app folder is opened
      home.folders.openFolder(appFolder.id)
      const openSnapshot = home.getRendererSnapshot('mon-1')
      expect(openSnapshot.openFolderId).toBe(appFolder.id)
      const openAppFolder = openSnapshot.items.find(it => it.id === appFolder.id)
      expect(openAppFolder?.isOpen).toBe(true)
    })
  })

  describe('4. Renderer SSR HTML Generation', () => {
    it('resizes every desktop icon through the renderer intent path', async () => {
      const { home } = await createTestHome()
      const item = home.items.addItem({
        type: 'file',
        monitorId: 'mon-1',
        position: { x: 40, y: 40 },
        metadata: { name: 'Resizable document' },
      })

      await home.dispatchIntent('mon-1', {
        type: 'resizeItem',
        itemId: item.id,
        size: { width: 128, height: 144 },
      })

      expect(home.items.getItem(item.id)?.size).toEqual({ width: 128, height: 144 })
      expect(renderHomeRoot(home.getRendererSnapshot('mon-1'))).toContain('class="home-item-resize-handle"')
    })

    it('renders AppFolderPreview for app folders and classic SVG for filesystem folders', async () => {
      const { home } = await createTestHome()

      const app1 = home.items.addItem({
        type: 'shortcut',
        monitorId: 'mon-1',
        position: { x: 40, y: 40 },
        metadata: { name: 'Terminal', target: 'wt.exe' },
      })
      const appFolder = home.folders.createFolder({
        monitorId: 'mon-1',
        position: { x: 140, y: 40 },
        name: 'Dev Tools',
        color: 'mint',
        initialItemIds: [app1.id],
      })
      expect(appFolder.id).toBeDefined()
      home.items.addItem({
        type: 'folder',
        monitorId: 'mon-1',
        position: { x: 240, y: 40 },
        metadata: { name: 'Archive', color: 'rose', isFilesystem: true, itemIds: [] },
      })

      const snapshot = home.getRendererSnapshot('mon-1')
      const html = renderHomeRoot(snapshot)

      // AppFolderPreview markup
      expect(html).toContain('class="app-folder-preview app-folder-mint"')
      expect(html).toContain('class="app-folder-mini-icon"')
      expect(html).toContain('class="app-folder-mini-monogram"')
      expect(html).toContain('data-is-app-folder="true"')

      // Filesystem folder markup
      expect(html).toContain('class="folder-icon')
      expect(html).toContain('class="folder-svg"')
      expect(html).toContain('Archive')
      expect(html).not.toContain('data-item-id="item-mu121h8n-32dw5" data-is-app-folder')

      // No open folder overlay yet
      expect(html).not.toContain('id="app-folder-window"')
    })

    it('renders AppFolderOverlayView when an App Folder is open', async () => {
      const { home } = await createTestHome()

      const app1 = home.items.addItem({
        type: 'shortcut',
        monitorId: 'mon-1',
        position: { x: 40, y: 40 },
        metadata: { name: 'Calculator', target: 'calc.exe' },
      })
      const appFolder = home.folders.createFolder({
        monitorId: 'mon-1',
        position: { x: 140, y: 40 },
        name: 'Productivity',
        color: 'violet',
        initialItemIds: [app1.id],
      })

      home.folders.openFolder(appFolder.id)

      const snapshot = home.getRendererSnapshot('mon-1')
      const html = renderHomeRoot(snapshot)

      // AppFolderOverlayView markup
      expect(html).toContain('class="app-folder-overlay"')
      expect(html).toContain('id="app-folder-window"')
      expect(html).toContain('class="app-folder-window app-folder-violet"')
      expect(html).toContain('Productivity')
      expect(html).toContain('class="app-folder-name-input"')
      expect(html).toContain('data-folder-action="toggle-manage"')
      expect(html).toContain('data-folder-action="close"')
      expect(html).toContain('class="app-folder-page-frame"')
      expect(html).toContain('class="app-folder-app-grid"')
      expect(html).toContain('data-app-id="' + app1.id + '"')
      expect(html).toContain('Calculator')
      expect(html).toContain('data-folder-action="remove-app"')
      expect(html).toContain('data-folder-action="delete"')
      expect(html).toContain('class="app-folder-resize-grip"')
      expect(html).toContain('class="app-folder-resize-rail app-folder-resize-bottom"')
    })
  })

  describe('5. Intent Handling & Interaction Dispatch', () => {
    it('handles openFolder, closeFolder, and reorderFolderItems intents', async () => {
      const { home } = await createTestHome()

      const app1 = home.items.addItem({
        type: 'shortcut',
        monitorId: 'mon-1',
        position: { x: 40, y: 40 },
        metadata: { name: 'A', target: 'a.exe' },
      })
      const app2 = home.items.addItem({
        type: 'shortcut',
        monitorId: 'mon-1',
        position: { x: 40, y: 140 },
        metadata: { name: 'B', target: 'b.exe' },
      })
      const folder = home.folders.createFolder({
        monitorId: 'mon-1',
        position: { x: 140, y: 40 },
        name: 'Apps',
        initialItemIds: [app1.id, app2.id],
      })

      // Dispatch openFolder
      await home.dispatchIntent('mon-1', { type: 'openFolder', folderId: folder.id })
      expect(home.folders.getOpenFolder()?.id).toBe(folder.id)

      // Dispatch reorderFolderItems
      await home.dispatchIntent('mon-1', {
        type: 'reorderFolderItems',
        folderId: folder.id,
        itemIds: [app2.id, app1.id],
      })
      const updatedFolder = home.folders.getFolder(folder.id)
      expect(updatedFolder?.metadata.itemIds).toEqual([app2.id, app1.id])

      // Dispatch closeFolder
      await home.dispatchIntent('mon-1', { type: 'closeFolder', folderId: folder.id })
      expect(home.folders.getOpenFolder()).toBeUndefined()
    })

    it('handles addItemToFolder and removeItemFromFolder intents', async () => {
      const { home } = await createTestHome()

      const app1 = home.items.addItem({
        type: 'shortcut',
        monitorId: 'mon-1',
        position: { x: 40, y: 40 },
        metadata: { name: 'A', target: 'a.exe' },
      })
      const app2 = home.items.addItem({
        type: 'shortcut',
        monitorId: 'mon-1',
        position: { x: 40, y: 140 },
        metadata: { name: 'B', target: 'b.exe' },
      })
      const folder = home.folders.createFolder({
        monitorId: 'mon-1',
        position: { x: 140, y: 40 },
        name: 'Container',
        initialItemIds: [app1.id],
      })

      // Add app2 to folder via intent
      await home.dispatchIntent('mon-1', {
        type: 'addItemToFolder',
        folderId: folder.id,
        itemId: app2.id,
      })
      expect(home.folders.getFolder(folder.id)?.metadata.itemIds).toEqual([app1.id, app2.id])
      expect(home.items.getItem(app2.id)?.folderId).toBe(folder.id)

      // Remove app1 from folder via intent -> restored to root desktop
      await home.dispatchIntent('mon-1', {
        type: 'removeItemFromFolder',
        folderId: folder.id,
        itemId: app1.id,
      })
      expect(home.folders.getFolder(folder.id)?.metadata.itemIds).toEqual([app2.id])
      expect(home.items.getItem(app1.id)?.folderId).toBeUndefined()
      expect(home.items.getRootItemsForMonitor('mon-1').some(it => it.id === app1.id)).toBe(true)
    })

    it('handles deleteFolder intent', async () => {
      const { home } = await createTestHome()

      const app1 = home.items.addItem({
        type: 'shortcut',
        monitorId: 'mon-1',
        position: { x: 40, y: 40 },
        metadata: { name: 'A', target: 'a.exe' },
      })
      const folder = home.folders.createFolder({
        monitorId: 'mon-1',
        position: { x: 140, y: 40 },
        name: 'ToDelete',
        initialItemIds: [app1.id],
      })

      await home.dispatchIntent('mon-1', { type: 'deleteFolder', folderId: folder.id })
      expect(home.folders.getFolder(folder.id)).toBeUndefined()
      // Children dissolved back to desktop
      expect(home.items.getItem(app1.id)?.folderId).toBeUndefined()
      expect(home.items.getRootItemsForMonitor('mon-1').some(it => it.id === app1.id)).toBe(true)
    })

    it('activates App Folder directly into in-WebView overlay instead of opening filesystem folder', async () => {
      const { home, ctx } = await createTestHome()

      let externalRequestReceivedForFolder: string | undefined
      ctx.on('home/folder-open-requested', (folderId) => {
        externalRequestReceivedForFolder = folderId
      })

      const app = home.items.addItem({
        type: 'shortcut',
        monitorId: 'mon-1',
        position: { x: 40, y: 40 },
        metadata: { name: 'A', target: 'a.exe' },
      })
      const appFolder = home.folders.createFolder({
        monitorId: 'mon-1',
        position: { x: 140, y: 40 },
        name: 'App Group',
        initialItemIds: [app.id],
      })
      const fsFolder = home.items.addItem({
        type: 'folder',
        monitorId: 'mon-1',
        position: { x: 240, y: 40 },
        metadata: { name: 'FS Folder', isFilesystem: true, itemIds: [] },
      })

      // Activating App Folder opens it in in-WebView overlay (isOpen = true)
      await home.dispatchIntent('mon-1', { type: 'activate', itemId: appFolder.id })
      expect(home.folders.getOpenFolder()?.id).toBe(appFolder.id)

      // Close it
      home.folders.closeFolder()
      expect(home.folders.getOpenFolder()).toBeUndefined()

      // Activating Filesystem Folder does NOT open App Folder overlay, but emits external open request
      await home.dispatchIntent('mon-1', { type: 'activate', itemId: fsFolder.id })
      expect(home.folders.getOpenFolder()).toBeUndefined()
      expect(externalRequestReceivedForFolder).toBe(fsFolder.id)
    })
  })
})
