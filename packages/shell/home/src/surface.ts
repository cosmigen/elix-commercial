/**
 * Per-monitor Home ownership over authoritative Surface Core instances.
 *
 * @module @deepseek-ai/dsh-home/surface
 */

import type {
  PhysicalBounds,
  SurfaceCreateOptions,
  SurfaceInstance,
  SurfaceLifecycleState,
  SurfaceService,
  SurfaceZOrderPolicy,
} from '@deepseek-ai/dsh-surface'
import type { MonitorManager } from './monitor.ts'
import type { WallpaperRuntimeState } from './renderer-protocol.ts'

export type { SurfaceZOrderPolicy } from '@deepseek-ai/dsh-surface'

/** Home callback for renderer wallpaper runtime changes. */
export type HomeSurfaceRuntimeListener = (monitorId: string, state: WallpaperRuntimeState) => void

/**
 * Home's monitor identity wrapper around a Surface Core instance.
 *
 * Surface Core remains the only owner of HWND, WebView2, readiness, native recovery,
 * visibility, z-order, DPI, bounds, and teardown.
 */
export class HomeSurfaceInstance {
  constructor(
    readonly monitorId: string,
    private readonly surface: SurfaceInstance,
    private readonly runtimeListener?: HomeSurfaceRuntimeListener,
  ) {}

  /** Stable native surface identifier. */
  get surfaceId(): string {
    return this.surface.id
  }

  /** Current authoritative Surface Core lifecycle state. */
  get state(): SurfaceLifecycleState {
    return this.surface.state
  }

  /** Whether the native surface is visible. */
  get isVisible(): boolean {
    return this.surface.isVisible
  }

  /** Whether current-generation native and renderer readiness are complete. */
  get isReady(): boolean {
    return this.surface.isReady()
  }

  /** Current-generation HWND. */
  get windowHandle(): number {
    return this.surface.hwnd
  }

  /**
   * Current canonical physical-pixel bounds.
   * @returns Copy of current surface physical bounds.
   */
  getBounds(): PhysicalBounds {
    return { ...this.surface.bounds }
  }

  /**
   * Await current-generation ready-before-show completion.
   * @returns Resolved SurfaceInstance once ready.
   */
  whenReady(): Promise<SurfaceInstance> {
    return this.surface.whenReady()
  }

  /**
   * Update authoritative physical bounds after a Windows Context topology change.
   * @param bounds - Target physical-pixel bounds.
   */
  async updateGeometry(bounds: PhysicalBounds): Promise<void> {
    if (sameBounds(this.surface.bounds, bounds)) return
    await this.surface.setBounds(bounds)
  }

  /** Reveal this surface only through Surface Core's readiness gate. */
  async show(): Promise<void> {
    await this.surface.show()
    this.runtimeListener?.(this.monitorId, 'active')
  }

  /** Hide this surface and suspend renderer background work. */
  async hide(): Promise<void> {
    this.runtimeListener?.(this.monitorId, 'suspended')
    await this.surface.hide()
  }

  /** Reload the current WebView document; Surface Core fences recovered generations. */
  async restart(): Promise<void> {
    this.runtimeListener?.(this.monitorId, 'suspended')
    await this.surface.reload()
  }

  /**
   * Adjust the native surface z-order policy (e.g. for demo/acceptance presentation).
   * @param zOrderPolicy - Target z-order policy ('bottom' | 'normal' | 'topmost').
   */
  async setZOrder(zOrderPolicy: SurfaceZOrderPolicy): Promise<void> {
    await this.surface.setZOrder(zOrderPolicy)
  }

  /** Destroy the native surface and dispose renderer background work. */
  async destroy(): Promise<void> {
    if (this.surface.state === 'DISPOSED' || this.surface.state === 'DESTROYING') return
    this.runtimeListener?.(this.monitorId, 'disposed')
    await this.surface.destroy()
  }
}

/** Collection replacement listener. */
export type SurfaceChangeListener = (surfaces: readonly HomeSurfaceInstance[]) => void

/** Per-instance creation listener. */
export type SurfaceCreatedListener = (surface: HomeSurfaceInstance) => void

/** Per-instance destruction listener. */
export type SurfaceDestroyedListener = (surface: HomeSurfaceInstance) => void

/** Surface Core dependencies used by Home's per-monitor coordinator. */
export interface HomeSurfaceManagerOptions {
  readonly getSurfaceService: () => SurfaceService
  readonly rendererUrl: (monitorId: string) => string
  readonly autoShowOnReady: boolean
  readonly runtimeListener?: HomeSurfaceRuntimeListener | undefined
  readonly zOrderPolicy?: SurfaceZOrderPolicy | undefined
}

/**
 * Reconciles exactly one authoritative native surface per Windows Context monitor.
 */
export class HomeSurfaceManager {
  private readonly surfaces = new Map<string, HomeSurfaceInstance>()
  private readonly listeners = new Set<SurfaceChangeListener>()
  private readonly createdListeners = new Set<SurfaceCreatedListener>()
  private readonly destroyedListeners = new Set<SurfaceDestroyedListener>()
  private operation: Promise<void> = Promise.resolve()
  private isShuttingDown = false

  constructor(
    private readonly monitorManager: MonitorManager,
    private readonly options: HomeSurfaceManagerOptions,
  ) {}

  /**
   * Retrieve all active Home surface wrappers.
   * @returns List of active HomeSurfaceInstance objects.
   */
  getSurfaces(): readonly HomeSurfaceInstance[] {
    return Array.from(this.surfaces.values())
  }

  /**
   * Get the Home surface assigned to one monitor.
   * @param monitorId - Target monitor identifier.
   * @returns The surface instance if registered, otherwise undefined.
   */
  getSurfaceForMonitor(monitorId: string): HomeSurfaceInstance | undefined {
    return this.surfaces.get(monitorId)
  }

  /**
   * Subscribe to collection replacements.
   * @param listener - Callback invoked with active surface list when surfaces change.
   * @returns Disposer function that unregisters the listener.
   */
  onChange(listener: SurfaceChangeListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Subscribe to Home surface creation after the instance is registered.
   * @param listener - Callback invoked when a Home surface is created.
   * @returns Disposer function that unregisters the listener.
   */
  onCreated(listener: SurfaceCreatedListener): () => void {
    this.createdListeners.add(listener)
    return () => {
      this.createdListeners.delete(listener)
    }
  }

  /**
   * Subscribe to Home surface destruction after native teardown settles.
   * @param listener - Callback invoked when a Home surface is destroyed.
   * @returns Disposer function that unregisters the listener.
   */
  onDestroyed(listener: SurfaceDestroyedListener): () => void {
    this.destroyedListeners.add(listener)
    return () => {
      this.destroyedListeners.delete(listener)
    }
  }

  /**
   * Serialize monitor reconciliation so rapid topology replacements cannot create duplicate surfaces.
   */
  reconcile(): Promise<void> {
    return this.enqueue(async () => {
      if (this.isShuttingDown) return
      const connectedMonitors = this.monitorManager.getMonitors()
      const connectedIds = new Set(connectedMonitors.map(monitor => monitor.id))

      for (const [monitorId, surface] of [...this.surfaces.entries()]) {
        if (connectedIds.has(monitorId)) continue
        await surface.destroy()
        this.surfaces.delete(monitorId)
        this.notifyDestroyed(surface)
      }

      for (const monitor of connectedMonitors) {
        const existing = this.surfaces.get(monitor.id)
        if (existing !== undefined) {
          await existing.updateGeometry(monitor.bounds)
          continue
        }
        const surfaceService = this.options.getSurfaceService()
        const createOptions: SurfaceCreateOptions = {
          id: surfaceIdForMonitor(monitor.id),
          monitorId: monitor.id,
          bounds: monitor.bounds,
          renderer: { type: 'url', target: this.options.rendererUrl(monitor.id) },
          focusPolicy: 'noActivate',
          zOrderPolicy: this.options.zOrderPolicy ?? 'bottom',
          skipTaskbar: true,
          transparent: false,
          visible: this.options.autoShowOnReady,
        }
        const nativeSurface = await surfaceService.create(createOptions)
        const created = new HomeSurfaceInstance(
          monitor.id,
          nativeSurface,
          this.options.runtimeListener,
        )
        this.surfaces.set(monitor.id, created)
        this.notifyCreated(created)
      }
      this.notify()
    })
  }

  /** Reveal every Home surface through Surface Core's readiness gate. */
  async showAll(): Promise<void> {
    await this.operation
    await Promise.all([...this.surfaces.values()].map(surface => surface.show()))
  }

  /** Hide every Home surface and suspend renderer wallpaper work. */
  async hideAll(): Promise<void> {
    await this.operation
    await Promise.all([...this.surfaces.values()].map(surface => surface.hide()))
  }

  /** Reload every Home renderer without replacing authoritative Home state. */
  async restartAll(): Promise<void> {
    await this.operation
    await Promise.all([...this.surfaces.values()].map(surface => surface.restart()))
  }

  /**
   * Adjust the z-order policy across all active surfaces.
   * @param zOrderPolicy - Target z-order policy.
   */
  async setZOrderAll(zOrderPolicy: SurfaceZOrderPolicy): Promise<void> {
    await this.operation
    await Promise.all([...this.surfaces.values()].map(surface => surface.setZOrder(zOrderPolicy)))
  }

  /** Destroy all native resources and wait until every teardown settles. */
  shutdownAll(): Promise<void> {
    this.isShuttingDown = true
    return this.enqueue(async () => {
      const current = [...this.surfaces.values()]
      await Promise.all(current.map(surface => surface.destroy()))
      this.surfaces.clear()
      for (const surface of current) this.notifyDestroyed(surface)
      this.notify()
      this.listeners.clear()
      this.createdListeners.clear()
      this.destroyedListeners.clear()
    })
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.operation.then(operation)
    this.operation = result.catch(() => {})
    return result
  }

  private notify(): void {
    const current = this.getSurfaces()
    for (const listener of this.listeners) {
      try {
        listener(current)
      } catch (error) {
        console.error('Error in Home surface collection listener:', error)
      }
    }
  }

  private notifyCreated(surface: HomeSurfaceInstance): void {
    for (const listener of this.createdListeners) {
      try {
        listener(surface)
      } catch (error) {
        console.error('Error in Home surface creation listener:', error)
      }
    }
  }

  private notifyDestroyed(surface: HomeSurfaceInstance): void {
    for (const listener of this.destroyedListeners) {
      try {
        listener(surface)
      } catch (error) {
        console.error('Error in Home surface destruction listener:', error)
      }
    }
  }
}

function surfaceIdForMonitor(monitorId: string): string {
  return 'surface-home-' + monitorId
}

function sameBounds(left: PhysicalBounds, right: PhysicalBounds): boolean {
  return left.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height
}
