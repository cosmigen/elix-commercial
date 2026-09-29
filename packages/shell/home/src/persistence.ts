/**
 * Safe, atomic persistence manager for ELIX Home Screen state.
 * Uses writeFileAtomic and withFileLock from @deepseek-ai/dsh-atomic-write
 * to guarantee atomic commits and prevent multi-process corruption.
 *
 * @module @deepseek-ai/dsh-home/persistence
 */

import { readFile } from 'node:fs/promises'
import { writeFileAtomic, withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { WidgetInstance } from '@deepseek-ai/dsh-shell-widgets'
import type { HomeItem } from './items.ts'
import type { HomePreferences } from './types.ts'
import type { WallpaperPreferences } from './wallpaper.ts'
import { DEFAULT_WALLPAPER_PREFERENCES } from './wallpaper.ts'

/** Current persistent schema format version. Bumped to 2 for Phase 12 Widget Runtime. */
export const HOME_SCHEMA_VERSION = 2

/** Durable on-disk state representation for ELIX Home. */
export interface HomePersistentState {
  readonly schemaVersion: number
  readonly items: readonly HomeItem[]
  readonly widgets?: readonly WidgetInstance[] | undefined
  readonly wallpaper: WallpaperPreferences
  readonly preferences: HomePreferences
  readonly updatedAt: number
}

/** Default initial Home state. */
export const DEFAULT_HOME_PREFERENCES: HomePreferences = {
  iconSize: 64,
  showLabels: true,
  snapToGrid: true,
  autoAlign: true,
}

export const INITIAL_HOME_STATE: HomePersistentState = {
  schemaVersion: HOME_SCHEMA_VERSION,
  items: [],
  widgets: [],
  wallpaper: DEFAULT_WALLPAPER_PREFERENCES,
  preferences: DEFAULT_HOME_PREFERENCES,
  updatedAt: Date.now(),
}

/** Options for HomePersistenceManager. */
export interface PersistenceOptions {
  /** Explicit filepath override. Defaults to ~/.dsh/elix-home-state.json. */
  filePath?: string | undefined
}

/**
 * Manages atomic saving and loading of the desktop state with schema versioning.
 */
export class HomePersistenceManager {
  readonly filePath: string

  constructor(options?: PersistenceOptions) {
    this.filePath = options?.filePath ?? dshHomePath('elix-home-state.json')
  }

  /**
   * Atomically save the current Home persistent state to disk using a writer lock.
   * Transient handles, HWNDs, or session pointers are strictly excluded.
   */
  async save(state: HomePersistentState): Promise<void> {
    const payload: HomePersistentState = {
      schemaVersion: HOME_SCHEMA_VERSION,
      items: state.items.map(item => ({
        id: item.id,
        type: item.type,
        monitorId: item.monitorId,
        position: { x: item.position.x, y: item.position.y },
        size: { width: item.size.width, height: item.size.height },
        metadata: item.metadata,
        folderId: item.folderId,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      })),
      widgets: (state.widgets ?? []).map(widget => ({
        id: widget.id,
        definitionId: widget.definitionId,
        ownerId: widget.ownerId,
        monitorId: widget.monitorId,
        position: { x: widget.position.x, y: widget.position.y },
        size: { width: widget.size.width, height: widget.size.height },
        zOrder: widget.zOrder,
        configuration: widget.configuration,
        state: widget.state,
        lifecycle: widget.lifecycle,
        suspended: widget.suspended ?? (widget.lifecycle === 'suspended'),
        createdAt: widget.createdAt,
        updatedAt: widget.updatedAt,
      })),
      wallpaper: { ...state.wallpaper },
      preferences: { ...state.preferences },
      updatedAt: Date.now(),
    }

    const content = JSON.stringify(payload, null, 2)

    await withFileLock(this.filePath, async () => {
      await writeFileAtomic(this.filePath, content, { mode: 0o600 })
    })
  }

  /**
   * Load the Home persistent state from disk.
   * If the file does not exist or contains invalid JSON, falls back gracefully to default state.
   * Migrates legacy Phase 8 schemaVersion 1 to Phase 12 schemaVersion 2.
   */
  async load(): Promise<HomePersistentState> {
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed: unknown = JSON.parse(raw)

      if (typeof parsed !== 'object' || parsed === null) {
        return { ...INITIAL_HOME_STATE }
      }

      const obj = parsed as Partial<HomePersistentState>
      void (typeof obj.schemaVersion === 'number' ? obj.schemaVersion : 1)

      const rawItems = Array.isArray(obj.items) ? (obj.items as HomeItem[]) : []
      const wallpaper = obj.wallpaper !== undefined ? obj.wallpaper : DEFAULT_WALLPAPER_PREFERENCES
      const preferences = obj.preferences !== undefined ? obj.preferences : DEFAULT_HOME_PREFERENCES

      // Authoritative v2 items collection: legacy widget items are strictly consumed and excluded
      const items: HomeItem[] = rawItems.filter(item => item.type !== 'widget')
      const widgets: WidgetInstance[] = []

      const rawWidgets: unknown = obj.widgets
      if (Array.isArray(rawWidgets) && rawWidgets.length > 0) {
        for (const candidate of rawWidgets) {
          if (candidate !== null && typeof candidate === 'object') {
            const w = candidate as Partial<WidgetInstance>
            if (typeof w.id === 'string' && typeof w.definitionId === 'string') {
              widgets.push(candidate as WidgetInstance)
            }
          }
        }
      }

      // Migration: consume any legacy widget items from rawItems and convert to WidgetInstance
      for (const item of rawItems) {
        if (item.type === 'widget') {
          if (!widgets.some(w => w.id === item.id)) {
            const meta = item.metadata as Record<string, unknown>
            widgets.push({
              id: item.id,
              definitionId: typeof meta.widgetType === 'string' ? meta.widgetType : 'clock',
              ownerId: 'elix.builtin',
              monitorId: item.monitorId,
              position: { x: item.position.x, y: item.position.y },
              size: { width: item.size.width, height: item.size.height },
              zOrder: 1,
              configuration: (meta.configuration as Record<string, unknown> | undefined) ?? {},
              state: (meta.state as Record<string, unknown> | undefined) ?? {},
              lifecycle: 'mounted',
              suspended: false,
              createdAt: item.createdAt,
              updatedAt: item.updatedAt,
            })
          }
        }
      }

      return {
        schemaVersion: HOME_SCHEMA_VERSION,
        items,
        widgets,
        wallpaper,
        preferences,
        updatedAt: typeof obj.updatedAt === 'number' ? obj.updatedAt : Date.now(),
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { ...INITIAL_HOME_STATE }
      }
      // Log corrupt JSON warning and recover with safe initial state
      console.warn(`HomePersistenceManager: failed to read ${this.filePath}; recovering with initial defaults:`, error)
      return { ...INITIAL_HOME_STATE }
    }
  }
}
