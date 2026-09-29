/**
 * @deepseek-ai/dsh-home — authoritative Home model and per-monitor React renderer.
 *
 * @module @deepseek-ai/dsh-home
 */

import { extname, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import type { SurfaceInstance, SurfaceService, SurfaceZOrderPolicy } from '@deepseek-ai/dsh-surface'
import type { WindowsContextSource, WindowsMonitor } from '@deepseek-ai/dsh-windows-context'
import type { WidgetInstance, WidgetService } from '@deepseek-ai/dsh-shell-widgets'
import z from '@deepseek-ai/schemastery'

export type { SurfaceZOrderPolicy } from '@deepseek-ai/dsh-surface'
import { HomeDragSession, type StartDragOptions } from './drag-drop.ts'
import { FolderManager } from './folder.ts'
import type { FolderMetadata, HomeItem, WidgetMetadata } from './items.ts'
import { HomeItemManager } from './items.ts'
import {
  DEFAULT_GRID_CONFIG,
  HomeLayoutEngine,
  intersectsAnyExclusionZone,
  rectsIntersect,
} from './layout.ts'
import type { MonitorInfo } from './monitor.ts'
import { MonitorManager } from './monitor.ts'
import {
  HomePersonalizationCoordinator,
  type UiFoundationPersonalizationRef,
} from './personalization.ts'
import type { HomePersistentState } from './persistence.ts'
import {
  DEFAULT_HOME_PREFERENCES,
  HOME_SCHEMA_VERSION,
  HomePersistenceManager,
} from './persistence.ts'
import type {
  HomeRendererAsset,
  ResolvedHomeRendererAsset,
} from './renderer-host.ts'
import { HomeRendererHost } from './renderer-host.ts'
import type {
  HomeRendererFolderChild,
  HomeRendererIntent,
  HomeRendererItem,
  HomeRendererSnapshot,
  HomeRendererWidget,
  RendererPoint,
  RendererRect,
} from './renderer-protocol.ts'
import { HomeSelectionManager } from './selection.ts'
import { HomeSurfaceInstance, HomeSurfaceManager } from './surface.ts'
import type { ContextMenuRequest, ContextMenuTargetType, ExclusionZone, HomeLayoutContext, HomePreferences, Position, Rect } from './types.ts'
import { HomeInteractionManager } from './interaction.ts'
import { DEFAULT_WALLPAPER_PREFERENCES, WallpaperManager } from './wallpaper.ts'
import { generateThemeTokensCss } from './theme-tokens.ts'

export * from './types.ts'
export * from './monitor.ts'
export * from './items.ts'
export * from './folder.ts'
export * from './widget.ts'
export * from './layout.ts'
export * from './drag-drop.ts'
export * from './wallpaper.ts'
export * from './personalization.ts'
export * from './persistence.ts'
export * from './surface.ts'
export * from './selection.ts'
export * from './interaction.ts'
export * from './renderer-protocol.ts'
export * from './theme-tokens.ts'
export { buildHomeRendererCss, renderHomeDocument, renderHomeRoot } from './renderer.tsx'

declare module '@deepseek-ai/cordis' {
  interface Context {
    home: HomeService
  }
  interface Events {
    /** @mode broadcast @param service Initialized Home service. */
    'home/ready'(service: HomeService): void
    /** @mode broadcast @param state Updated durable Home snapshot. */
    'home/state-changed'(state: HomePersistentState): void
    /** @mode broadcast @param surface Newly registered per-monitor Home surface. */
    'home/surface-created'(surface: HomeSurfaceInstance): void
    /** @mode broadcast @param surface Home surface that passed current-generation readiness. */
    'home/surface-ready'(surface: HomeSurfaceInstance): void
    /** @mode broadcast @param surfaceId Identifier of a disposed Home surface. */
    'home/surface-destroyed'(surfaceId: string): void
    /** @mode broadcast @param item Updated Home item. */
    'home/item-changed'(item: HomeItem): void
    /** @mode broadcast @param itemId Removed Home item identifier. */
    'home/item-removed'(itemId: string): void
    /** @mode broadcast @param folderId Folder whose overlay presentation was requested. */
    'home/folder-open-requested'(folderId: string): void
    /** @mode broadcast @param item Home item whose activation was requested. */
    'home/item-activate-requested'(item: HomeItem): void
    /** @mode broadcast @param request Context-menu presentation request. */
    'home/context-menu-requested'(request: ContextMenuRequest): void
    /** @mode broadcast @param selectedIds Complete current Home selection. */
    'home/selection-changed'(selectedIds: readonly string[]): void
    /** @mode broadcast @param zones Complete source-neutral exclusion collection. */
    'home/exclusion-zones-changed'(zones: readonly ExclusionZone[]): void
    /** @mode broadcast @param event Closed overlay instance event. */
    'overlay/closed'(event: {
      readonly instanceId: string
      readonly definitionId: string
      readonly ownerId: string
      readonly reason: string
    }): void
  }
}

/** Home plugin configuration. */
export interface Config {
  /** Whether Home creates renderer routes and native surfaces. */
  enabled: boolean
  /** Explicit persistent state filepath override. */
  persistencePath?: string | undefined
  /** Whether Surface Core reveals each surface after renderer readiness. */
  autoShowOnReady: boolean
  /** Whether Home commits item placement to its grid. */
  snapToGrid: boolean
  /** Development-only visualization of active exclusion rectangles. */
  debugExclusions: boolean
  /** Explicit monitor topology available only to deterministic tests. */
  initialMonitors?: readonly MonitorInfo[] | undefined
  /** Optional surface z-order policy override for demo/acceptance presentation (defaults to 'bottom'). */
  zOrderPolicy?: SurfaceZOrderPolicy | undefined
  /** Whether to show demo widget shortcuts in the desktop context menu (defaults to false in production). */
  demoMode?: boolean | undefined
  /** Theme token overrides to apply to the Home renderer. */
  themeTokens?: Readonly<Record<string, string>> | undefined
}

/** Configuration options for the Home plugin and service. */
export type HomeConfig = Config

export interface OverlayServiceRef {
  register(def: {
    id: string
    ownerId: string
    title: string
    size: { width: number; height: number }
    defaultPlacement: string
    focusPolicy: string
    dismiss: { outsideClick: boolean; escape: boolean }
    renderer: { type: string; target: string }
  }): () => void
  open(options: {
    definitionId: string
    anchor: { type: string; x: number; y: number }
    placement: string
  }): Promise<{ instanceId: string } | undefined>
  close(instanceId: string): Promise<boolean>
  getActive(): readonly { definitionId: string; actualBounds: { x: number } }[]
}

export interface IntentRouterServiceRef {
  dispatch(intent: Record<string, unknown>): Promise<{ success?: boolean } | void>
}

/**
 * Owns Home items, placement, selection, folders, wallpaper preferences, persistence,
 * and renderer intent handling while delegating native presentation to ctx.surface.
 */
export class HomeService extends Service {
  static Config = z.object({
    enabled: z.boolean().default(true),
    persistencePath: z.string(),
    autoShowOnReady: z.boolean().default(true),
    snapToGrid: z.boolean().default(true),
    debugExclusions: z.boolean().default(false),
    zOrderPolicy: z.union([z.const('bottom'), z.const('normal'), z.const('topmost')]).default('bottom'),
    demoMode: z.boolean().default(false),
    themeTokens: z.dict(z.string()),
  })

  readonly persistence: HomePersistenceManager
  readonly monitors: MonitorManager
  readonly items: HomeItemManager
  readonly folders: FolderManager
  readonly layout: HomeLayoutEngine
  readonly wallpaper: WallpaperManager
  readonly personalization: HomePersonalizationCoordinator
  readonly surfaces: HomeSurfaceManager
  readonly selection: HomeSelectionManager
  readonly interactions: HomeInteractionManager

  /**
   * Authoritative Widget Runtime Service accessor (ctx.widgets).
   * Home does not own an independent widget registry or host.
   */
  get widgets(): WidgetService | undefined {
    return this.widgetService
  }

  private readonly config: Config
  private _themeTokens: Readonly<Record<string, string>> | undefined
  private rendererHost: HomeRendererHost | undefined
  private _preferences: HomePreferences = { ...DEFAULT_HOME_PREFERENCES }
  private saveDebounceTimer: NodeJS.Timeout | null = null
  private saveDirty = false
  private isInitialized = false
  private readonly readyHwnds = new Map<string, number>()
  private activeContextMenuInstanceId: string | undefined
  private overlayDisposer: (() => void) | undefined
  private renamingItemId: string | undefined

  constructor(ctx: Context, config?: Partial<Config>) {
    super(ctx, 'home')
    this.config = {
      enabled: config?.enabled ?? true,
      persistencePath: config?.persistencePath,
      autoShowOnReady: config?.autoShowOnReady ?? true,
      snapToGrid: config?.snapToGrid ?? true,
      debugExclusions: config?.debugExclusions ?? false,
      initialMonitors: config?.initialMonitors,
      zOrderPolicy: config?.zOrderPolicy ?? 'bottom',
      demoMode: config?.demoMode ?? false,
      themeTokens: config?.themeTokens,
    }
    this._themeTokens = config?.themeTokens && Object.keys(config.themeTokens).length > 0
      ? config.themeTokens
      : undefined
    this.persistence = new HomePersistenceManager({ filePath: this.config.persistencePath })
    this.monitors = new MonitorManager(this.config.initialMonitors)
    this.items = new HomeItemManager(() => this.monitors.getPrimaryMonitor().id)
    this.folders = new FolderManager(this.items)
    this.layout = new HomeLayoutEngine(DEFAULT_GRID_CONFIG)
    this.wallpaper = new WallpaperManager()
    this.personalization = new HomePersonalizationCoordinator(this.wallpaper, {
      getUiFoundation: () => this.uiFoundationPersonalization,
      publish: () => this.rendererHost?.publishAll(),
    })
    this.selection = new HomeSelectionManager()
    this.interactions = new HomeInteractionManager()
    this.surfaces = new HomeSurfaceManager(this.monitors, {
      getSurfaceService: () => this.requireSurfaceService(),
      rendererUrl: monitorId => this.requireRendererHost().getSurfaceUrl(monitorId),
      autoShowOnReady: this.config.autoShowOnReady,
      runtimeListener: (monitorId, state) => this.rendererHost?.setRuntimeState(monitorId, state),
      zOrderPolicy: this.config.zOrderPolicy,
    })
  }

  /**
   * Load durable Home state, register the renderer transport, then create one native
   * Surface Core instance for each authoritative Windows Context monitor.
   */
  async [Service.init](): Promise<void> {
    if (!this.config.enabled) {
      this.ctx.logger.info('Home plugin is disabled by configuration.')
      return
    }

    let unbindWindowsContext = () => {}
    if (this.config.initialMonitors === undefined) {
      const windowsContext = this.ctx.get('windowsContext') as WindowsContextSource | undefined
      if (windowsContext === undefined) {
        throw new Error('Home requires ctx.windowsContext in production or explicit initialMonitors for tests.')
      }
      this.monitors.replaceTopology(windowsContext.getMonitors().map(projectWindowsMonitor))
      unbindWindowsContext = windowsContext.subscribe((change) => {
        this.monitors.replaceTopology(change.snapshot.monitors.map(projectWindowsMonitor))
      })
    }

    const saved = await this.persistence.load()
    this.items.loadSnapshot(saved.items)
    this._preferences = {
      ...DEFAULT_HOME_PREFERENCES,
      ...saved.preferences,
      snapToGrid: this.config.snapToGrid,
    }
    try {
      this.wallpaper.loadPreferences(saved.wallpaper)
    } catch (error) {
      this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
      this.wallpaper.loadPreferences(DEFAULT_WALLPAPER_PREFERENCES)
    }
    this.items.clampItemsToMonitors(this.monitors.getMonitors(), this.layout)

    // Restore persistent widgets into WidgetService if available
    const widgetService = this.widgetService
    if (widgetService !== undefined && saved.widgets && saved.widgets.length > 0) {
      const activeMonitorIds = this.monitors.getMonitors().map(m => m.id)
      widgetService.restoreInstances(saved.widgets, { activeMonitorIds })
    }
    this.reconcileExclusionPlacements()

    const webServer = this.ctx.get('webServer')
    if (webServer === undefined) throw new Error('Home Renderer V1 requires ctx.webServer.')
    this.rendererHost = new HomeRendererHost(webServer, {
      snapshot: (monitorId, assetBasePath, runtimeState) => {
        return this.buildRendererSnapshot(monitorId, assetBasePath, runtimeState)
      },
      dispatchIntent: (monitorId, intent) => this.dispatchRendererIntent(monitorId, intent),
      resolveAsset: (monitorId, asset) => this.resolveRendererAsset(monitorId, asset),
      onWarning: (error) => {
        this.ctx.logger.warn(error)
      },
    })

    const unbindMonitors = this.monitors.onChange((type, monitor) => {
      if (type === 'removed') {
        this.personalization.handleMonitorRemoved(monitor.id)
        this.rendererHost?.removeMonitor(monitor.id)
        this.widgetService?.suspendForMonitor(monitor.id)
      } else if (type === 'added') {
        const availableBounds = this.layout.getAvailableBounds(monitor.id, monitor.bounds)
        this.widgetService?.restoreForMonitor(monitor.id, availableBounds)
      }
      this.items.clampItemsToMonitors(this.monitors.getMonitors(), this.layout)
      this.reconcileExclusionPlacements()
      this.rendererHost?.publishAll()
      void this.surfaces.reconcile().catch((error: unknown) => {
        this.ctx.logger.error(error instanceof Error ? error : new Error(String(error)))
      })
    })
    const unbindCreated = this.surfaces.onCreated((surface) => {
      this.ctx.emit('home/surface-created', surface)
      this.emitReadyIfCurrent(surface)
    })
    const unbindDestroyed = this.surfaces.onDestroyed((surface) => {
      this.readyHwnds.delete(surface.surfaceId)
      this.rendererHost?.removeMonitor(surface.monitorId)
      this.ctx.emit('home/surface-destroyed', surface.surfaceId)
    })

    const scheduleSave = (): void => {
      this.saveDirty = true
      if (this.saveDebounceTimer !== null) clearTimeout(this.saveDebounceTimer)
      this.saveDebounceTimer = setTimeout(() => {
        this.saveDebounceTimer = null
        void this.saveState().catch((error: unknown) => {
          this.ctx.logger.error(error instanceof Error ? error : new Error(String(error)))
        })
      }, 300)
    }

    const unbindItems = this.items.onChange(() => {
      scheduleSave()
      this.ctx.emit('home/state-changed', this.buildPersistentSnapshot())
      this.rendererHost?.publishAll()
    })
    const unbindFolders = this.folders.onFolderOpenRequest((folderId) => {
      void this.dismissContextMenu()
      this.ctx.emit('home/folder-open-requested', folderId)
    })
    const unbindWallpaper = this.wallpaper.onChange(() => {
      scheduleSave()
      this.ctx.emit('home/state-changed', this.buildPersistentSnapshot())
      this.rendererHost?.publishAll()
    })

    // Listen to WidgetService events if available
    const unbindWidgetCreated = this.ctx.on('widgets/instance-created', () => {
      this.reconcileExclusionPlacements()
      scheduleSave()
      this.ctx.emit('home/state-changed', this.buildPersistentSnapshot())
      this.rendererHost?.publishAll()
    })
    const unbindWidgetUpdated = this.ctx.on('widgets/instance-updated', () => {
      scheduleSave()
      this.ctx.emit('home/state-changed', this.buildPersistentSnapshot())
      this.rendererHost?.publishAll()
    })
    const unbindWidgetRemoved = this.ctx.on('widgets/instance-removed', () => {
      scheduleSave()
      this.ctx.emit('home/state-changed', this.buildPersistentSnapshot())
      this.rendererHost?.publishAll()
    })

    const unbindSelection = this.selection.onChange((selectedIds) => {
      this.ctx.emit('home/selection-changed', selectedIds)
      this.rendererHost?.publishAll()
    })
    const unbindContextMenu = this.interactions.onContextMenuRequest((request) => {
      this.ctx.emit('home/context-menu-requested', request)
      void this.handleOpenOverlayContextMenu(request)
    })
    const unbindActivation = this.interactions.onItemActivationRequest((item) => {
      this.ctx.emit('home/item-activate-requested', item)
    })
    const unbindReservations = this.layout.onReservedRegionsChange(() => {
      this.reconcileExclusionPlacements()
      this.rendererHost?.publishAll()
    })
    const unbindExclusions = this.layout.onExclusionZonesChange((zones) => {
      this.reconcileExclusionPlacements()
      this.ctx.emit('home/exclusion-zones-changed', zones)
      this.rendererHost?.publishAll()
    })
    const unbindSurfaceReady = this.ctx.on('surface/ready', (surface) => {
      const homeSurface = this.surfaces.getSurfaces().find(candidate => candidate.surfaceId === surface.id)
      if (homeSurface !== undefined) this.emitReadyIfCurrent(homeSurface)
    })
    const unbindSurfaceShown = this.ctx.on('surface/shown', (surface) => {
      const homeSurface = this.surfaces.getSurfaces().find(candidate => candidate.surfaceId === surface.id)
      if (homeSurface !== undefined) this.rendererHost?.setRuntimeState(homeSurface.monitorId, 'active')
    })
    const unbindSurfaceHidden = this.ctx.on('surface/hidden', (surface) => {
      const homeSurface = this.surfaces.getSurfaces().find(candidate => candidate.surfaceId === surface.id)
      if (homeSurface !== undefined) this.rendererHost?.setRuntimeState(homeSurface.monitorId, 'suspended')
    })

    // Listen to surface messages for context menu action execution
    const unbindSurfaceMessage = this.ctx.on('surface/message', (ev: { readonly surface: SurfaceInstance; readonly message: string }) => {
      try {
        const parsed: unknown = typeof ev.message === 'string' ? JSON.parse(ev.message) : ev.message
        if (parsed !== null && typeof parsed === 'object' && (parsed as { readonly type?: string }).type === 'home-context-menu/action') {
          void this.handleContextMenuAction(parsed as Record<string, unknown>)
        }
      } catch {
        // Ignore unparseable messages from other surfaces
      }
    })

    // Listen to overlay closed event
    const unbindOverlayClosed = this.ctx.on('overlay/closed', (ev) => {
      if (this.activeContextMenuInstanceId && ev.instanceId === this.activeContextMenuInstanceId) {
        this.activeContextMenuInstanceId = undefined
      }
    })

    this.ctx.effect(() => async () => {
      this.isInitialized = false
      if (this.saveDebounceTimer !== null) {
        clearTimeout(this.saveDebounceTimer)
        this.saveDebounceTimer = null
      }
      unbindWindowsContext()
      unbindMonitors()
      unbindCreated()
      unbindDestroyed()
      unbindItems()
      unbindFolders()
      unbindWallpaper()
      unbindWidgetCreated()
      unbindWidgetUpdated()
      unbindWidgetRemoved()
      unbindSelection()
      unbindContextMenu()
      unbindActivation()
      unbindReservations()
      unbindExclusions()
      unbindSurfaceReady()
      unbindSurfaceShown()
      unbindSurfaceHidden()
      unbindSurfaceMessage()
      unbindOverlayClosed()
      this.overlayDisposer?.()
      this.overlayDisposer = undefined
      this.personalization.dispose()
      if (this.saveDirty) {
        await this.saveState().catch((error: unknown) => {
          this.ctx.logger.error(error instanceof Error ? error : new Error(String(error)))
        })
      }
      this.rendererHost?.dispose()
      this.rendererHost = undefined
      await this.surfaces.shutdownAll()
      this.readyHwnds.clear()
    }, 'home.lifecycle')

    await this.surfaces.reconcile()
    this.isInitialized = true
    this.ctx.emit('home/ready', this)
  }

  /** Whether Home completed initialization and owns active renderer infrastructure. */
  get isRunning(): boolean {
    return this.isInitialized && this.config.enabled
  }

  /** Get optional WidgetService reference from Context. */
  get widgetService(): WidgetService | undefined {
    try {
      return this.ctx.get('widgets')
    } catch {
      return undefined
    }
  }

  /** Get optional OverlayService reference from Context. */
  get overlayService(): OverlayServiceRef | undefined {
    try {
      const svc: unknown = this.ctx.get('overlay')
      return svc as OverlayServiceRef | undefined
    } catch {
      return undefined
    }
  }

  /** Get optional IntentRouterService reference from Context. */
  get intentRouterService(): IntentRouterServiceRef | undefined {
    try {
      const svc: unknown = this.ctx.get('intentRouter') ?? (this.ctx as unknown as Record<string, unknown>)['intentRouter']
      return svc as IntentRouterServiceRef | undefined
    } catch {
      return undefined
    }
  }

  /** Get optional Phase 16B UI Foundation reference for coordinated personalization previews. */
  get uiFoundationPersonalization(): UiFoundationPersonalizationRef | undefined {
    try {
      return this.ctx.get('uiFoundation')
    } catch {
      return undefined
    }
  }

  /** Emit a folder-open intent for the future shared overlay owner. */
  requestOpenFolder(folderId: string): boolean {
    return this.folders.requestOpenFolder(folderId)
  }

  /** Emit a context-menu intent for the future shared overlay owner. */
  requestContextMenu(request: ContextMenuRequest): void {
    this.interactions.requestContextMenu(request)
  }

  /** Subscribe to context-menu intent requests. */
  onContextMenuRequest(listener: (request: ContextMenuRequest) => void): () => void {
    return this.interactions.onContextMenuRequest(listener)
  }

  /** Retrieve current Home preferences. */
  get preferences(): HomePreferences {
    return { ...this._preferences }
  }

  /** Retrieve current Home preferences. */
  getPreferences(): HomePreferences {
    return { ...this._preferences }
  }

  /** Update Home preferences and update active renderers. */
  setPreferences(patch: Partial<HomePreferences>): void {
    this._preferences = { ...this._preferences, ...patch }
    this.saveDirty = true
    this.rendererHost?.publishAll()
  }

  /** Retrieve active theme token overrides. */
  getThemeTokens(): Readonly<Record<string, string>> | undefined {
    return this._themeTokens
  }

  /** Update or override theme tokens and republish renderer snapshots. */
  setThemeTokens(tokens: Record<string, string>): void {
    this._themeTokens = Object.freeze({ ...(this._themeTokens ?? {}), ...tokens })
    this.rendererHost?.publishAll()
  }

  /** Rename a desktop item. */
  renameItem(itemId: string, newName: string): boolean {
    return this.items.renameItem(itemId, newName)
  }

  /** Return the authoritative layout projection for one connected monitor. */
  getLayoutContext(monitorId: string): HomeLayoutContext {
    const monitor = this.monitors.getMonitor(monitorId)
    if (monitor === undefined) throw new Error('Unknown Home monitor ' + JSON.stringify(monitorId) + '.')
    return this.layout.getLayoutContext(monitorId, monitor.bounds, this.items.getItems())
  }

  /** Reveal every Home surface through Surface Core. */
  show(): Promise<void> {
    return this.surfaces.showAll()
  }

  /** Hide every Home surface and suspend renderer background work. */
  hide(): Promise<void> {
    return this.surfaces.hideAll()
  }

  /** Reload every renderer without replacing authoritative Home state. */
  async restart(): Promise<void> {
    await this.dismissContextMenu()
    await this.surfaces.restartAll()
  }

  /**
   * Adjust the native z-order policy across all active Home surfaces.
   * Useful for demo/acceptance visual mode to present the surface visibly.
   * @param zOrderPolicy - Target z-order policy ('bottom' | 'normal' | 'topmost').
   */
  setZOrder(zOrderPolicy: SurfaceZOrderPolicy): Promise<void> {
    return this.surfaces.setZOrderAll(zOrderPolicy)
  }

  /** Start a drag session in canonical physical monitor coordinates. */
  startDragSession(options: Omit<StartDragOptions, 'availableBounds'>): HomeDragSession {
    const monitor = this.monitors.getMonitor(options.monitorId)
    if (monitor === undefined) throw new Error('Cannot drag on unknown Home monitor ' + JSON.stringify(options.monitorId) + '.')
    const availableBounds = this.layout.getAvailableBounds(options.monitorId, monitor.bounds)
    const activeWidgets = (this.widgetService?.getActiveForMonitor(options.monitorId) ?? [])
      .map(w => ({ x: w.position.x, y: w.position.y, width: w.size.width, height: w.size.height }))
    const getAdditionalOccupied = (monId: string): readonly Rect[] => {
      return (this.widgetService?.getActiveForMonitor(monId) ?? [])
        .map(w => ({ x: w.position.x, y: w.position.y, width: w.size.width, height: w.size.height }))
    }
    return new HomeDragSession(
      {
        ...options,
        availableBounds,
        snapToGrid: this._preferences.snapToGrid,
        additionalOccupied: activeWidgets,
        monitors: this.monitors.getMonitors(),
        getAdditionalOccupied,
      },
      this.items,
      this.folders,
      this.layout,
    )
  }

  /**
   * Authoritative desktop spatial occupancy query.
   * Collects bounding rectangles of all visible desktop items and active widgets
   * on the specified monitor, excluding any IDs currently moving or being evaluated.
   */
  getOccupiedRects(monitorId: string, excludingIds: readonly string[] = []): readonly Rect[] {
    const excludeSet = new Set(excludingIds)

    const itemRects: Rect[] = this.items
      .getRootItemsForMonitor(monitorId)
      .filter(item => !excludeSet.has(item.id))
      .map(item => ({
        x: item.position.x,
        y: item.position.y,
        width: item.size.width,
        height: item.size.height,
      }))

    const widgetRects: Rect[] = (this.widgetService?.getActiveForMonitor(monitorId) ?? [])
      .filter(widget => !excludeSet.has(widget.id))
      .map(widget => ({
        x: widget.position.x,
        y: widget.position.y,
        width: widget.size.width,
        height: widget.size.height,
      }))

    return [...itemRects, ...widgetRects]
  }

  /**
   * Resolve safe placement for an item or candidate rectangle on desktop,
   * avoiding collisions with all active items, widgets, and exclusion zones.
   */
  resolvePlacement(item: HomeItem, enforceSnap: boolean = this._preferences.snapToGrid): Position {
    const monitor = this.monitors.getMonitor(item.monitorId) ?? this.monitors.getPrimaryMonitor()
    const availableBounds = this.layout.getAvailableBounds(monitor.id, monitor.bounds)
    const activeWidgets = (this.widgetService?.getActiveForMonitor(monitor.id) ?? [])
      .map(w => ({ x: w.position.x, y: w.position.y, width: w.size.width, height: w.size.height }))
    return this.layout.resolvePlacement(
      item,
      this.items.getItems(),
      availableBounds,
      enforceSnap,
      activeWidgets,
    )
  }

  /** Dispatch a renderer intent directly to Home. */
  dispatchIntent(monitorId: string, intent: HomeRendererIntent): Promise<void> {
    return this.dispatchRendererIntent(monitorId, intent)
  }

  /** Handle context menu actions dispatched from the context menu surface. */
  executeContextMenuAction(data: Record<string, unknown>): Promise<void> {
    return this.handleContextMenuAction(data)
  }

  /** Flush current durable Home state through atomic persistence. */
  async saveState(): Promise<void> {
    await this.persistence.save(this.buildPersistentSnapshot())
    this.saveDirty = false
  }

  /** Force reconciliation of desktop items and widgets against exclusions and monitor bounds. */
  reconcilePlacements(): void {
    this.reconcileExclusionPlacements()
  }

  /**
   * Build a point-in-time renderer snapshot for a monitor.
   * @param monitorId - Monitor identifier.
   * @param assetBasePath - Base URL path for assets.
   * @param runtimeState - Wallpaper runtime state.
   * @returns Complete Home renderer snapshot.
   */
  getRendererSnapshot(
    monitorId: string,
    assetBasePath = '',
    runtimeState: HomeRendererSnapshot['wallpaperRuntime'] = 'active',
  ): HomeRendererSnapshot {
    return this.buildRendererSnapshot(monitorId, assetBasePath, runtimeState)
  }

  /** Build a point-in-time durable Home snapshot. */
  buildPersistentSnapshot(): HomePersistentState {
    const widgets: readonly WidgetInstance[] = this.widgetService !== undefined
      ? this.widgetService.list()
      : []

    return {
      schemaVersion: HOME_SCHEMA_VERSION,
      items: this.items.getItems(),
      widgets,
      wallpaper: this.wallpaper.getPreferences(),
      preferences: { ...this._preferences },
      updatedAt: Date.now(),
    }
  }

  private requireSurfaceService(): SurfaceService {
    const surface = this.ctx.get('surface')
    if (surface === undefined) throw new Error('Home Renderer V1 requires ctx.surface.')
    return surface
  }

  private requireRendererHost(): HomeRendererHost {
    if (this.rendererHost === undefined) throw new Error('Home renderer host is not initialized.')
    return this.rendererHost
  }

  private emitReadyIfCurrent(surface: HomeSurfaceInstance): void {
    if (!surface.isReady) return
    if (this.readyHwnds.get(surface.surfaceId) === surface.windowHandle) return
    this.readyHwnds.set(surface.surfaceId, surface.windowHandle)
    this.ctx.emit('home/surface-ready', surface)
  }

  private buildRendererSnapshot(
    monitorId: string,
    assetBasePath: string,
    wallpaperRuntime: HomeRendererSnapshot['wallpaperRuntime'],
  ): HomeRendererSnapshot {
    const monitor = this.monitors.getMonitor(monitorId)
    if (monitor === undefined) throw new Error('Cannot render disconnected Home monitor ' + JSON.stringify(monitorId) + '.')
    const scale = monitor.scaleFactor
    const wallpaperPreferences = this.personalization.getDisplayPreferences(monitorId)
    const wallpaper = this.personalization.getActiveWallpaper(monitorId)
    const items = this.items.getRootItemsForMonitor(monitorId).map((item) => {
      return projectRendererItem(
        item,
        monitor,
        assetBasePath,
        this.selection.isSelected(item.id),
        item.id === this.renamingItemId,
        this.items,
      )
    })

    // Project placed active widget instances for this monitor
    const widgetInstances = this.widgetService !== undefined
      ? this.widgetService.getActiveForMonitor(monitorId)
      : []

    const widgets: HomeRendererWidget[] = widgetInstances.map((inst) => {
      const def = this.widgetService?.getDefinition(inst.definitionId)
      return {
        id: inst.id,
        definitionId: inst.definitionId,
        title: def?.title ?? inst.definitionId,
        rect: physicalRectToRenderer({ ...inst.position, ...inst.size }, monitor),
        resizable: true,
        zOrder: inst.zOrder,
        contentHtml: this.widgetService?.renderWidget(inst, scale) ?? '',
        state: inst.state,
        minSize: def?.minSize
          ? { width: Math.round(def.minSize.width / scale), height: Math.round(def.minSize.height / scale) }
          : undefined,
        maxSize: def?.maxSize
          ? { width: Math.round(def.maxSize.width / scale), height: Math.round(def.maxSize.height / scale) }
          : undefined,
      }
    })

    return {
      monitorId,
      monitorName: monitor.name,
      cssWidth: monitor.bounds.width / scale,
      cssHeight: monitor.bounds.height / scale,
      scaleFactor: scale,
      iconSize: this._preferences.iconSize / scale,
      wallpaperRuntime,
      wallpaper: {
        kind: wallpaper.kind,
        fit: wallpaperPreferences.fit,
        source: wallpaper.source,
        blur: wallpaperPreferences.blur,
        saturation: wallpaperPreferences.saturation,
        dim: wallpaperPreferences.dim,
        ...(wallpaper.kind === 'image' || wallpaper.kind === 'video'
          ? { assetUrl: assetBasePath + '/wallpaper' }
          : {}),
      },
      items,
      widgets,
      exclusions: this.layout.getExclusionZones(monitorId).map(zone => physicalRectToRenderer(zone.rect, monitor)),
      debugExclusions: this.config.debugExclusions,
      openFolderId: this.folders.getOpenFolder()?.id,
      themeTokens: this._themeTokens,
    }
  }

  private pendingContextMenuPromise: Promise<void> | null = null

  private async dispatchRendererIntent(monitorId: string, intent: HomeRendererIntent): Promise<void> {
    switch (intent.type) {
      case 'select': {
        const item = this.getRootItemOnMonitor(intent.itemId, monitorId)
        if (item === undefined) return
        this.selection.select(item.id, intent.additive)
        return
      }
      case 'clearSelection':
        this.selection.clear()
        return
      case 'selectAll':
        this.selection.selectAll(this.items.getRootItemsForMonitor(monitorId), monitorId)
        return
      case 'marquee': {
        const monitor = this.requireMonitor(monitorId)
        this.selection.selectMarquee(
          rendererRectToPhysical(intent.rect, monitor),
          this.items.getRootItemsForMonitor(monitorId),
          intent.additive,
        )
        return
      }
      case 'moveItems': {
        const primary = this.getRootItemOnMonitor(intent.primaryItemId, monitorId)
        if (primary === undefined) return
        const additionalIds = [...new Set(intent.additionalItemIds)].filter(
          itemId => this.getRootItemOnMonitor(itemId, monitorId) !== undefined,
        )
        const monitor = this.requireMonitor(monitorId)
        const drag = this.startDragSession({
          mode: 'move',
          primaryItemId: primary.id,
          additionalItemIds: additionalIds,
          startPointer: rendererPointToPhysical(intent.start, monitor),
          monitorId,
        })
        drag.updatePointer(rendererPointToPhysical(intent.end, monitor), {
          forceArm: intent.folderTargetArmed === true,
        })
        drag.commit()
        return
      }
      case 'resizeItem': {
        const item = this.getRootItemOnMonitor(intent.itemId, monitorId)
        if (item === undefined) return
        const monitor = this.requireMonitor(monitorId)
        const availableBounds = this.layout.getAvailableBounds(monitor.id, monitor.bounds)
        const width = Math.min(
          Math.round(intent.size.width * monitor.scaleFactor),
          availableBounds.x + availableBounds.width - item.position.x,
        )
        const height = Math.min(
          Math.round(intent.size.height * monitor.scaleFactor),
          availableBounds.y + availableBounds.height - item.position.y,
        )
        this.items.resizeItem(item.id, { width, height })
        return
      }
      case 'contextMenu': {
        const monitor = this.requireMonitor(monitorId)
        const physicalPos = rendererPointToPhysical(intent.position, monitor)
        let targetType: ContextMenuTargetType = intent.targetType ?? (intent.itemId !== undefined ? 'item' : 'desktop')
        if (targetType === 'item' && intent.itemId !== undefined) {
          const item = this.items.getItem(intent.itemId)
          if (item?.type === 'folder') {
            targetType = 'folder'
          }
        }
        this.requestContextMenu({
          targetType,
          ...(intent.itemId !== undefined ? { targetId: intent.itemId } : {}),
          ...(intent.widgetId !== undefined ? { targetId: intent.widgetId } : {}),
          position: physicalPos,
          monitorId,
        })
        if (this.pendingContextMenuPromise !== null) {
          await this.pendingContextMenuPromise
        }
        return
      }
      case 'activate': {
        const item = this.items.getItem(intent.itemId)
        if (item === undefined || item.monitorId !== monitorId) return
        if (item.type === 'folder') {
          if (Boolean((item.metadata as Record<string, unknown>).isFilesystem)) {
            this.requestOpenFolder(item.id)
          } else {
            this.folders.openFolder(item.id)
          }
          return
        }

        // Delegate to IntentRouter if available. Folder children are valid activation targets.
        const router = this.intentRouterService
        if (router !== undefined) {
          if (item.type === 'file') {
            void router.dispatch({ type: 'open-file', itemId: item.id }).catch(() => {})
            return
          }
          if (item.type === 'shortcut') {
            void router.dispatch({ type: 'open-shortcut', itemId: item.id }).catch(() => {})
            return
          }
        }

        this.interactions.requestItemActivation(item)
        return
      }
      case 'moveWidget': {
        const monitor = this.monitors.getMonitor(monitorId) ?? this.monitors.getPrimaryMonitor()
        const targetPhysical = rendererPointToPhysical(intent.position, monitor)

        // Check if pointer moved across monitor boundary
        let destinationMonitor = monitor
        for (const candidate of this.monitors.getMonitors()) {
          if (
            targetPhysical.x >= candidate.bounds.x &&
            targetPhysical.x < candidate.bounds.x + candidate.bounds.width &&
            targetPhysical.y >= candidate.bounds.y &&
            targetPhysical.y < candidate.bounds.y + candidate.bounds.height
          ) {
            destinationMonitor = candidate
            break
          }
        }

        const widgetService = this.widgetService
        const inst = widgetService?.get(intent.instanceId)
        if (inst === undefined || widgetService === undefined) return
        const width = inst.size.width
        const height = inst.size.height

        const availableBounds = this.layout.getAvailableBounds(destinationMonitor.id, destinationMonitor.bounds)
        const occupied = this.getOccupiedRects(destinationMonitor.id, [intent.instanceId])

        const desiredRect: Rect = {
          x: targetPhysical.x,
          y: targetPhysical.y,
          width,
          height,
        }

        const finalPos = this.layout.resolveRectPlacement(
          desiredRect,
          occupied,
          availableBounds,
          this._preferences.snapToGrid,
          destinationMonitor.id,
        )

        widgetService.update(intent.instanceId, {
          position: finalPos,
          monitorId: destinationMonitor.id,
        })
        return
      }
      case 'resizeWidget': {
        const widgetService = this.widgetService
        if (widgetService === undefined) return
        const inst = widgetService.get(intent.instanceId)
        if (inst === undefined) return

        const def = widgetService.getDefinition(inst.definitionId)
        const targetMon =
          this.monitors.getMonitor(inst.monitorId) ??
          this.monitors.getMonitor(monitorId) ??
          this.monitors.getPrimaryMonitor()

        let reqWidth = Math.round(intent.size.width * targetMon.scaleFactor)
        let reqHeight = Math.round(intent.size.height * targetMon.scaleFactor)

        const minW = def?.minSize.width ?? 50
        const minH = def?.minSize.height ?? 50
        if (def !== undefined) {
          reqWidth = Math.max(minW, Math.min(def.maxSize?.width ?? Number.POSITIVE_INFINITY, reqWidth))
          reqHeight = Math.max(minH, Math.min(def.maxSize?.height ?? Number.POSITIVE_INFINITY, reqHeight))
        }

        const availableBounds = this.layout.getAvailableBounds(targetMon.id, targetMon.bounds)
        // Ensure widget cannot extend beyond available bounds
        const maxAvailWidth = Math.max(minW, (availableBounds.x + availableBounds.width) - inst.position.x)
        const maxAvailHeight = Math.max(minH, (availableBounds.y + availableBounds.height) - inst.position.y)

        let finalWidth = Math.min(reqWidth, maxAvailWidth)
        let finalHeight = Math.min(reqHeight, maxAvailHeight)

        // All obstacles: exclusion zones, desktop items, and other widgets on this monitor
        const zones = this.layout.getExclusionZones(targetMon.id).map(z => z.rect)
        const items = this.items.getRootItemsForMonitor(targetMon.id).map(i => ({ ...i.position, ...i.size }))
        const otherWidgets = widgetService.getActiveForMonitor(targetMon.id)
          .filter(w => w.id !== inst.id)
          .map(w => ({ ...w.position, ...w.size }))

        const blockers = [...zones, ...items, ...otherWidgets]
        const gap = this.layout.getGridConfig().gap

        const x0 = inst.position.x
        const y0 = inst.position.y
        const w0 = inst.size.width
        const h0 = inst.size.height

        for (const blocker of blockers) {
          if (!rectsIntersect({ x: x0, y: y0, width: finalWidth, height: finalHeight }, blocker, gap)) {
            continue
          }
          // Blocker overlaps candidate vertically (in the horizontal expansion path)
          const inYPath = blocker.y - gap < y0 + Math.min(h0, finalHeight) && blocker.y + blocker.height + gap > y0
          // Blocker overlaps candidate horizontally (in the vertical expansion path)
          const inXPath = blocker.x - gap < x0 + Math.min(w0, finalWidth) && blocker.x + blocker.width + gap > x0

          if (inYPath && !inXPath && blocker.x >= x0) {
            // Pure horizontal collision: clamp only width
            finalWidth = Math.max(minW, Math.min(finalWidth, blocker.x - x0 - gap))
          } else if (inXPath && !inYPath && blocker.y >= y0) {
            // Pure vertical collision: clamp only height
            finalHeight = Math.max(minH, Math.min(finalHeight, blocker.y - y0 - gap))
          } else if (blocker.x >= x0 && blocker.y >= y0) {
            // Corner / diagonal obstacle: clamp the dimension that avoids collision with least disruption
            const maxW = Math.max(minW, blocker.x - x0 - gap)
            const maxH = Math.max(minH, blocker.y - y0 - gap)
            if (finalWidth > maxW && finalHeight > maxH) {
              if ((finalWidth - w0) >= (finalHeight - h0)) {
                finalHeight = maxH
              } else {
                finalWidth = maxW
              }
            }
          }
        }

        const testRect = { x: x0, y: y0, width: finalWidth, height: finalHeight }
        if (blockers.some(b => rectsIntersect(testRect, b, gap))) {
          if (blockers.some(b => rectsIntersect({ x: x0, y: y0, width: finalWidth, height: h0 }, b, gap))) {
            finalWidth = w0
          }
          if (blockers.some(b => rectsIntersect({ x: x0, y: y0, width: w0, height: finalHeight }, b, gap))) {
            finalHeight = h0
          }
          if (blockers.some(b => rectsIntersect({ x: x0, y: y0, width: finalWidth, height: finalHeight }, b, gap))) {
            finalWidth = w0
            finalHeight = h0
          }
        }

        widgetService.update(intent.instanceId, { size: { width: finalWidth, height: finalHeight } })
        return
      }
      case 'removeWidget': {
        this.widgetService?.remove(intent.instanceId)
        return
      }
      case 'widgetAction': {
        if (this.widgetService !== undefined) {
          void this.widgetService.handleIntent(intent.instanceId, intent.action, intent.payload)
        }
        return
      }
      case 'renameItem': {
        const item = this.items.getItem(intent.itemId)
        if (item === undefined) return

        this.renamingItemId = undefined
        const router = this.intentRouterService
        if (router !== undefined) {
          try {
            const res = (await router.dispatch({
              type: 'rename',
              itemId: item.id,
              newName: intent.newName,
            })) as { readonly status?: string; readonly success?: boolean } | undefined

            // Authoritative typed status check
            if (res !== undefined && typeof res.status === 'string') {
              if (res.status !== 'success') {
                this.rendererHost?.publishAll()
                return
              }
            } else if (res && typeof res === 'object' && 'success' in res && !res.success) {
              this.rendererHost?.publishAll()
              return
            }
          } catch {
            this.rendererHost?.publishAll()
            return
          }
        }
        this.items.renameItem(item.id, intent.newName)
        this.rendererHost?.publishAll()
        return
      }
      case 'cancelRename': {
        this.renamingItemId = undefined
        this.rendererHost?.publishAll()
        return
      }
      case 'deleteItem': {
        const item = this.items.getItem(intent.itemId)
        if (item === undefined) return
        const router = this.intentRouterService
        if (router !== undefined) {
          try {
            const res = (await router.dispatch({
              type: 'delete',
              itemIds: [intent.itemId],
            })) as { readonly status?: string; readonly success?: boolean } | undefined

            // Authoritative typed status check
            if (res !== undefined && typeof res.status === 'string') {
              if (res.status !== 'success') {
                return
              }
            } else if (res && typeof res === 'object' && 'success' in res && !res.success) {
              return
            }
          } catch {
            return
          }
        }
        this.items.removeItem(intent.itemId)
        return
      }
      case 'openFolder': {
        this.folders.openFolder(intent.folderId)
        return
      }
      case 'closeFolder': {
        this.folders.closeFolder(intent.folderId)
        return
      }
      case 'setFolderColor': {
        this.folders.setFolderColor(intent.folderId, intent.color)
        return
      }
      case 'reorderFolderItems': {
        this.folders.reorderFolderItems(intent.folderId, intent.itemIds)
        return
      }
      case 'addItemToFolder': {
        this.folders.addItemToFolder(intent.folderId, intent.itemId)
        return
      }
      case 'removeItemFromFolder': {
        this.folders.removeItemFromFolder(intent.folderId, intent.itemId)
        return
      }
      case 'deleteFolder': {
        this.folders.deleteFolder(intent.folderId, false)
        return
      }
      default:
        assertNever(intent)
    }
  }

  private async handleOpenOverlayContextMenu(request: ContextMenuRequest): Promise<void> {
    const p = (async () => {
      const overlay = this.overlayService
      if (overlay === undefined) return

      if (this.activeContextMenuInstanceId) {
        await overlay.close(this.activeContextMenuInstanceId).catch(() => {})
        this.activeContextMenuInstanceId = undefined
      }

      // Empty desktop right-click MUST do nothing. Only entity-specific context menus (item, folder, widget) are shown.
      if (request.targetType === 'desktop') return

      const menuItems = this.buildContextMenuItems(request)
      if (menuItems.length === 0) return

      const defId = 'home-context-menu'
      const menuHtml = this.generateContextMenuHtml(request, menuItems)
      const menuHeight = Math.min(320, 24 + menuItems.length * 36)

      try {
        this.overlayDisposer?.()
        this.overlayDisposer = overlay.register({
          id: defId,
          ownerId: 'home',
          title: 'Home Context Menu',
          size: { width: 220, height: menuHeight },
          defaultPlacement: 'auto',
          focusPolicy: 'activate',
          dismiss: { outsideClick: true, escape: true },
          renderer: {
            type: 'html',
            target: menuHtml,
          },
        })

        const instance = await overlay.open({
          definitionId: defId,
          anchor: {
            type: 'point',
            x: request.position.x,
            y: request.position.y,
          },
          placement: 'auto',
        })
        this.activeContextMenuInstanceId = instance?.instanceId
      } catch (err) {
        this.ctx.logger.warn('Failed to open Overlay Core context menu:', err)
      }
    })()
    this.pendingContextMenuPromise = p
    void p.finally(() => {
      if (this.pendingContextMenuPromise === p) this.pendingContextMenuPromise = null
    })
    return p
  }

  private async dismissContextMenu(): Promise<void> {
    await this.pendingContextMenuPromise?.catch(() => {})
    const instanceId = this.activeContextMenuInstanceId
    this.activeContextMenuInstanceId = undefined
    if (instanceId !== undefined) {
      await this.overlayService?.close(instanceId).catch(() => {})
    }
  }

  private buildContextMenuItems(request: ContextMenuRequest): readonly { id: string; label: string; action: string; badge?: string }[] {
    if (request.targetType === 'item') {
      return [
        { id: 'open', label: 'Open', action: 'open' },
        { id: 'reveal', label: 'Reveal in Folder', action: 'reveal' },
        { id: 'rename', label: 'Rename', action: 'rename', badge: 'F2' },
        { id: 'delete', label: 'Delete', action: 'delete', badge: 'Del' },
      ]
    }
    if (request.targetType === 'folder') {
      return [
        { id: 'open', label: 'Open', action: 'open' },
        { id: 'rename', label: 'Rename', action: 'rename', badge: 'F2' },
        { id: 'delete', label: 'Delete', action: 'delete', badge: 'Del' },
      ]
    }
    if (request.targetType === 'widget') {
      return [
        { id: 'remove-widget', label: 'Remove Widget', action: 'remove-widget' },
        { id: 'reset', label: 'Reset Position', action: 'reset-position' },
      ]
    }
    return []
  }

  private generateContextMenuHtml(
    request: ContextMenuRequest,
    items: readonly { id: string; label: string; action: string; badge?: string }[],
  ): string {
    const itemRows = items.map(item => `
      <div class="menu-item" onclick="triggerAction('${item.action}')">
        <span>${escapeHtml(item.label)}</span>
        ${item.badge ? `<span class="menu-badge">${escapeHtml(item.badge)}</span>` : ''}
      </div>
    `).join('')

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Context Menu</title>
  <style>
    :root {
      ${generateThemeTokensCss(this._themeTokens)}
    }
    * {
      box-sizing: border-box;
    }
    body {
      margin: 0;
      padding: 6px;
      background: var(--elix-context-menu-bg);
      color: var(--elix-context-menu-text);
      font-family: var(--elix-font-ui);
      user-select: none;
      border: 1px solid var(--elix-context-menu-border);
      border-radius: var(--elix-context-menu-radius);
      box-shadow: var(--elix-context-menu-shadow);
      overflow: hidden;
      box-sizing: border-box;
    }
    .menu-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 12px;
      font-size: 12.5px;
      color: var(--elix-text-primary);
      border-radius: var(--elix-radius-sm);
      cursor: pointer;
      transition: background-color var(--elix-ui-transition-fast) ease;
    }
    .menu-item:hover {
      background: var(--elix-context-menu-item-hover-bg);
      color: #fff;
    }
    .menu-badge {
      font-size: 10px;
      color: var(--elix-text-muted);
    }
  </style>
</head>
<body>
  ${itemRows}
  <script>
    function triggerAction(action) {
      if (window.chrome && window.chrome.webview) {
        window.chrome.webview.postMessage(JSON.stringify({
          type: 'home-context-menu/action',
          action: action,
          targetType: '${escapeHtml(request.targetType)}',
          targetId: '${escapeHtml(request.targetId ?? '')}',
          monitorId: '${escapeHtml(request.monitorId)}',
          posX: ${request.position.x},
          posY: ${request.position.y}
        }));
      }
    }
    document.addEventListener('pointerdown', function(ev) {
      if (window.chrome && window.chrome.webview) {
        window.chrome.webview.postMessage({
          type: 'surface/pointer',
          action: 'down',
          screenX: ev.screenX,
          screenY: ev.screenY
        });
      }
    });
  </script>
</body>
</html>`
  }

  private async handleContextMenuAction(data: Record<string, unknown>): Promise<void> {
    const action = typeof data.action === 'string' ? data.action : ''
    const targetType = typeof data.targetType === 'string' ? data.targetType : ''
    const targetId = typeof data.targetId === 'string' && data.targetId.length > 0
      ? data.targetId
      : (typeof data.itemId === 'string' ? data.itemId : '')
    const monitorId = typeof data.monitorId === 'string' ? data.monitorId : this.monitors.getPrimaryMonitor().id
    const posX = typeof data.posX === 'number' ? data.posX : 100
    const posY = typeof data.posY === 'number' ? data.posY : 100

    if (action.startsWith('add-widget:')) {
      const defId = action.slice('add-widget:'.length)
      if (this.widgetService !== undefined) {
        const mon = this.monitors.getMonitor(monitorId) ?? this.monitors.getPrimaryMonitor()
        const def = this.widgetService.getDefinition(defId)
        const size = def?.defaultSize ?? { width: 260, height: 120 }
        const availableBounds = this.layout.getAvailableBounds(mon.id, mon.bounds)
        const zones = this.layout.getExclusionZones(mon.id)
        const minX = availableBounds.x
        const maxX = availableBounds.x + Math.max(0, availableBounds.width - size.width)
        const minY = availableBounds.y
        const maxY = availableBounds.y + Math.max(0, availableBounds.height - size.height)
        let finalPos: Position = {
          x: Math.max(minX, Math.min(maxX, posX)),
          y: Math.max(minY, Math.min(maxY, posY)),
        }
        const candidate: Rect = { ...finalPos, width: size.width, height: size.height }
        const occupied = this.getOccupiedRects(mon.id)
        const gap = this.layout.getGridConfig().gap
        const collidesOccupied = occupied.some(occ => rectsIntersect(candidate, occ, gap))
        const collidesZones = intersectsAnyExclusionZone(candidate, zones, mon.id, gap)
        if (collidesOccupied || collidesZones) {
          finalPos = this.layout.findNearestFreeSlot(
            candidate,
            occupied,
            mon.id,
            availableBounds,
            this._preferences.snapToGrid,
          )
        }
        this.widgetService.create({
          definitionId: defId,
          monitorId: mon.id,
          position: finalPos,
          size,
        })
      }
    } else if (action === 'new-folder') {
      const mon = this.monitors.getMonitor(monitorId) ?? this.monitors.getPrimaryMonitor()
      const availableBounds = this.layout.getAvailableBounds(mon.id, mon.bounds)
      const zones = this.layout.getExclusionZones(mon.id)
      const size = { width: 84, height: 96 }
      const minX = availableBounds.x
      const maxX = availableBounds.x + Math.max(0, availableBounds.width - size.width)
      const minY = availableBounds.y
      const maxY = availableBounds.y + Math.max(0, availableBounds.height - size.height)
      let finalPos: Position = {
        x: Math.max(minX, Math.min(maxX, posX)),
        y: Math.max(minY, Math.min(maxY, posY)),
      }
      const candidate: Rect = { ...finalPos, width: size.width, height: size.height }
      const occupied = this.getOccupiedRects(mon.id)
      const gap = this.layout.getGridConfig().gap
      const collidesOccupied = occupied.some(occ => rectsIntersect(candidate, occ, gap))
      const collidesZones = intersectsAnyExclusionZone(candidate, zones, mon.id, gap)
      if (collidesOccupied || collidesZones) {
        finalPos = this.layout.findNearestFreeSlot(
          candidate,
          occupied,
          mon.id,
          availableBounds,
          this._preferences.snapToGrid,
        )
      }
      this.folders.createFolder({
        monitorId: mon.id,
        position: finalPos,
        name: 'New Folder',
        color: 'sky',
      })
    } else if (action === 'toggle-grid') {
      this._preferences = { ...this._preferences, snapToGrid: !this._preferences.snapToGrid }
      this.rendererHost?.publishAll()
    } else if (action === 'refresh') {
      this.rendererHost?.publishAll()
    } else if (action === 'open') {
      if (targetId) {
        const item = this.items.getItem(targetId)
        if (item) void this.dispatchRendererIntent(monitorId, { type: 'activate', itemId: targetId })
      }
    } else if (action === 'reveal') {
      if (targetId && this.intentRouterService !== undefined) {
        void this.intentRouterService.dispatch({ type: 'reveal-in-folder', itemId: targetId }).catch(() => {})
      }
    } else if (action === 'rename') {
      if (targetId) {
        this.renamingItemId = targetId
        this.rendererHost?.publishAll()
      }
    } else if (action === 'reset-position') {
      if (targetId) {
        if (targetType === 'item' || this.items.getItem(targetId) !== undefined) {
          this.items.moveItem(targetId, { x: 10, y: 10 })
          this.rendererHost?.publishAll()
        } else if (this.widgetService !== undefined) {
          const primary = this.monitors.getPrimaryMonitor()
          this.widgetService.update(targetId, {
            position: { x: primary.bounds.x + 100, y: primary.bounds.y + 100 },
            monitorId: primary.id,
          })
        }
      }
    } else if (action === 'delete') {
      if (targetId) {
        void this.dispatchRendererIntent(monitorId, { type: 'deleteItem', itemId: targetId })
      }
    } else if (action === 'remove-widget') {
      if (targetId && this.widgetService !== undefined) {
        this.widgetService.remove(targetId)
      }
    }

    // Close context menu surface
    await this.dismissContextMenu()
    this.overlayDisposer?.()
    this.overlayDisposer = undefined
  }

  private resolveRendererAsset(monitorId: string, request: HomeRendererAsset): ResolvedHomeRendererAsset | undefined {
    this.requireMonitor(monitorId)
    const source = request.kind === 'wallpaper'
      ? this.personalization.getActiveWallpaper(monitorId).source
      : rendererItemIconSource(this.items.getItem(request.itemId), monitorId)
    if (source === undefined) return undefined
    const path = localMediaPath(source)
    if (path === undefined) return undefined
    const contentType = rendererMediaType(path, request.kind)
    return contentType === undefined ? undefined : { path, contentType }
  }

  private requireMonitor(monitorId: string): MonitorInfo {
    const monitor = this.monitors.getMonitor(monitorId)
    if (monitor === undefined) throw new Error('Unknown Home monitor ' + JSON.stringify(monitorId) + '.')
    return monitor
  }

  private getRootItemOnMonitor(itemId: string, monitorId: string): HomeItem | undefined {
    const item = this.items.getItem(itemId)
    if (item === undefined || item.folderId !== undefined || item.monitorId !== monitorId) return undefined
    return item
  }

  private reconcileExclusionPlacements(): void {
    const moves: Array<{ id: string; position: { x: number; y: number }; monitorId: string }> = []
    const gap = this.layout.getGridConfig().gap

    for (const monitor of this.monitors.getMonitors()) {
      const availableBounds = this.layout.getAvailableBounds(monitor.id, monitor.bounds)
      const zones = this.layout.getExclusionZones(monitor.id)

      // Active widgets on this monitor
      const activeWidgets = this.widgetService?.getActiveForMonitor(monitor.id) ?? []
      const placedWidgetRects: Array<{ id: string; rect: Rect }> = []

      // 1. Reconcile widgets: keep within availableBounds, outside exclusion zones, and not overlapping other widgets
      for (const widget of activeWidgets) {
        const rect: Rect = { ...widget.position, ...widget.size }
        const insideBounds =
          rect.x >= availableBounds.x &&
          rect.x + rect.width <= availableBounds.x + availableBounds.width &&
          rect.y >= availableBounds.y &&
          rect.y + rect.height <= availableBounds.y + availableBounds.height
        const collidesExclusions = intersectsAnyExclusionZone(rect, zones, monitor.id, gap)
        const collidesOtherWidgets = placedWidgetRects.some(p => rectsIntersect(rect, p.rect, gap))

        if (!insideBounds || collidesExclusions || collidesOtherWidgets) {
          const itemRects = this.items.getRootItemsForMonitor(monitor.id).map(i => ({ ...i.position, ...i.size }))
          const blockers = [...placedWidgetRects.map(p => p.rect), ...itemRects]
          const newPos = this.layout.findNearestFreeSlot(
            rect,
            blockers,
            monitor.id,
            availableBounds,
            this._preferences.snapToGrid,
          )
          const newRect: Rect = { ...newPos, ...widget.size }
          placedWidgetRects.push({ id: widget.id, rect: newRect })
          if (newPos.x !== widget.position.x || newPos.y !== widget.position.y) {
            this.widgetService?.update(widget.id, { position: newPos })
          }
        } else {
          placedWidgetRects.push({ id: widget.id, rect })
        }
      }

      // 2. Reconcile items: keep within availableBounds, outside exclusion zones, not overlapping widgets, and not overlapping items
      const working = this.items.getRootItemsForMonitor(monitor.id).map(item => ({ ...item }))
      const widgetRects = placedWidgetRects.map(p => p.rect)

      for (let i = 0; i < working.length; i++) {
        const item = working[i]
        if (!item) continue
        const rect = { ...item.position, ...item.size }
        const insideBounds =
          rect.x >= availableBounds.x &&
          rect.x + rect.width <= availableBounds.x + availableBounds.width &&
          rect.y >= availableBounds.y &&
          rect.y + rect.height <= availableBounds.y + availableBounds.height
        const collidesExclusions = intersectsAnyExclusionZone(rect, zones, monitor.id, gap)
        const collidesWidgets = widgetRects.some(w => rectsIntersect(rect, w, gap))
        const collidesOtherItems = working.some(
          (other, idx) => idx !== i && rectsIntersect(rect, { ...other.position, ...other.size }, gap),
        )

        if (!insideBounds || collidesExclusions || collidesWidgets || collidesOtherItems) {
          const otherItems = working.filter((_, idx) => idx !== i)
          const position = this.layout.resolvePlacement(
            item,
            otherItems,
            availableBounds,
            this._preferences.snapToGrid,
            widgetRects,
          )
          if (position.x !== item.position.x || position.y !== item.position.y) {
            moves.push({ id: item.id, position, monitorId: monitor.id })
            working[i] = { ...item, position }
          }
        }
      }
    }
    if (moves.length > 0) {
      this.items.moveItems(moves)
    }
  }
}

export const HomePlugin = HomeService
export default HomeService

function projectWindowsMonitor(monitor: WindowsMonitor): MonitorInfo {
  return {
    id: monitor.id,
    name: monitor.friendlyName ?? monitor.deviceName,
    bounds: monitor.bounds,
    workArea: monitor.workArea,
    scaleFactor: monitor.scaleFactor,
    isPrimary: monitor.isPrimary,
  }
}

function projectRendererItem(
  item: HomeItem,
  monitor: MonitorInfo,
  assetBasePath: string,
  selected: boolean,
  isRenaming = false,
  itemManager?: HomeItemManager,
): HomeRendererItem {
  const metadata = item.metadata as Record<string, unknown>
  const iconSource = rendererItemIconSource(item, monitor.id)
  const folderMetadata = item.type === 'folder' ? item.metadata as FolderMetadata : undefined
  const widgetMetadata = item.type === 'widget' ? item.metadata as WidgetMetadata : undefined
  const isFilesystemFolder = item.type === 'folder' && Boolean(metadata.isFilesystem)

  let folderChildren: HomeRendererFolderChild[] | undefined
  if (folderMetadata !== undefined && !isFilesystemFolder && itemManager !== undefined) {
    const rawChildren: HomeRendererFolderChild[] = []
    const ids = Array.isArray(folderMetadata.itemIds) ? folderMetadata.itemIds : []
    for (const childId of ids) {
      const childItem = itemManager.getItem(childId)
      if (childItem !== undefined) {
        const childIcon = rendererItemIconSource(childItem, monitor.id)
        rawChildren.push({
          id: childItem.id,
          label: rendererItemLabel(childItem),
          type: childItem.type,
          iconUrl: childIcon !== undefined ? assetBasePath + '/icon/' + encodeURIComponent(childItem.id) : undefined,
        })
      }
    }
    folderChildren = rawChildren
  }

  return {
    id: item.id,
    type: item.type,
    label: rendererItemLabel(item),
    rect: physicalRectToRenderer({ ...item.position, ...item.size }, monitor),
    selected,
    isRenaming,
    ...(iconSource === undefined ? {} : { iconUrl: assetBasePath + '/icon/' + encodeURIComponent(item.id) }),
    ...(folderMetadata === undefined
      ? {}
      : {
        folderColor: typeof folderMetadata.color === 'string' ? folderMetadata.color : 'sky',
        folderItemCount: Array.isArray(folderMetadata.itemIds) ? folderMetadata.itemIds.length : 0,
        isFilesystemFolder,
        isOpen: folderMetadata.isOpen,
        folderChildren,
      }),
    ...(widgetMetadata === undefined
      ? {}
      : { widgetType: typeof metadata.widgetType === 'string' ? metadata.widgetType : 'widget' }),
  }
}

function rendererItemLabel(item: HomeItem): string {
  const metadata = item.metadata as Record<string, unknown>
  for (const key of ['name', 'filename', 'label']) {
    const value = metadata[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim().slice(0, 128)
  }
  if (item.type === 'widget' && typeof metadata.widgetType === 'string') return metadata.widgetType
  return item.type
}

function rendererItemIconSource(item: HomeItem | undefined, monitorId: string): string | undefined {
  if (item === undefined || item.monitorId !== monitorId || item.folderId !== undefined) return undefined
  const metadata = item.metadata as Record<string, unknown>
  const value = typeof metadata.icon === 'string'
    ? metadata.icon
    : typeof metadata.iconPath === 'string'
      ? metadata.iconPath
      : undefined
  return value !== undefined && localMediaPath(value) !== undefined ? value : undefined
}

function physicalRectToRenderer(rect: Rect, monitor: MonitorInfo): RendererRect {
  return {
    x: (rect.x - monitor.bounds.x) / monitor.scaleFactor,
    y: (rect.y - monitor.bounds.y) / monitor.scaleFactor,
    width: rect.width / monitor.scaleFactor,
    height: rect.height / monitor.scaleFactor,
  }
}

function rendererPointToPhysical(point: RendererPoint, monitor: MonitorInfo): { x: number; y: number } {
  return {
    x: monitor.bounds.x + point.x * monitor.scaleFactor,
    y: monitor.bounds.y + point.y * monitor.scaleFactor,
  }
}

function rendererRectToPhysical(rect: RendererRect, monitor: MonitorInfo): Rect {
  return {
    ...rendererPointToPhysical(rect, monitor),
    width: rect.width * monitor.scaleFactor,
    height: rect.height * monitor.scaleFactor,
  }
}

function localMediaPath(source: string): string | undefined {
  try {
    if (source.startsWith('file://')) return fileURLToPath(source)
  } catch {
    return undefined
  }
  return isAbsolute(source) ? source : undefined
}

function rendererMediaType(path: string, asset: HomeRendererAsset['kind']): string | undefined {
  const extension = extname(path).toLowerCase()
  if (asset === 'icon') {
    return {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.gif': 'image/gif',
      '.bmp': 'image/bmp',
      '.ico': 'image/x-icon',
    }[extension]
  }
  return {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
  }[extension]
}

function assertNever(value: never): never {
  throw new Error('Unhandled Home renderer intent: ' + JSON.stringify(value))
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}
