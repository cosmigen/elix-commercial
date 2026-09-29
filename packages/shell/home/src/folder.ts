/**
 * Dedicated Desktop Folder management subsystem for ELIX Home Screen.
 * Rebuilds the folder concept from old ELIX into a clean, decoupled architecture
 * free of Dock and Status Bar coupling.
 *
 * @module @deepseek-ai/dsh-home/folder
 */

import type { FolderMetadata, HomeItem } from './items.ts'
import { HomeItemManager } from './items.ts'
import type { Position, Rect } from './types.ts'

/** Supported folder accent color palettes (inherited and refined from ELIX visual language). */
export type FolderColor = 'mint' | 'sky' | 'violet' | 'amber' | 'rose' | 'graphite'

export const FOLDER_COLORS: readonly FolderColor[] = [
  'mint',
  'sky',
  'violet',
  'amber',
  'rose',
  'graphite',
]

/** Options for creating a new desktop folder. */
export interface CreateFolderOptions {
  monitorId?: string | undefined
  position: Position
  name?: string | undefined
  color?: FolderColor | undefined
  initialItemIds?: readonly string[] | undefined
}

const RELEASE_GAP = 12
const RELEASE_STEP_X = 98
const RELEASE_STEP_Y = 108

/**
 * Root item types that may participate in folder targeting/discovery. Existing folders
 * are included here so a dragged app/file can discover them as drop targets. Actual
 * containment remains stricter and is enforced by isEligibleFolderSourceItem().
 */
const ELIGIBLE_FOLDER_ITEM_TYPES: ReadonlySet<string> = new Set([
  'shortcut',
  'app shortcut',
  'file',
  'folder',
])

const ELIGIBLE_CREATE_FOLDER_TARGET_TYPES: ReadonlySet<string> = new Set([
  'shortcut',
  'app shortcut',
  'file',
])

const ELIGIBLE_CREATE_FOLDER_SOURCE_TYPES: ReadonlySet<string> = new Set([
  'shortcut',
  'app shortcut',
  'file',
])

/** Distinguish ELIX App Folders from filesystem folders projected onto Home. */
export function isAppFolderItem(item: HomeItem | undefined): item is HomeItem<FolderMetadata> {
  if (item === undefined || item.type !== 'folder') return false
  const metadata = item.metadata as FolderMetadata & { readonly isFilesystem?: boolean | undefined }
  return metadata.isFilesystem !== true
}

/** Determine whether a root item participates in App Folder targeting/discovery. */
export function isEligibleFolderItem(item: HomeItem | undefined): boolean {
  if (item === undefined) return false
  if (item.type === 'folder') return isAppFolderItem(item)
  return ELIGIBLE_FOLDER_ITEM_TYPES.has(item.type)
}

/** Determine whether a desktop item can be the target of drag-to-create-folder. */
export function isEligibleFolderTargetItem(item: HomeItem | undefined): boolean {
  if (item === undefined) return false
  return ELIGIBLE_CREATE_FOLDER_TARGET_TYPES.has(item.type)
}

/** Determine whether a desktop item can be dragged into / used to create an App Folder. */
export function isEligibleFolderSourceItem(item: HomeItem | undefined): boolean {
  if (item === undefined) return false
  return ELIGIBLE_CREATE_FOLDER_SOURCE_TYPES.has(item.type)
}

/**
 * Defensive cycle check retained for corrupted/migrated state even though new App
 * Folder mutations reject nested folders at the public boundary.
 */
export function wouldCreateFolderCycle(
  folderManager: FolderManager,
  targetFolderId: string,
  itemId: string,
): boolean {
  if (targetFolderId === itemId) return true
  const itemFolder = folderManager.getFolder(itemId)
  if (itemFolder === undefined) return false

  const queue = [...itemFolder.metadata.itemIds]
  const visited = new Set<string>([itemId])
  while (queue.length > 0) {
    const currentId = queue.shift()
    if (currentId === undefined) break
    if (currentId === targetFolderId) return true
    if (visited.has(currentId)) continue
    visited.add(currentId)
    const childFolder = folderManager.getFolder(currentId)
    if (childFolder !== undefined) queue.push(...childFolder.metadata.itemIds)
  }
  return false
}

/** Manages desktop App Folder creation, containment, ordering, and in-Home open state. */
export class FolderManager {
  constructor(private readonly itemManager: HomeItemManager) {}

  /** Retrieve ELIX App Folders only; filesystem folders are a different semantic domain. */
  getFolders(): readonly HomeItem<FolderMetadata>[] {
    return this.itemManager.getItems().filter(isAppFolderItem)
  }

  /** Retrieve an ELIX App Folder by identifier. */
  getFolder(id: string): HomeItem<FolderMetadata> | undefined {
    const item = this.itemManager.getItem(id)
    return isAppFolderItem(item) ? item : undefined
  }

  /** Check whether a specific item is contained inside any App Folder. */
  getFolderContainingItem(itemId: string): HomeItem<FolderMetadata> | undefined {
    for (const folder of this.getFolders()) {
      if (folder.metadata.itemIds.includes(itemId)) return folder
    }
    return undefined
  }

  /** Create a new App Folder on the desktop. */
  createFolder(options: CreateFolderOptions): HomeItem<FolderMetadata> {
    const defaultName = this.getNextDefaultFolderName()
    const color = options.color ?? FOLDER_COLORS[this.getFolders().length % FOLDER_COLORS.length] ?? 'sky'
    const requestedItemIds = options.initialItemIds !== undefined ? [...new Set(options.initialItemIds)] : []
    const initialItemIds = requestedItemIds.filter(id => isEligibleFolderSourceItem(this.itemManager.getItem(id)))

    const metadata: FolderMetadata = {
      name: (options.name ?? defaultName).trim().slice(0, 48) || 'New Folder',
      color,
      itemIds: initialItemIds,
      isOpen: false,
      desktopIconSize: 64,
    }

    // Capture previous containment BEFORE registering the new folder. Once the new
    // folder exists its metadata already lists these IDs, so a fresh membership scan
    // could incorrectly find the new folder and leave stale membership behind.
    const previousContainers = new Map(
      initialItemIds.map(itemId => [itemId, this.getFolderContainingItem(itemId)] as const),
    )

    const folder = this.itemManager.addItem<FolderMetadata>({
      type: 'folder',
      monitorId: options.monitorId ?? 'primary',
      position: options.position,
      size: { width: 84, height: 96 },
      metadata,
    })

    for (const itemId of initialItemIds) {
      const otherFolder = previousContainers.get(itemId)
      if (otherFolder !== undefined && otherFolder.id !== folder.id) {
        this.removeItemFromFolder(otherFolder.id, itemId)
      }
      this.itemManager.setParentFolder(itemId, folder.id)
    }

    return folder
  }

  /** Rename a desktop folder. */
  renameFolder(folderId: string, newName: string): boolean {
    const sanitized = newName.trim().slice(0, 48)
    if (!sanitized) return false
    const folder = this.getFolder(folderId)
    if (folder === undefined) return false
    this.itemManager.updateMetadata<FolderMetadata>(folderId, { name: sanitized })
    return true
  }

  /** Set folder color theme. */
  setFolderColor(folderId: string, color: FolderColor): boolean {
    const folder = this.getFolder(folderId)
    if (folder === undefined) return false
    this.itemManager.updateMetadata<FolderMetadata>(folderId, { color })
    return true
  }

  /** Add an eligible root item into an App Folder. */
  addItemToFolder(folderId: string, itemId: string): boolean {
    if (folderId === itemId) return false
    const folder = this.getFolder(folderId)
    if (folder === undefined) return false
    const item = this.itemManager.getItem(itemId)
    if (!isEligibleFolderSourceItem(item)) return false
    if (wouldCreateFolderCycle(this, folderId, itemId)) return false
    if (folder.metadata.itemIds.includes(itemId)) return true

    const otherFolder = this.getFolderContainingItem(itemId)
    if (otherFolder !== undefined && otherFolder.id !== folderId) {
      this.removeItemFromFolder(otherFolder.id, itemId)
    }

    const current = this.getFolder(folderId)
    if (current === undefined) return false
    const updatedItemIds = [...current.metadata.itemIds, itemId]
    this.itemManager.updateMetadata<FolderMetadata>(folderId, { itemIds: updatedItemIds })
    this.itemManager.setParentFolder(itemId, folderId)
    return true
  }

  /**
   * Remove one item from an App Folder in one authoritative collection replacement.
   * This avoids transient snapshots where a child is simultaneously root + contained,
   * and removes an empty folder in the same publication as its final child release.
   */
  removeItemFromFolder(folderId: string, itemId: string, targetPosition?: Position): boolean {
    const folder = this.getFolder(folderId)
    const child = this.itemManager.getItem(itemId)
    if (
      folder === undefined ||
      child === undefined ||
      child.folderId !== folderId ||
      !folder.metadata.itemIds.includes(itemId)
    ) {
      return false
    }

    const snapshot = this.itemManager.getItems()
    const remainingIds = folder.metadata.itemIds.filter(id => id !== itemId)
    const occupied = snapshot
      .filter(
        item =>
          item.id !== folderId &&
          item.id !== itemId &&
          item.folderId === undefined &&
          item.monitorId === folder.monitorId,
      )
      .map(toRect)
    const desired = targetPosition ?? child.position
    const releasedPosition = findReleasePosition(child, desired, folder.position, occupied)
    const timestamp = Date.now()

    const next = snapshot.flatMap((item): HomeItem[] => {
      if (item.id === folderId) {
        if (remainingIds.length === 0) return []
        return [{
          ...item,
          metadata: { ...(item.metadata as FolderMetadata), itemIds: remainingIds },
          updatedAt: timestamp,
        }]
      }
      if (item.id === itemId) {
        return [{
          ...item,
          folderId: undefined,
          monitorId: folder.monitorId,
          monitor: folder.monitorId,
          position: releasedPosition,
          updatedAt: timestamp,
        }]
      }
      return [item]
    })

    this.itemManager.loadSnapshot(next)
    return true
  }

  /** Reorder items inside a folder without allowing duplicates or foreign IDs. */
  reorderFolderItems(folderId: string, itemIds: readonly string[]): boolean {
    const folder = this.getFolder(folderId)
    if (folder === undefined) return false

    const currentSet = new Set(folder.metadata.itemIds)
    const seen = new Set<string>()
    const validOrdered: string[] = []
    for (const id of itemIds) {
      if (currentSet.has(id) && !seen.has(id)) {
        seen.add(id)
        validOrdered.push(id)
      }
    }
    for (const existingId of folder.metadata.itemIds) {
      if (!seen.has(existingId)) validOrdered.push(existingId)
    }

    this.itemManager.updateMetadata<FolderMetadata>(folderId, { itemIds: validOrdered })
    return true
  }

  private readonly openRequestListeners = new Set<(folderId: string) => void>()

  /** Subscribe to folder open requests. */
  onFolderOpenRequest(listener: (folderId: string) => void): () => void {
    this.openRequestListeners.add(listener)
    return () => {
      this.openRequestListeners.delete(listener)
    }
  }

  /**
   * Emit a folder-open request for any projected folder item.
   * App Folder state remains App-Folder-only; filesystem folders reuse this event
   * transport so Home can hand them to their external opener without misclassifying
   * them as ELIX App Folders.
   */
  requestOpenFolder(folderId: string): boolean {
    const item = this.itemManager.getItem(folderId)
    if (item === undefined || item.type !== 'folder') return false
    for (const listener of this.openRequestListeners) {
      try {
        listener(folderId)
      } catch (err) {
        console.error('Error in folder open request listener:', err)
      }
    }
    return true
  }

  /** Retrieve the currently open folder, if any. */
  getOpenFolder(): HomeItem<FolderMetadata> | undefined {
    return this.getFolders().find(folder => folder.metadata.isOpen)
  }

  /** Open one folder and close any other open App Folder. */
  openFolder(folderId: string): boolean {
    const folder = this.getFolder(folderId)
    if (folder === undefined) return false
    for (const other of this.getFolders()) {
      if (other.id !== folderId && other.metadata.isOpen) {
        this.itemManager.updateMetadata<FolderMetadata>(other.id, { isOpen: false })
      }
    }
    this.itemManager.updateMetadata<FolderMetadata>(folderId, { isOpen: true })
    this.requestOpenFolder(folderId)
    return true
  }

  /** Close one folder, or all folders when folderId is omitted. */
  closeFolder(folderId?: string): boolean {
    if (folderId !== undefined) {
      const folder = this.getFolder(folderId)
      if (folder === undefined) return false
      this.itemManager.updateMetadata<FolderMetadata>(folderId, { isOpen: false })
      return true
    }

    let closedAny = false
    for (const folder of this.getFolders()) {
      if (folder.metadata.isOpen) {
        this.itemManager.updateMetadata<FolderMetadata>(folder.id, { isOpen: false })
        closedAny = true
      }
    }
    return closedAny
  }

  /**
   * Dissolve an App Folder atomically while preserving its applications.
   * Stored pre-folder positions are reused when still free. Blocked children are placed
   * by a deterministic local spiral around the former folder tile, avoiding root-item
   * collisions and avoiding child-on-child overlap. Stale metadata IDs are ignored.
   */
  dissolveFolder(folderId: string): boolean {
    const folder = this.getFolder(folderId)
    if (folder === undefined) return false

    const snapshot = this.itemManager.getItems()
    const declaredIds = new Set(folder.metadata.itemIds)
    const actualChildren = snapshot.filter(
      item => declaredIds.has(item.id) && item.folderId === folderId,
    )
    const actualChildIds = new Set(actualChildren.map(item => item.id))
    const occupied = snapshot
      .filter(
        item =>
          item.id !== folderId &&
          !actualChildIds.has(item.id) &&
          item.folderId === undefined &&
          item.monitorId === folder.monitorId,
      )
      .map(toRect)
    const placements = new Map<string, Position>()

    for (const child of actualChildren) {
      const position = findReleasePosition(child, child.position, folder.position, occupied)
      placements.set(child.id, position)
      occupied.push({ ...position, width: child.size.width, height: child.size.height })
    }

    const timestamp = Date.now()
    const next = snapshot.flatMap((item): HomeItem[] => {
      if (item.id === folderId) return []
      const releasedPosition = placements.get(item.id)
      if (releasedPosition === undefined) return [item]
      return [{
        ...item,
        folderId: undefined,
        monitorId: folder.monitorId,
        monitor: folder.monitorId,
        position: releasedPosition,
        updatedAt: timestamp,
      }]
    })

    this.itemManager.loadSnapshot(next)
    return true
  }

  /**
   * Delete an App Folder. The default preserves/release its applications (dissolve).
   * Destructive deletion only removes items that are *actually* parented by this folder;
   * stale metadata IDs can never delete unrelated root items.
   */
  deleteFolder(folderId: string, deleteContainedItems = false): boolean {
    if (!deleteContainedItems) return this.dissolveFolder(folderId)
    const folder = this.getFolder(folderId)
    if (folder === undefined) return false

    const snapshot = this.itemManager.getItems()
    const declaredIds = new Set(folder.metadata.itemIds)
    const next = snapshot.filter((item) => {
      if (item.id === folderId) return false
      return !(declaredIds.has(item.id) && item.folderId === folderId)
    })
    this.itemManager.loadSnapshot(next)
    return true
  }

  private getNextDefaultFolderName(): string {
    const existingNames = new Set(this.getFolders().map(f => f.metadata.name))
    if (!existingNames.has('New Folder')) return 'New Folder'
    let count = 2
    while (existingNames.has(`New Folder (${count})`)) count++
    return `New Folder (${count})`
  }
}

function toRect(item: HomeItem): Rect {
  return { ...item.position, ...item.size }
}

function rectsOverlap(a: Rect, b: Rect, gap = RELEASE_GAP): boolean {
  return (
    a.x - gap < b.x + b.width &&
    a.x + a.width + gap > b.x &&
    a.y - gap < b.y + b.height &&
    a.y + a.height + gap > b.y
  )
}

function positionIsFree(item: HomeItem, position: Position, occupied: readonly Rect[]): boolean {
  const candidate: Rect = { ...position, ...item.size }
  return !occupied.some(rect => rectsOverlap(candidate, rect))
}

/** Deterministic release search: preserved position first, then former-folder-centered rings. */
function findReleasePosition(
  item: HomeItem,
  preferred: Position,
  folderPosition: Position,
  occupied: readonly Rect[],
): Position {
  if (positionIsFree(item, preferred, occupied)) return { ...preferred }
  if (positionIsFree(item, folderPosition, occupied)) return { ...folderPosition }

  for (let radius = 1; radius <= 32; radius++) {
    const offsets: Array<readonly [number, number]> = []
    for (let x = -radius; x <= radius; x++) {
      offsets.push([x, -radius], [x, radius])
    }
    for (let y = -radius + 1; y < radius; y++) {
      offsets.push([-radius, y], [radius, y])
    }
    for (const [dx, dy] of offsets) {
      const candidate = {
        x: folderPosition.x + dx * RELEASE_STEP_X,
        y: folderPosition.y + dy * RELEASE_STEP_Y,
      }
      if (positionIsFree(item, candidate, occupied)) return candidate
    }
  }

  // Pathological fully-occupied fallback remains deterministic and avoids data loss.
  return {
    x: folderPosition.x + RELEASE_STEP_X * 33,
    y: folderPosition.y,
  }
}
