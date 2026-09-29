/**
 * Desktop selection manager for the ELIX Home Screen.
 * Provides single selection, multi-selection, marquee rubber-band calculation,
 * and selection query APIs.
 *
 * @module @deepseek-ai/dsh-home/selection
 */

import type { HomeItem } from './items.ts'
import { rectsIntersect } from './layout.ts'
import type { Rect } from './types.ts'

/** Callback listener for selection changes. */
export type SelectionChangeListener = (selectedIds: readonly string[]) => void

/**
 * Manages item selection state for desktop items.
 */
export class HomeSelectionManager {
  private readonly selectedItemIds = new Set<string>()
  private readonly listeners = new Set<SelectionChangeListener>()

  /** Retrieve all currently selected item IDs. */
  getSelectedIds(): readonly string[] {
    return Array.from(this.selectedItemIds)
  }

  /** Check whether a specific item is selected. */
  isSelected(id: string): boolean {
    return this.selectedItemIds.has(id)
  }

  /** Count of currently selected items. */
  get count(): number {
    return this.selectedItemIds.size
  }

  /** Retrieve the number of currently selected items. */
  getSelectedCount(): number {
    return this.selectedItemIds.size
  }

  /**
   * Select an item.
   * @param id - Item identifier.
   * @param multi - If true, adds to existing selection; otherwise replaces it.
   */
  select(id: string, multi = false): void {
    if (!multi) {
      if (this.selectedItemIds.size === 1 && this.selectedItemIds.has(id)) {
        return
      }
      this.selectedItemIds.clear()
      this.selectedItemIds.add(id)
    } else {
      if (this.selectedItemIds.has(id)) return
      this.selectedItemIds.add(id)
    }
    this.notify()
  }

  /**
   * Deselect a specific item.
   */
  deselect(id: string): boolean {
    if (!this.selectedItemIds.has(id)) return false
    this.selectedItemIds.delete(id)
    this.notify()
    return true
  }

  /**
   * Toggle the selection state of an item.
   */
  toggle(id: string): boolean {
    if (this.selectedItemIds.has(id)) {
      this.selectedItemIds.delete(id)
    } else {
      this.selectedItemIds.add(id)
    }
    this.notify()
    return this.selectedItemIds.has(id)
  }

  /**
   * Select all items or IDs.
   */
  selectAll(itemsOrIds: readonly HomeItem[] | readonly string[], monitorId?: string): void {
    this.selectedItemIds.clear()
    for (const item of itemsOrIds) {
      if (typeof item === 'string') {
        this.selectedItemIds.add(item)
      } else {
        if (item.folderId !== undefined) continue
        if (monitorId === undefined || item.monitorId === monitorId) {
          this.selectedItemIds.add(item.id)
        }
      }
    }
    this.notify()
  }

  /**
   * Clear all selected items.
   */
  clear(): void {
    if (this.selectedItemIds.size === 0) return
    this.selectedItemIds.clear()
    this.notify()
  }

  /**
   * Compute and apply marquee (rubber-band) selection box against desktop items.
   * Items whose bounding rectangles intersect the marquee rectangle are selected.
   * @param marqueeRect - Drag-selection rectangle in monitor coordinate space.
   * @param items - Candidate desktop items.
   * @param multi - Whether to add to existing selection or replace it.
   */
  selectMarquee(marqueeRect: Rect, items: readonly HomeItem[], multi = false): readonly string[] {
    if (!multi) {
      this.selectedItemIds.clear()
    }

    for (const item of items) {
      if (item.folderId !== undefined) continue
      const itemRect: Rect = {
        x: item.position.x,
        y: item.position.y,
        width: item.size.width,
        height: item.size.height,
      }

      if (rectsIntersect(marqueeRect, itemRect, 0)) {
        this.selectedItemIds.add(item.id)
      }
    }

    this.notify()
    return this.getSelectedIds()
  }

  /** Alias for selectMarquee. */
  selectInRect(rect: Rect, items: readonly HomeItem[], multi = false): readonly string[] {
    return this.selectMarquee(rect, items, multi)
  }

  /** Subscribe to selection modifications. */
  onChange(listener: SelectionChangeListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Alias for onChange. */
  onSelectionChange(listener: SelectionChangeListener): () => void {
    return this.onChange(listener)
  }

  private notify(): void {
    const list = this.getSelectedIds()
    for (const listener of this.listeners) {
      try {
        listener(list)
      } catch (err) {
        console.error('Error in selection change listener:', err)
      }
    }
  }
}
