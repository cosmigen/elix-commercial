/**
 * Shell Namespace Orchestration Engine.
 *
 * Coordinates Known Folders, Desktop aggregation, demand-driven filesystem
 * enumeration, change watchers, catalog indexing, and typed event dispatching.
 *
 * @module @deepseek-ai/dsh-shell-namespace/engine
 */

import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ShellNamespaceCatalog } from './catalog.ts'
import { DesktopAggregator } from './desktop.ts'
import { FileSystemProvider } from './file-system.ts'
import type { FileIdentityAdapter } from './identity.ts'
import { DefaultFileIdentityAdapter } from './identity.ts'
import type { ShellIconResolver } from './icons.ts'
import { DefaultShellIconResolver } from './icons.ts'
import type { KnownFolderResolver } from './known-folders.ts'
import { WindowsKnownFolderResolver } from './known-folders.ts'
import type { ShellLinkResolver } from './shortcuts.ts'
import { DefaultShellLinkResolver } from './shortcuts.ts'
import type { NamespaceWatcher } from './watcher.ts'
import { DefaultNamespaceWatcher } from './watcher.ts'
import {
  NativeBridgeClient,
  NativeFileIdentityAdapter,
  NativeKnownFolderResolver,
  NativeNamespaceWatcherAdapter,
  NativeShellIconResolver,
  NativeShellLinkResolver,
  getSharedNativeBridge,
} from '@deepseek-ai/dsh-native-core'
import type {
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

/** Event listener callback type. */
type Listener<T = void> = (arg: T) => void

/**
 * Core event map dispatched by the Shell Namespace Engine.
 */
export interface ShellNamespaceEngineEvents {
  'item-added': (item: ShellItem) => void
  'item-removed': (itemId: ShellItemId) => void
  'item-renamed': (item: ShellItem, previousItem: ShellItem) => void
  'item-changed': (item: ShellItem) => void
  'container-changed': (containerPath: string) => void
  'known-folder-changed': (id: KnownFolderId, resolution: KnownFolderResolution) => void
  'provider-fault': (fault: ProviderFault) => void
}

/**
 * Options for instantiating the Shell Namespace Engine.
 */
export interface ShellNamespaceEngineOptions {
  knownFolderResolver?: KnownFolderResolver | undefined
  fileIdentityAdapter?: FileIdentityAdapter | undefined
  shellLinkResolver?: ShellLinkResolver | undefined
  iconResolver?: ShellIconResolver | undefined
  watcher?: NamespaceWatcher | undefined
  debounceMs?: number | undefined
  /** Explicit NativeBridgeClient instance. */
  bridgeClient?: NativeBridgeClient | undefined
  /** Whether to prefer native adapters when available. Default true. */
  preferNative?: boolean | undefined
}

/**
 * The authoritative Shell Namespace Engine.
 */
export class ShellNamespaceEngine {
  readonly catalog: ShellNamespaceCatalog
  readonly knownFolders: KnownFolderResolver
  readonly fileSystem: FileSystemProvider
  readonly desktop: DesktopAggregator
  readonly watcher: NamespaceWatcher
  readonly identityAdapter: FileIdentityAdapter
  readonly linkResolver: ShellLinkResolver
  readonly iconResolver: ShellIconResolver
  readonly activeBackend: 'rust-native' | 'typescript-fallback'
  readonly bridgeClient?: NativeBridgeClient | undefined

  private readonly eventListeners = new Map<string, Set<Listener<unknown>>>()
  private readonly activeSubscriptions: NamespaceSubscription[] = []
  private isDisposed = false

  constructor(options?: ShellNamespaceEngineOptions) {
    this.catalog = new ShellNamespaceCatalog()

    const hasCustomAdapters =
      options?.knownFolderResolver !== undefined ||
      options?.fileIdentityAdapter !== undefined ||
      options?.shellLinkResolver !== undefined ||
      options?.iconResolver !== undefined ||
      options?.watcher !== undefined

    const shouldAttemptNative = options?.preferNative ?? (!hasCustomAdapters && NativeBridgeClient.isAvailable())

    let bridge: NativeBridgeClient | undefined
    if (shouldAttemptNative) {
      if (options?.bridgeClient) {
        bridge = options.bridgeClient
      } else if (NativeBridgeClient.isAvailable()) {
        bridge = getSharedNativeBridge()
      }
    }

    if (bridge && !hasCustomAdapters) {
      this.activeBackend = 'rust-native'
      this.bridgeClient = bridge
      this.knownFolders = new NativeKnownFolderResolver(bridge)
      this.identityAdapter = new NativeFileIdentityAdapter(bridge)
      this.iconResolver = new NativeShellIconResolver(bridge)
      this.linkResolver = new NativeShellLinkResolver(bridge)
      this.watcher = new NativeNamespaceWatcherAdapter(
        bridge,
        options?.debounceMs !== undefined ? { debounceMs: options.debounceMs } : undefined,
      )
    } else {
      this.activeBackend = 'typescript-fallback'
      this.bridgeClient = undefined
      this.knownFolders =
        options?.knownFolderResolver ?? new WindowsKnownFolderResolver()
      this.identityAdapter =
        options?.fileIdentityAdapter ?? new DefaultFileIdentityAdapter()
      this.iconResolver =
        options?.iconResolver ?? new DefaultShellIconResolver()
      this.linkResolver =
        options?.shellLinkResolver ?? new DefaultShellLinkResolver()
      this.watcher =
        options?.watcher ??
        new DefaultNamespaceWatcher(
          options?.debounceMs !== undefined ? { debounceMs: options.debounceMs } : undefined,
        )
    }

    this.fileSystem = new FileSystemProvider({
      identityAdapter: this.identityAdapter,
      iconResolver: this.iconResolver,
      linkResolver: this.linkResolver,
    })

    this.desktop = new DesktopAggregator({
      knownFolderResolver: this.knownFolders,
      fileSystemProvider: this.fileSystem,
    })
  }

  /**
   * Registers an event listener on the engine.
   *
   * @param event - Event name.
   * @param listener - Callback function.
   * @returns Disposer function.
   */
  on<K extends keyof ShellNamespaceEngineEvents>(
    event: K,
    listener: ShellNamespaceEngineEvents[K],
  ): () => void {
    let set = this.eventListeners.get(event)
    if (!set) {
      set = new Set()
      this.eventListeners.set(event, set)
    }
    const genericFn = listener as (...args: unknown[]) => void
    set.add(genericFn)
    return () => {
      set.delete(genericFn)
    }
  }

  /**
   * Emits an engine event to registered listeners.
   */
  private emit<K extends keyof ShellNamespaceEngineEvents>(
    event: K,
    ...args: Parameters<ShellNamespaceEngineEvents[K]>
  ): void {
    const set = this.eventListeners.get(event)
    if (set) {
      for (const fn of set) {
        try {
          Reflect.apply(fn, undefined, args)
        } catch {
          // Fault resilience
        }
      }
    }
  }

  /**
   * Returns a merged snapshot of all active desktop sources (User + Public Desktop).
   */
  async getDesktop(signal?: AbortSignal): Promise<DesktopSnapshot> {
    try {
      const snapshot = await this.desktop.getSnapshot(signal)

      // Update catalog with user and public desktop contents
      if (snapshot.userDesktopPath) {
        const userItems = snapshot.items.filter(i => i.source === 'user-desktop')
        this.catalog.updateContainer(snapshot.userDesktopPath, userItems)
      }
      if (snapshot.publicDesktopPath) {
        const pubItems = snapshot.items.filter(i => i.source === 'public-desktop')
        this.catalog.updateContainer(snapshot.publicDesktopPath, pubItems)
      }

      return snapshot
    } catch (err: unknown) {
      this.emit('provider-fault', {
        provider: 'DesktopAggregator',
        error: err instanceof Error ? err : new Error(String(err)),
        timestamp: Date.now(),
      })
      return {
        items: [],
        timestamp: Date.now(),
      }
    }
  }

  /**
   * Returns array of aggregated desktop items.
   */
  async listDesktop(signal?: AbortSignal): Promise<readonly ShellItem[]> {
    const snapshot = await this.getDesktop(signal)
    return snapshot.items
  }

  /**
   * Enumerates items in a container by container ShellItemId.
   */
  async list(
    containerId: ShellItemId,
    signal?: AbortSignal,
  ): Promise<readonly ShellItem[]> {
    const containerItem = this.catalog.get(containerId)
    if (!containerItem || (containerItem.kind !== 'folder' && !containerItem.attributes.directory)) {
      return []
    }
    return this.listPath(containerItem.location.path, signal)
  }

  /**
   * Enumerates items in a directory container by physical path.
   */
  async listPath(
    containerPath: string,
    signal?: AbortSignal,
  ): Promise<readonly ShellItem[]> {
    try {
      const items = await this.fileSystem.listDirectory(containerPath, { signal })
      this.catalog.updateContainer(containerPath, items)
      return items
    } catch (err: unknown) {
      this.emit('provider-fault', {
        provider: 'FileSystemProvider',
        error: err instanceof Error ? err : new Error(String(err)),
        timestamp: Date.now(),
      })
      return []
    }
  }

  /**
   * Retrieves a cached shell item by its ShellItemId.
   */
  get(itemId: ShellItemId): ShellItem | undefined {
    return this.catalog.get(itemId)
  }

  /**
   * Resolves a shell item by its physical or URI location.
   */
  async resolve(location: ShellLocation | string): Promise<ShellItem | undefined> {
    let targetPath: string
    if (typeof location === 'string') {
      targetPath = location
    } else if (location.path) {
      targetPath = location.path
    } else if (location.uri) {
      targetPath = location.uri
    } else {
      return undefined
    }

    if (targetPath.startsWith('file://')) {
      try {
        targetPath = fileURLToPath(targetPath)
      } catch {
        // Degrade cleanly
      }
    }

    const cached = this.catalog.getByPath(targetPath)
    if (cached) {
      return cached
    }

    try {
      const item = await this.fileSystem.getItem(targetPath)
      if (item) {
        const parentDir = path.dirname(item.location.path)
        const existing = Array.from(this.catalog.getContainerMap(parentDir).values())
          .filter(
            i =>
              i.id !== item.id &&
              path.resolve(i.location.path).toLowerCase() !==
                path.resolve(item.location.path).toLowerCase(),
          )
        this.catalog.updateContainer(parentDir, [...existing, item])
      }
      return item
    } catch (err: unknown) {
      this.emit('provider-fault', {
        provider: 'FileSystemProvider',
        error: err instanceof Error ? err : new Error(String(err)),
        timestamp: Date.now(),
      })
      return undefined
    }
  }

  /**
   * Resolves the real-time availability status of an item.
   */
  async resolveItem(itemId: ShellItemId): Promise<ShellItemResolution> {
    return this.catalog.resolveItem(itemId)
  }

  /**
   * Resolves a Windows Known Folder.
   */
  async getKnownFolder(id: KnownFolderId): Promise<KnownFolderResolution> {
    return this.knownFolders.resolve(id)
  }

  /**
   * Returns properties for a shell item.
   */
  async getProperties(itemId: ShellItemId): Promise<ShellItem | undefined> {
    const resolution = await this.resolveItem(itemId)
    if (resolution.status === 'available') {
      return resolution.item
    }
    return undefined
  }

  /**
   * Returns icon reference for an item.
   */
  getIconReference(itemId: ShellItemId): Promise<ShellIconReference> {
    const item = this.catalog.get(itemId)
    if (item) {
      return Promise.resolve(item.icon)
    }
    return Promise.resolve({
      kind: 'fallback',
      defaultIconId: 'generic-file',
    })
  }

  /**
   * Checks whether an item exists on disk and is available.
   */
  async exists(itemId: ShellItemId): Promise<boolean> {
    const res = await this.resolveItem(itemId)
    return res.status === 'available'
  }

  /**
   * Returns direct children of a folder container.
   */
  async getChildren(
    itemId: ShellItemId,
    signal?: AbortSignal,
  ): Promise<readonly ShellItem[]> {
    return this.list(itemId, signal)
  }

  /**
   * Refreshes a container or the entire catalog.
   */
  async refresh(containerPathOrId?: string | ShellItemId): Promise<void> {
    if (!containerPathOrId) {
      await this.getDesktop()
      return
    }

    if (typeof containerPathOrId === 'string') {
      await this.listPath(containerPathOrId)
    } else {
      await this.list(containerPathOrId)
    }
  }

  /**
   * Watches a container for filesystem changes.
   */
  watch(containerPathOrId: string | ShellItemId): NamespaceSubscription {
    if (containerPathOrId === 'Desktop') {
      return this.watchDesktop()
    }

    let containerPath: string
    if (typeof containerPathOrId === 'string') {
      containerPath = containerPathOrId
    } else {
      const item = this.catalog.get(containerPathOrId)
      if (!item) {
        return { path: String(containerPathOrId), dispose: () => {} }
      }
      containerPath = item.location.path
    }

    const sub = this.watcher.watch(containerPath, (changedPath) => {
      return this.handleDirectoryChange(changedPath)
    })

    this.activeSubscriptions.push(sub)

    return {
      path: containerPath,
      dispose: () => {
        sub.dispose()
        const idx = this.activeSubscriptions.indexOf(sub)
        if (idx !== -1) {
          this.activeSubscriptions.splice(idx, 1)
        }
      },
    }
  }

  /**
   * Watches both User Desktop and Public Desktop directories.
   */
  watchDesktop(): NamespaceSubscription {
    const subs: NamespaceSubscription[] = []
    let isSubDisposed = false

    void Promise.all([
      this.knownFolders.resolve('Desktop'),
      this.knownFolders.resolve('PublicDesktop'),
    ]).then(([userRes, pubRes]) => {
      if (this.isDisposed || isSubDisposed) return
      if (userRes.available && userRes.path) {
        subs.push(this.watch(userRes.path))
      }
      if (pubRes.available && pubRes.path) {
        subs.push(this.watch(pubRes.path))
      }
    })

    return {
      path: 'Desktop',
      dispose: () => {
        isSubDisposed = true
        for (const s of subs) {
          s.dispose()
        }
        subs.length = 0
      },
    }
  }

  /**
   * Handles coalesced directory change event and emits normalized events.
   */
  private async handleDirectoryChange(containerPath: string): Promise<void> {
    if (this.isDisposed) return

    try {
      // Re-enumerate directory
      const newItems = await this.fileSystem.listDirectory(containerPath)
      const diff = this.catalog.updateContainer(containerPath, newItems)

      // Emit normalized events
      for (const added of diff.added) {
        this.emit('item-added', added)
      }

      for (const renamed of diff.renamed) {
        this.emit('item-renamed', renamed.item, renamed.previousItem)
      }

      for (const modified of diff.modified) {
        this.emit('item-changed', modified)
      }

      for (const removedId of diff.removed) {
        this.emit('item-removed', removedId)
      }

      this.emit('container-changed', containerPath)
    } catch (err: unknown) {
      this.emit('provider-fault', {
        provider: 'ChangeWatcher',
        error: err instanceof Error ? err : new Error(String(err)),
        timestamp: Date.now(),
      })
      throw err
    }
  }

  /**
   * Disposes the engine, closes all watchers, clears timers and subscriptions.
   */
  dispose(): void {
    if (this.isDisposed) return
    this.isDisposed = true

    for (const sub of this.activeSubscriptions) {
      try {
        sub.dispose()
      } catch {
        // Ignore
      }
    }
    this.activeSubscriptions.length = 0

    this.watcher.dispose()
    this.catalog.clear()
    this.eventListeners.clear()
  }
}
