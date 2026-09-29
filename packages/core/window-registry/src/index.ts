/**
 * Authoritative ELIX Window Registry Core Service.
 *
 * Provides a coherent, real-time, read-only registry of all top-level Win32
 * windows with stable identities (WindowId != HWND), functional classification,
 * Windows Context monitor association, foreground tracking, and supervisory
 * recovery across host restarts.
 *
 * @module @deepseek-ai/dsh-window-registry
 */

import { Context, Service } from '@deepseek-ai/cordis'
import {
  getSharedNativeBridge,
  type NativeBridgeClient,
  type NativeBridgeError,
  type NativeRawWindow,
  type NativeWindowRegistryChange,
  type NativeWindowRegistrySnapshot,
  type NativeWindowRegistrySubscription,
} from '@deepseek-ai/dsh-native-core'
import type { MonitorId, PhysicalPixelRect, WindowsContextSource, WindowsMonitor } from '@deepseek-ai/dsh-windows-context'
import type {} from '@deepseek-ai/dsh-surface'
import z from '@deepseek-ai/schemastery'
import { classifyWindow, deriveWindowState } from './classification.ts'
import { WindowIdentityTracker } from './identity.ts'
import type {
  WindowChange,
  WindowForegroundChangeEvent,
  WindowId,
  WindowPropertyChange,
  WindowRegistryConfig,
  WindowRegistrySnapshot,
  WindowRegistrySource,
  WindowSnapshot,
  WindowState,
} from './types.ts'

export * from './types.ts'
export * from './identity.ts'
export * from './classification.ts'

/** Cordis service owning the authoritative registry of top-level desktop windows. */
export class WindowRegistryService extends Service implements WindowRegistrySource {
  static Config = z.object({ enabled: z.boolean().default(true) })

  private readonly config: WindowRegistryConfig
  private readonly tracker = new WindowIdentityTracker()
  private readonly windows = new Map<WindowId, WindowSnapshot>()
  private readonly hwndToId = new Map<number, WindowId>()
  private readonly listeners = new Set<(snapshot: WindowRegistrySnapshot) => void>()

  private currentRevision = 0
  private lastNativeRevision = 0
  private registryGeneration = 1
  private foregroundWindowId: WindowId | undefined = undefined

  private nativeSubscription: NativeWindowRegistrySubscription | null = null
  private recoveryPromise: Promise<void> | null = null
  private readonly lifecycle = { isDisposed: false }

  private get isDisposed(): boolean {
    return this.lifecycle.isDisposed
  }

  constructor(ctx: Context, config?: Partial<WindowRegistryConfig>) {
    super(ctx, 'windowRegistry')
    this.config = {
      enabled: config?.enabled ?? true,
      bridge: config?.bridge,
    }
  }

  /** Initializes native window registry observation. */
  async [Service.init](): Promise<void> {
    if (!this.config.enabled) return

    const bridge = this.config.bridge ?? getSharedNativeBridge()

    const onEvent = (event: NativeWindowRegistryChange) => {
      try {
        this.handleNativeChange(event)
      } catch (error) {
        this.ctx.emit(
          'window-registry/fault',
          error instanceof Error ? error : new Error(String(error)),
        )
      }
    }

    const onFault = (error: NativeBridgeError) => {
      if (this.isDisposed) return
      this.ctx.emit('window-registry/fault', error)
      void this.recoverDeadObserver(bridge, onEvent, onFault)
    }

    this.ctx.on('windows-context/change', () => {
      if (!this.isDisposed) this.reconcileMonitorTopology()
    })

    // Register ownership cleanup before the async native start. Cordis waits for async startup
    // before unloading, so a subscription created by a late start result is still owned here.
    this.ctx.effect(() => async () => {
      this.lifecycle.isDisposed = true
      const recovery = this.recoveryPromise
      const subscription = this.nativeSubscription
      this.nativeSubscription = null
      await recovery?.catch(() => {})
      await subscription?.dispose()
      this.windows.clear()
      this.hwndToId.clear()
      this.tracker.clear()
      this.listeners.clear()
    }, 'windowRegistry.lifecycle')

    const subscription = await bridge.windowRegistry.start(onEvent, onFault)
    this.nativeSubscription = subscription
    this.ctx.emit('window-registry/ready', this)
  }

  private async recoverDeadObserver(
    bridge: NativeBridgeClient,
    onEvent: (event: NativeWindowRegistryChange) => void,
    onFault: (error: NativeBridgeError) => void,
  ): Promise<void> {
    if (this.isDisposed) return
    if (this.recoveryPromise) return this.recoveryPromise

    this.recoveryPromise = (async () => {
      let consecutiveAliveChecks = 0
      for (let attempt = 0; attempt < 8; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)))
        if (this.isDisposed) return

        let status: Awaited<ReturnType<NativeBridgeClient['windowRegistry']['getStatus']>>
        try {
          status = await bridge.windowRegistry.getStatus()
        } catch (_hostRecovery) {
          return
        }

        if (status.threadAlive) {
          consecutiveAliveChecks++
          if (consecutiveAliveChecks >= 3) return
          continue
        }

        try {
          const replacement = await bridge.windowRegistry.start(onEvent, onFault)
          if (this.isDisposed) {
            await replacement.dispose()
            return
          }
          const previous = this.nativeSubscription
          this.nativeSubscription = replacement
          if (previous && previous !== replacement) {
            await previous.dispose().catch(() => {})
          }
          return
        } catch (error) {
          if (attempt === 7 && !this.isDisposed) {
            this.ctx.emit(
              'window-registry/fault',
              error instanceof Error ? error : new Error(String(error)),
            )
          }
        }
      }
    })().finally(() => {
      this.recoveryPromise = null
    })

    return this.recoveryPromise
  }

  /** Processes an incoming native registry event. */
  private handleNativeChange(event: NativeWindowRegistryChange): void {
    if (this.isDisposed) return

    const isRecovery = event.reason === 'recovered'
    if (!isRecovery && event.snapshot.revision <= this.lastNativeRevision) return
    this.lastNativeRevision = event.snapshot.revision
    this.reconcileSnapshot(event.snapshot, isRecovery)
  }

  /** Reconciles internal state against a complete native window snapshot. */
  private reconcileSnapshot(nativeSnapshot: NativeWindowRegistrySnapshot, isRecovery = false): void {
    if (this.isDisposed) return
    if (isRecovery) this.registryGeneration++

    const previousForegroundSnapshot = this.foregroundWindowId
      ? this.windows.get(this.foregroundWindowId) ?? null
      : null

    const { retained, created, destroyed, recycled } = this.tracker.reconcileSnapshot(
      nativeSnapshot.windows,
      this.registryGeneration,
    )

    const rawByHwnd = new Map<number, NativeRawWindow>()
    for (const raw of nativeSnapshot.windows) rawByHwnd.set(raw.hwnd, raw)

    let hasChanges = false
    const nextRevision = this.currentRevision + 1

    for (const rec of recycled) {
      const oldSnapshot = this.windows.get(rec.oldEvidence.id)
      if (oldSnapshot) {
        hasChanges = true
        this.windows.delete(rec.oldEvidence.id)
        this.hwndToId.delete(rec.oldEvidence.hwnd)
        this.ctx.emit('window-registry/window-destroyed', oldSnapshot)
      }
    }

    for (const dest of destroyed) {
      const oldSnapshot = this.windows.get(dest.id)
      if (oldSnapshot) {
        hasChanges = true
        this.windows.delete(dest.id)
        this.hwndToId.delete(dest.hwnd)
        this.ctx.emit('window-registry/window-destroyed', oldSnapshot)
      }
    }

    for (const item of created) {
      hasChanges = true
      const snapshot = this.createWindowSnapshot(
        item.raw,
        item.evidence.id,
        item.evidence.createdAt,
        nextRevision,
        this.registryGeneration,
      )
      this.windows.set(item.evidence.id, snapshot)
      this.hwndToId.set(item.raw.hwnd, item.evidence.id)
      this.ctx.emit('window-registry/window-created', snapshot)
    }

    for (const [hwnd, evidence] of retained.entries()) {
      const raw = rawByHwnd.get(hwnd)
      if (!raw) continue

      const oldSnapshot = this.windows.get(evidence.id)
      if (!oldSnapshot) {
        hasChanges = true
        const snapshot = this.createWindowSnapshot(
          raw,
          evidence.id,
          evidence.createdAt,
          nextRevision,
          this.registryGeneration,
        )
        this.windows.set(evidence.id, snapshot)
        this.hwndToId.set(hwnd, evidence.id)
        this.ctx.emit('window-registry/window-created', snapshot)
        continue
      }

      const candidate = this.createWindowSnapshot(
        raw,
        evidence.id,
        evidence.createdAt,
        oldSnapshot.updatedRevision,
        this.registryGeneration,
      )
      const diff = this.computeWindowDiff(oldSnapshot, candidate)

      if (diff.changes.length > 0) {
        hasChanges = true
        const updated: WindowSnapshot = Object.freeze({
          ...candidate,
          updatedRevision: nextRevision,
        })
        this.windows.set(evidence.id, updated)
        this.ctx.emit('window-registry/window-changed', {
          id: evidence.id,
          window: updated,
          previous: oldSnapshot,
          changes: diff.changes,
        })

        if (diff.changes.includes('title')) {
          const change: WindowPropertyChange<string> = {
            id: evidence.id,
            hwnd: oldSnapshot.hwnd,
            previous: oldSnapshot.title,
            current: updated.title,
            window: updated,
          }
          this.ctx.emit('window-registry/window-title-changed', change)
        }

        if (diff.changes.includes('bounds')) {
          const change: WindowPropertyChange<PhysicalPixelRect> = {
            id: evidence.id,
            hwnd: oldSnapshot.hwnd,
            previous: oldSnapshot.bounds,
            current: updated.bounds,
            window: updated,
          }
          this.ctx.emit('window-registry/window-bounds-changed', change)
        }

        if (diff.changes.includes('state')) {
          const change: WindowPropertyChange<WindowState> = {
            id: evidence.id,
            hwnd: oldSnapshot.hwnd,
            previous: oldSnapshot.state,
            current: updated.state,
            window: updated,
          }
          this.ctx.emit('window-registry/window-state-changed', change)
        }
      }
    }

    const targetForegroundId = nativeSnapshot.foregroundHwnd !== undefined
      ? this.hwndToId.get(nativeSnapshot.foregroundHwnd)
      : undefined

    if (targetForegroundId !== this.foregroundWindowId) {
      hasChanges = true
      const previous = previousForegroundSnapshot
      const current = targetForegroundId ? this.windows.get(targetForegroundId) ?? null : null
      this.foregroundWindowId = targetForegroundId
      const event: WindowForegroundChangeEvent = { previous, current }
      this.ctx.emit('window-registry/window-foreground-changed', event)
    }

    if (hasChanges || isRecovery || this.currentRevision === 0) {
      this.currentRevision++
      const snapshot = this.getSnapshot()

      for (const listener of [...this.listeners]) {
        try {
          listener(snapshot)
        } catch (_listenerError) {
          // One consumer cannot interrupt publication to the remaining listeners.
        }
      }

      this.ctx.emit('window-registry/snapshot', snapshot)
      if (isRecovery) this.ctx.emit('window-registry/recovered')
    }
  }

  /** Re-evaluates monitor association after authoritative display topology changes. */
  private reconcileMonitorTopology(): void {
    if (this.isDisposed || this.windows.size === 0) return

    let anyChanged = false
    const nextRevision = this.currentRevision + 1

    for (const [id, window] of this.windows.entries()) {
      const newMonitorId = this.associateMonitor(window.bounds)
      if (newMonitorId !== window.monitorId) {
        anyChanged = true
        const updated: WindowSnapshot = Object.freeze({
          ...window,
          ...(newMonitorId !== undefined ? { monitorId: newMonitorId } : { monitorId: undefined }),
          updatedRevision: nextRevision,
        })
        this.windows.set(id, updated)

        const change: WindowChange = {
          id,
          window: updated,
          previous: window,
          changes: ['monitor'],
        }
        this.ctx.emit('window-registry/window-changed', change)
      }
    }

    if (anyChanged) {
      this.currentRevision++
      const snapshot = this.getSnapshot()
      for (const listener of [...this.listeners]) {
        try {
          listener(snapshot)
        } catch (_listenerError) {
          // One consumer cannot interrupt publication to the remaining listeners.
        }
      }
      this.ctx.emit('window-registry/snapshot', snapshot)
    }
  }

  private createWindowSnapshot(
    raw: NativeRawWindow,
    id: WindowId,
    firstSeen: number,
    updatedRevision: number,
    generation: number,
  ): WindowSnapshot {
    const bounds: PhysicalPixelRect = Object.freeze({
      x: raw.bounds.x,
      y: raw.bounds.y,
      width: raw.bounds.width,
      height: raw.bounds.height,
    })

    const isSurface = this.isSurfaceHwnd(raw.hwnd)
    const classification = classifyWindow(raw, isSurface)
    const state = deriveWindowState(raw)
    const monitorId = this.associateMonitor(bounds, raw.monitorDeviceName)

    return Object.freeze({
      id,
      hwnd: raw.hwnd,
      processId: raw.processId,
      threadId: raw.threadId,
      processCreationTime: raw.processCreationTime,
      ...(raw.executablePath ? { executablePath: raw.executablePath } : {}),
      ...(raw.executableName ? { executableName: raw.executableName } : {}),
      ...(raw.packageFullName ? { packageFullName: raw.packageFullName } : {}),
      ...(raw.aumid ? { aumid: raw.aumid } : {}),
      title: raw.title,
      className: raw.className,
      bounds,
      classification,
      state,
      ...(monitorId !== undefined ? { monitorId } : {}),
      isVisible: raw.isVisible,
      isMinimized: raw.isMinimized,
      isMaximized: raw.isMaximized,
      isCloaked: raw.isCloaked,
      isToolWindow: raw.isToolWindow,
      isShellWindow: raw.isShellWindow,
      isEnabled: raw.isEnabled,
      isForeground: raw.isForeground,
      firstSeen,
      updatedRevision,
      generation,
      capturedAt: Date.now(),
    })
  }

  private computeWindowDiff(previous: WindowSnapshot, current: WindowSnapshot): WindowChange {
    const changes: ('title' | 'bounds' | 'state' | 'monitor' | 'classification' | 'foreground')[] = []

    if (previous.title !== current.title) changes.push('title')
    if (
      previous.bounds.x !== current.bounds.x ||
      previous.bounds.y !== current.bounds.y ||
      previous.bounds.width !== current.bounds.width ||
      previous.bounds.height !== current.bounds.height
    ) changes.push('bounds')
    if (previous.state !== current.state) changes.push('state')
    if (previous.monitorId !== current.monitorId) changes.push('monitor')
    if (previous.classification !== current.classification) changes.push('classification')
    if (previous.isForeground !== current.isForeground) changes.push('foreground')

    return {
      id: current.id,
      window: current,
      previous,
      changes: Object.freeze(changes),
    }
  }

  private get windowsContextService(): WindowsContextSource | undefined {
    return this.ctx.get('windowsContext') as WindowsContextSource | undefined
  }

  private get surfaceService(): { isSurfaceHwnd?: (hwnd: number) => boolean; getByHwnd?: (hwnd: number) => unknown } | undefined {
    return this.ctx.get('surface') as {
      isSurfaceHwnd?: (hwnd: number) => boolean
      getByHwnd?: (hwnd: number) => unknown
    } | undefined
  }

  private associateMonitor(bounds: PhysicalPixelRect, deviceName?: string): MonitorId | undefined {
    const monitorsContext = this.windowsContextService
    if (!monitorsContext) return undefined

    const monitors: readonly WindowsMonitor[] = monitorsContext.getMonitors()
    if (monitors.length === 0) return undefined

    if (deviceName) {
      const matched = monitors.find(monitor => monitor.deviceName === deviceName)
      if (matched) return matched.id
    }

    let maxArea = 0
    let bestMonitor: WindowsMonitor | undefined
    for (const monitor of monitors) {
      const ix = Math.max(bounds.x, monitor.bounds.x)
      const iy = Math.max(bounds.y, monitor.bounds.y)
      const ir = Math.min(bounds.x + bounds.width, monitor.bounds.x + monitor.bounds.width)
      const ib = Math.min(bounds.y + bounds.height, monitor.bounds.y + monitor.bounds.height)
      const width = Math.max(0, ir - ix)
      const height = Math.max(0, ib - iy)
      const area = width * height
      if (area > maxArea) {
        maxArea = area
        bestMonitor = monitor
      }
    }
    if (bestMonitor && maxArea > 0) return bestMonitor.id

    const centerX = bounds.x + bounds.width / 2
    const centerY = bounds.y + bounds.height / 2
    let minDistance = Infinity
    let closestMonitor = monitors[0]
    for (const monitor of monitors) {
      const monitorCenterX = monitor.bounds.x + monitor.bounds.width / 2
      const monitorCenterY = monitor.bounds.y + monitor.bounds.height / 2
      const distance = (centerX - monitorCenterX) ** 2 + (centerY - monitorCenterY) ** 2
      if (distance < minDistance) {
        minDistance = distance
        closestMonitor = monitor
      }
    }
    return closestMonitor?.id
  }

  private isSurfaceHwnd(hwnd: number): boolean {
    const surfaceService = this.surfaceService
    if (!surfaceService) return false
    if (typeof surfaceService.isSurfaceHwnd === 'function') return surfaceService.isSurfaceHwnd(hwnd)
    if (typeof surfaceService.getByHwnd === 'function') return Boolean(surfaceService.getByHwnd(hwnd))
    return false
  }

  /** Returns the current coherent snapshot of all windows. */
  getSnapshot(): WindowRegistrySnapshot {
    return Object.freeze({
      generation: this.registryGeneration,
      revision: this.currentRevision,
      windows: Object.freeze(Array.from(this.windows.values())),
      ...(this.foregroundWindowId !== undefined ? { foregroundWindowId: this.foregroundWindowId } : {}),
      capturedAt: Date.now(),
    })
  }

  /** Returns all currently tracked windows. */
  getWindows(): readonly WindowSnapshot[] {
    return Object.freeze(Array.from(this.windows.values()))
  }

  /** Finds a window by stable WindowId. */
  getWindow(id: WindowId): WindowSnapshot | undefined {
    return this.windows.get(id)
  }

  /** Finds a window by current Win32 HWND. */
  getByHwnd(hwnd: number): WindowSnapshot | undefined {
    const id = this.hwndToId.get(hwnd)
    return id ? this.windows.get(id) : undefined
  }

  /** Finds all windows belonging to a process ID. */
  getByProcessId(pid: number): readonly WindowSnapshot[] {
    const result: WindowSnapshot[] = []
    for (const window of this.windows.values()) {
      if (window.processId === pid) result.push(window)
    }
    return Object.freeze(result)
  }

  /** Returns the current foreground application window, if known. */
  getForegroundWindow(): WindowSnapshot | undefined {
    return this.foregroundWindowId ? this.windows.get(this.foregroundWindowId) : undefined
  }

  /** Returns windows currently associated with a monitor. */
  getWindowsForMonitor(monitorId: MonitorId): readonly WindowSnapshot[] {
    const result: WindowSnapshot[] = []
    for (const window of this.windows.values()) {
      if (window.monitorId === monitorId) result.push(window)
    }
    return Object.freeze(result)
  }

  /** Requests an immediate native enumeration recapture. */
  async refresh(): Promise<WindowRegistrySnapshot> {
    if (this.isDisposed) throw new Error('Window Registry service is disposed.')
    const bridge = this.config.bridge ?? getSharedNativeBridge()
    const nativeSnapshot = await bridge.windowRegistry.refresh()
    if (this.isDisposed) throw new Error('Window Registry service was disposed during refresh.')
    this.reconcileSnapshot(nativeSnapshot, false)
    return this.getSnapshot()
  }

  /** Subscribes to coherent registry snapshot replacements. */
  subscribe(listener: (snapshot: WindowRegistrySnapshot) => void): () => void {
    if (this.isDisposed) throw new Error('Window Registry service is disposed.')
    this.listeners.add(listener)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      this.listeners.delete(listener)
    }
  }
}

export default WindowRegistryService
