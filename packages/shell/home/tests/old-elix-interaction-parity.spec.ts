import { describe, expect, it } from 'vitest'
import {
  FolderManager,
  HomeItemManager,
} from '../src/index.ts'
import { HOME_RENDERER_CLIENT_SCRIPT } from '../src/renderer-client.ts'

describe('Old ELIX Home interaction parity', () => {
  it('keeps the mature drag thresholds and settle motion', () => {
    expect(HOME_RENDERER_CLIENT_SCRIPT).toContain('threshold=8')
    expect(HOME_RENDERER_CLIENT_SCRIPT).toContain('elapsed>=150?5:12')
    expect(HOME_RENDERER_CLIENT_SCRIPT).toContain('scale(1.02)')
    expect(HOME_RENDERER_CLIENT_SCRIPT).toContain('scale(1.025)')
    expect(HOME_RENDERER_CLIENT_SCRIPT).toContain('duration:cancelled?160:190')
    expect(HOME_RENDERER_CLIENT_SCRIPT).toContain('cubic-bezier(.2,.84,.26,1)')
    expect(HOME_RENDERER_CLIENT_SCRIPT).toContain('elix-item-drop-settle')
    expect(HOME_RENDERER_CLIENT_SCRIPT).toContain('elix-item-drag-cancel')
  })

  it('uses one live reflow preview across desktop items and widgets', () => {
    expect(HOME_RENDERER_CLIENT_SCRIPT).toContain('document.querySelectorAll(".home-item,.home-widget")')
    expect(HOME_RENDERER_CLIENT_SCRIPT).toContain('resolveSpatialPreview')
    expect(HOME_RENDERER_CLIENT_SCRIPT).toContain('commitPreviewDisplacements')
    expect(HOME_RENDERER_CLIENT_SCRIPT).toContain('is-layout-preview')
    expect(HOME_RENDERER_CLIENT_SCRIPT).toContain('nearestFree')
  })

  it('keeps folder-intent dwell separate from ordinary reflow', () => {
    expect(HOME_RENDERER_CLIENT_SCRIPT).toContain('setTimeout(function(){if(pointer===active')
    expect(HOME_RENDERER_CLIENT_SCRIPT).toContain('}},600)')
    expect(HOME_RENDERER_CLIENT_SCRIPT).toContain('is-folder-potential')
    expect(HOME_RENDERER_CLIENT_SCRIPT).toContain('is-folder-armed')
    expect(HOME_RENDERER_CLIENT_SCRIPT).toContain('clearSpatialPreview()')
  })

  it('ports the mature App Folder absorb/open/close/reorder motion', () => {
    expect(HOME_RENDERER_CLIENT_SCRIPT).toContain('duration:220,easing:"cubic-bezier(.18,.9,.24,1)"')
    expect(HOME_RENDERER_CLIENT_SCRIPT).toContain('elix-item-folder-absorb')
    expect(HOME_RENDERER_CLIENT_SCRIPT).toContain('duration:150,easing:"linear"')
    expect(HOME_RENDERER_CLIENT_SCRIPT).toContain('duration:285,easing:FOLDER_EASE')
    expect(HOME_RENDERER_CLIENT_SCRIPT).toContain('duration:260,delay:Math.min(72,index*12)')
    expect(HOME_RENDERER_CLIENT_SCRIPT).toContain('duration:230,easing:"cubic-bezier(.42,0,.72,.18)"')
    expect(HOME_RENDERER_CLIENT_SCRIPT).toContain('duration:210,easing:"linear"')
    expect(HOME_RENDERER_CLIENT_SCRIPT).toContain('elix-folder-reorder-settle')
    expect(HOME_RENDERER_CLIENT_SCRIPT).not.toContain('blur(14px)')
  })

  it('queues renderer snapshots while a pointer interaction or settle is active', () => {
    expect(HOME_RENDERER_CLIENT_SCRIPT).toContain('if(pointer||settling)queuedSnapshotMarkup=payload.markup')
    expect(HOME_RENDERER_CLIENT_SCRIPT).toContain('applyQueuedSnapshot')
  })

  it('resizes desktop items with the same live spatial preview used by widgets', () => {
    expect(HOME_RENDERER_CLIENT_SCRIPT).toContain('kind:"item-resize"')
    expect(HOME_RENDERER_CLIENT_SCRIPT).toContain('type:"resizeItem"')
    expect(HOME_RENDERER_CLIENT_SCRIPT).toContain('resolveSpatialPreview(pointer.node,irr')
    expect(HOME_RENDERER_CLIENT_SCRIPT).toContain('commitPreviewDisplacements(active')
  })

  it('honors reduced motion and does not invent an empty desktop context menu', () => {
    expect(HOME_RENDERER_CLIENT_SCRIPT).toContain('(prefers-reduced-motion: reduce)')
    expect(HOME_RENDERER_CLIENT_SCRIPT).not.toContain('targetType:"desktop"')
  })
})

describe('Old ELIX App Folder semantics', () => {
  it('cycles default folder colors in the mature palette order', () => {
    const items = new HomeItemManager()
    const folders = new FolderManager(items)
    const first = folders.createFolder({ position: { x: 0, y: 0 } })
    const second = folders.createFolder({ position: { x: 100, y: 0 } })
    expect(first.metadata.color).toBe('mint')
    expect(second.metadata.color).toBe('sky')
  })

  it('limits folder names to 48 characters', () => {
    const items = new HomeItemManager()
    const folders = new FolderManager(items)
    const folder = folders.createFolder({ position: { x: 0, y: 0 } })
    expect(folders.renameFolder(folder.id, 'x'.repeat(80))).toBe(true)
    expect(folders.getFolder(folder.id)?.metadata.name).toHaveLength(48)
  })

  it('rejects nested App Folders', () => {
    const items = new HomeItemManager()
    const folders = new FolderManager(items)
    const parent = folders.createFolder({ position: { x: 0, y: 0 } })
    const child = folders.createFolder({ position: { x: 100, y: 0 } })
    expect(folders.addItemToFolder(parent.id, child.id)).toBe(false)
    expect(items.getItem(child.id)?.folderId).toBeUndefined()
  })

  it('removes an App Folder when its final member is removed', () => {
    const items = new HomeItemManager()
    const folders = new FolderManager(items)
    const app = items.addItem({
      id: 'app-only',
      type: 'shortcut',
      position: { x: 0, y: 0 },
      metadata: {},
    })
    const folder = folders.createFolder({
      position: { x: 100, y: 100 },
      initialItemIds: [app.id],
    })
    expect(folders.removeItemFromFolder(folder.id, app.id)).toBe(true)
    expect(folders.getFolder(folder.id)).toBeUndefined()
    expect(items.getItem(app.id)?.folderId).toBeUndefined()
  })

  it('reparents items atomically when a new folder is formed from an existing folder member', () => {
    const items = new HomeItemManager()
    const folders = new FolderManager(items)
    const app = items.addItem({
      id: 'app-reparent',
      type: 'shortcut',
      position: { x: 0, y: 0 },
      metadata: {},
    })
    const oldFolder = folders.createFolder({
      position: { x: 100, y: 100 },
      initialItemIds: [app.id],
    })
    const newFolder = folders.createFolder({
      position: { x: 300, y: 100 },
      initialItemIds: [app.id],
    })
    expect(folders.getFolder(oldFolder.id)).toBeUndefined()
    expect(items.getItem(app.id)?.folderId).toBe(newFolder.id)
    expect(folders.getFolder(newFolder.id)?.metadata.itemIds).toEqual([app.id])
  })

  it('deduplicates reorder payloads while preserving omitted members', () => {
    const items = new HomeItemManager()
    const folders = new FolderManager(items)
    for (const id of ['a', 'b', 'c']) {
      items.addItem({ id, type: 'shortcut', position: { x: 0, y: 0 }, metadata: {} })
    }
    const folder = folders.createFolder({
      position: { x: 100, y: 100 },
      initialItemIds: ['a', 'b', 'c'],
    })
    expect(folders.reorderFolderItems(folder.id, ['c', 'c', 'a'])).toBe(true)
    expect(folders.getFolder(folder.id)?.metadata.itemIds).toEqual(['c', 'a', 'b'])
  })
})
