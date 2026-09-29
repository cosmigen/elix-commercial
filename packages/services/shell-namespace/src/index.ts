/**
 * @deepseek-ai/dsh-shell-namespace — ELIX OS Shell Namespace / File Provider Plugin.
 *
 * Implements an independent, authoritative capability layer over the Cordis plugin host.
 * Owns discovery of filesystem-backed shell items, stable file identity, Windows Known Folders,
 * composite Desktop aggregation (User + Public Desktop), filesystem metadata, shortcut (.lnk)
 * inspection, filesystem change observation, shell-item icon references, and availability state.
 *
 * CRITICAL BOUNDARIES:
 * - Shell Namespace is NOT a File Explorer UI.
 * - Shell Namespace is NOT the Home renderer.
 * - Shell Namespace does NOT own File Operations (copy/move/delete/rename).
 * - Shell Namespace does NOT execute files or shortcuts.
 * - Zero knowledge of Home coordinates, grids, wallpapers, widgets, Dock, or Status Bar.
 * - Home -> Shell Namespace (never Shell Namespace -> Home).
 * - App Registry and Shell Namespace are separate, independent authoritative domains.
 *
 * @module @deepseek-ai/dsh-shell-namespace
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {
  Config,
  DesktopSnapshot,
  KnownFolderId,
  KnownFolderResolution,
  NamespaceSubscription,
  ProviderFault,
  ShellIconReference,
  ShellItem,
  ShellItemId,
  ShellItemResolution,
  ShellLocation,
} from './types.ts'
import { ShellNamespaceEngine } from './engine.ts'
import type { KnownFolderResolver } from './known-folders.ts'
import type { FileIdentityAdapter } from './identity.ts'
import type { ShellLinkResolver } from './shortcuts.ts'
import type { ShellIconResolver } from './icons.ts'
import type { NamespaceWatcher } from './watcher.ts'

export * from './types.ts'
export * from './identity.ts'
export * from './known-folders.ts'
export * from './desktop.ts'
export * from './file-system.ts'
export * from './shortcuts.ts'
export * from './icons.ts'
export * from './watcher.ts'
export * from './reconcile.ts'
export * from './catalog.ts'
export * from './engine.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    shellNamespace: ShellNamespaceService
  }
  interface Events {
    /** Emitted when Shell Namespace finishes initialization and is ready. */
    'shell-namespace/ready'(service: ShellNamespaceService): void
    /** Emitted when a new shell item is added to an observed container. */
    'shell-namespace/item-added'(item: ShellItem): void
    /** Emitted when an existing shell item is removed from an observed container. */
    'shell-namespace/item-removed'(itemId: ShellItemId): void
    /** Emitted when an existing shell item is renamed, preserving stable identity. */
    'shell-namespace/item-renamed'(item: ShellItem, previousItem: ShellItem): void
    /** Emitted when a shell item's contents or attributes are modified. */
    'shell-namespace/item-changed'(item: ShellItem): void
    /** Emitted when a watched container is invalidated or changes. */
    'shell-namespace/container-changed'(containerPath: string): void
    /** Emitted when a known folder resolution changes or is updated. */
    'shell-namespace/known-folder-changed'(
      id: KnownFolderId,
      resolution: KnownFolderResolution,
    ): void
    /** Emitted when a provider or adapter encounters an error. */
    'shell-namespace/provider-fault'(fault: ProviderFault): void
  }
}

/**
 * The ELIX OS Shell Namespace Service.
 */
export class ShellNamespaceService extends Service {
  static Config = z.object({
    enabled: z.boolean().default(true),
    watchDesktopOnStartup: z.boolean().default(false),
    debounceMs: z.number().default(100),
    preferNative: z.boolean().default(true),
  })

  readonly engine: ShellNamespaceEngine
  private readonly config: Config & { preferNative?: boolean }
  private isInitialized = false

  constructor(ctx: Context, config?: Partial<Config & { preferNative?: boolean }>) {
    super(ctx, 'shellNamespace')

    const resolvedConfig = {
      enabled: config?.enabled ?? true,
      watchDesktopOnStartup: config?.watchDesktopOnStartup ?? false,
      debounceMs: config?.debounceMs ?? 100,
      preferNative: config?.preferNative ?? true,
      knownFolderResolver: config?.knownFolderResolver,
      fileIdentityAdapter: config?.fileIdentityAdapter,
      shellLinkResolver: config?.shellLinkResolver,
      iconResolver: config?.iconResolver,
      watcher: config?.watcher,
    }
    this.config = resolvedConfig

    this.engine = new ShellNamespaceEngine({
      knownFolderResolver: resolvedConfig.knownFolderResolver as
        | KnownFolderResolver
        | undefined,
      fileIdentityAdapter: resolvedConfig.fileIdentityAdapter as
        | FileIdentityAdapter
        | undefined,
      shellLinkResolver: resolvedConfig.shellLinkResolver as
        | ShellLinkResolver
        | undefined,
      iconResolver: resolvedConfig.iconResolver as ShellIconResolver | undefined,
      watcher: resolvedConfig.watcher as NamespaceWatcher | undefined,
      debounceMs: resolvedConfig.debounceMs,
      preferNative: resolvedConfig.preferNative,
    })
  }

  /** The active adapter backend ('rust-native' or 'typescript-fallback'). */
  get activeBackend(): 'rust-native' | 'typescript-fallback' {
    return this.engine.activeBackend
  }

  /**
   * Service initialization hook.
   */
  [Service.init](): void {
    if (!this.config.enabled) {
      return
    }

    this.ctx.logger('shell-namespace').info(
      'Shell Namespace initialized using active backend: %s',
      this.engine.activeBackend,
    )

    // 1. Forward engine events to Cordis event bus
    const unbindAdded = this.engine.on('item-added', (item) => {
      this.ctx.emit('shell-namespace/item-added', item)
    })
    const unbindRemoved = this.engine.on('item-removed', (itemId) => {
      this.ctx.emit('shell-namespace/item-removed', itemId)
    })
    const unbindRenamed = this.engine.on('item-renamed', (item, prev) => {
      this.ctx.emit('shell-namespace/item-renamed', item, prev)
    })
    const unbindChanged = this.engine.on('item-changed', (item) => {
      this.ctx.emit('shell-namespace/item-changed', item)
    })
    const unbindContainer = this.engine.on('container-changed', (path) => {
      this.ctx.emit('shell-namespace/container-changed', path)
    })
    const unbindFolder = this.engine.on('known-folder-changed', (id, res) => {
      this.ctx.emit('shell-namespace/known-folder-changed', id, res)
    })
    const unbindFault = this.engine.on('provider-fault', (fault) => {
      this.ctx.emit('shell-namespace/provider-fault', fault)
    })

    // 2. Register Cordis lifecycle disposal effect
    this.ctx.effect(() => () => {
      unbindAdded()
      unbindRemoved()
      unbindRenamed()
      unbindChanged()
      unbindContainer()
      unbindFolder()
      unbindFault()
      this.engine.dispose()
      this.isInitialized = false
    }, 'shellNamespace.lifecycle')

    this.isInitialized = true
    this.ctx.emit('shell-namespace/ready', this)

    // 3. Optionally start watching Desktop on startup
    if (this.config.watchDesktopOnStartup) {
      this.engine.watchDesktop()
    }
  }

  /** Whether the Shell Namespace service is actively initialized and ready. */
  get ready(): boolean {
    return this.isInitialized
  }

  /**
   * Returns a merged snapshot of all active desktop sources (User + Public Desktop).
   */
  async getDesktop(): Promise<DesktopSnapshot> {
    return this.engine.getDesktop()
  }

  /**
   * Returns a list of all aggregated desktop items.
   */
  async listDesktop(): Promise<readonly ShellItem[]> {
    return this.engine.listDesktop()
  }

  /**
   * Enumerates direct children of a container by container ShellItemId.
   */
  async list(containerId: ShellItemId): Promise<readonly ShellItem[]> {
    return this.engine.list(containerId)
  }

  /**
   * Enumerates direct children of a directory by physical filesystem path.
   */
  async listPath(path: string): Promise<readonly ShellItem[]> {
    return this.engine.listPath(path)
  }

  /**
   * Retrieves a cached shell item by its ShellItemId.
   */
  get(itemId: ShellItemId): ShellItem | undefined {
    return this.engine.get(itemId)
  }

  /**
   * Resolves a shell item by its physical or URI location.
   */
  async resolve(location: ShellLocation | string): Promise<ShellItem | undefined> {
    return this.engine.resolve(location)
  }

  /**
   * Resolves the real-time availability status of an item.
   */
  async resolveItem(itemId: ShellItemId): Promise<ShellItemResolution> {
    return this.engine.resolveItem(itemId)
  }

  /**
   * Resolves a Windows Known Folder by identifier.
   */
  async getKnownFolder(id: KnownFolderId): Promise<KnownFolderResolution> {
    return this.engine.getKnownFolder(id)
  }

  /**
   * Returns verified properties for a shell item.
   */
  async getProperties(itemId: ShellItemId): Promise<ShellItem | undefined> {
    return this.engine.getProperties(itemId)
  }

  /**
   * Returns the icon reference associated with a shell item.
   */
  async getIconReference(itemId: ShellItemId): Promise<ShellIconReference> {
    return this.engine.getIconReference(itemId)
  }

  /**
   * Subscribes to changes in a directory container.
   */
  watch(containerPathOrId: string | ShellItemId): NamespaceSubscription {
    return this.engine.watch(containerPathOrId)
  }

  /**
   * Subscribes to changes on the desktop (both User and Public desktop).
   */
  watchDesktop(): NamespaceSubscription {
    return this.engine.watchDesktop()
  }

  /**
   * Manually refreshes a container or the entire catalog.
   */
  async refresh(containerPathOrId?: string | ShellItemId): Promise<void> {
    return this.engine.refresh(containerPathOrId)
  }

  /**
   * Checks whether an item exists and is accessible on disk.
   */
  async exists(itemId: ShellItemId): Promise<boolean> {
    return this.engine.exists(itemId)
  }

  /**
   * Returns direct children of a folder shell item.
   */
  async getChildren(itemId: ShellItemId): Promise<readonly ShellItem[]> {
    return this.engine.getChildren(itemId)
  }
}

export default ShellNamespaceService
