/** Authoritative ELIX Windows monitor, DPI, foreground, and fullscreen service. */

import { Context, Service } from '@deepseek-ai/cordis'
import {
  getSharedNativeBridge,
  type NativeBridgeClient,
  type NativeBridgeError,
  type NativeWindowsContextChange,
} from '@deepseek-ai/dsh-native-core'
import z from '@deepseek-ai/schemastery'
import { WindowsContextState } from './state.ts'
import type {
  ForegroundWindowContext,
  MonitorId,
  WindowsContextChange,
  WindowsContextConfig,
  WindowsContextSnapshot,
  WindowsContextSource,
  WindowsMonitor,
} from './types.ts'

export * from './types.ts'
export * from './state.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    windowsContext: WindowsContextService
  }
  interface Events {
    /** @mode broadcast @param change Complete committed Windows Context replacement. */
    'windows-context/change'(change: WindowsContextChange): void
    /** @mode broadcast @param error Native observation fault; the last good snapshot is retained. */
    'windows-context/fault'(error: Error): void
    /** @mode broadcast @param service Initialized authoritative Windows Context service. */
    'windows-context/ready'(service: WindowsContextService): void
  }
}

/** Cordis service that owns normalized immutable Windows context state. */
export class WindowsContextService extends Service implements WindowsContextSource {
  static Config = z.object({ enabled: z.boolean().default(true) })

  private readonly config: WindowsContextConfig
  private readonly state = new WindowsContextState()
  private nativeSubscription: Awaited<ReturnType<NativeBridgeClient['windowsContext']['start']>> | null = null
  private recoveryPromise: Promise<void> | null = null
  private readonly lifecycle = { isDisposed: false }

  private get isDisposed(): boolean {
    return this.lifecycle.isDisposed
  }

  constructor(ctx: Context, config?: Partial<WindowsContextConfig>) {
    super(ctx, 'windowsContext')
    this.config = {
      enabled: config?.enabled ?? true,
      bridge: config?.bridge,
    }
  }

  /** Starts native observation only after an initial coherent snapshot is available. */
  async [Service.init](): Promise<void> {
    if (!this.config.enabled) return
    const bridge = this.config.bridge ?? getSharedNativeBridge()
    const onEvent = (event: NativeWindowsContextChange) => {
      try {
        const change = this.state.apply(event)
        if (change) this.ctx.emit('windows-context/change', change)
      } catch (error) {
        this.ctx.emit(
          'windows-context/fault',
          error instanceof Error ? error : new Error(String(error)),
        )
      }
    }
    const onFault = (error: NativeBridgeError) => {
      this.ctx.emit('windows-context/fault', error)
      void this.recoverDeadObserver(bridge, onEvent, onFault)
    }

    // Install cleanup before awaiting native startup. Disposal is allowed to race an async
    // observer start; a late subscription is immediately torn down instead of leaking its worker.
    this.ctx.effect(() => async () => {
      this.lifecycle.isDisposed = true
      const recovery = this.recoveryPromise
      const subscription = this.nativeSubscription
      this.nativeSubscription = null
      await recovery?.catch(() => {})
      await subscription?.dispose()
    }, 'windowsContext.lifecycle')

    const subscription = await bridge.windowsContext.start(onEvent, onFault)
    if (this.isDisposed) {
      await subscription.dispose()
      return
    }
    this.nativeSubscription = subscription
    this.ctx.emit('windows-context/ready', this)
  }

  private recoverDeadObserver(
    bridge: NativeBridgeClient,
    onEvent: (event: NativeWindowsContextChange) => void,
    onFault: (error: NativeBridgeError) => void,
  ): Promise<void> {
    if (this.isDisposed) return Promise.resolve()
    if (this.recoveryPromise) return this.recoveryPromise
    this.recoveryPromise = (async () => {
      // Fatal observer faults are emitted from the observer thread immediately before it exits.
      // Give that thread a bounded quiescence window before concluding that a still-alive worker
      // only reported a recoverable capture fault. This avoids racing start() against a dying worker.
      let consecutiveAliveChecks = 0
      for (let attempt = 0; attempt < 8; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)))
        let status: Awaited<ReturnType<NativeBridgeClient['windowsContext']['getStatus']>>
        try {
          status = await bridge.windowsContext.getStatus()
        } catch {
          // Process-level host recovery is already owned by NativeBridgeClient. Its declarative
          // Windows Context intent will be restored after the new host generation handshakes.
          return
        }
        if (status.threadAlive) {
          consecutiveAliveChecks++
          if (consecutiveAliveChecks >= 3) return
          continue
        }
        try {
          const replacement = await bridge.windowsContext.start(onEvent, onFault)
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
          if (attempt === 7) {
            this.ctx.emit(
              'windows-context/fault',
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

  /** Returns the current immutable complete snapshot. */
  getSnapshot(): WindowsContextSnapshot {
    return this.state.getSnapshot()
  }

  /** Returns the connected monitors from the current snapshot. */
  getMonitors(): readonly WindowsMonitor[] {
    return this.getSnapshot().monitors
  }

  /** Returns one connected monitor by stable/best-effort identity. */
  getMonitor(id: MonitorId): WindowsMonitor | undefined {
    return this.getSnapshot().monitors.find(monitor => monitor.id === id)
  }

  /** Returns the unique primary monitor. */
  getPrimaryMonitor(): WindowsMonitor {
    const snapshot = this.getSnapshot()
    const primary = snapshot.monitors.find(monitor => monitor.id === snapshot.primaryMonitorId)
    if (!primary) {
      throw new Error(
        `Windows Context snapshot invariant violated: primary monitor '${snapshot.primaryMonitorId}' was not found in active monitors.`,
      )
    }
    return primary
  }

  /** Returns the filtered transient foreground application context. */
  getForegroundContext(): ForegroundWindowContext | null {
    return this.getSnapshot().foreground
  }

  /** Requests an immediate native recapture and returns the committed snapshot. */
  async refresh(): Promise<WindowsContextSnapshot> {
    if (this.isDisposed) throw new Error('Windows Context service is disposed.')
    const bridge = this.config.bridge ?? getSharedNativeBridge()
    await bridge.windowsContext.refresh()
    if (this.isDisposed) throw new Error('Windows Context service was disposed during refresh.')
    return this.getSnapshot()
  }

  /** Subscribes to complete committed replacements. Listener exceptions are isolated. */
  subscribe(listener: (change: WindowsContextChange) => void): () => void {
    if (this.isDisposed) throw new Error('Windows Context service is disposed.')
    return this.state.subscribe(listener)
  }
}

export default WindowsContextService
