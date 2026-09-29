/**
 * Desktop Projector and Event Reconciler for ELIX Intent Router.
 * Projects real Windows Desktop objects (User Desktop + Public Desktop) from
 * Shell Namespace into Home Screen items, and keeps them reconciled via event observation
 * without duplicate state updates or faked changes.
 *
 * @module @deepseek-ai/dsh-intent-router/desktop-projector
 */

import type { ShellItem, ShellItemId, ShellNamespaceEngine, ShellNamespaceService } from '@deepseek-ai/dsh-shell-namespace'

/** Projected Home item descriptor. */
export interface ProjectedHomeItem {
  readonly id: string
  readonly name?: string | undefined
  readonly type?: string | undefined
  readonly position?: { readonly x: number; readonly y: number } | undefined
  readonly size?: { readonly width: number; readonly height: number } | undefined
  readonly monitorId?: string | undefined
  readonly metadata?: Record<string, unknown> | undefined
}

/** Minimal structural interface of Home service required for desktop projection. */
export interface DesktopProjectorHomeHost {
  monitors: {
    getMonitor(id: string): { id: string; bounds?: { x: number; y: number; width: number; height: number } } | undefined
    getPrimaryMonitor(): { id: string; bounds?: { x: number; y: number; width: number; height: number } }
  }
  items: {
    getItems(): readonly ProjectedHomeItem[]
    getRootItemsForMonitor(monitorId: string): readonly { position: { x: number; y: number }; size: { width: number; height: number } }[]
    addItem(options: Record<string, unknown>): ProjectedHomeItem
    removeItem(id: string): boolean
    renameItem(id: string, name: string): boolean
    updateMetadata(id: string, updater: (prev: Record<string, unknown>) => Record<string, unknown>): ProjectedHomeItem | undefined
  }
  layout: {
    getAvailableBounds(
      monitorId: string,
      monitorBounds?: { x: number; y: number; width: number; height: number },
    ): { x: number; y: number; width: number; height: number }
    getExclusionZones(monitorId: string): readonly unknown[]
    findNearestFreeSlot(
      desired: { x: number; y: number; width: number; height: number },
      occupied: readonly { x: number; y: number; width: number; height: number }[],
      monitorId?: string,
      availableBounds?: { x: number; y: number; width: number; height: number },
    ): { x: number; y: number }
  }
}

/** Options for desktop projection. */
export interface DesktopProjectorOptions {
  /** Target monitor ID. Defaults to Home primary monitor. */
  monitorId?: string | undefined
}

/** Helper to extract shellItemId from item metadata. */
function getMetaShellItemId(it: ProjectedHomeItem): string | undefined {
  if (!it.metadata) return undefined
  const val = (it.metadata as { shellItemId?: unknown }).shellItemId
  return typeof val === 'string' ? val : undefined
}

/**
 * Desktop projection and event reconciliation coordinator.
 */
export class DesktopProjector {
  private projectQueue: Promise<unknown> = Promise.resolve()

  /**
   * Projects real Desktop items from Shell Namespace onto Home Desktop.
   *
   * @param home - Active HomeService instance.
   * @param shellNamespace - Active ShellNamespaceService or ShellNamespaceEngine instance.
   * @param options - Projection options.
   * @returns Array of newly projected Home items.
   */
  async projectDesktop(
    home: DesktopProjectorHomeHost,
    shellNamespace: ShellNamespaceService | ShellNamespaceEngine,
    options?: DesktopProjectorOptions,
  ): Promise<readonly ProjectedHomeItem[]> {
    const run = async (): Promise<readonly ProjectedHomeItem[]> => {
      const monitor = options?.monitorId
        ? home.monitors.getMonitor(options.monitorId) ?? home.monitors.getPrimaryMonitor()
        : home.monitors.getPrimaryMonitor()

      const snapshot = await shellNamespace.getDesktop()
      const existingItems = home.items.getItems()
      const existingShellItemIds = new Set<string>()

      for (const it of existingItems) {
        existingShellItemIds.add(it.id)
        const metaShellId = getMetaShellItemId(it)
        if (metaShellId) {
          existingShellItemIds.add(metaShellId)
        }
      }

      const monitorBounds = monitor.bounds ?? { x: 0, y: 0, width: 1920, height: 1080 }
      const availableBounds = home.layout.getAvailableBounds(monitor.id, monitorBounds)
      const itemSize = { width: 84, height: 96 }
      const newlyAdded: ProjectedHomeItem[] = []

      for (const shellItem of snapshot.items) {
        if (existingShellItemIds.has(shellItem.id)) {
          continue
        }

        // Compute collision-free grid placement, including items newly placed in this batch
        const rootItems = home.items.getRootItemsForMonitor(monitor.id)
        const occupiedRects: { x: number; y: number; width: number; height: number }[] = rootItems
          .map(i => ({ x: i.position.x, y: i.position.y, width: i.size.width, height: i.size.height }))

        for (const added of newlyAdded) {
          const pos = added.position
          const size = added.size
          if (pos !== undefined && size !== undefined) {
            if (!occupiedRects.some(r => r.x === pos.x && r.y === pos.y)) {
              occupiedRects.push({
                x: pos.x,
                y: pos.y,
                width: size.width,
                height: size.height,
              })
            }
          }
        }

        const freePos = typeof home.layout.findNearestFreeSlot === 'function'
          ? home.layout.findNearestFreeSlot(
            { x: availableBounds.x + 24, y: availableBounds.y + 24, ...itemSize },
            occupiedRects,
            monitor.id,
            availableBounds,
          )
          : { x: availableBounds.x + 24, y: availableBounds.y + 24 }

        let type = 'file'
        let metadata: Record<string, unknown> = {}

        if (shellItem.kind === 'shortcut') {
          type = 'shortcut'
          metadata = {
            name: shellItem.displayName.replace(/\.lnk$/i, ''),
            icon: shellItem.icon.kind === 'file' ? shellItem.icon.filePath : '',
            target: shellItem.shortcut?.target ?? shellItem.location.path,
            shellItemId: shellItem.id,
          }
        } else if (shellItem.kind === 'folder' || shellItem.attributes.directory) {
          type = 'folder'
          metadata = {
            name: shellItem.displayName,
            color: '#3b82f6',
            itemIds: [],
            isOpen: false,
            path: shellItem.location.path,
            shellItemId: shellItem.id,
          }
        } else {
          type = 'file'
          metadata = {
            filename: shellItem.displayName,
            path: shellItem.location.path,
            extension: shellItem.extension ?? '',
            fileSize: shellItem.size,
            shellItemId: shellItem.id,
          }
        }

        try {
          const homeItem = home.items.addItem({
            id: `desktop:${shellItem.id}`,
            type,
            monitorId: monitor.id,
            position: freePos,
            size: itemSize,
            metadata,
          })
          newlyAdded.push(homeItem)
          existingShellItemIds.add(shellItem.id)
        } catch {
          // Safe degrade if placement collisions occur
        }
      }

      return newlyAdded
    }

    const nextPromise = this.projectQueue.then(run, run)
    this.projectQueue = nextPromise.catch(() => {})
    return nextPromise
  }

  /**
   * Binds live Shell Namespace change events to automatically reconcile Home items.
   *
   * @param home - Active HomeService instance.
   * @param shellNamespace - Active ShellNamespaceService instance.
   * @returns Disposer function.
   */
  bindChangeObservation(
    home: DesktopProjectorHomeHost,
    shellNamespace: ShellNamespaceService | ShellNamespaceEngine,
  ): () => void {
    const engine = ('engine' in shellNamespace ? shellNamespace.engine : shellNamespace) as
      | ShellNamespaceEngine
      | undefined

    if (!engine || typeof engine.on !== 'function') {
      return () => {}
    }

    const unbindAdded = engine.on('item-added', (shellItem: ShellItem) => {
      if (shellItem.source !== 'user-desktop' && shellItem.source !== 'public-desktop') {
        return
      }

      // Check if already in Home
      const found = home.items.getItems().some(
        it => it.id === `desktop:${shellItem.id}` || getMetaShellItemId(it) === shellItem.id,
      )
      if (found) return

      void this.projectDesktop(home, shellNamespace).catch(() => {})
    })

    const unbindRemoved = engine.on('item-removed', (shellItemId: ShellItemId) => {
      const homeItem = home.items.getItems().find(
        it => it.id === `desktop:${shellItemId}` || getMetaShellItemId(it) === shellItemId,
      )
      if (homeItem) {
        home.items.removeItem(homeItem.id)
      }
    })

    const unbindRenamed = engine.on('item-renamed', (shellItem: ShellItem, previousItem?: ShellItem) => {
      const homeItem = home.items.getItems().find(
        it =>
          it.id === `desktop:${shellItem.id}` ||
          getMetaShellItemId(it) === shellItem.id ||
          (previousItem !== undefined && (it.id === `desktop:${previousItem.id}` || getMetaShellItemId(it) === previousItem.id)),
      )
      if (homeItem) {
        const cleanName = shellItem.kind === 'shortcut'
          ? shellItem.displayName.replace(/\.lnk$/i, '')
          : shellItem.displayName
        home.items.renameItem(homeItem.id, cleanName)
        home.items.updateMetadata(homeItem.id, (prev: Record<string, unknown>) => ({
          ...prev,
          path: shellItem.location.path,
          shellItemId: shellItem.id,
        }))
      }
    })

    const unbindChanged = engine.on('item-changed', (shellItem: ShellItem) => {
      const homeItem = home.items.getItems().find(
        it => it.id === `desktop:${shellItem.id}` || getMetaShellItemId(it) === shellItem.id,
      )
      if (homeItem) {
        home.items.updateMetadata(homeItem.id, (prev: Record<string, unknown>) => ({
          ...prev,
          path: shellItem.location.path,
          fileSize: shellItem.size,
        }))
      }
    })

    return () => {
      unbindAdded()
      unbindRemoved()
      unbindRenamed()
      unbindChanged()
    }
  }
}
