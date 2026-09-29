import { describe, expect, it } from 'vitest'
import {
  FolderManager,
  HomeDragSession,
  HomeItemManager,
  HomeLayoutEngine,
} from '../src/index.ts'
import type { Rect } from '../src/index.ts'

describe('HomeDragSession', () => {
  const availableBounds: Rect = { x: 0, y: 0, width: 1920, height: 1080 }

  it('moves a single desktop item and updates its position on commit', () => {
    const itemManager = new HomeItemManager()
    const folderManager = new FolderManager(itemManager)
    const layoutEngine = new HomeLayoutEngine()

    const item = itemManager.addItem({
      id: 'item-1',
      type: 'shortcut',
      position: { x: 50, y: 50 },
      metadata: {},
    })

    const session = new HomeDragSession(
      {
        mode: 'move',
        primaryItemId: item.id,
        startPointer: { x: 55, y: 55 },
        monitorId: 'mon-1',
        availableBounds,
      },
      itemManager,
      folderManager,
      layoutEngine,
    )

    // Move pointer by +100px in X and Y
    session.updatePointer({ x: 155, y: 155 })
    expect(session.delta).toEqual({ x: 100, y: 100 })

    const result = session.commit()
    expect(result.type).toBe('moved')

    const moved = itemManager.getItem('item-1')
    expect(moved?.position.x).toBeGreaterThan(50)
    expect(moved?.position.y).toBeGreaterThan(50)
  })

  it('moves multiple selected items concurrently preserving relative offsets', () => {
    const itemManager = new HomeItemManager()
    const folderManager = new FolderManager(itemManager)
    const layoutEngine = new HomeLayoutEngine()

    itemManager.addItem({ id: 'item-a', type: 'shortcut', position: { x: 100, y: 100 }, metadata: {} })
    itemManager.addItem({ id: 'item-b', type: 'shortcut', position: { x: 200, y: 100 }, metadata: {} })

    const session = new HomeDragSession(
      {
        mode: 'move',
        primaryItemId: 'item-a',
        additionalItemIds: ['item-b'],
        startPointer: { x: 100, y: 100 },
        monitorId: 'mon-1',
        availableBounds,
      },
      itemManager,
      folderManager,
      layoutEngine,
    )

    session.updatePointer({ x: 150, y: 150 })
    const result = session.commit()
    expect(result.type).toBe('moved')

    const itemA = itemManager.getItem('item-a')
    const itemB = itemManager.getItem('item-b')

    expect(itemA).toBeDefined()
    expect(itemB).toBeDefined()
    // Both items shifted
    expect(itemA?.position.x).toBeGreaterThan(100)
    expect(itemB?.position.x).toBeGreaterThan(200)
  })

  it('detects folder hover and merges dropped items into the folder', () => {
    const itemManager = new HomeItemManager()
    const folderManager = new FolderManager(itemManager)
    const layoutEngine = new HomeLayoutEngine()

    const item = itemManager.addItem({
      id: 'dragged-doc',
      type: 'file',
      position: { x: 50, y: 50 },
      size: { width: 84, height: 96 },
      metadata: {},
    })

    const folder = folderManager.createFolder({
      position: { x: 200, y: 200 },
      name: 'Archive',
    })

    const session = new HomeDragSession(
      {
        mode: 'move',
        primaryItemId: item.id,
        startPointer: { x: 50, y: 50 },
        monitorId: 'mon-1',
        availableBounds,
      },
      itemManager,
      folderManager,
      layoutEngine,
    )

    // Move pointer so the dragged item overlaps the folder at (200, 200)
    const snapshot = session.updatePointer({ x: 210, y: 210 })
    expect(snapshot.isOverFolder).toBe(true)
    expect(snapshot.targetFolderId).toBe(folder.id)

    const result = session.commit()
    expect(result.type).toBe('folder_merged')

    // Document is now inside the folder
    const updatedFolder = folderManager.getFolder(folder.id)
    expect(updatedFolder?.metadata.itemIds).toContain('dragged-doc')
  })

  it('resizes widgets during resize drag mode', () => {
    const itemManager = new HomeItemManager()
    const folderManager = new FolderManager(itemManager)
    const layoutEngine = new HomeLayoutEngine()

    const widget = itemManager.addItem({
      id: 'widget-clock',
      type: 'widget',
      position: { x: 100, y: 100 },
      size: { width: 172, height: 144 },
      metadata: {},
    })

    const session = new HomeDragSession(
      {
        mode: 'resize',
        primaryItemId: widget.id,
        startPointer: { x: 272, y: 244 },
        monitorId: 'mon-1',
        availableBounds,
      },
      itemManager,
      folderManager,
      layoutEngine,
    )

    // Drag resize handle outwards by +100px width and +80px height
    session.updatePointer({ x: 372, y: 324 })
    const result = session.commit()
    expect(result.type).toBe('resized')

    const resizedWidget = itemManager.getItem('widget-clock')
    expect(resizedWidget?.size.width).toBeGreaterThan(172)
    expect(resizedWidget?.size.height).toBeGreaterThan(144)
  })

  it('restores original positions on drag cancellation', () => {
    const itemManager = new HomeItemManager()
    const folderManager = new FolderManager(itemManager)
    const layoutEngine = new HomeLayoutEngine()

    const item = itemManager.addItem({
      id: 'cancel-item',
      type: 'shortcut',
      position: { x: 120, y: 120 },
      metadata: {},
    })

    const session = new HomeDragSession(
      {
        mode: 'move',
        primaryItemId: item.id,
        startPointer: { x: 120, y: 120 },
        monitorId: 'mon-1',
        availableBounds,
      },
      itemManager,
      folderManager,
      layoutEngine,
    )

    session.updatePointer({ x: 400, y: 400 })
    session.cancel()

    expect(itemManager.getItem('cancel-item')?.position).toEqual({ x: 120, y: 120 })
  })

  it('handles external file drop onto the desktop canvas', () => {
    const itemManager = new HomeItemManager()
    const folderManager = new FolderManager(itemManager)
    const layoutEngine = new HomeLayoutEngine()

    const session = new HomeDragSession(
      {
        mode: 'external_drop',
        startPointer: { x: 300, y: 300 },
        monitorId: 'mon-1',
        availableBounds,
        externalData: {
          name: 'Budget.xlsx',
          path: '/home/user/Documents/Budget.xlsx',
          type: 'file',
        },
      },
      itemManager,
      folderManager,
      layoutEngine,
    )

    const result = session.commit()
    expect(result.type).toBe('external_dropped')
    if (result.type === 'external_dropped') {
      expect(result.item.type).toBe('file')
      expect((result.item.metadata as unknown as { name: string }).name).toBe('Budget.xlsx')
      expect(itemManager.getItem(result.item.id)).toBeDefined()
    }
  })

  it('handles external file drop directly into an existing folder', () => {
    const itemManager = new HomeItemManager()
    const folderManager = new FolderManager(itemManager)
    const layoutEngine = new HomeLayoutEngine()

    const folder = folderManager.createFolder({
      position: { x: 200, y: 200 },
      name: 'Receipts',
    })

    const session = new HomeDragSession(
      {
        mode: 'external_drop',
        startPointer: { x: 10, y: 10 },
        monitorId: 'mon-1',
        availableBounds,
        externalData: {
          name: 'Invoice.pdf',
          path: '/home/user/Downloads/Invoice.pdf',
          type: 'file',
        },
      },
      itemManager,
      folderManager,
      layoutEngine,
    )

    // Move pointer over folder
    const snapshot = session.updatePointer({ x: 210, y: 210 })
    expect(snapshot.isOverFolder).toBe(true)
    expect(snapshot.targetFolderId).toBe(folder.id)

    const result = session.commit()
    expect(result.type).toBe('external_dropped')
    if (result.type === 'external_dropped') {
      expect(result.targetFolderId).toBe(folder.id)
      const updatedFolder = folderManager.getFolder(folder.id)
      expect(updatedFolder?.metadata.itemIds).toContain(result.item.id)
      expect(result.item.folderId).toBe(folder.id)
    }
  })

  it('correctly checks collision against destination monitor items when moving across monitors', () => {
    const itemManager = new HomeItemManager()
    const folderManager = new FolderManager(itemManager)
    const layoutEngine = new HomeLayoutEngine()

    // Item 1 on monitor 1
    const item1 = itemManager.addItem({
      id: 'item-m1',
      type: 'shortcut',
      monitorId: 'mon-1',
      position: { x: 50, y: 50 },
      metadata: {},
    })

    // Item 2 already occupying (1940, 50) on monitor 2
    const mon2Bounds: Rect = { x: 1920, y: 0, width: 1920, height: 1080 }
    itemManager.addItem({
      id: 'item-m2-existing',
      type: 'widget',
      monitorId: 'mon-2',
      position: { x: 1936, y: 16 },
      size: { width: 84, height: 96 },
      metadata: {},
    })

    // Drag item 1 from monitor 1 to monitor 2, dropping right on top of item-m2-existing
    const session = new HomeDragSession(
      {
        mode: 'move',
        primaryItemId: item1.id,
        startPointer: { x: 50, y: 50 },
        monitorId: 'mon-2',
        availableBounds: mon2Bounds,
      },
      itemManager,
      folderManager,
      layoutEngine,
    )

    session.updatePointer({ x: 1936, y: 16 })
    const result = session.commit()
    expect(result.type).toBe('moved')

    const moved = itemManager.getItem('item-m1')
    expect(moved?.monitorId).toBe('mon-2')
    // Collision detected on mon-2, so placed at a free slot, not overlapping item-m2-existing
    expect(moved?.position.x).toBeGreaterThanOrEqual(1920)
    const overlaps = moved?.position.x === 1936 && moved?.position.y === 16
    expect(overlaps).toBe(false)
  })
})
