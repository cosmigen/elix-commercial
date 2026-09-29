/**
 * Unified Desktop Item model and manager for the ELIX Home Screen.
 * Provides a singular, clean item abstraction for shortcuts, files, folders,
 * widgets, and system shortcuts, decoupling data state from rendering.
 *
 * @module @deepseek-ai/dsh-home/items
 */

import type { MonitorInfo } from './monitor.ts'
import type { Position, Size } from './types.ts'
import { clampRectToBounds } from './layout.ts'
import type { HomeLayoutEngine } from './layout.ts'

/** Supported desktop item classification types. */
export type HomeItemType =
  | 'shortcut'
  | 'app shortcut'
  | 'file'
  | 'folder'
  | 'widget'
  | 'system'
  | 'system shortcut'

/** Metadata for application shortcuts. */
export interface ShortcutMetadata {
  name: string
  icon: string
  target: string
  appId?: string | undefined
  arguments?: string | undefined
}

/** Metadata for filesystem items placed on desktop. */
export interface FileMetadata {
  path: string
  filename: string
  extension: string
  fileSize?: number | undefined
  mimeType?: string | undefined
}

/** Metadata for desktop folders containing other items. */
export interface FolderMetadata {
  name: string
  color: string
  itemIds: string[]
  isOpen: boolean
  desktopIconSize?: number | undefined
}

/** Metadata for widget instances hosted on the desktop surface. */
export interface WidgetMetadata {
  widgetType: string
  configuration: Record<string, unknown>
  state: Record<string, unknown>
}

/** Metadata for special system shortcuts (e.g. This PC, Settings, Recycle Bin). */
export interface SystemMetadata {
  targetAction: string
  label: string
  icon: string
}

/** Generic metadata union covering all item types. */
export type AnyItemMetadata =
  | ShortcutMetadata
  | FileMetadata
  | FolderMetadata
  | WidgetMetadata
  | SystemMetadata
  | Record<string, unknown>

/**
 * Universal desktop item contract.
 */
export interface HomeItem<TMetadata = AnyItemMetadata> {
  /** Unique item identifier. */
  readonly id: string
  /** Item classification type. */
  readonly type: HomeItemType
  /** Identifier of the monitor where this item resides. */
  readonly monitorId: string
  /** Alias for monitorId per specification. */
  readonly monitor?: string | undefined
  /** 2D coordinate on the desktop work area. */
  readonly position: Position
  /** Bounding box dimension of the item. */
  readonly size: Size
  /** Type-specific item payload. */
  readonly metadata: TMetadata
  /** Containing folder ID if enclosed inside a folder, or undefined if directly on desktop. */
  readonly folderId?: string | undefined
  /** Timestamp when the item was first placed. */
  readonly createdAt: number
  /** Timestamp of the most recent modification. */
  readonly updatedAt: number
}

/** Options for creating a new desktop item. */
export interface CreateHomeItemOptions<TMetadata = AnyItemMetadata> {
  id?: string | undefined
  type: HomeItemType
  monitorId?: string | undefined
  position: Position
  size?: Size | undefined
  folderId?: string | undefined
  metadata: TMetadata
}


/** Callback function for item mutations. */
export type ItemChangeListener = (items: readonly HomeItem[]) => void

/** One item position update committed as part of an atomic Home mutation. */
export interface HomeItemMove {
  readonly id: string
  readonly position: Position
  readonly monitorId?: string | undefined
}

/**
 * Repository and mutation coordinator for desktop items.
 */
export class HomeItemManager {
  private readonly items = new Map<string, HomeItem>()
  private readonly listeners = new Set<ItemChangeListener>()

  constructor(
    private readonly defaultMonitorId: () => string = () => 'primary',
    initialItems?: readonly HomeItem[],
  ) {
    if (initialItems !== undefined) {
      for (const item of initialItems) {
        this.items.set(item.id, this.sanitizeItem(item))
      }
    }
  }

  /** Retrieve all desktop items. */
  getItems(): readonly HomeItem[] {
    return Array.from(this.items.values())
  }

  /** Retrieve all root desktop items (excluding items inside folders). */
  getRootItems(): readonly HomeItem[] {
    return Array.from(this.items.values()).filter(it => it.folderId === undefined)
  }

  /** Retrieve all items residing on a specific monitor. */
  getItemsForMonitor(monitorId: string): readonly HomeItem[] {
    const result: HomeItem[] = []
    for (const item of this.items.values()) {
      if (item.monitorId === monitorId) {
        result.push(item)
      }
    }
    return result
  }

  /** Retrieve all root desktop items residing on a specific monitor (excluding items in folders). */
  getRootItemsForMonitor(monitorId: string): readonly HomeItem[] {
    const result: HomeItem[] = []
    for (const item of this.items.values()) {
      if (item.monitorId === monitorId && item.folderId === undefined) {
        result.push(item)
      }
    }
    return result
  }

  /** Retrieve a single item by ID. */
  getItem<TMetadata = AnyItemMetadata>(id: string): HomeItem<TMetadata> | undefined {
    return this.items.get(id) as HomeItem<TMetadata> | undefined
  }

  /** Subscribe to item collection changes. */
  onChange(listener: ItemChangeListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Create and register a new desktop item.
   */
  addItem<TMetadata = AnyItemMetadata>(options: CreateHomeItemOptions<TMetadata>): HomeItem<TMetadata> {
    const id = options.id ?? `item-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    if (this.items.has(id)) {
      throw new Error(`Item with id "${id}" already exists on desktop.`)
    }

    const defaultSize: Size =
      options.type === 'widget' ? { width: 172, height: 144 } : { width: 84, height: 96 }

    const monitorId = options.monitorId ?? this.defaultMonitorId()

    const item: HomeItem<TMetadata> = {
      id,
      type: options.type,
      monitorId,
      monitor: monitorId,
      position: {
        x: Number.isFinite(options.position.x) ? options.position.x : 0,
        y: Number.isFinite(options.position.y) ? options.position.y : 0,
      },
      size: options.size !== undefined ? { ...options.size } : defaultSize,
      metadata: options.metadata,
      folderId: options.folderId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }

    const sanitized = this.sanitizeItem(item as HomeItem) as HomeItem<TMetadata>
    this.items.set(id, sanitized as HomeItem)
    this.notify()
    return sanitized
  }

  /**
   * Update an item's position on desktop.
   */
  moveItem(id: string, position: Position, monitorId?: string): HomeItem | undefined {
    const existing = this.items.get(id)
    if (existing === undefined) return undefined

    const updated: HomeItem = {
      ...existing,
      monitorId: monitorId ?? existing.monitorId,
      position: {
        x: Number.isFinite(position.x) ? position.x : existing.position.x,
        y: Number.isFinite(position.y) ? position.y : existing.position.y,
      },
      updatedAt: Date.now(),
    }

    this.items.set(id, updated)
    this.notify()
    return updated
  }

  /**
   * Commit several item positions before publishing one collection replacement.
   * Missing item identifiers are ignored and do not prevent valid moves from committing.
   * @param moves - Array of item move specifications.
   * @returns List of updated items that were successfully moved.
   */
  moveItems(moves: readonly HomeItemMove[]): readonly HomeItem[] {
    const updatedItems: HomeItem[] = []
    const timestamp = Date.now()
    for (const move of moves) {
      const existing = this.items.get(move.id)
      if (existing === undefined) continue
      const updated: HomeItem = {
        ...existing,
        monitorId: move.monitorId ?? existing.monitorId,
        monitor: move.monitorId ?? existing.monitorId,
        position: {
          x: Number.isFinite(move.position.x) ? move.position.x : existing.position.x,
          y: Number.isFinite(move.position.y) ? move.position.y : existing.position.y,
        },
        updatedAt: timestamp,
      }
      this.items.set(move.id, updated)
      updatedItems.push(updated)
    }
    if (updatedItems.length > 0) this.notify()
    return updatedItems
  }

  /**
   * Resize an existing item (applicable to widgets and resizable desktop modules).
   */
  resizeItem(id: string, size: Size): HomeItem | undefined {
    const existing = this.items.get(id)
    if (existing === undefined) return undefined

    const updated: HomeItem = {
      ...existing,
      size: {
        width: Math.max(20, Number.isFinite(size.width) ? size.width : existing.size.width),
        height: Math.max(20, Number.isFinite(size.height) ? size.height : existing.size.height),
      },
      updatedAt: Date.now(),
    }

    this.items.set(id, updated)
    this.notify()
    return updated
  }

  /**
   * Mutate an item's metadata.
   */
  updateMetadata<TMetadata = AnyItemMetadata>(
    id: string,
    updater: Partial<TMetadata> | ((prev: TMetadata) => TMetadata),
  ): HomeItem<TMetadata> | undefined {
    const existing = this.items.get(id)
    if (existing === undefined) return undefined

    const nextMetadata =
      typeof updater === 'function'
        ? updater(existing.metadata as TMetadata)
        : { ...(existing.metadata as object), ...(updater as object) }

    const updated: HomeItem = {
      ...existing,
      metadata: nextMetadata as AnyItemMetadata,
      updatedAt: Date.now(),
    }

    this.items.set(id, updated)
    this.notify()
    return updated as HomeItem<TMetadata>
  }

  /**
   * Assign or clear the parent folder containing an item.
   */
  setParentFolder(itemId: string, folderId: string | undefined): boolean {
    const existing = this.items.get(itemId)
    if (existing === undefined) return false
    if (existing.folderId === folderId) return true

    const updated: HomeItem = {
      ...existing,
      folderId,
      updatedAt: Date.now(),
    }

    this.items.set(itemId, updated)
    this.notify()
    return true
  }

  /**
   * Rename an item (supports shortcuts, files, folders, and system shortcuts).
   */
  renameItem(id: string, newName: string): boolean {
    const sanitized = newName.trim().slice(0, 64)
    if (!sanitized) return false

    const item = this.items.get(id)
    if (item === undefined) return false

    if (item.type === 'shortcut' || item.type === 'app shortcut') {
      return this.updateMetadata<Record<string, unknown>>(id, { name: sanitized }) !== undefined
    }
    if (item.type === 'file') {
      const ext = sanitized.includes('.') ? sanitized.split('.').pop() ?? '' : ''
      return this.updateMetadata<Record<string, unknown>>(id, { filename: sanitized, name: sanitized, extension: ext }) !== undefined
    }
    if (item.type === 'folder') {
      return this.updateMetadata<Record<string, unknown>>(id, { name: sanitized }) !== undefined
    }
    if (item.type === 'system' || item.type === 'system shortcut') {
      return this.updateMetadata<Record<string, unknown>>(id, { label: sanitized, name: sanitized }) !== undefined
    }
    return this.updateMetadata<Record<string, unknown>>(id, { name: sanitized, filename: sanitized, label: sanitized }) !== undefined
  }

  /**
   * Reconcile item monitor assignments and bounds when monitor topology changes.
   * If an item's monitor is no longer connected, migrates the item to the primary monitor
   * and clamps its position into the target monitor's available bounds.
   */
  clampItemsToMonitors(
    monitors: readonly MonitorInfo[],
    layoutEngineOrPrimaryId?: HomeLayoutEngine | string,
  ): boolean {
    if (monitors.length === 0) return false

    const explicitPrimaryId = typeof layoutEngineOrPrimaryId === 'string' ? layoutEngineOrPrimaryId : undefined
    const layoutEngine =
      typeof layoutEngineOrPrimaryId === 'object'
        ? layoutEngineOrPrimaryId
        : undefined

    const primaryMonitor =
      (explicitPrimaryId ? monitors.find(m => m.id === explicitPrimaryId) : undefined) ??
      monitors.find(m => m.isPrimary) ??
      monitors[0]
    if (primaryMonitor === undefined) return false
    let changed = false

    for (const [id, item] of this.items.entries()) {
      let targetMon = monitors.find(m => m.id === item.monitorId)
      let needsMonitorMigration = false

      if (targetMon === undefined) {
        targetMon = primaryMonitor
        needsMonitorMigration = true
      }

      const availableBounds =
        layoutEngine !== undefined
          ? layoutEngine.getAvailableBounds(targetMon.id, targetMon.bounds)
          : targetMon.workArea

      const clamped = clampRectToBounds(
        {
          x: item.position.x,
          y: item.position.y,
          width: item.size.width,
          height: item.size.height,
        },
        availableBounds,
      )

      if (
        needsMonitorMigration ||
        clamped.x !== item.position.x ||
        clamped.y !== item.position.y
      ) {
        const updated: HomeItem = {
          ...item,
          monitorId: targetMon.id,
          monitor: targetMon.id,
          position: { x: clamped.x, y: clamped.y },
          updatedAt: Date.now(),
        }
        this.items.set(id, updated)
        changed = true
      }
    }

    if (changed) {
      this.notify()
    }
    return changed
  }

  /**
   * Remove an item from the desktop.
   * Cleans up reciprocal parent-folder and child-folder references to prevent dangling state.
   */
  removeItem(id: string): boolean {
    const existing = this.items.get(id)
    if (existing === undefined) return false

    // If item was inside a folder, remove reference from parent folder
    if (existing.folderId !== undefined) {
      const parentFolder = this.items.get(existing.folderId)
      if (parentFolder !== undefined && parentFolder.type === 'folder') {
        const meta = parentFolder.metadata as FolderMetadata
        if (Array.isArray(meta.itemIds) && meta.itemIds.includes(id)) {
          meta.itemIds = meta.itemIds.filter(itemId => itemId !== id)
        }
      }
    }

    // If item was a folder itself, unlink contained items
    if (existing.type === 'folder') {
      const meta = existing.metadata as FolderMetadata
      if (Array.isArray(meta.itemIds)) {
        for (const childId of meta.itemIds) {
          const child = this.items.get(childId)
          if (child !== undefined && child.folderId === id) {
            this.items.set(childId, { ...child, folderId: undefined, updatedAt: Date.now() })
          }
        }
      }
    }

    this.items.delete(id)
    this.notify()
    return true
  }

  /**
   * Replace the entire items state (e.g. from restored persistence snapshot).
   */
  loadSnapshot(snapshot: readonly HomeItem[]): void {
    this.items.clear()
    for (const item of snapshot) {
      this.items.set(item.id, this.sanitizeItem(item))
    }
    this.notify()
  }

  private sanitizeItem(item: HomeItem): HomeItem {
    return {
      ...item,
      monitor: item.monitorId,
      folderId: typeof item.folderId === 'string' ? item.folderId : undefined,
      position: {
        x: Number.isFinite(item.position.x) ? item.position.x : 0,
        y: Number.isFinite(item.position.y) ? item.position.y : 0,
      },
      size: {
        width: Math.max(20, Number.isFinite(item.size.width) ? item.size.width : 64),
        height: Math.max(20, Number.isFinite(item.size.height) ? item.size.height : 64),
      },
      createdAt: Number.isFinite(item.createdAt) ? item.createdAt : Date.now(),
      updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : Date.now(),
    }
  }


  private notify(): void {
    const list = this.getItems()
    for (const listener of this.listeners) {
      try {
        listener(list)
      } catch (err) {
        console.error('Error in item change listener:', err)
      }
    }
  }
}
