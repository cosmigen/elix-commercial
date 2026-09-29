import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { SurfaceService } from '@deepseek-ai/dsh-surface'
import type { WindowsContextService } from '@deepseek-ai/dsh-windows-context'
import { WidgetService } from '@deepseek-ai/dsh-shell-widgets'
import HomePlugin from '../src/index.ts'
import {
  FOLDER_ARM_DELAY_MS,
  HomeDragSession,
  INNER_HOTSPOT_RATIO,
  getItemInnerHotspot,
} from '../src/drag-drop.ts'
import { FolderManager } from '../src/folder.ts'
import { HomeItemManager } from '../src/items.ts'
import { HomeLayoutEngine } from '../src/layout.ts'
import type { MonitorInfo } from '../src/monitor.ts'
import type { Rect } from '../src/types.ts'
import { createMockSurfaceRuntime } from './test-runtime.ts'

describe('Phase 12 Desktop Drag-to-Create Folder (Intent-Aware UX)', () => {
  let tempDir: string
  const contexts: Context[] = []

  const availableBounds: Rect = { x: 0, y: 0, width: 1920, height: 1080 }

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

  const negativeMonitor: MonitorInfo = {
    id: 'mon-neg',
    name: 'Left Display',
    bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
    workArea: { x: -1920, y: 0, width: 1920, height: 1040 },
    scaleFactor: 1.0,
    isPrimary: false,
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'elix-home-drag-folder-test-'))
  })

  afterEach(async () => {
    for (const ctx of contexts) {
      await ctx.fiber.dispose().catch(() => {})
    }
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  })

  // 1. Drag A between B and C: no folder created
  it('1. Drag A between B and C: no folder created, normal placement occurs', () => {
    const itemManager = new HomeItemManager()
    const folderManager = new FolderManager(itemManager)
    const layoutEngine = new HomeLayoutEngine()

    const itemA = itemManager.addItem({
      id: 'item-a',
      type: 'shortcut',
      monitorId: 'mon-1',
      position: { x: 0, y: 100 },
      size: { width: 84, height: 96 },
      metadata: { name: 'App A' },
    })
    itemManager.addItem({
      id: 'item-b',
      type: 'shortcut',
      monitorId: 'mon-1',
      position: { x: 100, y: 100 },
      size: { width: 84, height: 96 },
      metadata: { name: 'App B' },
    })
    itemManager.addItem({
      id: 'item-c',
      type: 'shortcut',
      monitorId: 'mon-1',
      position: { x: 300, y: 100 },
      size: { width: 84, height: 96 },
      metadata: { name: 'App C' },
    })

    const session = new HomeDragSession(
      {
        mode: 'move',
        primaryItemId: itemA.id,
        startPointer: { x: 42, y: 148 },
        monitorId: 'mon-1',
        availableBounds,
      },
      itemManager,
      folderManager,
      layoutEngine,
    )

    // Move pointer to (200, 148) which is between B and C
    const snap = session.updatePointer({ x: 200, y: 148 })
    expect(snap.dropTarget.type).toBe('none')
    expect(session.getTargetState()).toBe('normal')

    const result = session.commit()
    expect(result.type).toBe('moved')
    expect(folderManager.getFolders()).toHaveLength(0)
    expect(itemManager.getItem('item-a')?.position).toBeDefined()
  })

  // 2. Drag A briefly over B: no folder
  it('2. Drag A briefly over B: no folder created on rapid pass', () => {
    const itemManager = new HomeItemManager()
    const folderManager = new FolderManager(itemManager)
    const layoutEngine = new HomeLayoutEngine()

    const itemA = itemManager.addItem({
      id: 'item-a',
      type: 'shortcut',
      monitorId: 'mon-1',
      position: { x: 100, y: 100 },
      size: { width: 84, height: 96 },
      metadata: { name: 'App A' },
    })
    itemManager.addItem({
      id: 'item-b',
      type: 'shortcut',
      monitorId: 'mon-1',
      position: { x: 300, y: 200 },
      size: { width: 84, height: 96 },
      metadata: { name: 'App B' },
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

    // Briefly enter B hotspot for 100ms
    session.updatePointer({ x: 342, y: 248 }, { timestamp: 1000 })
    const snap = session.updatePointer({ x: 342, y: 248 }, { timestamp: 1100 })
    expect(snap.dropTarget.type).toBe('create-folder')
    if (snap.dropTarget.type === 'create-folder') {
      expect(snap.dropTarget.armed).toBe(false)
    }
    expect(session.getTargetState()).toBe('potential')

    // Commit before dwell threshold -> normal move wins
    const result = session.commit()
    expect(result.type).toBe('moved')
    expect(folderManager.getFolders()).toHaveLength(0)
    expect(itemManager.getItem('item-a')?.folderId).toBeUndefined()
  })

  // 3. Drag A into B hotspot for less than arm delay: no folder
  it('3. Drag A into B hotspot for less than arm delay: no folder', () => {
    const itemManager = new HomeItemManager()
    const folderManager = new FolderManager(itemManager)
    const layoutEngine = new HomeLayoutEngine()

    const itemA = itemManager.addItem({
      id: 'item-a',
      type: 'shortcut',
      monitorId: 'mon-1',
      position: { x: 100, y: 100 },
      size: { width: 84, height: 96 },
      metadata: {},
    })
    itemManager.addItem({
      id: 'item-b',
      type: 'shortcut',
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

    // 590 ms elapsed < FOLDER_ARM_DELAY_MS (600ms)
    session.updatePointer({ x: 342, y: 248 }, { timestamp: 1000 })
    const snap = session.updatePointer({ x: 342, y: 248 }, { timestamp: 1000 + FOLDER_ARM_DELAY_MS - 10 })
    expect(snap.dropTarget.type).toBe('create-folder')
    if (snap.dropTarget.type === 'create-folder') {
      expect(snap.dropTarget.armed).toBe(false)
    }

    const result = session.commit()
    expect(result.type).toBe('moved')
    expect(folderManager.getFolders()).toHaveLength(0)
  })

  // 4. Drag A into B hotspot and hold beyond threshold: target becomes armed
  it('4. Drag A into B hotspot and hold beyond threshold: target becomes armed', () => {
    const itemManager = new HomeItemManager()
    const folderManager = new FolderManager(itemManager)
    const layoutEngine = new HomeLayoutEngine()

    const itemA = itemManager.addItem({
      id: 'item-a',
      type: 'shortcut',
      monitorId: 'mon-1',
      position: { x: 100, y: 100 },
      size: { width: 84, height: 96 },
      metadata: {},
    })
    itemManager.addItem({
      id: 'item-b',
      type: 'shortcut',
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

    session.updatePointer({ x: 342, y: 248 }, { timestamp: 1000 })
    expect(session.getTargetState()).toBe('potential')

    // At exactly 600ms
    const snap = session.updatePointer({ x: 342, y: 248 }, { timestamp: 1000 + FOLDER_ARM_DELAY_MS })
    expect(snap.dropTarget.type).toBe('create-folder')
    if (snap.dropTarget.type === 'create-folder') {
      expect(snap.dropTarget.armed).toBe(true)
      expect(snap.dropTarget.targetItemId).toBe('item-b')
    }
    expect(session.getTargetState()).toBe('armed')
    session.dispose()
  })

  // 5. Drop after armed: exactly one new folder
  it('5. Drop after armed: creates exactly one new folder', () => {
    const itemManager = new HomeItemManager()
    const folderManager = new FolderManager(itemManager)
    const layoutEngine = new HomeLayoutEngine()

    const itemA = itemManager.addItem({
      id: 'item-a',
      type: 'shortcut',
      monitorId: 'mon-1',
      position: { x: 100, y: 100 },
      size: { width: 84, height: 96 },
      metadata: { name: 'App A' },
    })
    itemManager.addItem({
      id: 'item-b',
      type: 'shortcut',
      monitorId: 'mon-1',
      position: { x: 300, y: 200 },
      size: { width: 84, height: 96 },
      metadata: { name: 'App B' },
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

    session.updatePointer({ x: 342, y: 248 }, { timestamp: 1000 })
    session.updatePointer({ x: 342, y: 248 }, { timestamp: 1000 + FOLDER_ARM_DELAY_MS })
    const result = session.commit()

    expect(result.type).toBe('folder_created')
    expect(folderManager.getFolders()).toHaveLength(1)
  })

  // 6. New folder contains exactly A + B
  it('6. New folder contains exactly A + B and removes them from root desktop items', () => {
    const itemManager = new HomeItemManager()
    const folderManager = new FolderManager(itemManager)
    const layoutEngine = new HomeLayoutEngine()

    const itemA = itemManager.addItem({
      id: 'item-a',
      type: 'shortcut',
      monitorId: 'mon-1',
      position: { x: 100, y: 100 },
      size: { width: 84, height: 96 },
      metadata: { name: 'App A' },
    })
    itemManager.addItem({
      id: 'item-b',
      type: 'shortcut',
      monitorId: 'mon-1',
      position: { x: 300, y: 200 },
      size: { width: 84, height: 96 },
      metadata: { name: 'App B' },
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

    session.updatePointer({ x: 342, y: 248 }, { forceArm: true })
    const result = session.commit()
    expect(result.type).toBe('folder_created')
    if (result.type === 'folder_created') {
      expect(result.itemIds).toEqual(['item-b', 'item-a'])
      expect(result.folder.metadata.itemIds).toEqual(['item-b', 'item-a'])
    }

    // Underlying items are preserved with folderId
    expect(itemManager.getItem('item-a')?.folderId).toBeDefined()
    expect(itemManager.getItem('item-b')?.folderId).toBeDefined()

    // Root items only contain the new folder
    const rootItems = itemManager.getRootItemsForMonitor('mon-1')
    expect(rootItems.map(i => i.id)).not.toContain('item-a')
    expect(rootItems.map(i => i.id)).not.toContain('item-b')
    expect(rootItems.some(i => i.type === 'folder')).toBe(true)
  })

  // 7. New folder appears at deterministic B location
  it('7. New folder appears at deterministic B location', () => {
    const itemManager = new HomeItemManager()
    const folderManager = new FolderManager(itemManager)
    const layoutEngine = new HomeLayoutEngine()

    const itemA = itemManager.addItem({
      id: 'item-a',
      type: 'shortcut',
      monitorId: 'mon-1',
      position: { x: 100, y: 100 },
      metadata: {},
    })
    itemManager.addItem({
      id: 'item-b',
      type: 'shortcut',
      monitorId: 'mon-1',
      position: { x: 420, y: 310 },
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

    session.updatePointer({ x: 462, y: 358 }, { forceArm: true })
    const result = session.commit()
    expect(result.type).toBe('folder_created')
    if (result.type === 'folder_created') {
      expect(result.folder.position).toEqual({ x: 420, y: 310 })
      expect(result.folder.monitorId).toBe('mon-1')
    }
  })

  // 8. Move away after target armed: arm state cancelled
  it('8. Move away after target armed: arm state cancelled and normal move restored', () => {
    const itemManager = new HomeItemManager()
    const folderManager = new FolderManager(itemManager)
    const layoutEngine = new HomeLayoutEngine()

    const itemA = itemManager.addItem({
      id: 'item-a',
      type: 'shortcut',
      monitorId: 'mon-1',
      position: { x: 100, y: 100 },
      metadata: {},
    })
    itemManager.addItem({
      id: 'item-b',
      type: 'shortcut',
      monitorId: 'mon-1',
      position: { x: 300, y: 200 },
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

    // Arm target B
    session.updatePointer({ x: 342, y: 248 }, { timestamp: 1000 })
    session.updatePointer({ x: 342, y: 248 }, { timestamp: 1700 })
    expect(session.getTargetState()).toBe('armed')

    // Move pointer away to empty space (600, 400)
    const snap = session.updatePointer({ x: 600, y: 400 }, { timestamp: 1800 })
    expect(snap.dropTarget.type).toBe('none')
    expect(session.getTargetState()).toBe('normal')

    const result = session.commit()
    expect(result.type).toBe('moved')
    expect(folderManager.getFolders()).toHaveLength(0)
  })

  // 9. Move from B target to C target: B timer cancelled, C gets new timer
  it('9. Move from B target to C target: B timer cancelled and C gets new timer', () => {
    const itemManager = new HomeItemManager()
    const folderManager = new FolderManager(itemManager)
    const layoutEngine = new HomeLayoutEngine()

    const itemA = itemManager.addItem({
      id: 'item-a',
      type: 'shortcut',
      monitorId: 'mon-1',
      position: { x: 100, y: 100 },
      metadata: {},
    })
    itemManager.addItem({
      id: 'item-b',
      type: 'shortcut',
      monitorId: 'mon-1',
      position: { x: 300, y: 200 },
      metadata: {},
    })
    itemManager.addItem({
      id: 'item-c',
      type: 'shortcut',
      monitorId: 'mon-1',
      position: { x: 600, y: 200 },
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

    // Enter B at t=1000
    session.updatePointer({ x: 342, y: 248 }, { timestamp: 1000 })
    expect(session.getTargetState()).toBe('potential')

    // Move to C at t=1300 (only 300ms on B)
    const snapC1 = session.updatePointer({ x: 642, y: 248 }, { timestamp: 1300 })
    expect(snapC1.dropTarget.type).toBe('create-folder')
    if (snapC1.dropTarget.type === 'create-folder') {
      expect(snapC1.dropTarget.targetItemId).toBe('item-c')
      expect(snapC1.dropTarget.armed).toBe(false)
    }

    // At t=1600 (only 300ms on C, less than 600ms): not armed yet
    const snapC2 = session.updatePointer({ x: 642, y: 248 }, { timestamp: 1600 })
    if (snapC2.dropTarget.type === 'create-folder') {
      expect(snapC2.dropTarget.armed).toBe(false)
    }

    // At t=1900 (600ms on C): armed!
    const snapC3 = session.updatePointer({ x: 642, y: 248 }, { timestamp: 1900 })
    if (snapC3.dropTarget.type === 'create-folder') {
      expect(snapC3.dropTarget.armed).toBe(true)
      expect(snapC3.dropTarget.targetItemId).toBe('item-c')
    }
    session.dispose()
  })

  // 10. Cancel drag: no folder created
  it('10. Cancel drag: no folder created and original positions restored', () => {
    const itemManager = new HomeItemManager()
    const folderManager = new FolderManager(itemManager)
    const layoutEngine = new HomeLayoutEngine()

    const itemA = itemManager.addItem({
      id: 'item-a',
      type: 'shortcut',
      monitorId: 'mon-1',
      position: { x: 100, y: 100 },
      metadata: {},
    })
    itemManager.addItem({
      id: 'item-b',
      type: 'shortcut',
      monitorId: 'mon-1',
      position: { x: 300, y: 200 },
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

    // Arm target
    session.updatePointer({ x: 342, y: 248 }, { forceArm: true })
    expect(session.getTargetState()).toBe('armed')

    // Cancel drag gesture (Escape / pointercancel)
    session.cancel()

    expect(session.getTargetState()).toBe('normal')
    expect(folderManager.getFolders()).toHaveLength(0)
    expect(itemManager.getItem('item-a')?.position).toEqual({ x: 100, y: 100 })
  })

  // 11. Multi-select A+C -> B: folder contains A+B+C
  it('11. Multi-select A+C -> B: folder contains A+B+C at B position', () => {
    const itemManager = new HomeItemManager()
    const folderManager = new FolderManager(itemManager)
    const layoutEngine = new HomeLayoutEngine()

    const itemA = itemManager.addItem({
      id: 'item-a',
      type: 'shortcut',
      monitorId: 'mon-1',
      position: { x: 100, y: 100 },
      metadata: {},
    })
    const itemC = itemManager.addItem({
      id: 'item-c',
      type: 'file',
      monitorId: 'mon-1',
      position: { x: 100, y: 220 },
      metadata: {},
    })
    itemManager.addItem({
      id: 'item-b',
      type: 'shortcut',
      monitorId: 'mon-1',
      position: { x: 400, y: 200 },
      metadata: {},
    })

    const session = new HomeDragSession(
      {
        mode: 'move',
        primaryItemId: itemA.id,
        additionalItemIds: [itemC.id],
        startPointer: { x: 142, y: 148 },
        monitorId: 'mon-1',
        availableBounds,
      },
      itemManager,
      folderManager,
      layoutEngine,
    )

    session.updatePointer({ x: 442, y: 248 }, { forceArm: true })
    const result = session.commit()

    expect(result.type).toBe('folder_created')
    if (result.type === 'folder_created') {
      expect(result.folder.position).toEqual({ x: 400, y: 200 })
      expect(result.itemIds).toEqual(['item-b', 'item-a', 'item-c'])
      expect(result.folder.metadata.itemIds).toEqual(['item-b', 'item-a', 'item-c'])
    }
  })

  // 12. A -> existing folder: A becomes folder child
  it('12. A -> existing folder: A becomes folder child', () => {
    const itemManager = new HomeItemManager()
    const folderManager = new FolderManager(itemManager)
    const layoutEngine = new HomeLayoutEngine()

    const existingFolder = folderManager.createFolder({
      name: 'Work',
      monitorId: 'mon-1',
      position: { x: 300, y: 200 },
    })

    const itemA = itemManager.addItem({
      id: 'item-a',
      type: 'shortcut',
      monitorId: 'mon-1',
      position: { x: 100, y: 100 },
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

    const snap = session.updatePointer({ x: 342, y: 248 })
    expect(snap.dropTarget.type).toBe('existing-folder')
    if (snap.dropTarget.type === 'existing-folder') {
      expect(snap.dropTarget.folderId).toBe(existingFolder.id)
    }

    const result = session.commit()
    expect(result.type).toBe('folder_merged')
    expect(folderManager.getFolder(existingFolder.id)?.metadata.itemIds).toContain('item-a')
  })

  // 13. Drag near existing folder edge: no accidental containment
  it('13. Drag near existing folder edge: no accidental containment', () => {
    const itemManager = new HomeItemManager()
    const folderManager = new FolderManager(itemManager)
    const layoutEngine = new HomeLayoutEngine()

    const existingFolder = folderManager.createFolder({
      name: 'Docs',
      monitorId: 'mon-1',
      position: { x: 300, y: 200 },
    })

    const itemA = itemManager.addItem({
      id: 'item-a',
      type: 'shortcut',
      monitorId: 'mon-1',
      position: { x: 100, y: 100 },
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

    // Position at (304, 204) - on the outer icon edge, outside inner hotspot
    const hotspot = getItemInnerHotspot(existingFolder.position, existingFolder.size, INNER_HOTSPOT_RATIO)
    expect(304 < hotspot.x).toBe(true)

    const snap = session.updatePointer({ x: 304, y: 204 })
    expect(snap.dropTarget.type).toBe('none')

    const result = session.commit()
    expect(result.type).toBe('moved')
    expect(folderManager.getFolder(existingFolder.id)?.metadata.itemIds).toHaveLength(0)
  })

  // 14. Invalid/system/widget target: no folder
  it('14. Invalid/system/widget target: no folder created', () => {
    const itemManager = new HomeItemManager()
    const folderManager = new FolderManager(itemManager)
    const layoutEngine = new HomeLayoutEngine()

    const itemA = itemManager.addItem({
      id: 'item-a',
      type: 'shortcut',
      monitorId: 'mon-1',
      position: { x: 100, y: 100 },
      metadata: {},
    })

    itemManager.addItem({
      id: 'widget-clock',
      type: 'widget',
      monitorId: 'mon-1',
      position: { x: 300, y: 200 },
      metadata: {},
    })

    itemManager.addItem({
      id: 'sys-trash',
      type: 'system',
      monitorId: 'mon-1',
      position: { x: 500, y: 200 },
      metadata: {},
    })

    // Drag onto widget
    const session1 = new HomeDragSession(
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
    const snap1 = session1.updatePointer({ x: 342, y: 248 }, { forceArm: true })
    expect(snap1.dropTarget.type).toBe('none')
    expect(session1.commit().type).toBe('moved')

    // Drag onto system item
    const session2 = new HomeDragSession(
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
    const snap2 = session2.updatePointer({ x: 542, y: 248 }, { forceArm: true })
    expect(snap2.dropTarget.type).toBe('none')
    expect(session2.commit().type).toBe('moved')
    expect(folderManager.getFolders()).toHaveLength(0)
  })

  // 15. Cross-monitor drag: destination monitor preserved
  it('15. Cross-monitor drag: destination monitor preserved for created folder', () => {
    const itemManager = new HomeItemManager()
    const folderManager = new FolderManager(itemManager)
    const layoutEngine = new HomeLayoutEngine()

    const itemA = itemManager.addItem({
      id: 'item-a',
      type: 'shortcut',
      monitorId: 'mon-1',
      position: { x: 100, y: 100 },
      metadata: {},
    })

    itemManager.addItem({
      id: 'item-m2',
      type: 'shortcut',
      monitorId: monitor2.id,
      position: { x: 2100, y: 200 },
      metadata: {},
    })

    const session = new HomeDragSession(
      {
        mode: 'move',
        primaryItemId: itemA.id,
        startPointer: { x: 142, y: 148 },
        monitorId: monitor2.id,
        availableBounds: monitor2.bounds,
      },
      itemManager,
      folderManager,
      layoutEngine,
    )

    const snap = session.updatePointer({ x: 2142, y: 248 }, { forceArm: true })
    expect(snap.dropTarget.type).toBe('create-folder')

    const result = session.commit()
    expect(result.type).toBe('folder_created')
    if (result.type === 'folder_created') {
      expect(result.folder.monitorId).toBe(monitor2.id)
      expect(result.folder.position).toEqual({ x: 2100, y: 200 })
    }
  })

  // 16. Negative-coordinate monitor
  it('16. Negative-coordinate monitor: correctly creates folder with negative offsets', () => {
    const itemManager = new HomeItemManager()
    const folderManager = new FolderManager(itemManager)
    const layoutEngine = new HomeLayoutEngine()

    const itemA = itemManager.addItem({
      id: 'item-neg-a',
      type: 'shortcut',
      monitorId: negativeMonitor.id,
      position: { x: -1800, y: 100 },
      metadata: {},
    })

    itemManager.addItem({
      id: 'item-neg-b',
      type: 'shortcut',
      monitorId: negativeMonitor.id,
      position: { x: -1600, y: 200 },
      metadata: {},
    })

    const session = new HomeDragSession(
      {
        mode: 'move',
        primaryItemId: itemA.id,
        startPointer: { x: -1758, y: 148 },
        monitorId: negativeMonitor.id,
        availableBounds: negativeMonitor.bounds,
      },
      itemManager,
      folderManager,
      layoutEngine,
    )

    const snap = session.updatePointer({ x: -1558, y: 248 }, { forceArm: true })
    expect(snap.dropTarget.type).toBe('create-folder')

    const result = session.commit()
    expect(result.type).toBe('folder_created')
    if (result.type === 'folder_created') {
      expect(result.folder.monitorId).toBe(negativeMonitor.id)
      expect(result.folder.position).toEqual({ x: -1600, y: 200 })
      expect(result.itemIds).toEqual(['item-neg-b', 'item-neg-a'])
    }
  })

  // 17. Shell Layout exclusion interaction
  it('17. Shell Layout exclusion interaction: creates folder within legal workArea bounds and relocates if target position is illegal', () => {
    const itemManager = new HomeItemManager()
    const folderManager = new FolderManager(itemManager)
    const layoutEngine = new HomeLayoutEngine()

    // Register top AppBar exclusion (0..48)
    layoutEngine.registerReservedRegion({
      id: 'appbar-top',
      monitorId: 'mon-1',
      edge: 'top',
      size: 48,
      priority: 1,
      rect: { x: 0, y: 0, width: 1920, height: 48 },
    })

    const usableBounds = layoutEngine.getAvailableBounds('mon-1', monitor1.bounds)
    expect(usableBounds.y).toBe(48)

    // Item B is placed inside an illegal reserved region (y = 20 < 48)
    const itemA = itemManager.addItem({
      id: 'excl-a',
      type: 'shortcut',
      monitorId: 'mon-1',
      position: { x: 100, y: 100 },
      metadata: {},
    })
    const itemB = itemManager.addItem({
      id: 'excl-b',
      type: 'shortcut',
      monitorId: 'mon-1',
      position: { x: 300, y: 20 },
      metadata: {},
    })

    const session = new HomeDragSession(
      {
        mode: 'move',
        primaryItemId: itemA.id,
        startPointer: { x: 142, y: 148 },
        monitorId: 'mon-1',
        availableBounds: usableBounds,
      },
      itemManager,
      folderManager,
      layoutEngine,
    )

    // Drag over item B
    session.updatePointer({ x: 342, y: 68 }, { forceArm: true })
    const result = session.commit()

    expect(result.type).toBe('folder_created')
    if (result.type === 'folder_created') {
      // Must NOT be placed at illegal y=20; must be resolved into legal workArea (y >= 48)
      expect(result.folder.position.y).toBeGreaterThanOrEqual(48)
      expect(result.folder.position.x).toBeGreaterThanOrEqual(0)
      expect(result.itemIds).toContain(itemB.id)
    }

    // Also verify when target item is covered by an active exclusion zone
    layoutEngine.registerExclusionZone({
      id: 'overlay-exclusion',
      monitorId: 'mon-1',
      rect: { x: 500, y: 100, width: 200, height: 200 },
    })
    const itemC = itemManager.addItem({
      id: 'excl-c',
      type: 'shortcut',
      monitorId: 'mon-1',
      position: { x: 100, y: 300 },
      metadata: {},
    })
    const itemD = itemManager.addItem({
      id: 'excl-d',
      type: 'shortcut',
      monitorId: 'mon-1',
      position: { x: 550, y: 150 }, // Inside exclusion zone
      metadata: {},
    })
    const session2 = new HomeDragSession(
      {
        mode: 'move',
        primaryItemId: itemC.id,
        startPointer: { x: 142, y: 348 },
        monitorId: 'mon-1',
        availableBounds: usableBounds,
      },
      itemManager,
      folderManager,
      layoutEngine,
    )
    session2.updatePointer({ x: 592, y: 198 }, { forceArm: true })
    const result2 = session2.commit()
    expect(result2.type).toBe('folder_created')
    if (result2.type === 'folder_created') {
      const fRect = { ...result2.folder.position, ...result2.folder.size }
      const collides =
        fRect.x < 500 + 200 &&
        fRect.x + fRect.width > 500 &&
        fRect.y < 100 + 200 &&
        fRect.y + fRect.height > 100
      expect(collides).toBe(false)
      expect(result2.itemIds).toContain(itemD.id)
    }
  })

  // 18. Persistence restart: folder and children restored exactly
  it('18. Persistence restart: folder and children restored exactly', async () => {
    const stateFile = join(tempDir, 'persist-drag-folder.json')

    // Session 1: Create Home, dispatch armed moveItems intent
    {
      const ctx1 = new Context()
      contexts.push(ctx1)
      const runtime1 = createMockSurfaceRuntime()

      ctx1.windowsContext = {
        getMonitors: () => [monitor1],
        getMonitor: () => monitor1,
      } as unknown as WindowsContextService

      await ctx1.plugin(WebServer, { host: '127.0.0.1', port: 0 })
      await ctx1.plugin(SurfaceService, { runtime: runtime1 })
      await ctx1.plugin(WidgetService)
      await ctx1.plugin(HomePlugin, {
        enabled: true,
        persistencePath: stateFile,
        initialMonitors: [monitor1],
      })

      const home1 = ctx1.home
      home1.items.addItem({
        id: 'persist-a',
        type: 'shortcut',
        monitorId: monitor1.id,
        position: { x: 100, y: 100 },
        metadata: { name: 'Persistent A' },
      })
      home1.items.addItem({
        id: 'persist-b',
        type: 'shortcut',
        monitorId: monitor1.id,
        position: { x: 300, y: 200 },
        metadata: { name: 'Persistent B' },
      })

      await home1.dispatchIntent(monitor1.id, {
        type: 'moveItems',
        primaryItemId: 'persist-a',
        additionalItemIds: [],
        start: { x: 142, y: 148 },
        end: { x: 342, y: 248 },
        folderTargetArmed: true,
      })

      await home1.saveState()
      await ctx1.fiber.dispose()
    }

    // Session 2: Reload and verify folder and children
    {
      const ctx2 = new Context()
      contexts.push(ctx2)
      const runtime2 = createMockSurfaceRuntime()

      ctx2.windowsContext = {
        getMonitors: () => [monitor1],
        getMonitor: () => monitor1,
      } as unknown as WindowsContextService

      await ctx2.plugin(WebServer, { host: '127.0.0.1', port: 0 })
      await ctx2.plugin(SurfaceService, { runtime: runtime2 })
      await ctx2.plugin(WidgetService)
      await ctx2.plugin(HomePlugin, {
        enabled: true,
        persistencePath: stateFile,
        initialMonitors: [monitor1],
      })

      const home2 = ctx2.home
      const folders = home2.folders.getFolders()
      expect(folders).toHaveLength(1)

      const folder = folders[0]!
      expect(folder.position).toEqual({ x: 300, y: 200 })
      expect(folder.metadata.itemIds).toContain('persist-a')
      expect(folder.metadata.itemIds).toContain('persist-b')

      expect(home2.items.getItem('persist-a')?.folderId).toBe(folder.id)
      expect(home2.items.getItem('persist-b')?.folderId).toBe(folder.id)
    }
  })

  // 19. No duplicate root children after restart
  it('19. No duplicate root children after restart', async () => {
    const stateFile = join(tempDir, 'persist-drag-folder-root.json')

    {
      const ctx1 = new Context()
      contexts.push(ctx1)
      const runtime1 = createMockSurfaceRuntime()

      ctx1.windowsContext = {
        getMonitors: () => [monitor1],
        getMonitor: () => monitor1,
      } as unknown as WindowsContextService

      await ctx1.plugin(WebServer, { host: '127.0.0.1', port: 0 })
      await ctx1.plugin(SurfaceService, { runtime: runtime1 })
      await ctx1.plugin(WidgetService)
      await ctx1.plugin(HomePlugin, {
        enabled: true,
        persistencePath: stateFile,
        initialMonitors: [monitor1],
      })

      const home1 = ctx1.home
      home1.items.addItem({
        id: 'child-1',
        type: 'shortcut',
        monitorId: monitor1.id,
        position: { x: 100, y: 100 },
        metadata: {},
      })
      home1.items.addItem({
        id: 'child-2',
        type: 'shortcut',
        monitorId: monitor1.id,
        position: { x: 300, y: 200 },
        metadata: {},
      })
      home1.items.addItem({
        id: 'standalone',
        type: 'shortcut',
        monitorId: monitor1.id,
        position: { x: 600, y: 400 },
        metadata: {},
      })

      await home1.dispatchIntent(monitor1.id, {
        type: 'moveItems',
        primaryItemId: 'child-1',
        additionalItemIds: [],
        start: { x: 142, y: 148 },
        end: { x: 342, y: 248 },
        folderTargetArmed: true,
      })

      await home1.saveState()
      await ctx1.fiber.dispose()
    }

    {
      const ctx2 = new Context()
      contexts.push(ctx2)
      const runtime2 = createMockSurfaceRuntime()

      ctx2.windowsContext = {
        getMonitors: () => [monitor1],
        getMonitor: () => monitor1,
      } as unknown as WindowsContextService

      await ctx2.plugin(WebServer, { host: '127.0.0.1', port: 0 })
      await ctx2.plugin(SurfaceService, { runtime: runtime2 })
      await ctx2.plugin(WidgetService)
      await ctx2.plugin(HomePlugin, {
        enabled: true,
        persistencePath: stateFile,
        initialMonitors: [monitor1],
      })

      const home2 = ctx2.home
      const rootItems = home2.items.getRootItemsForMonitor(monitor1.id)
      const rootIds = rootItems.map(i => i.id)

      expect(rootIds).not.toContain('child-1')
      expect(rootIds).not.toContain('child-2')
      expect(rootIds).toContain('standalone')
      expect(rootItems.some(i => i.type === 'folder')).toBe(true)
      expect(rootItems).toHaveLength(2) // 1 folder + 1 standalone
    }
  })

  // 20. Rapid drag/cancel cycles: no leaked timers/state
  it('20. Rapid drag/cancel cycles: no leaked timers or dangling state', () => {
    const itemManager = new HomeItemManager()
    const folderManager = new FolderManager(itemManager)
    const layoutEngine = new HomeLayoutEngine()

    const itemA = itemManager.addItem({
      id: 'item-a',
      type: 'shortcut',
      monitorId: 'mon-1',
      position: { x: 100, y: 100 },
      metadata: {},
    })
    itemManager.addItem({
      id: 'item-b',
      type: 'shortcut',
      monitorId: 'mon-1',
      position: { x: 300, y: 200 },
      metadata: {},
    })

    // Execute 100 rapid start, update, and cancel cycles
    for (let i = 0; i < 100; i++) {
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

      session.updatePointer({ x: 342, y: 248 })
      session.cancel()
    }

    expect(folderManager.getFolders()).toHaveLength(0)
    expect(itemManager.getItem('item-a')?.position).toEqual({ x: 100, y: 100 })
  })
})
