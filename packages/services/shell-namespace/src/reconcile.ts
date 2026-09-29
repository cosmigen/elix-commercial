/**
 * Reconciliation Engine for ELIX Shell Namespace.
 *
 * Compares current directory snapshot against previous state to deduce:
 * - item-added
 * - item-removed
 * - item-renamed (identity-correlated)
 * - item-modified (content timestamp / size change)
 *
 * CRITICAL INVARIANT:
 * Where identity allows it (e.g. filesystem-stable inode/fileId identity),
 * a rename produces `item-renamed` with both the new item state and previous
 * item state, NEVER an unlinked remove + add!
 *
 * @module @deepseek-ai/dsh-shell-namespace/reconcile
 */

import type { ShellItem, ShellItemId } from './types.ts'

/**
 * Result of reconciling two snapshots of a directory container.
 */
export interface ReconciliationResult {
  readonly added: readonly ShellItem[]
  readonly removed: readonly ShellItemId[]
  readonly renamed: readonly { item: ShellItem; previousItem: ShellItem }[]
  readonly modified: readonly ShellItem[]
  readonly currentMap: ReadonlyMap<ShellItemId, ShellItem>
}

/**
 * Reconciles a freshly enumerated item list against the previously tracked items.
 *
 * @param previousMap - Previously known items mapped by ShellItemId.
 * @param currentItems - Freshly enumerated items.
 * @returns Partitioned list of changes and updated item map.
 */
export function reconcileContainer(
  previousMap: ReadonlyMap<ShellItemId, ShellItem>,
  currentItems: readonly ShellItem[],
): ReconciliationResult {
  const added: ShellItem[] = []
  const removed: ShellItemId[] = []
  const renamed: { item: ShellItem; previousItem: ShellItem }[] = []
  const modified: ShellItem[] = []
  const nextMap = new Map<ShellItemId, ShellItem>()

  for (const item of currentItems) {
    nextMap.set(item.id, item)

    const prev = previousMap.get(item.id)
    if (!prev) {
      // Identity was not seen before in this container -> Added
      added.push(item)
    } else {
      // Identity matches! Check for rename vs content modification
      const pathChanged =
        prev.location.path.toLowerCase() !== item.location.path.toLowerCase()
      const nameChanged = prev.displayName !== item.displayName

      if (pathChanged || nameChanged) {
        renamed.push({ item, previousItem: prev })
      } else if (
        (prev.modifiedAt !== undefined &&
          item.modifiedAt !== undefined &&
          prev.modifiedAt !== item.modifiedAt) ||
        (prev.size !== undefined && item.size !== undefined && prev.size !== item.size)
      ) {
        modified.push(item)
      }
    }
  }

  // Check for items that were present previously but are missing now
  for (const [id] of previousMap) {
    if (!nextMap.has(id)) {
      removed.push(id)
    }
  }

  return {
    added: Object.freeze(added),
    removed: Object.freeze(removed),
    renamed: Object.freeze(renamed),
    modified: Object.freeze(modified),
    currentMap: nextMap,
  }
}
