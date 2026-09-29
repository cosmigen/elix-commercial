/**
 * Authoritative native Windows surface system for ELIX.
 *
 * Provides HWND ownership, WebView2 hosting, lifecycle state machine,
 * physical-pixel bounds, PMv2 DPI awareness, z-order control, focus policy,
 * and ready-before-show enforcement.
 *
 * @module @deepseek-ai/dsh-surface
 */

import { Context, Service } from '@deepseek-ai/cordis'
import {
  getSharedNativeBridge,
  type NativeBridgeClient,
  type NativeSurfaceEvent,
  type NativeSurfaceSubscription,
} from '@deepseek-ai/dsh-native-core'
import type {
  MonitorId,
  WindowsContextChange,
  WindowsContextService,
} from '@deepseek-ai/dsh-windows-context'
import z from '@deepseek-ai/schemastery'
import { SurfaceInstance } from './instance.ts'
import type {
  PhysicalBounds,
  SurfaceConfig,
  SurfaceCreateOptions,
  SurfaceFocusState,
  SurfaceRuntimeStatus,
} from './types.ts'

export * from './types.ts'
export * from './instance.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    surface: SurfaceService
  }
  interface Events {
    /** @mode broadcast @param surface Newly created native surface instance. */
    'surface/created'(surface: SurfaceInstance): void
    /** @mode broadcast @param surface Surface that completed ready-before-show verification. */
    'surface/ready'(surface: SurfaceInstance): void
    /** @mode broadcast @param surface Surface that was shown on desktop. */
    'surface/shown'(surface: SurfaceInstance): void
    /** @mode broadcast @param surface Surface that was hidden from desktop. */
    'surface/hidden'(surface: SurfaceInstance): void
    /** @mode broadcast @param event Surface and its updated physical bounds. */
    'surface/bounds-changed'(event: { readonly surface: SurfaceInstance; readonly bounds: PhysicalBounds }): void
    /** @mode broadcast @param event Surface and its updated DPI metrics. */
    'surface/dpi-changed'(event: {
      readonly surface: SurfaceInstance
      readonly dpi: number
      readonly scaleFactor: number
      readonly suggestedBounds: PhysicalBounds
    }): void
    /** @mode broadcast @param event Surface and the fault encountered. */
    'surface/fault'(event: { readonly surface: SurfaceInstance; readonly error: Error }): void
    /** @mode broadcast @param event Identifier of destroyed surface. */
    'surface/destroyed'(event: { readonly id: string }): void
    /** @mode broadcast @param event Key input event on a native surface. */
    'surface/input-key'(event: { readonly surface: SurfaceInstance; readonly key: string }): void
    /** @mode broadcast @param event Pointer input event on a native surface. */
    'surface/pointer'(event: {
      readonly surface: SurfaceInstance
      readonly action: string
      readonly point: { readonly x: number; readonly y: number }
    }): void
    /** @mode broadcast @param event Message received from WebView2 renderer. */
    'surface/message'(event: { readonly surface: SurfaceInstance; readonly message: string }): void
    /** @mode broadcast @param service Initialized authoritative Surface service. */
    'surface/service-ready'(service: SurfaceService): void
  }
}

/**
 * Cordis service managing the authoritative lifecycle of native ELIX surfaces.
 */
export class SurfaceService extends Service {
  static Config = z.object({
    enabled: z.boolean().default(true),
    defaultUserDataFolder: z.string(),
  })

  private readonly config: SurfaceConfig
  private readonly surfaces = new Map<string, SurfaceInstance>()
  private readonly pendingCreationOptions = new Map<string, SurfaceCreateOptions>()
  private nativeSubscription: NativeSurfaceSubscription | null = null
  private bridgeInstance: NativeBridgeClient | null = null
  private readonly lifecycle = { isDisposed: false }

  constructor(ctx: Context, config?: Partial<SurfaceConfig>) {
    super(ctx, 'surface')
    this.config = {
      enabled: config?.enabled ?? true,
      bridge: config?.bridge,
      defaultUserDataFolder: config?.defaultUserDataFolder,
    }
  }

  private get windowsContext(): WindowsContextService | undefined {
    return this.ctx.get('windowsContext')
  }

  /**
   * Initializes the native surface subsystem, connecting event streams and recovery handlers.
   */
  [Service.init](): void {
    if (!this.config.enabled) return

    const bridge = this.config.bridge ?? getSharedNativeBridge()
    this.bridgeInstance = bridge

    this.nativeSubscription = bridge.surface.onEvent(this.handleNativeEvent.bind(this))

    const unbindWindowsContext = this.ctx.on('windows-context/change', (change) => {
      this.handleWindowsContextChange(change)
    })

    this.ctx.effect(() => () => {
      this.lifecycle.isDisposed = true
      unbindWindowsContext()
      const sub = this.nativeSubscription
      this.nativeSubscription = null
      void sub?.dispose()

      for (const surface of this.surfaces.values()) {
        void surface.destroy().catch(() => {})
      }
      this.surfaces.clear()
      this.pendingCreationOptions.clear()
    }, 'surface.lifecycle')

    this.ctx.emit('surface/service-ready', this)
  }

  /**
   * Creates a new managed native surface.
   *
   * Surfaces are created hidden by default to enforce ready-before-show semantics.
   * If `visible: true` is requested, the surface will be automatically shown
   * once native and renderer readiness are established.
   */
  async create(options: SurfaceCreateOptions): Promise<SurfaceInstance> {
    if (this.lifecycle.isDisposed) {
      throw new Error('SurfaceService is disposed')
    }
    if (this.surfaces.has(options.id) || this.pendingCreationOptions.has(options.id)) {
      throw new Error(`Surface '${options.id}' already exists or is being created.`)
    }

    // Validate against authoritative Windows Context if monitorId is specified
    const windowsContext = this.windowsContext
    if (options.monitorId && windowsContext) {
      const monitors = windowsContext.getMonitors()
      if (monitors.length > 0 && !windowsContext.getMonitor(options.monitorId as MonitorId)) {
        throw new Error(
          `Cannot create surface on unknown monitor '${options.monitorId}'. Active monitors: ${monitors.map(m => m.id).join(', ')}`,
        )
      }
    }

    const bridge = this.bridgeInstance ?? this.config.bridge ?? getSharedNativeBridge()
    const finalOptions: SurfaceCreateOptions = {
      ...options,
      userDataFolder: options.userDataFolder ?? this.config.defaultUserDataFolder,
    }

    this.pendingCreationOptions.set(options.id, finalOptions)

    let snapshot
    try {
      snapshot = await bridge.surface.create(finalOptions)
    } finally {
      this.pendingCreationOptions.delete(options.id)
    }

    // Native creation crosses an async process boundary. The service may have been disposed while
    // the request was in flight; never resurrect a managed SurfaceInstance after its owner died.
    if (this.lifecycle.isDisposed) {
      await bridge.surface.destroy(options.id).catch(() => false)
      throw new Error(`SurfaceService was disposed while creating surface '${options.id}'.`)
    }

    let instance = this.surfaces.get(options.id)
    if (!instance) {
      instance = new SurfaceInstance(snapshot, bridge, finalOptions)
      this.surfaces.set(options.id, instance)
      this.ctx.emit('surface/created', instance)
    }

    if (finalOptions.visible) {
      void instance.show().catch((err: unknown) => {
        if (this.lifecycle.isDisposed) return
        this.ctx.emit('surface/fault', {
          surface: instance,
          error: err instanceof Error ? err : new Error(String(err)),
        })
      })
    }

    return instance
  }

  /**
   * Creates a native surface sized to fill or fit within an authoritative physical monitor.
   */
  async createOnMonitor(
    monitorId: string,
    options: Omit<SurfaceCreateOptions, 'monitorId' | 'bounds'> & { bounds?: PhysicalBounds },
  ): Promise<SurfaceInstance> {
    const monitor = this.windowsContext?.getMonitor(monitorId as MonitorId)
    const bounds = options.bounds ?? (monitor ? monitor.bounds : { x: 0, y: 0, width: 800, height: 600 })
    return this.create({
      ...options,
      monitorId,
      bounds,
    })
  }

  /**
   * Retrieves an active surface instance by identifier.
   */
  get(id: string): SurfaceInstance | undefined {
    return this.surfaces.get(id)
  }

  /**
   * Retrieves an active surface instance by its native HWND handle.
   */
  getByHwnd(hwnd: number): SurfaceInstance | undefined {
    for (const surface of this.surfaces.values()) {
      if (surface.hwnd === hwnd) return surface
    }
    return undefined
  }

  /**
   * Returns true if the specified HWND belongs to an active ELIX surface.
   */
  isSurfaceHwnd(hwnd: number): boolean {
    return this.getByHwnd(hwnd) !== undefined
  }

  /**
   * Returns all active surface instances.
   */
  list(): readonly SurfaceInstance[] {
    return Array.from(this.surfaces.values())
  }

  /**
   * Destroys a surface by identifier.
   */
  async destroy(id: string): Promise<boolean> {
    const surface = this.surfaces.get(id)
    if (surface) {
      return surface.destroy()
    }
    const bridge = this.bridgeInstance ?? this.config.bridge ?? getSharedNativeBridge()
    return bridge.surface.destroy(id)
  }

  /**
   * Checks the runtime status of the host Microsoft Edge WebView2 installation.
   */
  async getRuntimeStatus(): Promise<SurfaceRuntimeStatus> {
    const bridge = this.bridgeInstance ?? this.config.bridge ?? getSharedNativeBridge()
    return bridge.surface.runtimeStatus()
  }

  /**
   * Queries real-time focus and foreground activation status for a surface from the native host.
   */
  async getFocusState(id: string): Promise<SurfaceFocusState> {
    const surface = this.surfaces.get(id)
    if (surface) {
      return surface.getFocusState()
    }
    const bridge = this.bridgeInstance ?? this.config.bridge ?? getSharedNativeBridge()
    return bridge.surface.getFocusState(id)
  }

  /**
   * Queries the current Win32 foreground window HWND.
   */
  async getForegroundHwnd(): Promise<number> {
    const bridge = this.bridgeInstance ?? this.config.bridge ?? getSharedNativeBridge()
    const res = await bridge.surface.getForegroundHwnd()
    return res.hwnd
  }

  private handleNativeEvent(event: NativeSurfaceEvent): void {
    if (this.lifecycle.isDisposed) return

    const id = event.type === 'created' ? event.snapshot.id : event.id
    const instance = this.surfaces.get(id)

    switch (event.type) {
      case 'created': {
        if (!instance) {
          const bridge = this.bridgeInstance ?? this.config.bridge ?? getSharedNativeBridge()
          const opts = this.pendingCreationOptions.get(event.snapshot.id)
          const newInstance = new SurfaceInstance(event.snapshot, bridge, opts)
          this.surfaces.set(event.snapshot.id, newInstance)
          this.ctx.emit('surface/created', newInstance)
        } else if (instance.hwnd !== event.snapshot.hwnd) {
          instance._handleRecreation(event.snapshot)
        }
        break
      }
      case 'nativeReady': {
        if (instance) {
          const wasReady = instance.isReady()
          instance._handleNativeReady(event.hwnd)
          if (!wasReady && instance.isReady()) {
            this.ctx.emit('surface/ready', instance)
          }
        }
        break
      }
      case 'rendererReady': {
        if (instance) {
          const wasReady = instance.isReady()
          instance._handleRendererReady()
          if (!wasReady && instance.isReady()) {
            this.ctx.emit('surface/ready', instance)
          }
        }
        break
      }
      case 'shown': {
        if (instance) {
          instance._handleShown()
          this.ctx.emit('surface/shown', instance)
        }
        break
      }
      case 'hidden': {
        if (instance) {
          instance._handleHidden()
          this.ctx.emit('surface/hidden', instance)
        }
        break
      }
      case 'boundsChanged': {
        if (instance) {
          instance._handleBoundsChanged(event.bounds)
          this.ctx.emit('surface/bounds-changed', { surface: instance, bounds: event.bounds })
        }
        break
      }
      case 'dpiChanged': {
        if (instance) {
          instance._handleDpiChanged(event.dpi, event.scaleFactor, event.suggestedBounds)
          this.ctx.emit('surface/dpi-changed', {
            surface: instance,
            dpi: event.dpi,
            scaleFactor: event.scaleFactor,
            suggestedBounds: event.suggestedBounds,
          })
        }
        break
      }
      case 'fault': {
        if (instance && instance.state !== 'DISPOSED' && instance.state !== 'DESTROYING') {
          const err = new Error(`[${event.error.code}] ${event.error.message}`)
          Object.assign(err, event.error)
          instance._handleFault(err)
          this.ctx.emit('surface/fault', { surface: instance, error: err })
        }
        break
      }
      case 'destroyed': {
        if (instance) {
          instance._handleDestroyed()
          this.surfaces.delete(event.id)
        }
        this.ctx.emit('surface/destroyed', { id: event.id })
        break
      }
      case 'inputKey': {
        if (instance) {
          this.ctx.emit('surface/input-key', { surface: instance, key: event.key })
        }
        break
      }
      case 'pointer': {
        if (instance) {
          this.ctx.emit('surface/pointer', {
            surface: instance,
            action: event.action,
            point: { x: event.x, y: event.y },
          })
        }
        break
      }
      case 'message': {
        if (instance) {
          try {
            const parsed: unknown = typeof event.message === 'string' ? JSON.parse(event.message) : event.message
            if (
              parsed &&
              typeof parsed === 'object' &&
              (parsed as { type?: string }).type === 'surface/pointer'
            ) {
              const p = parsed as { action?: string; x?: number; y?: number; screenX?: number; screenY?: number }
              this.ctx.emit('surface/pointer', {
                surface: instance,
                action: p.action ?? 'down',
                point: {
                  x: p.screenX ?? p.x ?? 0,
                  y: p.screenY ?? p.y ?? 0,
                },
              })
            }
          } catch {
            // Non-JSON web message, continue
          }
          this.ctx.emit('surface/message', { surface: instance, message: event.message })
        }
        break
      }
    }
  }

  private handleWindowsContextChange(_change: WindowsContextChange): void {
    if (this.lifecycle.isDisposed) return

    const windowsContext = this.windowsContext
    for (const surface of this.surfaces.values()) {
      if (surface.monitorId) {
        const monitor = windowsContext?.getMonitor(surface.monitorId as MonitorId)
        if (!monitor) {
          this.ctx.emit('surface/fault', {
            surface,
            error: new Error(`Affiliated monitor '${surface.monitorId}' is no longer connected.`),
          })
        }
      }
    }
  }
}

export default SurfaceService
