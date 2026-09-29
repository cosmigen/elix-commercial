import { describe, expect, it } from 'vitest'
import { FolderManager, HomeItemManager } from '../src/index.ts'
import type { ShortcutMetadata } from '../src/index.ts'

describe('HomeItemManager', () => {
  it('supports item CRUD operations', () => {
    const itemManager = new HomeItemManager()

    const item = itemManager.addItem<ShortcutMetadata>({
      id: 'app-terminal',
      type: 'shortcut',
      monitorId: 'primary',
      position: { x: 100, y: 150 },
      metadata: {
        name: 'Terminal',
        icon: 'terminal.svg',
        target: 'wt.exe',
      },
    })

    expect(item.id).toBe('app-terminal')
    expect(item.position).toEqual({ x: 100, y: 150 })
    expect(item.metadata.name).toBe('Terminal')

    // Move item
    const moved = itemManager.moveItem('app-terminal', { x: 250, y: 300 })
    expect(moved?.position).toEqual({ x: 250, y: 300 })

    // Resize item
    const resized = itemManager.resizeItem('app-terminal', { width: 96, height: 110 })
    expect(resized?.size).toEqual({ width: 96, height: 110 })

    // Update metadata
    const updated = itemManager.updateMetadata<ShortcutMetadata>('app-terminal', {
      name: 'PowerShell Terminal',
    })
    expect(updated?.metadata.name).toBe('PowerShell Terminal')

    // Remove item
    expect(itemManager.removeItem('app-terminal')).toBe(true)
    expect(itemManager.getItem('app-terminal')).toBeUndefined()
  })

  it('filters items by monitor', () => {
    const itemManager = new HomeItemManager()
    itemManager.addItem({
      id: 'item-1',
      type: 'shortcut',
      monitorId: 'mon-left',
      position: { x: 10, y: 10 },
      metadata: {},
    })
    itemManager.addItem({
      id: 'item-2',
      type: 'file',
      monitorId: 'mon-right',
      position: { x: 20, y: 20 },
      metadata: {},
    })

    expect(itemManager.getItemsForMonitor('mon-left')).toHaveLength(1)
    expect(itemManager.getItemsForMonitor('mon-right')).toHaveLength(1)
    expect(itemManager.getItemsForMonitor('mon-other')).toHaveLength(0)
  })
})

describe('FolderManager', () => {
  it('creates folders with sequential default names and assigns theme colors', () => {
    const itemManager = new HomeItemManager()
    const folderManager = new FolderManager(itemManager)

    const folder1 = folderManager.createFolder({
      position: { x: 50, y: 50 },
      color: 'mint',
    })
    expect(folder1.metadata.name).toBe('New Folder')
    expect(folder1.metadata.color).toBe('mint')
    expect(folder1.metadata.itemIds).toEqual([])

    const folder2 = folderManager.createFolder({
      position: { x: 150, y: 50 },
      color: 'violet',
    })
    expect(folder2.metadata.name).toBe('New Folder (2)')
    expect(folder2.metadata.color).toBe('violet')
  })

  it('manages folder membership: adding, removing, and reordering items', () => {
    const itemManager = new HomeItemManager()
    const folderManager = new FolderManager(itemManager)

    const itemA = itemManager.addItem({
      id: 'app-a',
      type: 'shortcut',
      position: { x: 10, y: 10 },
      metadata: {},
    })
    const itemB = itemManager.addItem({
      id: 'app-b',
      type: 'shortcut',
      position: { x: 20, y: 20 },
      metadata: {},
    })

    const folder = folderManager.createFolder({
      position: { x: 200, y: 200 },
      name: 'Productivity',
    })

    // Add items to folder
    expect(folderManager.addItemToFolder(folder.id, itemA.id)).toBe(true)
    expect(folderManager.addItemToFolder(folder.id, itemB.id)).toBe(true)

    const updatedFolder = folderManager.getFolder(folder.id)
    expect(updatedFolder?.metadata.itemIds).toEqual(['app-a', 'app-b'])
    expect(folderManager.getFolderContainingItem('app-a')?.id).toBe(folder.id)

    // Reorder items
    folderManager.reorderFolderItems(folder.id, ['app-b', 'app-a'])
    expect(folderManager.getFolder(folder.id)?.metadata.itemIds).toEqual(['app-b', 'app-a'])

    // Remove item from folder back to desktop
    expect(folderManager.removeItemFromFolder(folder.id, 'app-a', { x: 300, y: 300 })).toBe(true)
    expect(folderManager.getFolder(folder.id)?.metadata.itemIds).toEqual(['app-b'])
    expect(itemManager.getItem('app-a')?.position).toEqual({ x: 300, y: 300 })
  })

  it('prevents folder from containing itself', () => {
    const itemManager = new HomeItemManager()
    const folderManager = new FolderManager(itemManager)

    const folder = folderManager.createFolder({
      position: { x: 100, y: 100 },
    })

    expect(folderManager.addItemToFolder(folder.id, folder.id)).toBe(false)
  })

  it('dissolves folder and restores contained items to desktop', () => {
    const itemManager = new HomeItemManager()
    const folderManager = new FolderManager(itemManager)

    itemManager.addItem({ id: 'item-1', type: 'shortcut', position: { x: 0, y: 0 }, metadata: {} })
    itemManager.addItem({ id: 'item-2', type: 'shortcut', position: { x: 0, y: 0 }, metadata: {} })

    const folder = folderManager.createFolder({
      position: { x: 500, y: 500 },
      initialItemIds: ['item-1', 'item-2'],
    })

    expect(folderManager.dissolveFolder(folder.id)).toBe(true)
    expect(folderManager.getFolder(folder.id)).toBeUndefined()
    expect(itemManager.getItem('item-1')).toBeDefined()
    expect(itemManager.getItem('item-2')).toBeDefined()
  })

  it('emits open request intent without rendering any visual modal (Phase 2 boundary)', () => {
    const itemManager = new HomeItemManager()
    const folderManager = new FolderManager(itemManager)

    const folder = folderManager.createFolder({
      position: { x: 100, y: 100 },
    })

    let requestedFolderId: string | null = null
    const unbind = folderManager.onFolderOpenRequest((id) => {
      requestedFolderId = id
    })

    // Calling requestOpenFolder emits the intent to listeners
    expect(folderManager.requestOpenFolder(folder.id)).toBe(true)
    expect(requestedFolderId).toBe(folder.id)

    unbind()
  })

  it('filters root items excluding items contained inside folders', () => {
    const itemManager = new HomeItemManager()
    const folderManager = new FolderManager(itemManager)

    itemManager.addItem({
      id: 'doc-root',
      type: 'file',
      monitorId: 'mon-1',
      position: { x: 50, y: 50 },
      metadata: { name: 'Root File' },
    })

    const folder = folderManager.createFolder({
      position: { x: 100, y: 100 },
      monitorId: 'mon-1',
      name: 'Docs',
    })

    const insideDoc = itemManager.addItem({
      id: 'doc-inside',
      type: 'file',
      monitorId: 'mon-1',
      position: { x: 0, y: 0 },
      metadata: { name: 'Inside File' },
    })

    folderManager.addItemToFolder(folder.id, insideDoc.id)

    const allItems = itemManager.getItems()
    expect(allItems).toHaveLength(3) // rootDoc, folder, insideDoc

    const rootItems = itemManager.getRootItems()
    expect(rootItems.map(i => i.id)).toEqual(expect.arrayContaining(['doc-root', folder.id]))
    expect(rootItems.map(i => i.id)).not.toContain('doc-inside')

    const rootForMon = itemManager.getRootItemsForMonitor('mon-1')
    expect(rootForMon.map(i => i.id)).toEqual(expect.arrayContaining(['doc-root', folder.id]))
    expect(rootForMon.map(i => i.id)).not.toContain('doc-inside')
  })

  it('migrates and clamps items to the primary monitor when a monitor is disconnected', () => {
    const itemManager = new HomeItemManager()

    // Item placed far off on a secondary monitor
    itemManager.addItem({
      id: 'item-secondary',
      type: 'shortcut',
      monitorId: 'mon-secondary',
      position: { x: 2500, y: 1200 },
      size: { width: 84, height: 96 },
      metadata: { name: 'Secondary App' },
    })

    // Now disconnect secondary monitor: only primary monitor remains
    const activeMonitors = [
      {
        id: 'mon-primary',
        name: 'Primary Display',
        isPrimary: true,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        workArea: { x: 0, y: 0, width: 1920, height: 1040 },
        scaleFactor: 1,
      },
    ]

    const changed = itemManager.clampItemsToMonitors(activeMonitors, 'mon-primary')
    expect(changed).toBe(true)

    const item = itemManager.getItem('item-secondary')
    expect(item?.monitorId).toBe('mon-primary')
    // Must be clamped within primary monitor bounds
    expect(item?.position.x).toBeLessThanOrEqual(1920 - 84)
    expect(item?.position.y).toBeLessThanOrEqual(1080 - 96)
  })

  it('cleans up folder membership reciprocally when a contained item is removed', () => {
    const itemManager = new HomeItemManager()
    const folderManager = new FolderManager(itemManager)

    const item = itemManager.addItem({
      id: 'item-to-delete',
      type: 'file',
      position: { x: 0, y: 0 },
      metadata: {},
    })

    const folder = folderManager.createFolder({
      position: { x: 50, y: 50 },
      initialItemIds: [item.id],
    })

    expect(folder.metadata.itemIds).toContain(item.id)

    // Remove item directly from itemManager
    itemManager.removeItem(item.id)

    const updatedFolder = folderManager.getFolder(folder.id)
    expect(updatedFolder?.metadata.itemIds).not.toContain(item.id)
  })
})
