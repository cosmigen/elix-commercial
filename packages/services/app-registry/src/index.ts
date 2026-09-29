/**
 * @deepseek-ai/dsh-app-registry — ELIX OS Application Registry Plugin.
 *
 * Implements an independent, modular application capability layer over the Cordis plugin host.
 * Owns discovery of installed applications (Start Menu, Packaged apps/AUMIDs, Registry metadata),
 * deterministic stable application identity, normalization, deduplication, transactional catalog,
 * application search, icon references, launch resolution, atomic cache persistence, and typed events.
 *
 * @module @deepseek-ai/dsh-app-registry
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {
  AppDiscoveryProvider,
  AppId,
  AppLaunchOptions,
  AppLaunchResult,
  AppRecord,
  AppRegistryRefreshResult,
  AppResolution,
  AppSearchOptions,
  Config,
  ProviderFault,
} from './types.ts'
import { AppRegistryEngine, type RegistryDisposer } from './registry.ts'
import { AppRegistryCacheManager } from './cache.ts'
import { StartMenuProvider } from './providers/start-menu.ts'
import { PackagedAppsProvider } from './providers/packaged-apps.ts'
import { RegistryMetadataProvider } from './providers/registry-metadata.ts'

export * from './types.ts'
export * from './identity.ts'
export * from './normalize.ts'
export * from './reconcile.ts'
export * from './powershell.ts'
export * from './cache.ts'
export * from './icons.ts'
export * from './launch.ts'
export * from './search.ts'
export * from './registry.ts'
export * from './providers/start-menu.ts'
export * from './providers/packaged-apps.ts'
export * from './providers/registry-metadata.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    appRegistry: AppRegistryService
  }
  interface Events {
    /** Emitted when App Registry finishes initialization and has loaded its initial catalog. */
    'app-registry/ready'(service: AppRegistryService): void
    /** Emitted when a discovery refresh scan starts. */
    'app-registry/refresh-started'(): void
    /** Emitted when a discovery refresh completes with its aggregate result. */
    'app-registry/refresh-completed'(result: AppRegistryRefreshResult): void
    /** Emitted when a new application is added to the catalog. */
    'app-registry/app-added'(app: AppRecord): void
    /** Emitted when an existing application's metadata is updated. */
    'app-registry/app-updated'(app: AppRecord): void
    /** Emitted when an application is uninstalled or removed from the catalog. */
    'app-registry/app-removed'(appId: AppId): void
    /** Emitted when an underlying discovery provider encounters an error or deadline timeout. */
    'app-registry/provider-fault'(fault: ProviderFault): void
    /** Emitted when an application launch is initiated. */
    'app-registry/launch-requested'(appId: AppId): void
    /** Emitted when an application launch succeeds. */
    'app-registry/launch-succeeded'(appId: AppId, result: AppLaunchResult): void
    /** Emitted when an application launch fails. */
    'app-registry/launch-failed'(appId: AppId, error: Error): void
  }
}

/**
 * The ELIX OS Application Registry Service.
 */
export class AppRegistryService extends Service {
  static Config = z.object({
    enabled: z.boolean().default(true),
    cachePath: z.string(),
    autoRefreshOnStartup: z.boolean().default(true),
    providerTimeoutMs: z.number().default(10000),
    preferNative: z.boolean().default(true),
  })

  readonly engine: AppRegistryEngine
  private readonly config: Config & { preferNative?: boolean }
  private isInitialized = false
  private isDisposed = false

  constructor(ctx: Context, config?: Partial<Config & { preferNative?: boolean }>) {
    super(ctx, 'appRegistry')

    const resolvedConfig = {
      enabled: config?.enabled ?? true,
      cachePath: config?.cachePath,
      autoRefreshOnStartup: config?.autoRefreshOnStartup ?? true,
      providerTimeoutMs: config?.providerTimeoutMs ?? 10_000,
      preferNative: config?.preferNative ?? true,
      launchAdapter: config?.launchAdapter,
      customProviders: config?.customProviders,
    }
    this.config = resolvedConfig

    const cacheManager = new AppRegistryCacheManager(
      resolvedConfig.cachePath !== undefined ? { filePath: resolvedConfig.cachePath } : undefined,
    )

    // Prepare providers: use custom providers if passed (e.g. for testing) or register standard Windows providers
    let initialProviders: AppDiscoveryProvider[]
    if (resolvedConfig.customProviders && resolvedConfig.customProviders.length > 0) {
      initialProviders = [...resolvedConfig.customProviders]
    } else {
      initialProviders = [
        new StartMenuProvider(),
        new PackagedAppsProvider(),
        new RegistryMetadataProvider(),
      ]
    }

    this.engine = new AppRegistryEngine({
      cacheManager,
      ...resolvedConfig.launchAdapter !== undefined ? { launchAdapter: resolvedConfig.launchAdapter } : {},
      providers: initialProviders,
      providerTimeoutMs: resolvedConfig.providerTimeoutMs,
      preferNative: resolvedConfig.preferNative,
    })
  }

  /** The active launch adapter backend ('rust-native' or 'typescript-fallback'). */
  get activeLaunchBackend(): 'rust-native' | 'typescript-fallback' {
    return this.engine.activeLaunchBackend
  }

  /**
   * Service initialization hook.
   * Loads cached applications and optionally initiates background discovery.
   */
  async [Service.init](): Promise<void> {
    if (!this.config.enabled) {
      return
    }

    this.ctx.logger('app-registry').info(
      'App Registry initialized using active launch backend: %s',
      this.engine.activeLaunchBackend,
    )

    // 1. Forward engine events to Cordis event bus
    const unbindRefreshStarted = this.engine.on('refresh-started', () => {
      this.ctx.emit('app-registry/refresh-started')
    })
    const unbindRefreshCompleted = this.engine.on('refresh-completed', (result) => {
      this.ctx.emit('app-registry/refresh-completed', result)
    })
    const unbindAppAdded = this.engine.on('app-added', (app) => {
      this.ctx.emit('app-registry/app-added', app)
    })
    const unbindAppUpdated = this.engine.on('app-updated', (app) => {
      this.ctx.emit('app-registry/app-updated', app)
    })
    const unbindAppRemoved = this.engine.on('app-removed', (appId) => {
      this.ctx.emit('app-registry/app-removed', appId)
    })
    const unbindFault = this.engine.on('provider-fault', (fault) => {
      this.ctx.emit('app-registry/provider-fault', fault)
    })
    const unbindLaunchReq = this.engine.on('launch-requested', (appId) => {
      this.ctx.emit('app-registry/launch-requested', appId)
    })
    const unbindLaunchSucc = this.engine.on('launch-succeeded', (appId, result) => {
      this.ctx.emit('app-registry/launch-succeeded', appId, result)
    })
    const unbindLaunchFail = this.engine.on('launch-failed', (appId, error) => {
      this.ctx.emit('app-registry/launch-failed', appId, error)
    })

    // 2. Register Cordis lifecycle disposal effect before asynchronous initialization.
    this.ctx.effect(() => () => {
      this.isDisposed = true
      unbindRefreshStarted()
      unbindRefreshCompleted()
      unbindAppAdded()
      unbindAppUpdated()
      unbindAppRemoved()
      unbindFault()
      unbindLaunchReq()
      unbindLaunchSucc()
      unbindLaunchFail()
      this.engine.dispose()
      this.isInitialized = false
    }, 'appRegistry.lifecycle')

    // 3. Load cache from disk if available. Disposal can race this I/O; never resurrect a
    // disposed engine or announce readiness after the service lifetime has ended.
    await this.engine.loadCache().catch(() => false)
    if (this.isDisposed) {
      this.engine.dispose()
      return
    }

    this.isInitialized = true
    this.ctx.emit('app-registry/ready', this)

    // 4. Trigger background discovery refresh if enabled
    if (this.config.autoRefreshOnStartup) {
      void this.engine.refresh().catch((err: unknown) => {
        if (!this.isDisposed) this.ctx.logger.warn('Initial App Registry refresh failed:', err)
      })
    }
  }

  /** Whether the App Registry service is actively running and initialized. */
  get ready(): boolean {
    return this.isInitialized && !this.isDisposed
  }

  /**
   * Returns a frozen list of all registered applications in the catalog.
   */
  list(): readonly AppRecord[] {
    return this.engine.list()
  }

  /**
   * Retrieves an application record by its AppId.
   */
  get(appId: AppId): AppRecord | undefined {
    return this.engine.get(appId)
  }

  /**
   * Resolves the current availability status of an application.
   */
  resolve(appId: AppId): AppResolution {
    return this.engine.resolve(appId)
  }

  /**
   * Searches applications in the catalog.
   */
  search(query: string, options?: AppSearchOptions): readonly AppRecord[] {
    return this.engine.search(query, options)
  }

  /**
   * Manually initiates an application discovery scan across all providers.
   */
  async refresh(): Promise<AppRegistryRefreshResult> {
    return this.engine.refresh()
  }

  /**
   * Launches an application by its AppId.
   */
  async launch(appId: AppId, options?: AppLaunchOptions): Promise<AppLaunchResult> {
    return this.engine.launch(appId, options)
  }

  /**
   * Registers a custom or dynamic discovery provider.
   */
  registerProvider(provider: AppDiscoveryProvider): RegistryDisposer {
    return this.engine.registerProvider(provider)
  }
}

export default AppRegistryService
