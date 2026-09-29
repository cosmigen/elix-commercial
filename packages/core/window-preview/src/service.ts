import { Context, Service } from '@deepseek-ai/cordis'
import { getSharedNativeBridge, type NativeBridgeClient } from '@deepseek-ai/dsh-native-core'
import type { SurfaceInstance, SurfaceService } from '@deepseek-ai/dsh-surface'
import type {
  WindowRegistryService,
  WindowSnapshot,
} from '@deepseek-ai/dsh-window-registry'
import z from '@deepseek-ai/schemastery'
import type {
  NativePreviewSnapshot,
  PreviewBackend,
  PreviewFit,
  PreviewImportance,
  PreviewLeaseOptions,
  PreviewLeaseSnapshot,
  PreviewRect,
  PreviewState,
  PreviewStats,
  WindowPreviewConfig,
} from './types.ts'

interface NormalizedPreviewOptions {
  readonly sourceWindowId: PreviewLeaseOptions['sourceWindowId']
  readonly destinationSurfaceId: string
  readonly destinationRect: PreviewRect
  readonly consumerId: string
  readonly visible: boolean
  readonly opacity: number
  readonly importance: PreviewImportance
  readonly desiredRefreshHz: number
  readonly sourceClientAreaOnly: boolean
  readonly fit: PreviewFit
}

interface NativeBinding {
  readonly sourceHwnd: number
  readonly destinationHwnd: number
  readonly processId: number
  readonly processCreationTime: number
}

interface LeaseRecord {
  readonly id: string
  options: NormalizedPreviewOptions
  snapshot: PreviewLeaseSnapshot
  nativeBinding?: NativeBinding | undefined
  order: number
}

const IMPORTANCE: Readonly<Record<PreviewImportance, number>> = Object.freeze({
  critical: 4,
  high: 3,
  normal: 2,
  low: 1,
})

function clampOpacity(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 255
  return Math.max(0, Math.min(255, Math.round(value)))
}

function clampRefresh(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 30
  return Math.max(1, Math.min(240, Math.round(value)))
}

function validateRect(rect: PreviewRect): void {
  if (
    !Number.isInteger(rect.x)
    || !Number.isInteger(rect.y)
    || !Number.isInteger(rect.width)
    || !Number.isInteger(rect.height)
    || rect.width <= 0
    || rect.height <= 0
    || rect.width > 32_767
    || rect.height > 32_767
  ) {
    throw new RangeError(
      'Preview destinationRect must contain integer coordinates and positive physical-pixel dimensions.',
    )
  }
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined
  const code = Reflect.get(error, 'code')
  return typeof code === 'string' ? code : undefined
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function isPreviewableWindow(window: WindowSnapshot): boolean {
  return (
    (window.classification === 'APPLICATION'
      || window.classification === 'TOOL'
      || window.classification === 'TRANSIENT')
    && !window.isShellWindow
  )
}

function fitRect(
  container: PreviewRect,
  sourceWidth: number,
  sourceHeight: number,
  fit: PreviewFit,
): PreviewRect {
  if (
    fit === 'stretch'
    || sourceWidth <= 0
    || sourceHeight <= 0
  ) {
    return Object.freeze({ ...container })
  }

  const scale = Math.min(container.width / sourceWidth, container.height / sourceHeight)
  const width = Math.max(1, Math.round(sourceWidth * scale))
  const height = Math.max(1, Math.round(sourceHeight * scale))
  return Object.freeze({
    x: container.x + Math.floor((container.width - width) / 2),
    y: container.y + Math.floor((container.height - height) / 2),
    width,
    height,
  })
}

function sameRect(left: PreviewRect, right: PreviewRect): boolean {
  return left.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height
}

/**
 * Phase 17A authority for backend-neutral live window-preview leases.
 *
 * Stable WindowId and Surface IDs are resolved immediately before every native mutation.
 * HWND and HTHUMBNAIL never escape this backend boundary. DWM is the first live backend;
 * callers consume lease state rather than depending on DWM-specific primitives.
 */
export class WindowPreviewService extends Service {
  static Config = z.object({
    enabled: z.boolean().default(true),
    maxLivePreviews: z.number().default(12),
  })

  private readonly config: WindowPreviewConfig
  private readonly leases = new Map<string, LeaseRecord>()
  private readonly listeners = new Set<(snapshot: PreviewLeaseSnapshot) => void>()
  private registry: WindowRegistryService | undefined
  private surfaces: SurfaceService | undefined
  private registryDisposer: (() => void) | undefined
  private bridgeInstance: NativeBridgeClient | undefined
  private nextLeaseId = 1
  private nextOrder = 1
  private reconcileVersion = 0
  private reconciledVersion = 0
  private reconcileWorker: Promise<void> | undefined
  private disposed = false
  private sessionLocked = false

  constructor(ctx: Context, config?: Partial<WindowPreviewConfig>) {
    super(ctx, 'windowPreview')
    const requestedBudget = config?.maxLivePreviews ?? 12
    this.config = {
      enabled: config?.enabled ?? true,
      maxLivePreviews: Math.max(1, Math.min(64, Math.floor(requestedBudget))),
      bridge: config?.bridge,
    }
  }

  [Service.init](): void {
    if (!this.config.enabled) return

    this.bridgeInstance = this.config.bridge ?? getSharedNativeBridge()
    this.attachRegistry(this.ctx.get('windowRegistry'))
    this.attachSurfaces(this.ctx.get('surface'))

    this.ctx.on('window-registry/ready', (service) => {
      this.attachRegistry(service)
    })
    this.ctx.on('window-registry/recovered', () => {
      // DWM handles belonged to the previous native-host process and no longer exist.
      for (const lease of this.leases.values()) lease.nativeBinding = undefined
      void this.scheduleReconcile()
    })
    this.ctx.on('surface/service-ready', (service) => {
      this.attachSurfaces(service)
    })
    this.ctx.on('surface/shown', () => {
      void this.scheduleReconcile()
    })
    this.ctx.on('surface/hidden', () => {
      void this.scheduleReconcile()
    })
    this.ctx.on('surface/ready', () => {
      // Surface readiness also covers native-host recreation with a new destination HWND.
      void this.scheduleReconcile()
    })
    this.ctx.on('surface/destroyed', () => {
      void this.scheduleReconcile()
    })

    this.ctx.effect(() => async () => {
      this.disposed = true
      this.registryDisposer?.()
      this.registryDisposer = undefined
      await this.reconcileWorker?.catch(() => {})
      const active = Array.from(this.leases.values())
      for (const lease of active) {
        await this.unbindNative(lease).catch(() => {})
      }
      this.leases.clear()
      this.listeners.clear()
    }, 'windowPreview.lifecycle')

    this.ctx.emit('window-preview/ready', this)
  }

  /** Allocates one logical preview lease and reconciles it to the best available backend. */
  async acquirePreview(options: PreviewLeaseOptions): Promise<PreviewLeaseSnapshot> {
    if (this.disposed) throw new Error('WindowPreviewService is disposed')
    const normalized = this.normalizeOptions(options)
    const id = `preview:${this.nextLeaseId++}`
    const now = Date.now()
    const snapshot: PreviewLeaseSnapshot = Object.freeze({
      id,
      sourceWindowId: normalized.sourceWindowId,
      destinationSurfaceId: normalized.destinationSurfaceId,
      consumerId: normalized.consumerId,
      state: 'paused',
      backend: 'none',
      destinationRect: normalized.destinationRect,
      effectiveRect: normalized.destinationRect,
      visible: normalized.visible,
      opacity: normalized.opacity,
      importance: normalized.importance,
      desiredRefreshHz: normalized.desiredRefreshHz,
      sourceClientAreaOnly: normalized.sourceClientAreaOnly,
      fit: normalized.fit,
      reason: 'pending-reconciliation',
      updatedAt: now,
    })
    const record: LeaseRecord = {
      id,
      options: normalized,
      snapshot,
      order: this.nextOrder++,
    }
    this.leases.set(id, record)
    await this.scheduleReconcile()
    return record.snapshot
  }

  /** Updates consumer hints or geometry while preserving stable source/destination identity. */
  async updateLease(
    id: string,
    patch: Partial<Omit<PreviewLeaseOptions, 'sourceWindowId' | 'destinationSurfaceId' | 'consumerId'>>,
  ): Promise<PreviewLeaseSnapshot> {
    const lease = this.requireLease(id)
    const nextRect = patch.destinationRect ?? lease.options.destinationRect
    validateRect(nextRect)
    lease.options = {
      ...lease.options,
      destinationRect: Object.freeze({ ...nextRect }),
      visible: patch.visible ?? lease.options.visible,
      opacity: patch.opacity === undefined ? lease.options.opacity : clampOpacity(patch.opacity),
      importance: patch.importance ?? lease.options.importance,
      desiredRefreshHz: patch.desiredRefreshHz === undefined
        ? lease.options.desiredRefreshHz
        : clampRefresh(patch.desiredRefreshHz),
      sourceClientAreaOnly: patch.sourceClientAreaOnly ?? lease.options.sourceClientAreaOnly,
      fit: patch.fit ?? lease.options.fit,
    }
    lease.order = this.nextOrder++
    await this.scheduleReconcile()
    return lease.snapshot
  }

  /** Releases one logical lease and any process-local native composition resource. */
  async releasePreview(id: string): Promise<boolean> {
    const lease = this.leases.get(id)
    if (!lease) return false
    await this.unbindNative(lease).catch((error: unknown) => {
      this.ctx.emit('window-preview/fault', toError(error))
    })
    this.transition(lease, 'destroyed', 'released', 'none')
    this.leases.delete(id)
    return true
  }

  /** Session integration hook. Lock releases live imagery; unlock re-evaluates leases. */
  async setSessionLocked(locked: boolean): Promise<void> {
    if (this.sessionLocked === locked) return
    this.sessionLocked = locked
    await this.scheduleReconcile()
  }

  getLease(id: string): PreviewLeaseSnapshot | undefined {
    return this.leases.get(id)?.snapshot
  }

  listLeases(): readonly PreviewLeaseSnapshot[] {
    return Array.from(this.leases.values(), lease => lease.snapshot)
  }

  subscribe(listener: (snapshot: PreviewLeaseSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getStats(): PreviewStats {
    const counts: Record<PreviewState, number> = {
      live: 0,
      cached: 0,
      paused: 0,
      unavailable: 0,
      denied: 0,
      destroyed: 0,
    }
    let nativeBindings = 0
    for (const lease of this.leases.values()) {
      counts[lease.snapshot.state]++
      if (lease.nativeBinding) nativeBindings++
    }
    return Object.freeze({
      totalLeases: this.leases.size,
      live: counts.live,
      cached: counts.cached,
      paused: counts.paused,
      unavailable: counts.unavailable,
      denied: counts.denied,
      destroyed: counts.destroyed,
      nativeBindings,
      maxLivePreviews: this.config.maxLivePreviews,
      sessionLocked: this.sessionLocked,
    })
  }

  /** Forces immediate reconciliation after an explicit external state transition. */
  refresh(): Promise<void> {
    return this.scheduleReconcile()
  }

  private normalizeOptions(options: PreviewLeaseOptions): NormalizedPreviewOptions {
    if (!String(options.sourceWindowId).trim()) throw new TypeError('sourceWindowId is required')
    if (!options.destinationSurfaceId.trim()) throw new TypeError('destinationSurfaceId is required')
    if (!options.consumerId.trim()) throw new TypeError('consumerId is required')
    validateRect(options.destinationRect)
    return Object.freeze({
      sourceWindowId: options.sourceWindowId,
      destinationSurfaceId: options.destinationSurfaceId,
      destinationRect: Object.freeze({ ...options.destinationRect }),
      consumerId: options.consumerId,
      visible: options.visible ?? true,
      opacity: clampOpacity(options.opacity),
      importance: options.importance ?? 'normal',
      desiredRefreshHz: clampRefresh(options.desiredRefreshHz),
      sourceClientAreaOnly: options.sourceClientAreaOnly ?? false,
      fit: options.fit ?? 'contain',
    })
  }

  private requireLease(id: string): LeaseRecord {
    const lease = this.leases.get(id)
    if (!lease) throw new Error(`Unknown preview lease '${id}'.`)
    return lease
  }

  private attachRegistry(registry: WindowRegistryService | undefined): void {
    if (!registry || this.registry === registry) return
    this.registryDisposer?.()
    this.registry = registry
    this.registryDisposer = registry.subscribe(() => {
      void this.scheduleReconcile()
    })
    void this.scheduleReconcile()
  }

  private attachSurfaces(surfaces: SurfaceService | undefined): void {
    if (!surfaces || this.surfaces === surfaces) return
    this.surfaces = surfaces
    void this.scheduleReconcile()
  }

  /**
   * Coalesces event/resize storms. Every caller waits until at least the version it requested
   * has been reconciled, while bursts arriving during native I/O collapse into the next pass.
   */
  private scheduleReconcile(): Promise<void> {
    const requestedVersion = ++this.reconcileVersion
    if (!this.reconcileWorker) {
      this.reconcileWorker = (async () => {
        while (!this.disposed && this.reconciledVersion < this.reconcileVersion) {
          const targetVersion = this.reconcileVersion
          await this.reconcileAll()
          this.reconciledVersion = targetVersion
        }
      })()
        .catch((error: unknown) => {
          this.ctx.emit('window-preview/fault', toError(error))
          throw error
        })
        .finally(() => {
          this.reconcileWorker = undefined
        })
    }

    const worker = this.reconcileWorker
    return worker.then(async () => {
      if (!this.disposed && this.reconciledVersion < requestedVersion) {
        await this.scheduleReconcile()
      }
    })
  }

  private resolveSource(lease: LeaseRecord): WindowSnapshot | undefined {
    if (!this.registry) {
      const root = this.ctx.root as unknown as Record<string, unknown>
      const registry = (this.ctx.get('windowRegistry') ?? root['windowRegistry']) as WindowRegistryService | undefined
      if (registry) this.attachRegistry(registry)
    }
    return this.registry?.getWindow(lease.options.sourceWindowId)
  }

  private resolveDestination(lease: LeaseRecord): SurfaceInstance | undefined {
    if (!this.surfaces) {
      const root = this.ctx.root as unknown as Record<string, unknown>
      const surfaces = (this.ctx.get('surface') ?? root['surface']) as SurfaceService | undefined
      if (surfaces) this.attachSurfaces(surfaces)
    }
    return this.surfaces?.get(lease.options.destinationSurfaceId)
  }

  private liveCandidates(): Set<string> {
    if (this.sessionLocked) return new Set()

    const candidates = Array.from(this.leases.values()).filter((lease) => {
      const source = this.resolveSource(lease)
      const destination = this.resolveDestination(lease)
      return Boolean(
        source
        && destination
        && lease.options.visible
        && destination.isVisible
        && destination.hwnd !== 0
        && isPreviewableWindow(source)
        && source.isVisible
        && !source.isCloaked
        && source.state !== 'hidden',
      )
    })

    candidates.sort((left, right) => {
      const importance = IMPORTANCE[right.options.importance] - IMPORTANCE[left.options.importance]
      return importance !== 0 ? importance : right.order - left.order
    })
    return new Set(candidates.slice(0, this.config.maxLivePreviews).map(lease => lease.id))
  }

  private async reconcileAll(): Promise<void> {
    const live = this.liveCandidates()
    for (const lease of this.leases.values()) {
      await this.reconcileLease(lease, live.has(lease.id))
    }
  }

  private async reconcileLease(lease: LeaseRecord, budgetAllowsLive: boolean): Promise<void> {
    const source = this.resolveSource(lease)
    const destination = this.resolveDestination(lease)

    if (!source) {
      await this.unbindNative(lease)
      this.transition(lease, 'destroyed', 'source-window-destroyed', 'none')
      return
    }
    if (!destination || destination.state === 'DISPOSED' || destination.state === 'DESTROYING') {
      await this.unbindNative(lease)
      this.transition(lease, 'destroyed', 'destination-surface-destroyed', 'none')
      return
    }
    if (this.sessionLocked) {
      await this.unbindNative(lease)
      this.transition(lease, 'paused', 'session-locked', 'dwm-thumbnail')
      return
    }
    if (!isPreviewableWindow(source)) {
      await this.unbindNative(lease)
      this.transition(lease, 'unavailable', 'source-window-not-previewable', 'dwm-thumbnail')
      return
    }
    if (!lease.options.visible || !destination.isVisible) {
      await this.unbindNative(lease)
      this.transition(lease, 'paused', 'consumer-hidden', 'dwm-thumbnail')
      return
    }
    if (source.isCloaked || !source.isVisible || source.state === 'hidden') {
      await this.unbindNative(lease)
      this.transition(lease, 'unavailable', 'source-not-composable', 'dwm-thumbnail')
      return
    }
    if (!budgetAllowsLive) {
      await this.unbindNative(lease)
      this.transition(lease, 'paused', 'live-preview-budget', 'dwm-thumbnail')
      return
    }
    if (source.hwnd === destination.hwnd) {
      await this.unbindNative(lease)
      this.transition(lease, 'unavailable', 'self-capture-blocked', 'none')
      return
    }

    await this.bindNative(lease, source, destination.hwnd)
  }

  private async bindNative(
    lease: LeaseRecord,
    source: WindowSnapshot,
    destinationHwnd: number,
  ): Promise<void> {
    const bridge = this.bridgeInstance ?? this.config.bridge ?? getSharedNativeBridge()
    const sourceHwnd = source.hwnd
    const processId = source.processId
    const processCreationTime = source.processCreationTime
    const sameBinding = lease.nativeBinding?.sourceHwnd === sourceHwnd
      && lease.nativeBinding.destinationHwnd === destinationHwnd
      && lease.nativeBinding.processId === processId
      && lease.nativeBinding.processCreationTime === processCreationTime

    try {
      let native: NativePreviewSnapshot
      if (sameBinding) {
        const effective = fitRect(
          lease.options.destinationRect,
          lease.snapshot.contentWidth ?? 0,
          lease.snapshot.contentHeight ?? 0,
          lease.options.fit,
        )
        native = await bridge.sendRequest<NativePreviewSnapshot>('preview/update', {
          id: lease.id,
          destinationRect: effective,
          opacity: lease.options.opacity,
          sourceClientAreaOnly: lease.options.sourceClientAreaOnly,
          visible: true,
        })
      } else {
        // Register hidden first so a wrong aspect ratio never flashes on screen. Source size is
        // queried by Native Core, then a second property update reveals the fitted relationship.
        const registered = await bridge.sendRequest<NativePreviewSnapshot>('preview/register', {
          id: lease.id,
          sourceHwnd,
          destinationHwnd,
          destinationRect: lease.options.destinationRect,
          opacity: lease.options.opacity,
          sourceClientAreaOnly: lease.options.sourceClientAreaOnly,
          visible: false,
          processId,
          processCreationTime,
        })
        const effective = fitRect(
          lease.options.destinationRect,
          registered.sourceWidth,
          registered.sourceHeight,
          lease.options.fit,
        )
        native = await bridge.sendRequest<NativePreviewSnapshot>('preview/update', {
          id: lease.id,
          destinationRect: effective,
          opacity: lease.options.opacity,
          sourceClientAreaOnly: lease.options.sourceClientAreaOnly,
          visible: true,
        })
      }

      lease.nativeBinding = { sourceHwnd, destinationHwnd, processId, processCreationTime }
      this.transition(lease, 'live', undefined, 'dwm-thumbnail', native)
    } catch (error: unknown) {
      // A partially successful register is removed before the fallback is exposed.
      await this.unregisterBestEffort(bridge, lease.id)
      lease.nativeBinding = undefined
      const code = errorCode(error)
      const denied = code === 'PREVIEW_ACCESS_DENIED' || code === 'E_ACCESSDENIED'
      this.transition(
        lease,
        denied ? 'denied' : 'unavailable',
        code ?? 'native-preview-failure',
        'dwm-thumbnail',
      )
    }
  }

  private async unregisterBestEffort(bridge: NativeBridgeClient, id: string): Promise<void> {
    try {
      await bridge.sendRequest<{ readonly unregistered: boolean }>('preview/unregister', { id })
    } catch {
      // The relationship may have never existed or its native-host generation may already be gone.
    }
  }

  private async unbindNative(lease: LeaseRecord): Promise<void> {
    if (!lease.nativeBinding) return
    lease.nativeBinding = undefined
    const bridge = this.bridgeInstance ?? this.config.bridge ?? getSharedNativeBridge()
    try {
      await bridge.sendRequest<{ readonly unregistered: boolean }>('preview/unregister', { id: lease.id })
    } catch (error: unknown) {
      // Native-host restart implicitly releases process-local HTHUMBNAIL resources.
      const code = errorCode(error)
      if (
        code !== 'NOT_CONNECTED'
        && code !== 'HOST_TERMINATED'
        && code !== 'BRIDGE_FAULTED'
        && code !== 'NOT_FOUND'
      ) {
        this.ctx.emit('window-preview/fault', toError(error))
      }
    }
  }

  private transition(
    lease: LeaseRecord,
    state: PreviewState,
    reason: string | undefined,
    backend: PreviewBackend,
    native?: NativePreviewSnapshot,
  ): void {
    const previous = lease.snapshot
    const contentWidth = native?.sourceWidth ?? previous.contentWidth
    const contentHeight = native?.sourceHeight ?? previous.contentHeight
    const effectiveRect = state === 'live'
      ? fitRect(
        lease.options.destinationRect,
        contentWidth ?? 0,
        contentHeight ?? 0,
        lease.options.fit,
      )
      : lease.options.destinationRect

    const next: PreviewLeaseSnapshot = Object.freeze({
      id: lease.id,
      sourceWindowId: lease.options.sourceWindowId,
      destinationSurfaceId: lease.options.destinationSurfaceId,
      consumerId: lease.options.consumerId,
      state,
      backend,
      destinationRect: lease.options.destinationRect,
      effectiveRect,
      visible: lease.options.visible,
      opacity: lease.options.opacity,
      importance: lease.options.importance,
      desiredRefreshHz: lease.options.desiredRefreshHz,
      sourceClientAreaOnly: lease.options.sourceClientAreaOnly,
      fit: lease.options.fit,
      ...(contentWidth !== undefined ? { contentWidth } : {}),
      ...(contentHeight !== undefined ? { contentHeight } : {}),
      ...(reason ? { reason } : {}),
      updatedAt: Date.now(),
      ...(state === 'live' ? { freshAt: Date.now() } : {}),
    })

    if (
      previous.state === next.state
      && previous.backend === next.backend
      && previous.reason === next.reason
      && previous.contentWidth === next.contentWidth
      && previous.contentHeight === next.contentHeight
      && sameRect(previous.destinationRect, next.destinationRect)
      && sameRect(previous.effectiveRect, next.effectiveRect)
      && previous.opacity === next.opacity
      && previous.visible === next.visible
      && previous.fit === next.fit
    ) {
      return
    }

    lease.snapshot = next
    for (const listener of this.listeners) {
      try {
        listener(next)
      } catch {
        // Consumer exceptions never interrupt native ownership or cleanup.
      }
    }
    this.ctx.emit('window-preview/changed', next)
  }
}

export default WindowPreviewService
