/**
 * Core transactional catalog, provider coordination, and query engine.
 *
 * Implements:
 * 1. Transactional atomic snapshot replacement: a provider failure never leaves
 *    the catalog in a corrupted or partially-updated state.
 * 2. Missing application resolution: preserves caller references (e.g. Home desktop shortcuts)
 *    when software is uninstalled without removing items from user space.
 * 3. Event-driven lifecycle notifications with duplicate-event suppression.
 * 4. Pluggable discovery providers and launch adapters.
 *
 * @module @deepseek-ai/dsh-app-registry/registry
 */

import type {
  AppDiscoveryProvider,
  AppId,
  AppLaunchAdapter,
  AppLaunchOptions,
  AppLaunchResult,
  AppRecord,
  AppRegistryRefreshResult,
  AppResolution,
  AppSearchOptions,
  DiscoveredApplication,
  ProviderFault,
} from './types.ts'
import { deduplicateAndReconcile } from './reconcile.ts'
import { hasAppRecordChanged } from './normalize.ts'
import { searchApplications } from './search.ts'
import { DefaultAppLaunchAdapter } from './launch.ts'
import { AppRegistryCacheManager } from './cache.ts'
import {
  NativeAppLaunchAdapter,
  NativeBridgeClient,
  getSharedNativeBridge,
} from '@deepseek-ai/dsh-native-core'

/** Event listener subscription remover. */
export type RegistryDisposer = () => void

/**
 * Event callbacks emitted by {@link AppRegistryEngine}.
 */
export interface RegistryEventMap {
  'ready'?: () => void
  'refresh-started'?: () => void
  'refresh-completed'?: (result: AppRegistryRefreshResult) => void
  'app-added'?: (app: AppRecord) => void
  'app-updated'?: (app: AppRecord) => void
  'app-removed'?: (appId: AppId) => void
  'provider-fault'?: (fault: ProviderFault) => void
  'launch-requested'?: (appId: AppId) => void
  'launch-succeeded'?: (appId: AppId, result: AppLaunchResult) => void
  'launch-failed'?: (appId: AppId, error: Error) => void
}

/**
 * Configuration options for {@link AppRegistryEngine}.
 */
export interface RegistryEngineOptions {
  readonly cacheManager?: AppRegistryCacheManager | undefined
  readonly launchAdapter?: AppLaunchAdapter | undefined
  readonly providers?: readonly AppDiscoveryProvider[] | undefined
  readonly providerTimeoutMs?: number | undefined
  readonly bridgeClient?: NativeBridgeClient | undefined
  readonly preferNative?: boolean | undefined
}

/**
 * The core Application Registry engine.
 */
type RegistryEventListener = (...args: readonly unknown[]) => void

export class AppRegistryEngine {
  private catalog = new Map<AppId, AppRecord>()
  private readonly providers = new Map<string, AppDiscoveryProvider>()
  private readonly cacheManager: AppRegistryCacheManager
  readonly launchAdapter: AppLaunchAdapter
  private readonly providerTimeoutMs: number
  private readonly listeners = new Map<keyof RegistryEventMap, Set<RegistryEventListener>>()
  readonly activeLaunchBackend: 'rust-native' | 'typescript-fallback'

  private refreshAbortController: AbortController | null = null
  private currentRefreshPromise: Promise<AppRegistryRefreshResult> | null = null
  private isDisposed = false

  constructor(options?: RegistryEngineOptions) {
    this.cacheManager = options?.cacheManager ?? new AppRegistryCacheManager()
    this.providerTimeoutMs = options?.providerTimeoutMs ?? 10_000

    if (options?.launchAdapter) {
      this.launchAdapter = options.launchAdapter
      this.activeLaunchBackend = 'typescript-fallback'
    } else {
      const shouldAttemptNative = options?.preferNative ?? NativeBridgeClient.isAvailable()
      let bridge: NativeBridgeClient | undefined
      if (shouldAttemptNative) {
        bridge = options?.bridgeClient ?? (NativeBridgeClient.isAvailable() ? getSharedNativeBridge() : undefined)
      }

      if (bridge) {
        this.launchAdapter = new NativeAppLaunchAdapter(bridge)
        this.activeLaunchBackend = 'rust-native'
      } else {
        this.launchAdapter = new DefaultAppLaunchAdapter()
        this.activeLaunchBackend = 'typescript-fallback'
      }
    }

    if (options?.providers) {
      for (const provider of options.providers) {
        this.registerProvider(provider)
      }
    }
  }

  /**
   * Registers an application discovery provider.
   *
   * @param provider - Discovery provider implementation.
   * @returns Unregistration disposer.
   */
  registerProvider(provider: AppDiscoveryProvider): RegistryDisposer {
    this.providers.set(provider.id, provider)
    return () => {
      this.providers.delete(provider.id)
    }
  }

  /**
   * Subscribes to registry lifecycle and catalog mutation events.
   *
   * @template K - Event name.
   * @param event - Event key.
   * @param listener - Callback function.
   * @returns Subscription disposer.
   */
  on<K extends keyof RegistryEventMap>(event: K, listener: NonNullable<RegistryEventMap[K]>): RegistryDisposer {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    const genericListener = listener as unknown as RegistryEventListener
    set.add(genericListener)
    return () => {
      set.delete(genericListener)
    }
  }

  /**
   * Dispatches a typed event to registered listeners.
   */
  private emit(event: keyof RegistryEventMap, ...args: readonly unknown[]): void {
    const set = this.listeners.get(event)
    if (set) {
      for (const listener of set) {
        try {
          listener(...args)
        } catch {
          // Swallow listener errors to protect registry loop
        }
      }
    }
  }

  /**
   * Returns a frozen list of all available applications in the catalog.
   */
  list(): readonly AppRecord[] {
    return Object.freeze(Array.from(this.catalog.values()))
  }

  /**
   * Retrieves an application record by its unique AppId.
   */
  get(appId: AppId): AppRecord | undefined {
    return this.catalog.get(appId)
  }

  /**
   * Resolves the availability of an application by its AppId.
   * Returns `{ status: 'available', app }` if found, or `{ status: 'missing', appId }` if absent.
   */
  resolve(appId: AppId): AppResolution {
    const record = this.catalog.get(appId)
    if (record) {
      return {
        status: 'available',
        app: record,
      }
    }
    return {
      status: 'missing',
      appId,
    }
  }

  /**
   * Searches the application catalog using deterministic ranking.
   */
  search(query: string, options?: AppSearchOptions): readonly AppRecord[] {
    return searchApplications(this.list(), query, options)
  }

  /**
   * Loads cached application metadata into the active catalog snapshot.
   *
   * @returns True if valid cache was found and populated.
   */
  async loadCache(): Promise<boolean> {
    const cached = await this.cacheManager.load()
    if (!cached || cached.length === 0) {
      return false
    }

    const nextCatalog = new Map<AppId, AppRecord>()
    for (const app of cached) {
      nextCatalog.set(app.id, app)
    }

    this.catalog = nextCatalog
    return true
  }

  /**
   * Executes a full transactional discovery scan across all registered providers.
   * Atomically replaces the active catalog snapshot upon completion.
   *
   * @param signal - Optional cancellation signal.
   * @returns Aggregate refresh summary.
   */
  async refresh(signal?: AbortSignal): Promise<AppRegistryRefreshResult> {
    if (this.isDisposed) {
      return {
        totalApps: 0,
        addedCount: 0,
        updatedCount: 0,
        removedCount: 0,
        durationMs: 0,
        faults: [],
      }
    }

    // Coalesce concurrent refresh calls to share the in-flight operation safely
    if (this.currentRefreshPromise) {
      return this.currentRefreshPromise
    }

    const abortCtrl = new AbortController()
    this.refreshAbortController = abortCtrl

    const refreshPromise = this.executeRefresh(abortCtrl, signal)
    this.currentRefreshPromise = refreshPromise

    try {
      return await refreshPromise
    } finally {
      this.refreshAbortController = null
      this.currentRefreshPromise = null
    }
  }

  private async executeRefresh(
    abortCtrl: AbortController,
    externalSignal?: AbortSignal,
  ): Promise<AppRegistryRefreshResult> {
    const combinedSignal = externalSignal
      ? AbortSignal.any([externalSignal, abortCtrl.signal])
      : abortCtrl.signal

    const startTime = Date.now()
    this.emit('refresh-started')

    const allDiscoveries: DiscoveredApplication[] = []
    const faults: ProviderFault[] = []

    // 1. Run all providers concurrently with fault isolation
    const providerPromises = Array.from(this.providers.values()).map(async (provider) => {
      try {
        const timeoutController = new AbortController()
        const timerId = setTimeout(() => {
          timeoutController.abort(new Error(`Provider "${provider.id}" timed out after ${this.providerTimeoutMs}ms`))
        }, this.providerTimeoutMs)

        const providerSignal = AbortSignal.any([combinedSignal, timeoutController.signal])

        try {
          const results = await provider.discover(providerSignal)
          for (const item of results) {
            allDiscoveries.push(item)
          }
        } finally {
          clearTimeout(timerId)
        }
      } catch (err) {
        const fault: ProviderFault = {
          providerId: provider.id,
          error: err instanceof Error ? err.message : String(err),
          timestamp: Date.now(),
        }
        faults.push(fault)
        this.emit('provider-fault', fault)
      }
    })

    await Promise.all(providerPromises)

    // Check if refresh was cancelled or engine was disposed before committing
    if (combinedSignal.aborted || this.isDisposed) {
      return {
        totalApps: this.catalog.size,
        addedCount: 0,
        updatedCount: 0,
        removedCount: 0,
        durationMs: Date.now() - startTime,
        faults: Object.freeze(faults),
      }
    }

    // 2. Normalize, deduplicate, and reconcile candidate catalog atomically
    const nextCatalog = deduplicateAndReconcile(allDiscoveries, this.catalog, Date.now())

    // 3. Compute differences between previous and next catalog
    const prevCatalog = this.catalog
    const added: AppRecord[] = []
    const updated: AppRecord[] = []
    const removedIds: AppId[] = []

    for (const [id, nextApp] of nextCatalog) {
      const prevApp = prevCatalog.get(id)
      if (!prevApp) {
        added.push(nextApp)
      } else if (hasAppRecordChanged(prevApp, nextApp)) {
        updated.push(nextApp)
      }
    }

    for (const id of prevCatalog.keys()) {
      if (!nextCatalog.has(id)) {
        removedIds.push(id)
      }
    }

    // 4. Commit atomic catalog replacement
    this.catalog = nextCatalog

    // 5. Emit granular mutation events
    for (const app of added) {
      this.emit('app-added', app)
    }
    for (const app of updated) {
      this.emit('app-updated', app)
    }
    for (const id of removedIds) {
      this.emit('app-removed', id)
    }

    // 6. Save new cache to disk
    const recordsToCache = this.list()
    try {
      await this.cacheManager.save(recordsToCache)
    } catch {
      // Ignore cache write errors during background refresh
    }

    const durationMs = Date.now() - startTime
    const result: AppRegistryRefreshResult = {
      totalApps: this.catalog.size,
      addedCount: added.length,
      updatedCount: updated.length,
      removedCount: removedIds.length,
      durationMs,
      faults: Object.freeze(faults),
    }

    this.emit('refresh-completed', result)
    return result
  }

  /**
   * Launches an application specified by its AppId.
   *
   * @param appId - Unique application identifier.
   * @param options - Additional launch parameters.
   * @returns Launch outcome.
   */
  async launch(appId: AppId, options?: AppLaunchOptions): Promise<AppLaunchResult> {
    this.emit('launch-requested', appId)

    const resolution = this.resolve(appId)
    if (resolution.status === 'missing') {
      const err = new Error(`Application "${appId as string}" is not installed or missing`)
      this.emit('launch-failed', appId, err)
      return {
        success: false,
        error: err.message,
      }
    }

    const { launch: spec } = resolution.app

    try {
      let result: AppLaunchResult
      switch (spec.kind) {
        case 'win32':
          result = await this.launchAdapter.launchWin32(spec, options)
          break
        case 'packaged':
          result = await this.launchAdapter.launchPackaged(spec, options)
          break
        case 'shortcut':
          result = await this.launchAdapter.launchShortcut(spec, options)
          break
        default:
          result = {
            success: false,
            error: 'Unsupported launch specification kind',
          }
      }

      if (result.success) {
        this.emit('launch-succeeded', appId, result)
      } else {
        const err = new Error(result.error ?? 'Unknown launch error')
        this.emit('launch-failed', appId, err)
      }

      return result
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      this.emit('launch-failed', appId, error)
      return {
        success: false,
        error: error.message,
      }
    }
  }

  /**
   * Whether an application discovery refresh is currently executing.
   */
  get refreshing(): boolean {
    return this.currentRefreshPromise !== null
  }

  /**
   * Disposes the engine, aborting active refresh operations and clearing catalog state.
   */
  dispose(): void {
    this.isDisposed = true
    if (this.refreshAbortController) {
      this.refreshAbortController.abort()
      this.refreshAbortController = null
    }
    this.currentRefreshPromise = null
    this.listeners.clear()
    this.providers.clear()
    this.catalog.clear()
  }
}
