/**
 * In-memory catalog and availability resolver for ELIX Shell Namespace.
 *
 * Maintains a demand-driven index of known shell items by ShellItemId and path.
 * Resolves item availability (available, missing, unavailable) dynamically
 * against filesystem reality.
 *
 * @module @deepseek-ai/dsh-shell-namespace/catalog
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { reconcileContainer, type ReconciliationResult } from './reconcile.ts'
import type {
  ShellItem,
  ShellItemId,
  ShellItemResolution,
} from './types.ts'

/**
 * Shell Namespace Catalog.
 */
export class ShellNamespaceCatalog {
  /** Index of all known items by unique ShellItemId. */
  private readonly itemsById = new Map<ShellItemId, ShellItem>()
  /** Secondary index of known items by lowercase canonical path. */
  private readonly itemsByPath = new Map<string, ShellItemId>()
  /** Map of container path to its known item map. */
  private readonly containers = new Map<string, Map<ShellItemId, ShellItem>>()

  /**
   * Retrieves an item from the catalog by its ShellItemId.
   *
   * @param id - ShellItemId to search for.
   * @returns ShellItem copy or undefined.
   */
  get(id: ShellItemId): ShellItem | undefined {
    return this.itemsById.get(id)
  }

  /**
   * Retrieves an item from the catalog by its filesystem path.
   *
   * @param filePath - Filesystem path.
   * @returns ShellItem copy or undefined.
   */
  getByPath(filePath: string): ShellItem | undefined {
    const key = path.resolve(filePath).toLowerCase()
    const id = this.itemsByPath.get(key)
    return id ? this.itemsById.get(id) : undefined
  }

  /**
   * Returns a snapshot map of all currently tracked items in a container.
   *
   * @param containerPath - Container path.
   * @returns ReadonlyMap of ShellItemId to ShellItem.
   */
  getContainerMap(containerPath: string): ReadonlyMap<ShellItemId, ShellItem> {
    const norm = path.resolve(containerPath).toLowerCase()
    return this.containers.get(norm) ?? new Map()
  }

  /**
   * Updates container items and returns reconciliation diff.
   *
   * @param containerPath - Directory container path.
   * @param items - Freshly enumerated items.
   * @returns Reconciliation diff detailing additions, removals, renames, and modifications.
   */
  updateContainer(
    containerPath: string,
    items: readonly ShellItem[],
  ): ReconciliationResult {
    const norm = path.resolve(containerPath).toLowerCase()
    const prevMap = this.containers.get(norm) ?? new Map()

    const result = reconcileContainer(prevMap, items)

    // Update container map
    const nextMap = new Map<ShellItemId, ShellItem>(result.currentMap)
    this.containers.set(norm, nextMap)

    // Update global indexes
    for (const removedId of result.removed) {
      const oldItem = this.itemsById.get(removedId)
      if (oldItem) {
        const itemDir = path.dirname(path.resolve(oldItem.location.path)).toLowerCase()
        if (itemDir === norm) {
          this.itemsByPath.delete(path.resolve(oldItem.location.path).toLowerCase())
          this.itemsById.delete(removedId)
        }
      }
    }

    // Critical: Clean up stale previous paths for renamed items from secondary index
    for (const { previousItem } of result.renamed) {
      this.itemsByPath.delete(path.resolve(previousItem.location.path).toLowerCase())
    }

    for (const item of items) {
      this.itemsById.set(item.id, item)
      this.itemsByPath.set(path.resolve(item.location.path).toLowerCase(), item.id)
    }

    return result
  }

  /**
   * Resolves the real-time availability of an item on disk.
   *
   * @param id - ShellItemId to verify.
   * @returns Availability resolution (available, missing, or unavailable).
   */
  async resolveItem(id: ShellItemId): Promise<ShellItemResolution> {
    const item = this.itemsById.get(id)
    if (!item) {
      return { status: 'missing', itemId: id }
    }

    if (item.kind === 'virtual') {
      return { status: 'available', item }
    }

    try {
      await fs.lstat(item.location.path)
      return { status: 'available', item }
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException
      if (error.code === 'ENOENT') {
        return { status: 'missing', itemId: id }
      }
      return {
        status: 'unavailable',
        itemId: id,
        reason: error.message || 'Access denied or unavailable',
      }
    }
  }

  /**
   * Clears all cached items and container mappings.
   */
  clear(): void {
    this.itemsById.clear()
    this.itemsByPath.clear()
    this.containers.clear()
  }
}
