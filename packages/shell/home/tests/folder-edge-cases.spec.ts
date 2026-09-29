import { describe, expect, it } from 'vitest'
import { FolderManager, HomeItemManager, rectsIntersect } from '../src/index.ts'

describe('Phase 12 App Folder edge-case hardening', () => {
  it('dissolves a folder atomically and releases every actual child', () => {
    const items = new HomeItemManager()
    const folders = new FolderManager(items)
    const a = items.addItem({ id: 'a', type: 'shortcut', monitorId: 'm1', position: { x: 20, y: 20 }, metadata: {} })
    const b = items.addItem({ id: 'b', type: 'shortcut', monitorId: 'm1', position: { x: 220, y: 20 }, metadata: {} })
    const folder = folders.createFolder({ monitorId: 'm1', position: { x: 500, y: 300 }, initialItemIds: [a.id, b.id] })

    let changes = 0
    const dispose = items.onChange(() => { changes++ })
    expect(folders.dissolveFolder(folder.id)).toBe(true)
    dispose()

    expect(changes).toBe(1)
    expect(folders.getFolder(folder.id)).toBeUndefined()
    expect(items.getItem(a.id)?.folderId).toBeUndefined()
    expect(items.getItem(b.id)?.folderId).toBeUndefined()
  })

  it('preserves a stored child position when that position is still free', () => {
    const items = new HomeItemManager()
    const folders = new FolderManager(items)
    const app = items.addItem({ id: 'app', type: 'shortcut', monitorId: 'm1', position: { x: 140, y: 180 }, metadata: {} })
    const folder = folders.createFolder({ monitorId: 'm1', position: { x: 600, y: 400 }, initialItemIds: [app.id] })

    expect(folders.dissolveFolder(folder.id)).toBe(true)
    expect(items.getItem(app.id)?.position).toEqual({ x: 140, y: 180 })
  })

  it('resolves release collisions between children and existing root items', () => {
    const items = new HomeItemManager()
    const folders = new FolderManager(items)
    items.addItem({ id: 'blocker', type: 'shortcut', monitorId: 'm1', position: { x: 100, y: 100 }, metadata: {} })
    const a = items.addItem({ id: 'a', type: 'shortcut', monitorId: 'm1', position: { x: 100, y: 100 }, metadata: {} })
    const b = items.addItem({ id: 'b', type: 'shortcut', monitorId: 'm1', position: { x: 100, y: 100 }, metadata: {} })
    const folder = folders.createFolder({ monitorId: 'm1', position: { x: 420, y: 260 }, initialItemIds: [a.id, b.id] })

    expect(folders.dissolveFolder(folder.id)).toBe(true)
    const blocker = items.getItem('blocker')!
    const releasedA = items.getItem('a')!
    const releasedB = items.getItem('b')!
    const gap = 12

    expect(rectsIntersect({ ...releasedA.position, ...releasedA.size }, { ...blocker.position, ...blocker.size }, gap)).toBe(false)
    expect(rectsIntersect({ ...releasedB.position, ...releasedB.size }, { ...blocker.position, ...blocker.size }, gap)).toBe(false)
    expect(rectsIntersect({ ...releasedA.position, ...releasedA.size }, { ...releasedB.position, ...releasedB.size }, gap)).toBe(false)
  })

  it('ignores stale folder metadata instead of moving an unrelated root item', () => {
    const items = new HomeItemManager()
    const folders = new FolderManager(items)
    const child = items.addItem({ id: 'child', type: 'shortcut', monitorId: 'm1', position: { x: 40, y: 40 }, metadata: {} })
    const unrelated = items.addItem({ id: 'unrelated', type: 'shortcut', monitorId: 'm1', position: { x: 900, y: 500 }, metadata: {} })
    const folder = folders.createFolder({ monitorId: 'm1', position: { x: 400, y: 240 }, initialItemIds: [child.id] })
    items.updateMetadata(folder.id, previous => ({
      ...(previous as Record<string, unknown>),
      itemIds: [child.id, unrelated.id],
    }))

    expect(folders.dissolveFolder(folder.id)).toBe(true)
    expect(items.getItem(unrelated.id)?.position).toEqual({ x: 900, y: 500 })
    expect(items.getItem(unrelated.id)?.folderId).toBeUndefined()
  })

  it('destructive folder deletion removes only actual children and never stale root references', () => {
    const items = new HomeItemManager()
    const folders = new FolderManager(items)
    const child = items.addItem({ id: 'child', type: 'shortcut', monitorId: 'm1', position: { x: 40, y: 40 }, metadata: {} })
    const unrelated = items.addItem({ id: 'unrelated', type: 'shortcut', monitorId: 'm1', position: { x: 700, y: 400 }, metadata: {} })
    const folder = folders.createFolder({ monitorId: 'm1', position: { x: 400, y: 240 }, initialItemIds: [child.id] })
    items.updateMetadata(folder.id, previous => ({
      ...(previous as Record<string, unknown>),
      itemIds: [child.id, unrelated.id],
    }))

    let changes = 0
    const dispose = items.onChange(() => { changes++ })
    expect(folders.deleteFolder(folder.id, true)).toBe(true)
    dispose()

    expect(changes).toBe(1)
    expect(items.getItem(folder.id)).toBeUndefined()
    expect(items.getItem(child.id)).toBeUndefined()
    expect(items.getItem(unrelated.id)).toBeDefined()
  })

  it('removes the final child and empty folder in one collection publication', () => {
    const items = new HomeItemManager()
    const folders = new FolderManager(items)
    const child = items.addItem({ id: 'only-child', type: 'shortcut', monitorId: 'm1', position: { x: 80, y: 80 }, metadata: {} })
    const folder = folders.createFolder({ monitorId: 'm1', position: { x: 300, y: 200 }, initialItemIds: [child.id] })

    let changes = 0
    const dispose = items.onChange(() => { changes++ })
    expect(folders.removeItemFromFolder(folder.id, child.id)).toBe(true)
    dispose()

    expect(changes).toBe(1)
    expect(folders.getFolder(folder.id)).toBeUndefined()
    expect(items.getItem(child.id)?.folderId).toBeUndefined()
  })

  it('never treats a filesystem folder as an ELIX App Folder', () => {
    const items = new HomeItemManager()
    const folders = new FolderManager(items)
    const filesystemFolder = items.addItem({
      id: 'documents',
      type: 'folder',
      monitorId: 'm1',
      position: { x: 100, y: 100 },
      metadata: { name: 'Documents', color: 'amber', itemIds: [], isOpen: false, isFilesystem: true },
    })

    expect(folders.getFolder(filesystemFolder.id)).toBeUndefined()
    expect(folders.getFolders()).toHaveLength(0)
    expect(folders.openFolder(filesystemFolder.id)).toBe(false)
    expect(folders.deleteFolder(filesystemFolder.id)).toBe(false)
    expect(items.getItem(filesystemFolder.id)).toBeDefined()
  })
})
