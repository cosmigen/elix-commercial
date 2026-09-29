/**
 * Managed Surface Instance representing an authoritative native Win32 window
 * hosting Microsoft Edge WebView2.
 *
 * Enforces the ready-before-show invariant: surfaces remain unmapped from desktop
 * z-order and invisible until both Win32 HWND allocation and WebView2 rendering
 * readiness are established.
 *
 * @module @deepseek-ai/dsh-surface/instance
 */

import type { NativeBridgeClient } from '@deepseek-ai/dsh-native-core'
import type {
  PhysicalBounds,
  SurfaceCreateOptions,
  SurfaceFocusPolicy,
  SurfaceFocusState,
  SurfaceLifecycleState,
  SurfaceSnapshot,
  SurfaceZOrderPolicy,
} from './types.ts'

/**
 * High-level handle for an active native surface.
 */
export class SurfaceInstance {
  private _snapshot: SurfaceSnapshot
  private readonly _bridge: NativeBridgeClient
  private _readyPromise!: Promise<SurfaceInstance>
  private _resolveReady!: (instance: SurfaceInstance) => void
  private _rejectReady!: (err: Error) => void
  private _nativeReady = false
  private _rendererReady = false
  /** Desired visibility, including requests made before renderer readiness. */
  private _pendingShow = false
  /** Coalesces concurrent show requests so ready transition cannot double-dispatch native show. */
  private _showPromise: Promise<SurfaceSnapshot> | null = null

  constructor(initialSnapshot: SurfaceSnapshot, bridge: NativeBridgeClient, options?: SurfaceCreateOptions) {
    this._snapshot = initialSnapshot
    this._bridge = bridge
    this._pendingShow = options?.visible ?? false

    this.initReadyPromise()

    if (
      initialSnapshot.state === 'READY' ||
      initialSnapshot.state === 'VISIBLE' ||
      initialSnapshot.state === 'HIDDEN'
    ) {
      this._nativeReady = true
      this._rendererReady = true
      this._resolveReady(this)
    } else if (
      initialSnapshot.state === 'NATIVE_CREATED' ||
      initialSnapshot.state === 'WEBVIEW_INITIALIZING' ||
      initialSnapshot.state === 'WEBVIEW_CREATED' ||
      initialSnapshot.state === 'NAVIGATING' ||
      initialSnapshot.state === 'RENDERER_READY'
    ) {
      this._nativeReady = true
      if (initialSnapshot.state === 'RENDERER_READY') {
        this._rendererReady = true
        this.checkAndCommitReady()
      }
    }
  }

  private initReadyPromise(): void {
    let resolveReady!: (instance: SurfaceInstance) => void
    let rejectReady!: (err: Error) => void
    this._readyPromise = new Promise<SurfaceInstance>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    // Attach default rejection handler to prevent unhandled rejection warnings in Node.js
    this._readyPromise.catch(() => {})

    this._resolveReady = resolveReady
    this._rejectReady = rejectReady
  }

  /** Surface unique identifier. */
  get id(): string {
    return this._snapshot.id
  }

  /** Current Win32 HWND handle (0 if unallocated or disposed). */
  get hwnd(): number {
    return this._snapshot.hwnd
  }

  /** Authoritative lifecycle state. */
  get state(): SurfaceLifecycleState {
    return this._snapshot.state
  }

  /** Physical bounds in virtual screen coordinates. */
  get bounds(): PhysicalBounds {
    return this._snapshot.bounds
  }

  /** Whether the Win32 window is currently mapped and visible on desktop. */
  get isVisible(): boolean {
    return this._snapshot.visible
  }

  /** Current dots-per-inch metric (standard baseline 96 DPI). */
  get dpi(): number {
    return this._snapshot.dpi
  }

  /** DPI scale factor (1.0 = 100%, 1.5 = 150%, 2.0 = 200%). */
  get scaleFactor(): number {
    return this._snapshot.scaleFactor
  }

  /** Current focus and activation policy. */
  get focusPolicy(): SurfaceFocusPolicy {
    return this._snapshot.focusPolicy
  }

  /** Current z-order placement policy. */
  get zOrderPolicy(): SurfaceZOrderPolicy {
    return this._snapshot.zOrderPolicy
  }

  /** Monitor identifier this surface is affiliated with, if known. */
  get monitorId(): string | undefined {
    return this._snapshot.monitorId
  }

  /** Immutable snapshot of current surface state. */
  getSnapshot(): SurfaceSnapshot {
    return { ...this._snapshot }
  }

  /** Returns true if the surface has passed ready-before-show verification. */
  isReady(): boolean {
    return (
      this._nativeReady &&
      this._rendererReady &&
      (this._snapshot.state === 'READY' ||
        this._snapshot.state === 'VISIBLE' ||
        this._snapshot.state === 'HIDDEN')
    )
  }

  /**
   * Returns a promise that resolves when the surface is fully ready to be displayed
   * without visual glitches or white flashes.
   */
  whenReady(): Promise<SurfaceInstance> {
    if (this.isReady()) {
      return Promise.resolve(this)
    }
    if (
      this._snapshot.state === 'DISPOSED' ||
      this._snapshot.state === 'DESTROYING' ||
      this._snapshot.state === 'FAULTED'
    ) {
      return Promise.reject(
        new Error(`Surface '${this.id}' cannot become ready because it is ${this._snapshot.state}.`),
      )
    }
    return this._readyPromise
  }

  /**
   * Displays the surface on desktop according to its z-order and focus policy.
   * Guarantees ready-before-show: awaits readiness before calling native show.
   */
  show(): Promise<SurfaceSnapshot> {
    if (
      this._snapshot.state === 'DISPOSED' ||
      this._snapshot.state === 'DESTROYING' ||
      this._snapshot.state === 'FAULTED'
    ) {
      return Promise.reject(
        new Error(`Cannot show surface '${this.id}': surface is ${this._snapshot.state}`),
      )
    }

    this._pendingShow = true
    if (this._showPromise) return this._showPromise

    const operation = (async (): Promise<SurfaceSnapshot> => {
      if (!this.isReady()) await this.whenReady()

      // hide() is allowed to cancel a pre-ready show intent. Re-check after the readiness await so
      // a stale show waiter cannot remap a surface the caller deliberately hid in the meantime.
      if (!this._pendingShow) return this._snapshot
      if (
        this._snapshot.state === 'DISPOSED' ||
        this._snapshot.state === 'DESTROYING' ||
        this._snapshot.state === 'FAULTED'
      ) {
        throw new Error(`Cannot show surface '${this.id}': surface is ${this._snapshot.state}`)
      }

      const shown = await this._bridge.surface.show(this.id)
      this._snapshot = shown

      // A hide can race the native show call itself. Desired visibility wins; issue a final hide
      // after the show acknowledgement so completion order cannot leave the HWND unexpectedly mapped.
      if (!this._pendingShow) {
        const hidden = await this._bridge.surface.hide(this.id)
        this._snapshot = hidden
        return hidden
      }
      return shown
    })()

    this._showPromise = operation
    void operation.finally(() => {
      if (this._showPromise === operation) this._showPromise = null
    }).catch(() => {})
    return operation
  }

  /**
   * Hides the surface from desktop display without destroying native HWND or WebView2 state.
   */
  async hide(): Promise<SurfaceSnapshot> {
    this._pendingShow = false
    if (this._snapshot.state === 'DISPOSED' || this._snapshot.state === 'DESTROYING') {
      throw new Error(`Cannot hide surface '${this.id}': surface is ${this._snapshot.state}`)
    }
    const res = await this._bridge.surface.hide(this.id)
    this._snapshot = res
    return res
  }

  /**
   * Sets canonical physical-pixel bounds in virtual screen coordinates.
   */
  async setBounds(bounds: PhysicalBounds): Promise<SurfaceSnapshot> {
    const res = await this._bridge.surface.setBounds(this.id, bounds)
    this._snapshot = res
    return res
  }

  /**
   * Adjusts desktop z-order placement policy.
   */
  async setZOrder(zOrderPolicy: SurfaceZOrderPolicy): Promise<SurfaceSnapshot> {
    const res = await this._bridge.surface.setZOrder(this.id, zOrderPolicy)
    this._snapshot = res
    return res
  }

  /**
   * Navigates the hosted WebView2 renderer to a URL.
   */
  async navigate(url: string): Promise<SurfaceSnapshot> {
    const res = await this._bridge.surface.navigate(this.id, url)
    this._snapshot = res
    return res
  }

  /**
   * Reloads the active WebView2 renderer document.
   */
  async reload(): Promise<SurfaceSnapshot> {
    const res = await this._bridge.surface.reload(this.id)
    this._snapshot = res
    return res
  }

  /**
   * Explicitly signals that the renderer UI has loaded and finished first paint.
   */
  async markReady(): Promise<SurfaceSnapshot> {
    const res = await this._bridge.surface.markReady(this.id)
    this._snapshot = res
    this._rendererReady = true
    this.checkAndCommitReady()
    return res
  }

  /**
   * Posts a web message to the hosted WebView2 renderer.
   */
  async postMessage(message: unknown): Promise<boolean> {
    return this._bridge.surface.postMessage(this.id, message)
  }

  /**
   * Queries real-time focus and foreground activation status from the native host.
   */
  async getFocusState(): Promise<SurfaceFocusState> {
    return this._bridge.surface.getFocusState(this.id)
  }

  /**
   * Checks whether this surface HWND currently matches the system foreground HWND.
   */
  async isForeground(): Promise<boolean> {
    const state = await this.getFocusState()
    return state.isForeground
  }

  /**
   * Checks whether this surface HWND or its hosted WebView2 child currently has keyboard focus.
   */
  async hasKeyboardFocus(): Promise<boolean> {
    const state = await this.getFocusState()
    return state.hasKeyboardFocus
  }

  /**
   * Destroys the surface HWND and WebView2 controller.
   */
  async destroy(): Promise<boolean> {
    if (this._snapshot.state === 'DISPOSED') return false
    this._pendingShow = false
    const wasReady = this.isReady()
    this.updateState('DESTROYING')
    if (!wasReady) {
      this._rejectReady(new Error(`Surface '${this.id}' was destroyed before becoming ready.`))
    }
    const destroyed = await this._bridge.surface.destroy(this.id)
    this.updateState('DISPOSED')
    return destroyed
  }

  // --- Internal State Transition Handlers ---

  /** @internal */
  _handleNativeReady(hwnd: number): void {
    if (this._snapshot.state === 'DISPOSED' || this._snapshot.state === 'DESTROYING') return
    this._nativeReady = true
    this._snapshot = {
      ...this._snapshot,
      hwnd,
      state: 'WEBVIEW_INITIALIZING',
    }
    this.checkAndCommitReady()
  }

  /** @internal */
  _handleRendererReady(): void {
    if (this._snapshot.state === 'DISPOSED' || this._snapshot.state === 'DESTROYING') return
    this._rendererReady = true
    this.checkAndCommitReady()
  }

  /** @internal */
  _handleShown(): void {
    if (this._snapshot.state === 'DISPOSED' || this._snapshot.state === 'DESTROYING') return
    this._snapshot = {
      ...this._snapshot,
      visible: true,
      state: 'VISIBLE',
    }
  }

  /** @internal */
  _handleHidden(): void {
    if (this._snapshot.state === 'DISPOSED') return
    this._snapshot = {
      ...this._snapshot,
      visible: false,
      state: 'HIDDEN',
    }
  }

  /** @internal */
  _handleBoundsChanged(bounds: PhysicalBounds): void {
    if (this._snapshot.state === 'DISPOSED') return
    this._snapshot = {
      ...this._snapshot,
      bounds,
    }
  }

  /** @internal */
  _handleDpiChanged(dpi: number, scaleFactor: number, suggestedBounds: PhysicalBounds): void {
    if (this._snapshot.state === 'DISPOSED') return
    this._snapshot = {
      ...this._snapshot,
      dpi,
      scaleFactor,
      bounds: suggestedBounds,
    }
  }

  /** @internal */
  _handleFault(err: Error): void {
    if (this._snapshot.state === 'DISPOSED' || this._snapshot.state === 'DESTROYING') {
      return
    }
    this._pendingShow = false
    this.updateState('FAULTED')
    this._rejectReady(err)
  }

  /** @internal */
  _handleDestroyed(): void {
    if (this._snapshot.state === 'DISPOSED') return
    const wasReady = this.isReady()
    this._pendingShow = false
    if (!wasReady) {
      this._rejectReady(new Error(`Surface '${this.id}' was destroyed before becoming ready.`))
    }
    this.updateState('DISPOSED')
  }

  /** @internal */
  _handleRecreation(snapshot: SurfaceSnapshot): void {
    const hadPendingReadiness = !this.isReady()
    const shouldShow = this._snapshot.visible || this._pendingShow
    if (hadPendingReadiness) {
      this._rejectReady(new Error(`Surface '${this.id}' was recreated before the previous generation became ready.`))
    }

    // Reset native and renderer readiness for the new generation.
    this._nativeReady = false
    this._rendererReady = false
    this.initReadyPromise()
    this._pendingShow = shouldShow

    // A recreated HWND must prove readiness for its new WebView generation even if the native
    // snapshot was emitted from a later lifecycle state.
    this._snapshot = {
      ...snapshot,
      state: 'NATIVE_CREATED',
      visible: false,
    }
  }

  private checkAndCommitReady(): void {
    if (
      this._snapshot.state === 'DISPOSED' ||
      this._snapshot.state === 'DESTROYING' ||
      this._snapshot.state === 'FAULTED'
    ) {
      return
    }
    if (this._nativeReady && this._rendererReady && !this.isReady()) {
      this.updateState('READY')
      this._resolveReady(this)

      if (this._pendingShow) {
        // show() coalesces with any caller already waiting on readiness, so this cannot emit a
        // duplicate native show request during the ready transition.
        void this.show().catch(() => {})
      }
    }
  }

  private updateState(newState: SurfaceLifecycleState): void {
    this._snapshot = {
      ...this._snapshot,
      state: newState,
    }
  }
}
