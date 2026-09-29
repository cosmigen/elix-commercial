/**
 * ELIX Native Core Bridge Client.
 *
 * Manages the persistent local Rust native host process (`elix-native-host.exe`),
 * protocol versioning, capability negotiation, request/response multiplexing,
 * push event streaming, process supervision/auto-restart with host generations,
 * declarative watcher restoration with post-reconnect invalidation,
 * and backpressure-aware stdio IPC.
 *
 * @module @deepseek-ai/dsh-native-core/client
 */

import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import * as path from 'node:path'
import * as readline from 'node:readline'
import type { Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import type {
  BridgeStatus,
  FileIdentity,
  HandshakeResult,
  KnownFolderId,
  KnownFolderResolution,
  NativeAppBarSpec,
  NativeBridgeOptions,
  NativeCapabilities,
  NativeError,
  NativePackagedLaunchParams,
  NativePhysicalBounds,
  NativePhysicalPixelRect,
  NativeRegisteredAppBar,
  NativeSurfaceCreateOptions,
  NativeSurfaceEvent,
  NativeSurfaceFocusState,
  NativeSurfaceSnapshot,
  NativeSurfaceSubscription,
  NativeSurfaceZOrderPolicy,
  NativeWin32LaunchParams,
  NativeWindowRegistryChange,
  NativeWindowRegistrySnapshot,
  NativeWindowRegistryStatus,
  NativeWindowRegistrySubscription,
  NativeWindowsContextChange,
  NativeWindowsContextSnapshot,
  NativeWindowsContextStatus,
  NativeWindowsContextSubscription,
  ProcessLaunchResult,
  ShellIconDescriptor,
  ShellShortcutMetadata,
  WatcherChangeEvent,
} from './types.ts'

/**
 * Error class representing a failure returned by or related to the Native Bridge.
 */
export class NativeBridgeError extends Error implements NativeError {
  readonly domain: string
  readonly code: string
  readonly nativeCode?: number | undefined
  readonly hresult?: number | undefined
  readonly retryable?: boolean | undefined

  constructor(err: NativeError) {
    super(err.message)
    this.name = 'NativeBridgeError'
    this.domain = err.domain
    this.code = err.code
    this.nativeCode = err.nativeCode
    this.hresult = err.hresult
    this.retryable = err.retryable
  }
}

interface PendingRequest {
  readonly id: number
  readonly generation: number
  readonly method: string
  readonly resolve: (result: unknown) => void
  readonly reject: (error: NativeBridgeError) => void
  readonly cleanup: () => void
}

interface WatcherSubscriptionIntent {
  readonly clientSubId: number
  readonly containerPath: string
  readonly onEvent: (ev: WatcherChangeEvent) => void
  nativeSubscription: NativeWatcherBinding | null
  isDisposed: boolean
}

interface NativeWatcherBinding {
  readonly id: number
  readonly generation: number
}

interface WindowsContextObservationIntent {
  readonly listeners: Set<(event: NativeWindowsContextChange) => void>
  readonly faultListeners: Set<(error: NativeBridgeError) => void>
  nativeGeneration: number | null
  lastNativeRevision: number
  hasObserved: boolean
  recoveryPending: boolean
}

interface WindowRegistryObservationIntent {
  readonly listeners: Set<(event: NativeWindowRegistryChange) => void>
  readonly faultListeners: Set<(error: NativeBridgeError) => void>
  nativeGeneration: number | null
  lastNativeRevision: number
  hasObserved: boolean
  recoveryPending: boolean
}

interface SurfaceIntent {
  readonly id: string
  spec: NativeSurfaceCreateOptions
  visible: boolean
  lastBounds: NativePhysicalBounds
  lastZOrder: NativeSurfaceZOrderPolicy
  isDisposed: boolean
}

const PROTOCOL_VERSION = 1
const CLIENT_VERSION = '0.1.0'
const MAX_REQUEST_FRAME_BYTES = 1024 * 1024
const MAX_UNBOUND_WATCHER_INVALIDATIONS = 256

/**
 * Searches default workspace locations for the compiled elix-native-host.exe binary.
 */
export function findNativeHostBinary(overridePath?: string): string | undefined {
  if (overridePath !== undefined) {
    return existsSync(overridePath) ? overridePath : undefined
  }

  const candidates: string[] = []

  // Try relative to current module file
  try {
    const currentDir = path.dirname(fileURLToPath(import.meta.url))
    candidates.push(
      path.resolve(currentDir, '../../../../native/target/release/elix-native-host.exe'),
      path.resolve(currentDir, '../../../../native/target/debug/elix-native-host.exe'),
      path.resolve(currentDir, '../../../native/target/release/elix-native-host.exe'),
      path.resolve(currentDir, '../../../native/target/debug/elix-native-host.exe'),
    )
  } catch {
    // Ignore URL resolution errors in environments without import.meta.url
  }

  // Try relative to process current working directory
  candidates.push(
    path.resolve(process.cwd(), 'native/target/release/elix-native-host.exe'),
    path.resolve(process.cwd(), 'native/target/debug/elix-native-host.exe'),
  )

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate
    }
  }

  return undefined
}

/**
 * Client for communicating with the ELIX Native Host process over typed stdio IPC.
 * Features process supervision, bounded restart backoff, generation fencing,
 * declarative watcher restoration, and backpressure-aware pipe writing.
 */
export class NativeBridgeClient {
  private child: ChildProcess | null = null
  private rl: readline.Interface | null = null
  private status: BridgeStatus = 'uninitialized'
  private hostGeneration = 0
  private nextId = 1
  private nextClientSubId = 1
  private readonly pendingRequests = new Map<number, PendingRequest>()
  private readonly activeWatchers = new Map<number, WatcherSubscriptionIntent>()
  private readonly nativeToClientSubMap = new Map<number, number>()
  private readonly unboundWatcherInvalidations = new Map<number, WatcherChangeEvent>()
  private readonly activeSurfaces = new Map<string, SurfaceIntent>()
  private readonly surfaceEventListeners = new Set<(event: NativeSurfaceEvent) => void>()
  private windowsContextIntent: WindowsContextObservationIntent | null = null
  private windowRegistryIntent: WindowRegistryObservationIntent | null = null
  private handshake: HandshakeResult | null = null
  private readonly options: NativeBridgeOptions
  private binaryPath: string | undefined

  private connectPromise: Promise<HandshakeResult> | null = null
  private isReconnecting = false
  private consecutiveRestarts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private stabilityTimer: ReturnType<typeof setTimeout> | null = null
  private discardedStaleFrames = 0

  constructor(options?: NativeBridgeOptions) {
    this.options = options ?? {}
    this.binaryPath = findNativeHostBinary(this.options.binaryPath)
  }

  /**
   * Checks whether the native host binary exists on the system.
   */
  static isAvailable(overridePath?: string): boolean {
    return Boolean(findNativeHostBinary(overridePath))
  }

  /** Gets the current bridge operational status. */
  getStatus(): BridgeStatus {
    return this.status
  }

  /** Gets the current native host generation index. */
  getHostGeneration(): number {
    return this.hostGeneration
  }

  /** Gets the count of active client watcher subscriptions. */
  getActiveWatchersCount(): number {
    return this.activeWatchers.size
  }

  /** Gets the count of active client surface intents. */
  getActiveSurfacesCount(): number {
    return this.activeSurfaces.size
  }

  /** Gets the number of listeners sharing the process-wide Windows Context observer. */
  getWindowsContextListenerCountForTest(): number {
    return this.windowsContextIntent?.listeners.size ?? 0
  }

  /** Gets the number of listeners sharing the process-wide Window Registry observer. */
  getWindowRegistryListenerCountForTest(): number {
    return this.windowRegistryIntent?.listeners.size ?? 0
  }

  /** Gets the number of listeners registered for surface events. */
  getSurfaceListenerCountForTest(): number {
    return this.surfaceEventListeners.size
  }

  /**
   * Returns active client watcher IDs.
   * @internal
   */
  getActiveWatcherIds(): readonly number[] {
    return Array.from(this.activeWatchers.keys())
  }

  /** Returns the current native binding for an active watcher. @internal */
  getNativeWatcherBindingForTest(subscriptionId: number): NativeWatcherBinding | null {
    return this.activeWatchers.get(subscriptionId)?.nativeSubscription ?? null
  }

  /** Returns the number of incoming frames rejected before ID lookup due to generation. @internal */
  getDiscardedStaleFrameCountForTest(): number {
    return this.discardedStaleFrames
  }

  /** Returns the child PID while the process is owned by this client. @internal */
  getChildProcessIdForTest(): number | undefined {
    return this.child?.pid
  }

  /**
   * Returns whether child process is killed or null.
   * @internal
   */
  isChildKilled(): boolean {
    return this.child?.killed ?? true
  }

  /**
   * Invokes writeToStdin for backpressure testing.
   * @internal
   */
  writeToStdinForTest(
    stream: Writable,
    payload: string,
    isCancelled: () => boolean,
    onCancelHook?: (cancelFn: () => void) => void,
    childProcess?: ChildProcess | null,
  ): Promise<void> {
    return this.writeToStdin(stream, payload, isCancelled, onCancelHook, childProcess)
  }

  /**
   * Injects an incoming JSON line for generation testing.
   * @internal
   */
  handleIncomingLineForTest(line: string, generation: number): void {
    this.handleIncomingLine(line, generation)
  }

  /** Gets the negotiated native capabilities, or undefined if not connected. */
  getCapabilities(): NativeCapabilities | undefined {
    return this.handshake?.capabilities
  }

  /** Gets the full handshake negotiation result. */
  getHandshake(): HandshakeResult | null {
    return this.handshake
  }

  /** Whether the bridge is connected and ready for requests. */
  isReady(): boolean {
    return this.status === 'ready' && this.child !== null && !this.child.killed
  }

  private get autoRestart(): boolean {
    return this.options.supervisor?.autoRestart ?? this.options.autoRestart ?? true
  }

  private get maxRestarts(): number {
    return this.options.supervisor?.maxRestarts ?? 5
  }

  private get initialBackoffMs(): number {
    return this.options.supervisor?.initialBackoffMs ?? 100
  }

  private get maxBackoffMs(): number {
    return this.options.supervisor?.maxBackoffMs ?? 2000
  }

  private get stabilityWindowMs(): number {
    return this.options.supervisor?.stabilityWindowMs ?? 30_000
  }

  /**
   * Connects to the native host process and executes the protocol handshake.
   */
  async connect(): Promise<HandshakeResult> {
    if (this.status === 'ready' && this.handshake && this.child && !this.child.killed) {
      return this.handshake
    }

    if (this.connectPromise) {
      return this.connectPromise
    }

    const resolvedBinary = this.binaryPath ?? findNativeHostBinary(this.options.binaryPath)
    if (!resolvedBinary || !existsSync(resolvedBinary)) {
      this.status = 'faulted'
      const err: NativeError = {
        domain: 'bridge',
        code: 'BINARY_NOT_FOUND',
        message: 'Native host binary \'elix-native-host.exe\' not found. Run \'cargo build --release\' in native/ directory.',
        retryable: false,
      }
      throw new NativeBridgeError(err)
    }
    this.binaryPath = resolvedBinary

    this.status = this.isReconnecting ? 'reconnecting' : 'connecting'

    this.connectPromise = (async () => {
      try {
        const binPath = resolvedBinary
        const generation = ++this.hostGeneration

        const child = spawn(binPath, [], {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        })

        this.child = child

        const stdoutStream = child.stdout
        const rl = readline.createInterface({
          input: stdoutStream,
          crlfDelay: Infinity,
        })
        this.rl = rl

        rl.on('line', (line) => {
          this.handleIncomingLine(line, generation)
        })

        // Drain stderr to prevent OS pipe buffer saturation and native process blockage
        child.stderr.on('data', (chunk: Buffer) => {
          const msg = chunk.toString('utf8').trim()
          if (msg && this.options.debug) {
            console.warn(`[elix-native-host stderr] ${msg}`)
          }
        })
        child.stderr.resume()

        child.on('error', (procErr) => {
          this.handleProcessTermination('faulted', procErr.message, generation)
        })

        child.on('exit', (code, signal) => {
          const reason = `Process exited with code ${code}, signal ${signal}`
          this.handleProcessTermination(
            this.status === 'closed' ? 'closed' : 'faulted',
            reason,
            generation,
          )
        })

        // Perform handshake with deadline
        const handshakeTimeout = this.options.handshakeTimeoutMs ?? 5_000
        const handshakeResult = await this.sendRequestInternal<HandshakeResult>(
          'bridge/handshake',
          { protocolVersion: PROTOCOL_VERSION, clientVersion: CLIENT_VERSION },
          handshakeTimeout,
          generation,
        )

        // Bidirectional protocol negotiation: validate native protocol version compatibility
        if (
          typeof handshakeResult.protocolVersion !== 'number' ||
          handshakeResult.protocolVersion !== PROTOCOL_VERSION
        ) {
          throw new NativeBridgeError({
            domain: 'bridge',
            code: 'INCOMPATIBLE_PROTOCOL',
            message: `Native protocol version '${handshakeResult.protocolVersion}' is incompatible with client (expected ${PROTOCOL_VERSION})`,
            retryable: false,
          })
        }

        // Protect against dispose-during-reconnect race
        if (this.status === 'closed') {
          this.disposeInternal()
          throw new NativeBridgeError({
            domain: 'bridge',
            code: 'BRIDGE_CLOSED',
            message: 'Bridge closed during connection',
            retryable: false,
          })
        }

        this.handshake = handshakeResult

        // Declaratively restore native observation intents after reconnect.
        await this.restoreWatchers(generation)
        await this.restoreWindowsContext(generation)
        await this.restoreWindowRegistry(generation)
        await this.restoreSurfaces(generation)

        const statusAfterRestore = this.status as string
        if (
          generation !== this.hostGeneration ||
          statusAfterRestore === 'closed' ||
          statusAfterRestore === 'faulted' ||
          this.child !== child ||
          child.killed ||
          child.exitCode !== null ||
          child.signalCode !== null
        ) {
          throw new NativeBridgeError({
            domain: 'bridge',
            code: 'HOST_TERMINATED',
            message: `Native host generation ${generation} ended during watcher restoration.`,
            retryable: true,
          })
        }
        this.status = 'ready'
        this.armStabilityReset(generation)

        return handshakeResult
      } catch (err) {
        if (this.status !== 'closed' && !this.isReconnecting) {
          this.status = 'faulted'
          this.disposeInternal()
        }
        throw err
      } finally {
        this.connectPromise = null
      }
    })()

    return this.connectPromise
  }

  private isWatcherRestorable(intent: WatcherSubscriptionIntent, generation: number): boolean {
    const s = this.status as string
    return (
      !intent.isDisposed &&
      s !== 'closed' &&
      s !== 'faulted' &&
      generation === this.hostGeneration
    )
  }

  private armStabilityReset(generation: number): void {
    if (this.stabilityTimer) {
      clearTimeout(this.stabilityTimer)
    }
    this.stabilityTimer = setTimeout(() => {
      this.stabilityTimer = null
      if (this.status === 'ready' && generation === this.hostGeneration) {
        this.consecutiveRestarts = 0
      }
    }, this.stabilityWindowMs)
  }

  /**
   * Re-registers all active client watcher subscriptions after native host reconnect.
   */
  private async restoreWatchers(generation: number): Promise<void> {
    if (generation !== this.hostGeneration || this.status === 'closed' || this.status === 'faulted') {
      return
    }

    this.nativeToClientSubMap.clear()
    const liveIntents: WatcherSubscriptionIntent[] = Array.from(this.activeWatchers.values())

    for (const intent of liveIntents) {
      if (!this.isWatcherRestorable(intent, generation)) {
        continue
      }

      try {
        const res = await this.sendRequestInternal<{ subscriptionId: number }>(
          'watcher/watch',
          { containerPath: intent.containerPath },
          this.options.requestTimeoutMs ?? 5_000,
          generation,
        )

        if (!this.isWatcherRestorable(intent, generation)) {
          // Disposed while reconnect request was in flight
          this.unboundWatcherInvalidations.delete(res.subscriptionId)
          void this.sendRequestInternal(
            'watcher/unwatch',
            { subscriptionId: res.subscriptionId },
            1_000,
            generation,
          ).catch(() => {})
          continue
        }

        this.bindNativeWatcher(intent, { id: res.subscriptionId, generation })

        // The restored native watcher remains degraded until its consumer reconciles and rearms it.
        await this.sendRequestInternal(
          'watcher/invalidate',
          { subscriptionId: res.subscriptionId },
          this.options.requestTimeoutMs ?? 5_000,
          generation,
        )
      } catch (err: unknown) {
        // If host crashed again or bridge was closed during restoration, do NOT purge the watcher!
        if (
          !this.isWatcherRestorable(intent, generation) ||
          (err instanceof NativeBridgeError && (
            err.code === 'HOST_TERMINATED' ||
            err.code === 'BRIDGE_CLOSED' ||
            err.code === 'NOT_CONNECTED' ||
            err.code === 'STALE_GENERATION'
          ))
        ) {
          return
        }

        // Failed to restore single watcher (e.g. folder deleted during downtime);
        // Cleanly mark intent un-restorable, purge from active list, and emit container-invalidated
        // so listeners (like ShellNamespaceEngine) reconcile and purge missing items.
        this.activeWatchers.delete(intent.clientSubId)
        try {
          intent.onEvent({
            subscriptionId: intent.clientSubId,
            containerPath: intent.containerPath,
            changeType: 'container-invalidated',
          })
        } catch {
          // Prevent listener error from disrupting other watcher restorations
        }
      }
    }
  }

  private async restoreWindowsContext(generation: number): Promise<void> {
    const intent = this.windowsContextIntent
    if (
      !intent ||
      intent.listeners.size === 0 ||
      generation !== this.hostGeneration ||
      this.status === 'closed' ||
      this.status === 'faulted'
    ) {
      return
    }
    intent.nativeGeneration = null
    intent.lastNativeRevision = 0
    intent.recoveryPending = intent.hasObserved
    const result = await this.sendRequestInternal<{
      snapshot: NativeWindowsContextSnapshot
      alreadyStarted: boolean
    }>(
      'windowsContext/start',
      {},
      this.options.requestTimeoutMs ?? 5_000,
      generation,
    )
    const statusAfterStart = this.status as string
    if (
      generation !== this.hostGeneration ||
      statusAfterStart === 'closed' ||
      statusAfterStart === 'faulted' ||
      this.windowsContextIntent !== intent ||
      intent.listeners.size === 0
    ) {
      return
    }
    intent.nativeGeneration = generation
    const reason = intent.hasObserved ? 'recovered' : 'initial'
    intent.hasObserved = true
    intent.recoveryPending = false
    this.deliverWindowsContextEvent({ reason, snapshot: result.snapshot }, generation)
  }

  private async restoreWindowRegistry(generation: number): Promise<void> {
    const intent = this.windowRegistryIntent
    if (
      !intent ||
      intent.listeners.size === 0 ||
      generation !== this.hostGeneration ||
      this.status === 'closed' ||
      this.status === 'faulted'
    ) {
      return
    }
    intent.nativeGeneration = null
    intent.lastNativeRevision = 0
    intent.recoveryPending = intent.hasObserved
    const result = await this.sendRequestInternal<{
      snapshot: NativeWindowRegistrySnapshot
      alreadyStarted: boolean
    }>(
      'windowRegistry/start',
      {},
      this.options.requestTimeoutMs ?? 5_000,
      generation,
    )
    const statusAfterStart = this.status as string
    if (
      generation !== this.hostGeneration ||
      statusAfterStart === 'closed' ||
      statusAfterStart === 'faulted' ||
      this.windowRegistryIntent !== intent ||
      intent.listeners.size === 0
    ) {
      return
    }
    intent.nativeGeneration = generation
    const reason = intent.hasObserved ? 'recovered' : 'initial'
    intent.hasObserved = true
    intent.recoveryPending = false
    this.deliverWindowRegistryEvent({ reason, snapshot: result.snapshot }, generation)
  }

  private async restoreSurfaces(generation: number): Promise<void> {
    if (generation !== this.hostGeneration || this.status === 'closed' || this.status === 'faulted') {
      return
    }

    const liveSurfaces = Array.from(this.activeSurfaces.values())
    for (const intent of liveSurfaces) {
      if (intent.isDisposed || generation !== this.hostGeneration) continue
      try {
        const recreateSpec: NativeSurfaceCreateOptions = {
          ...intent.spec,
          bounds: intent.lastBounds,
          zOrderPolicy: intent.lastZOrder,
          visible: false,
        }
        await this.sendRequestInternal<NativeSurfaceSnapshot>(
          'surface/create',
          recreateSpec,
          this.options.requestTimeoutMs ?? 5_000,
          generation,
        )
        if (intent.visible && generation === this.hostGeneration) {
          await this.sendRequestInternal<NativeSurfaceSnapshot>(
            'surface/show',
            { id: intent.id },
            this.options.requestTimeoutMs ?? 5_000,
            generation,
          ).catch(() => {})
        }
      } catch {
        // Individual surface recreation failure isolated
      }
    }
  }

  private async waitForReady(timeoutMsOverride?: number): Promise<void> {
    const timeout = timeoutMsOverride ?? this.options.requestTimeoutMs ?? 5_000
    const start = Date.now()
    while (
      (this.status === 'reconnecting' || this.connectPromise) &&
      this.status !== 'closed' &&
      this.status !== 'faulted' &&
      Date.now() - start < timeout
    ) {
      if (this.connectPromise) {
        try {
          await this.connectPromise
        } catch {
          // Reconnect error handled by supervisor loop
        }
      } else {
        await new Promise(r => setTimeout(r, 20))
      }
    }

    if (Date.now() - start >= timeout && (this.status === 'reconnecting' || this.connectPromise)) {
      throw new NativeBridgeError({
        domain: 'bridge',
        code: 'REQUEST_TIMEOUT',
        message: `Timed out waiting for native host reconnection after ${timeout}ms.`,
        retryable: true,
      })
    }
  }

  /**
   * Sends a typed JSON-RPC request to the native host process and awaits response.
   * Automatically connects if the bridge is currently uninitialized, and awaits in-flight reconnection.
   */
  async sendRequest<T>(
    method: string,
    params?: unknown,
    timeoutMsOverride?: number,
  ): Promise<T> {
    if (this.status === 'uninitialized') {
      await this.connect()
    } else if (this.status === 'reconnecting' || this.connectPromise) {
      await this.waitForReady(timeoutMsOverride)
    }
    return this.sendRequestInternal<T>(method, params, timeoutMsOverride)
  }

  /**
   * Sends a request directly over the process channel with backpressure handling.
   */
  private async sendRequestInternal<T>(
    method: string,
    params?: unknown,
    timeoutMsOverride?: number,
    expectedGeneration?: number,
  ): Promise<T> {
    if (this.status === 'closed') {
      const err: NativeError = {
        domain: 'bridge',
        code: 'BRIDGE_CLOSED',
        message: `Cannot send request '${method}': Native bridge is closed.`,
        retryable: false,
      }
      return Promise.reject(new NativeBridgeError(err))
    }

    if (this.status === 'faulted') {
      const err: NativeError = {
        domain: 'bridge',
        code: 'BRIDGE_FAULTED',
        message: `Cannot send request '${method}': Native bridge is in faulted state.`,
        retryable: false,
      }
      return Promise.reject(new NativeBridgeError(err))
    }

    const generation = expectedGeneration ?? this.hostGeneration
    if (generation !== this.hostGeneration) {
      return Promise.reject(new NativeBridgeError({
        domain: 'bridge',
        code: 'STALE_GENERATION',
        message: `Cannot send request '${method}' for native host generation ${generation}; current generation is ${this.hostGeneration}.`,
        retryable: false,
      }))
    }
    const child = this.child
    if (!child || !child.stdin || child.killed) {
      const err: NativeError = {
        domain: 'bridge',
        code: 'NOT_CONNECTED',
        message: `Cannot send request '${method}': Native host process is not running.`,
        retryable: false,
      }
      return Promise.reject(new NativeBridgeError(err))
    }
    const childStdin = child.stdin

    const id = this.nextId++
    const timeoutMs = timeoutMsOverride ?? this.options.requestTimeoutMs ?? 5_000
    let payload: string
    try {
      payload = JSON.stringify({
        id,
        method,
        params: params ?? {},
      })
    } catch (error) {
      return Promise.reject(new NativeBridgeError({
        domain: 'bridge',
        code: 'INVALID_ARGUMENT',
        message: `Native request '${method}' is not JSON serializable: ${String(error)}`,
        retryable: false,
      }))
    }
    const payloadBytes = Buffer.byteLength(payload, 'utf8')
    if (payloadBytes > MAX_REQUEST_FRAME_BYTES) {
      return Promise.reject(new NativeBridgeError({
        domain: 'bridge',
        code: 'REQUEST_TOO_LARGE',
        message: `Native request '${method}' is ${payloadBytes} bytes; maximum is ${MAX_REQUEST_FRAME_BYTES}.`,
        retryable: false,
      }))
    }

    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      let cancelled = false
      let cancelDrainWait: (() => void) | null = null

      const cleanup = () => {
        cancelled = true
        if (timer) clearTimeout(timer)
        if (cancelDrainWait) {
          cancelDrainWait()
          cancelDrainWait = null
        }
        this.pendingRequests.delete(id)
      }

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          cleanup()
          const timeoutErr: NativeError = {
            domain: 'bridge',
            code: 'REQUEST_TIMEOUT',
            message: `Native request '${method}' (id: ${id}) timed out after ${timeoutMs}ms.`,
            retryable: true,
          }
          reject(new NativeBridgeError(timeoutErr))
        }, timeoutMs)
      }

      this.pendingRequests.set(id, {
        id,
        generation,
        method,
        resolve: resolve as (val: unknown) => void,
        reject,
        cleanup,
      })

      this.writeToStdin(
        childStdin,
        payload,
        () => cancelled,
        (cb) => {
          cancelDrainWait = cb
        },
        child,
      ).catch((writeErr: unknown) => {
        cleanup()
        const err = writeErr instanceof NativeBridgeError
          ? writeErr
          : new NativeBridgeError({
            domain: 'bridge',
            code: 'WRITE_ERROR',
            message: `Failed to write request: ${String(writeErr)}`,
            retryable: false,
          })
        reject(err)
      })
    })
  }

  /**
   * Writes a payload to child stdin with drain backpressure handling.
   */
  private async writeToStdin(
    childStdin: Writable,
    payload: string,
    isCancelled: () => boolean,
    onCancelHook?: (cancelFn: () => void) => void,
    childProcess?: ChildProcess | null,
  ): Promise<void> {
    if (isCancelled()) {
      throw new NativeBridgeError({
        domain: 'bridge',
        code: 'REQUEST_CANCELLED',
        message: 'Request was cancelled before write',
      })
    }

    const ok = childStdin.write(payload + '\n', 'utf8')
    if (ok) return

    // Pipe backpressure: wait for 'drain' event with error, close, child exit, and cancellation guards
    await new Promise<void>((resolve, reject) => {
      let isSettled = false

      const cleanup = () => {
        childStdin.off('drain', onDrain)
        childStdin.off('error', onError)
        childStdin.off('close', onClose)
        if (childProcess) {
          childProcess.off('exit', onChildExit)
          childProcess.off('error', onChildError)
        }
      }

      const onDrain = () => {
        if (isSettled) return
        isSettled = true
        cleanup()
        resolve()
      }

      const onError = (err: Error) => {
        if (isSettled) return
        isSettled = true
        cleanup()
        reject(
          new NativeBridgeError({
            domain: 'bridge',
            code: 'PIPE_ERROR',
            message: `Stdin write pipe error: ${err.message}`,
          }),
        )
      }

      const onClose = () => {
        if (isSettled) return
        isSettled = true
        cleanup()
        reject(
          new NativeBridgeError({
            domain: 'bridge',
            code: 'PIPE_CLOSED',
            message: 'Stdin pipe closed before drain',
          }),
        )
      }

      const onChildExit = (code: number | null, signal: string | null) => {
        if (isSettled) return
        isSettled = true
        cleanup()
        reject(
          new NativeBridgeError({
            domain: 'bridge',
            code: 'HOST_TERMINATED',
            message: `Native host exited (${code}, ${signal}) before stdin drain`,
          }),
        )
      }

      const onChildError = (err: Error) => {
        if (isSettled) return
        isSettled = true
        cleanup()
        reject(
          new NativeBridgeError({
            domain: 'bridge',
            code: 'HOST_TERMINATED',
            message: `Native host error before stdin drain: ${err.message}`,
          }),
        )
      }

      if (onCancelHook) {
        onCancelHook(() => {
          if (isSettled) return
          isSettled = true
          cleanup()
          reject(
            new NativeBridgeError({
              domain: 'bridge',
              code: 'REQUEST_CANCELLED',
              message: 'Request was cancelled while awaiting stdin drain',
            }),
          )
        })
      }

      childStdin.once('drain', onDrain)
      childStdin.once('error', onError)
      childStdin.once('close', onClose)
      if (childProcess) {
        childProcess.once('exit', onChildExit)
        childProcess.once('error', onChildError)
      }
    })
  }

  private handleIncomingLine(line: string, generation: number): void {
    // Fencing: reject lines from old generations
    if (generation !== this.hostGeneration) {
      this.discardedStaleFrames++
      return
    }

    const trimmed = line.trim()
    if (!trimmed) return

    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      // Malformed protocol framing from native host: reject pending requests with PROTOCOL_ERROR
      const protoErr = new NativeBridgeError({
        domain: 'bridge',
        code: 'PROTOCOL_ERROR',
        message: `Malformed JSON received from native host: ${trimmed.slice(0, 120)}`,
        retryable: false,
      })
      for (const [id, pending] of this.pendingRequests.entries()) {
        if (pending.generation === generation) {
          pending.cleanup()
          this.pendingRequests.delete(id)
          pending.reject(protoErr)
        }
      }
      return
    }

    if (typeof parsed !== 'object' || parsed === null) return
    const record = parsed as Record<string, unknown>

    // 1. Check if it is a response to an in-flight request
    if (typeof record.id === 'number') {
      const pending = this.pendingRequests.get(record.id)
      if (pending) {
        if (pending.generation !== generation) {
          // Stale generation response: discard and do not resolve
          return
        }
        pending.cleanup()
        this.pendingRequests.delete(record.id)
        if (record.error && typeof record.error === 'object') {
          pending.reject(new NativeBridgeError(record.error as unknown as NativeError))
        } else {
          pending.resolve(record.result)
        }
      }
      return
    }

    // 2. Check if it is a push event
    if (typeof record.event === 'string') {
      if (record.event === 'watcher/change' && record.payload && typeof record.payload === 'object') {
        const ev = record.payload as unknown as WatcherChangeEvent
        if (!this.deliverWatcherEvent(ev)) {
          // Native startup events can race the watcher/watch response. Losing any such event loses
          // precision, so retain one bounded degraded marker until the binding is installed.
          if (
            this.unboundWatcherInvalidations.has(ev.subscriptionId) ||
            this.unboundWatcherInvalidations.size < MAX_UNBOUND_WATCHER_INVALIDATIONS
          ) {
            this.unboundWatcherInvalidations.set(ev.subscriptionId, {
              subscriptionId: ev.subscriptionId,
              containerPath: ev.containerPath,
              changeType: 'container-invalidated',
            })
          }
        }
      } else if (
        record.event === 'windowsContext/change' &&
        record.payload &&
        typeof record.payload === 'object'
      ) {
        this.deliverWindowsContextEvent(
          record.payload as unknown as NativeWindowsContextChange,
          generation,
        )
      } else if (
        record.event === 'windowsContext/fault' &&
        record.payload &&
        typeof record.payload === 'object'
      ) {
        this.deliverWindowsContextFault(
          new NativeBridgeError(record.payload as unknown as NativeError),
          generation,
        )
      } else if (
        record.event === 'windowRegistry/change' &&
        record.payload &&
        typeof record.payload === 'object'
      ) {
        this.deliverWindowRegistryEvent(
          record.payload as unknown as NativeWindowRegistryChange,
          generation,
        )
      } else if (
        record.event === 'windowRegistry/fault' &&
        record.payload &&
        typeof record.payload === 'object'
      ) {
        this.deliverWindowRegistryFault(
          new NativeBridgeError(record.payload as unknown as NativeError),
          generation,
        )
      } else if (
        record.event === 'surface/event' &&
        record.payload &&
        typeof record.payload === 'object'
      ) {
        this.deliverSurfaceEvent(
          record.payload as unknown as NativeSurfaceEvent,
          generation,
        )
      }
    }
  }

  private deliverSurfaceEvent(event: NativeSurfaceEvent, generation: number): void {
    if (generation !== this.hostGeneration) return

    if (event.type === 'boundsChanged') {
      const intent = this.activeSurfaces.get(event.id)
      if (intent) intent.lastBounds = event.bounds
    } else if (event.type === 'shown') {
      const intent = this.activeSurfaces.get(event.id)
      if (intent) intent.visible = true
    } else if (event.type === 'hidden') {
      const intent = this.activeSurfaces.get(event.id)
      if (intent) intent.visible = false
    } else if (event.type === 'destroyed') {
      const intent = this.activeSurfaces.get(event.id)
      if (intent) {
        intent.isDisposed = true
        this.activeSurfaces.delete(event.id)
      }
    }

    for (const listener of this.surfaceEventListeners) {
      try {
        listener(event)
      } catch {
        // Listener failures are isolated from protocol processing
      }
    }
  }

  private deliverWindowsContextEvent(
    event: NativeWindowsContextChange,
    generation: number,
  ): void {
    const intent = this.windowsContextIntent
    if (!intent || generation !== this.hostGeneration || intent.listeners.size === 0) return
    if (event.snapshot.revision <= intent.lastNativeRevision) return
    intent.lastNativeRevision = event.snapshot.revision
    const delivered = intent.recoveryPending ? { ...event, reason: 'recovered' as const } : event
    intent.recoveryPending = false
    intent.hasObserved = true
    intent.nativeGeneration = generation
    for (const listener of intent.listeners) {
      try {
        listener(delivered)
      } catch {
        // Listener failures are isolated from protocol processing and sibling listeners.
      }
    }
  }

  private deliverWindowsContextFault(error: NativeBridgeError, generation: number): void {
    const intent = this.windowsContextIntent
    if (!intent || generation !== this.hostGeneration) return
    intent.nativeGeneration = null
    for (const listener of intent.faultListeners) {
      try {
        listener(error)
      } catch {
        // Listener failures are isolated from protocol processing and sibling listeners.
      }
    }
  }

  private deliverWindowRegistryEvent(
    event: NativeWindowRegistryChange,
    generation: number,
  ): void {
    const intent = this.windowRegistryIntent
    if (!intent || generation !== this.hostGeneration || intent.listeners.size === 0) return
    if (event.snapshot.revision <= intent.lastNativeRevision) return
    intent.lastNativeRevision = event.snapshot.revision
    const delivered = intent.recoveryPending ? { ...event, reason: 'recovered' as const } : event
    intent.recoveryPending = false
    intent.hasObserved = true
    intent.nativeGeneration = generation
    for (const listener of intent.listeners) {
      try {
        listener(delivered)
      } catch {
        // Listener failures are isolated from protocol processing and sibling listeners.
      }
    }
  }

  private deliverWindowRegistryFault(error: NativeBridgeError, generation: number): void {
    const intent = this.windowRegistryIntent
    if (!intent || generation !== this.hostGeneration) return
    intent.nativeGeneration = null
    for (const listener of intent.faultListeners) {
      try {
        listener(error)
      } catch {
        // Listener failures are isolated from protocol processing and sibling listeners.
      }
    }
  }

  private deliverWatcherEvent(ev: WatcherChangeEvent): boolean {
    const clientSubId = this.nativeToClientSubMap.get(ev.subscriptionId)
    if (clientSubId === undefined) return false

    const intent = this.activeWatchers.get(clientSubId)
    if (!intent || intent.isDisposed) return true
    try {
      intent.onEvent({
        ...ev,
        subscriptionId: clientSubId,
      })
    } catch {
      // Listener failures are isolated from protocol processing.
    }
    return true
  }

  private bindNativeWatcher(intent: WatcherSubscriptionIntent, binding: NativeWatcherBinding): void {
    intent.nativeSubscription = binding
    this.nativeToClientSubMap.set(binding.id, intent.clientSubId)
    const invalidation = this.unboundWatcherInvalidations.get(binding.id)
    if (invalidation) {
      this.unboundWatcherInvalidations.delete(binding.id)
      this.deliverWatcherEvent(invalidation)
    }
  }

  private handleProcessTermination(
    targetStatus: BridgeStatus,
    reason: string,
    generation: number,
  ): void {
    // Fencing: ignore termination signals from older generations
    if (generation !== this.hostGeneration && generation !== 0) {
      return
    }

    // Reject all pending requests belonging to this generation
    for (const [id, pending] of this.pendingRequests.entries()) {
      if (pending.generation === generation) {
        pending.cleanup()
        this.pendingRequests.delete(id)
        pending.reject(
          new NativeBridgeError({
            domain: 'bridge',
            code: 'HOST_TERMINATED',
            message: `Native host terminated during request '${pending.method}': ${reason}`,
            retryable: false,
          }),
        )
      }
    }

    if (this.status === 'closed') {
      return
    }

    if (this.stabilityTimer) {
      clearTimeout(this.stabilityTimer)
      this.stabilityTimer = null
    }

    // Clean up streams for terminated process
    if (this.rl) {
      this.rl.close()
      this.rl = null
    }
    this.child = null
    this.nativeToClientSubMap.clear()
    this.unboundWatcherInvalidations.clear()
    for (const intent of this.activeWatchers.values()) {
      intent.nativeSubscription = null
    }
    if (this.windowsContextIntent) {
      this.windowsContextIntent.nativeGeneration = null
      this.windowsContextIntent.lastNativeRevision = 0
      this.windowsContextIntent.recoveryPending = this.windowsContextIntent.hasObserved
    }
    if (this.windowRegistryIntent) {
      this.windowRegistryIntent.nativeGeneration = null
      this.windowRegistryIntent.lastNativeRevision = 0
      this.windowRegistryIntent.recoveryPending = this.windowRegistryIntent.hasObserved
    }

    // Supervision: automatic restart with bounded backoff
    if (this.autoRestart && this.consecutiveRestarts < this.maxRestarts) {
      if (this.isReconnecting) {
        return // Already reconnecting
      }
      this.isReconnecting = true
      this.status = 'reconnecting'

      const backoff = Math.min(
        this.initialBackoffMs * (2 ** this.consecutiveRestarts),
        this.maxBackoffMs,
      )
      this.consecutiveRestarts++

      this.reconnectTimer = setTimeout(() => {
        void (async () => {
          this.reconnectTimer = null
          if (this.status === 'closed') {
            this.isReconnecting = false
            return
          }
          try {
            await this.connect()
            this.isReconnecting = false
          } catch {
            this.isReconnecting = false
            this.handleProcessTermination(
              this.consecutiveRestarts >= this.maxRestarts ? 'faulted' : 'reconnecting',
              'Host reconnect failed',
              this.hostGeneration,
            )
          }
        })()
      }, backoff)
    } else {
      this.status = targetStatus
      if (this.status === 'faulted') {
        for (const pending of this.pendingRequests.values()) {
          pending.cleanup()
          pending.reject(
            new NativeBridgeError({
              domain: 'bridge',
              code: 'BRIDGE_FAULTED',
              message: `Native host permanently faulted: ${reason}`,
              retryable: false,
            }),
          )
        }
        this.pendingRequests.clear()
      }
    }
  }

  /**
   * Cleanly disposes the native bridge, cancelling reconnection, sending shutdown command, and stopping process.
   */
  async dispose(): Promise<void> {
    if (this.status === 'closed') return

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.isReconnecting = false

    const child = this.child
    try {
      // Send graceful shutdown RPC before transitioning status to 'closed'
      if (this.child && !this.child.killed && (this.status === 'ready' || this.status === 'connecting')) {
        await this.sendRequestInternal('bridge/shutdown', {}, 1_000).catch(() => {})
      }
    } finally {
      this.status = 'closed'
      this.disposeInternal(false)
    }

    if (child) {
      const timeoutMs = this.options.shutdownTimeoutMs ?? 1_000
      if (!await this.waitForChildExit(child, timeoutMs)) {
        try {
          child.kill()
        } catch {
          // The process may have exited between the deadline and fallback termination.
        }
        if (!await this.waitForChildExit(child, timeoutMs)) {
          throw new NativeBridgeError({
            domain: 'bridge',
            code: 'HOST_SHUTDOWN_TIMEOUT',
            message: `Native host did not exit within ${timeoutMs}ms after fallback termination.`,
            retryable: false,
          })
        }
      }
    }
  }

  private waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) {
      return Promise.resolve(true)
    }
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      const finish = (exited: boolean) => {
        child.off('exit', onExit)
        if (timer) clearTimeout(timer)
        resolve(exited)
      }
      const onExit = () => {
        finish(true)
      }
      child.once('exit', onExit)
      timer = setTimeout(() => {
        finish(false)
      }, timeoutMs)
    })
  }

  private disposeInternal(terminateChild = true): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.isReconnecting = false
    if (this.stabilityTimer) {
      clearTimeout(this.stabilityTimer)
      this.stabilityTimer = null
    }

    if (this.rl) {
      this.rl.close()
      this.rl = null
    }

    if (terminateChild && this.child && !this.child.killed) {
      try {
        this.child.kill()
      } catch {
        // Ignore kill errors
      }
    }
    this.child = null

    for (const pending of this.pendingRequests.values()) {
      pending.cleanup()
      pending.reject(
        new NativeBridgeError({
          domain: 'bridge',
          code: 'BRIDGE_CLOSED',
          message: 'Bridge disposed',
        }),
      )
    }

    this.pendingRequests.clear()
    this.activeWatchers.clear()
    this.nativeToClientSubMap.clear()
    this.unboundWatcherInvalidations.clear()
    this.windowsContextIntent = null
    this.windowRegistryIntent = null
    this.activeSurfaces.clear()
    this.surfaceEventListeners.clear()
  }

  // --- Domain Capability Facades ---

  /** Known Folders domain facade. */
  readonly knownFolders = {
    resolve: (id: KnownFolderId): Promise<KnownFolderResolution> => {
      return this.sendRequest<KnownFolderResolution>('knownFolders/resolve', { id })
    },
    resolveAll: (): Promise<readonly KnownFolderResolution[]> => {
      return this.sendRequest<readonly KnownFolderResolution[]>('knownFolders/resolveAll')
    },
  }

  /** File Identity domain facade. */
  readonly files = {
    identify: (filePath: string): Promise<FileIdentity> => {
      return this.sendRequest<FileIdentity>('files/identify', { path: filePath })
    },
  }

  /** Shell Links (.lnk) domain facade. */
  readonly shortcuts = {
    resolve: (linkPath: string): Promise<ShellShortcutMetadata> => {
      return this.sendRequest<ShellShortcutMetadata>('shortcuts/resolve', { path: linkPath })
    },
    resolveBatch: (linkPaths: readonly string[]): Promise<Record<string, ShellShortcutMetadata>> => {
      return this.sendRequest<Record<string, ShellShortcutMetadata>>('shortcuts/resolveBatch', {
        paths: linkPaths,
      })
    },
  }

  /** Shell Icons domain facade. */
  readonly icons = {
    resolve: (filePath: string, isDirectory = false): Promise<ShellIconDescriptor> => {
      return this.sendRequest<ShellIconDescriptor>('icons/resolve', {
        path: filePath,
        isDirectory,
      })
    },
    queryPeCount: (filePath: string): Promise<number> => {
      return this.sendRequest<{ count: number }>('icons/queryPeCount', { path: filePath }).then(
        r => r.count,
      )
    },
  }

  /** Directory Watcher domain facade with declarative persistence across restarts. */
  readonly watcher = {
    watch: async (
      containerPath: string,
      onEvent: (ev: WatcherChangeEvent) => void,
    ): Promise<{
      subscriptionId: number
      unwatch: () => Promise<boolean>
      rearm: () => Promise<boolean>
      getStats: () => Promise<{
        containerEventCount: number
        isInvalidated: boolean
        isAlive: boolean
      }>
    }> => {
      const clientSubId = this.nextClientSubId++
      const intent: WatcherSubscriptionIntent = {
        clientSubId,
        containerPath,
        onEvent,
        nativeSubscription: null,
        isDisposed: false,
      }
      this.activeWatchers.set(clientSubId, intent)

      const unwatchFn = async (): Promise<boolean> => {
        if (intent.isDisposed) return false
        intent.isDisposed = true
        this.activeWatchers.delete(clientSubId)

        const binding = intent.nativeSubscription
        intent.nativeSubscription = null
        if (binding?.generation === this.hostGeneration && this.status === 'ready') {
          this.nativeToClientSubMap.delete(binding.id)
          const res = await this.sendRequestInternal<{ unwatched: boolean }>(
            'watcher/unwatch',
            { subscriptionId: binding.id },
            this.options.requestTimeoutMs ?? 5_000,
            binding.generation,
          ).catch(() => ({ unwatched: false }))
          return res.unwatched
        }
        return true
      }

      try {
        if (this.status === 'uninitialized') {
          await this.connect()
        } else if (this.status === 'reconnecting' || this.connectPromise) {
          await this.waitForReady()
        }
        const generation = this.hostGeneration
        const res = await this.sendRequestInternal<{ subscriptionId: number }>(
          'watcher/watch',
          { containerPath },
          this.options.requestTimeoutMs ?? 5_000,
          generation,
        )

        if (intent.isDisposed) {
          this.unboundWatcherInvalidations.delete(res.subscriptionId)
          if (generation === this.hostGeneration && this.status === 'ready') {
            await this.sendRequestInternal<{ unwatched: boolean }>(
              'watcher/unwatch',
              { subscriptionId: res.subscriptionId },
              1_000,
              generation,
            ).catch(() => {})
          }
          return {
            subscriptionId: clientSubId,
            unwatch: unwatchFn,
            rearm: () => Promise.resolve(false),
            getStats: () => Promise.resolve({ containerEventCount: 0, isInvalidated: false, isAlive: false }),
          }
        }

        if (generation !== this.hostGeneration || this.status !== 'ready') {
          return {
            subscriptionId: clientSubId,
            unwatch: unwatchFn,
            rearm: () => Promise.resolve(false),
            getStats: () => Promise.resolve({ containerEventCount: 0, isInvalidated: true, isAlive: false }),
          }
        }
        this.bindNativeWatcher(intent, { id: res.subscriptionId, generation })
      } catch (err) {
        if (!this.isReconnecting && this.status !== 'reconnecting') {
          this.activeWatchers.delete(clientSubId)
          throw err
        }
      }

      return {
        subscriptionId: clientSubId,
        unwatch: unwatchFn,
        rearm: () => this.watcher.rearm(clientSubId),
        getStats: () => this.watcher.getStats(clientSubId),
      }
    },
    rearm: async (subscriptionId: number): Promise<boolean> => {
      if (this.status === 'uninitialized') {
        await this.connect()
      } else if (this.status === 'reconnecting' || this.connectPromise) {
        await this.waitForReady()
      }
      const intent = this.activeWatchers.get(subscriptionId)
      const binding = intent?.nativeSubscription
      if (!binding || binding.generation !== this.hostGeneration) return false
      const res = await this.sendRequestInternal<{ rearmed: boolean }>(
        'watcher/rearm',
        { subscriptionId: binding.id },
        this.options.requestTimeoutMs ?? 5_000,
        binding.generation,
      ).catch(() => ({ rearmed: false }))
      return res.rearmed
    },
    getStats: async (
      subscriptionId: number,
    ): Promise<{ containerEventCount: number; isInvalidated: boolean; isAlive: boolean }> => {
      if (this.status === 'uninitialized') {
        await this.connect()
      } else if (this.status === 'reconnecting' || this.connectPromise) {
        await this.waitForReady()
      }
      const intent = this.activeWatchers.get(subscriptionId)
      const binding = intent?.nativeSubscription
      if (!binding || binding.generation !== this.hostGeneration) {
        return { containerEventCount: 0, isInvalidated: true, isAlive: false }
      }
      return this.sendRequestInternal<{ containerEventCount: number; isInvalidated: boolean; isAlive: boolean }>(
        'watcher/getStats',
        { subscriptionId: binding.id },
        this.options.requestTimeoutMs ?? 5_000,
        binding.generation,
      )
    },
  }

  /** Process Launch domain facade. */
  readonly process = {
    launchWin32: (spec: NativeWin32LaunchParams): Promise<ProcessLaunchResult> => {
      return this.sendRequest<ProcessLaunchResult>('process/launchWin32', spec)
    },
    launchPackaged: (spec: NativePackagedLaunchParams): Promise<ProcessLaunchResult> => {
      return this.sendRequest<ProcessLaunchResult>('process/launchPackaged', spec)
    },
  }

  /** Process-wide Windows Context facade with declarative restoration across host restarts. */
  readonly windowsContext = {
    getSnapshot: (): Promise<NativeWindowsContextSnapshot> => {
      return this.sendRequest<NativeWindowsContextSnapshot>('windowsContext/getSnapshot')
    },
    start: async (
      onEvent: (event: NativeWindowsContextChange) => void,
      onFault?: (error: NativeBridgeError) => void,
    ): Promise<NativeWindowsContextSubscription> => {
      let intent = this.windowsContextIntent
      if (!intent) {
        intent = {
          listeners: new Set(),
          faultListeners: new Set(),
          nativeGeneration: null,
          lastNativeRevision: 0,
          hasObserved: false,
          recoveryPending: false,
        }
        this.windowsContextIntent = intent
      }
      intent.listeners.add(onEvent)
      if (onFault) intent.faultListeners.add(onFault)
      const subscriptionState = { disposed: false }
      const dispose = async (): Promise<boolean> => {
        if (subscriptionState.disposed) return false
        subscriptionState.disposed = true
        intent.listeners.delete(onEvent)
        if (onFault) intent.faultListeners.delete(onFault)
        if (intent.listeners.size > 0) return true
        if (this.windowsContextIntent === intent) this.windowsContextIntent = null
        if (intent.nativeGeneration === this.hostGeneration && this.status === 'ready') {
          return this.sendRequestInternal<{ stopped: boolean }>(
            'windowsContext/stop',
            {},
            this.options.requestTimeoutMs ?? 5_000,
            intent.nativeGeneration,
          ).then(result => result.stopped).catch(() => false)
        }
        return true
      }

      try {
        if (this.status === 'uninitialized') {
          await this.connect()
        } else if (this.status === 'reconnecting' || this.connectPromise) {
          await this.waitForReady()
        }
        if (subscriptionState.disposed) return { dispose }
        if (intent.nativeGeneration !== this.hostGeneration) {
          await this.restoreWindowsContext(this.hostGeneration)
        }
      } catch (error) {
        intent.listeners.delete(onEvent)
        if (onFault) intent.faultListeners.delete(onFault)
        if (intent.listeners.size === 0 && this.windowsContextIntent === intent) {
          this.windowsContextIntent = null
        }
        throw error
      }
      return { dispose }
    },
    refresh: async (): Promise<NativeWindowsContextSnapshot> => {
      if (this.status === 'uninitialized') await this.connect()
      if (this.status === 'reconnecting' || this.connectPromise) await this.waitForReady()
      const snapshot = await this.sendRequest<NativeWindowsContextSnapshot>('windowsContext/refresh')
      this.deliverWindowsContextEvent({ reason: 'refresh', snapshot }, this.hostGeneration)
      return snapshot
    },
    getStatus: (): Promise<NativeWindowsContextStatus> => {
      return this.sendRequest<NativeWindowsContextStatus>('windowsContext/status')
    },
  }

  /** Process-wide Window Registry facade with declarative restoration across host restarts. */
  readonly windowRegistry = {
    getSnapshot: (): Promise<NativeWindowRegistrySnapshot> => {
      return this.sendRequest<NativeWindowRegistrySnapshot>('windowRegistry/getSnapshot')
    },
    start: async (
      onEvent: (event: NativeWindowRegistryChange) => void,
      onFault?: (error: NativeBridgeError) => void,
    ): Promise<NativeWindowRegistrySubscription> => {
      let intent = this.windowRegistryIntent
      if (!intent) {
        intent = {
          listeners: new Set(),
          faultListeners: new Set(),
          nativeGeneration: null,
          lastNativeRevision: 0,
          hasObserved: false,
          recoveryPending: false,
        }
        this.windowRegistryIntent = intent
      }
      intent.listeners.add(onEvent)
      if (onFault) intent.faultListeners.add(onFault)
      const subscriptionState = { disposed: false }
      const dispose = async (): Promise<boolean> => {
        if (subscriptionState.disposed) return false
        subscriptionState.disposed = true
        intent.listeners.delete(onEvent)
        if (onFault) intent.faultListeners.delete(onFault)
        if (intent.listeners.size > 0) return true
        if (this.windowRegistryIntent === intent) this.windowRegistryIntent = null
        if (intent.nativeGeneration === this.hostGeneration && this.status === 'ready') {
          return this.sendRequestInternal<{ stopped: boolean }>(
            'windowRegistry/stop',
            {},
            this.options.requestTimeoutMs ?? 5_000,
            intent.nativeGeneration,
          ).then(result => result.stopped).catch(() => false)
        }
        return true
      }

      try {
        if (this.status === 'uninitialized') {
          await this.connect()
        } else if (this.status === 'reconnecting' || this.connectPromise) {
          await this.waitForReady()
        }
        if (subscriptionState.disposed) return { dispose }
        if (intent.nativeGeneration !== this.hostGeneration) {
          await this.restoreWindowRegistry(this.hostGeneration)
        }
      } catch (error) {
        intent.listeners.delete(onEvent)
        if (onFault) intent.faultListeners.delete(onFault)
        if (intent.listeners.size === 0 && this.windowRegistryIntent === intent) {
          this.windowRegistryIntent = null
        }
        throw error
      }
      return { dispose }
    },
    refresh: async (): Promise<NativeWindowRegistrySnapshot> => {
      if (this.status === 'uninitialized') await this.connect()
      if (this.status === 'reconnecting' || this.connectPromise) await this.waitForReady()
      const snapshot = await this.sendRequest<NativeWindowRegistrySnapshot>('windowRegistry/refresh')
      this.deliverWindowRegistryEvent({ reason: 'refresh', snapshot }, this.hostGeneration)
      return snapshot
    },
    getStatus: (): Promise<NativeWindowRegistryStatus> => {
      return this.sendRequest<NativeWindowRegistryStatus>('windowRegistry/status')
    },
    testFailNextStart: (message?: string): Promise<{ armed: boolean }> => {
      return this.sendRequest<{ armed: boolean }>('windowRegistry/testFailNextStart', { message })
    },
    testFailRuntime: (message?: string): Promise<{ simulated: boolean }> => {
      return this.sendRequest<{ simulated: boolean }>('windowRegistry/testFailRuntime', { message })
    },
  }

  /** Liveness ping returning server epoch milliseconds. */
  ping(): Promise<number> {
    return this.sendRequest<{ timestamp: number }>('bridge/ping').then(r => r.timestamp)
  }

  /** Forces native host process to crash for supervisor testing. */
  async crashHost(): Promise<void> {
    await this.sendRequest('bridge/crash').catch(() => {})
  }

  /** Simulates container saturation and invalidation for testing. */
  async simulateOverflow(subscriptionId: number): Promise<boolean> {
    if (this.status === 'uninitialized') {
      await this.connect()
    } else if (this.status === 'reconnecting' || this.connectPromise) {
      await this.waitForReady()
    }
    const intent = this.activeWatchers.get(subscriptionId)
    const binding = intent?.nativeSubscription
    if (!binding || binding.generation !== this.hostGeneration) return false
    const res = await this.sendRequestInternal<{ overflowSimulated: boolean }>(
      'watcher/simulateOverflow',
      { subscriptionId: binding.id },
      this.options.requestTimeoutMs ?? 5_000,
      binding.generation,
    ).catch(() => ({ overflowSimulated: false }))
    return res.overflowSimulated
  }

  /** Native Surface domain facade. */
  readonly surface = {
    create: async (spec: NativeSurfaceCreateOptions): Promise<NativeSurfaceSnapshot> => {
      const snapshot = await this.sendRequest<NativeSurfaceSnapshot>('surface/create', spec)
      this.activeSurfaces.set(spec.id, {
        id: spec.id,
        spec,
        visible: spec.visible ?? false,
        lastBounds: spec.bounds,
        lastZOrder: spec.zOrderPolicy ?? 'normal',
        isDisposed: false,
      })
      return snapshot
    },
    show: async (id: string): Promise<NativeSurfaceSnapshot> => {
      const snapshot = await this.sendRequest<NativeSurfaceSnapshot>('surface/show', { id })
      const intent = this.activeSurfaces.get(id)
      if (intent) intent.visible = true
      return snapshot
    },
    hide: async (id: string): Promise<NativeSurfaceSnapshot> => {
      const snapshot = await this.sendRequest<NativeSurfaceSnapshot>('surface/hide', { id })
      const intent = this.activeSurfaces.get(id)
      if (intent) intent.visible = false
      return snapshot
    },
    setBounds: async (id: string, bounds: NativePhysicalBounds): Promise<NativeSurfaceSnapshot> => {
      const snapshot = await this.sendRequest<NativeSurfaceSnapshot>('surface/setBounds', { id, bounds })
      const intent = this.activeSurfaces.get(id)
      if (intent) intent.lastBounds = bounds
      return snapshot
    },
    setZOrder: async (id: string, zOrderPolicy: NativeSurfaceZOrderPolicy): Promise<NativeSurfaceSnapshot> => {
      const snapshot = await this.sendRequest<NativeSurfaceSnapshot>('surface/setZOrder', {
        id,
        policy: zOrderPolicy,
        zOrderPolicy,
      })
      const intent = this.activeSurfaces.get(id)
      if (intent) intent.lastZOrder = zOrderPolicy
      return snapshot
    },
    navigate: async (id: string, url: string): Promise<NativeSurfaceSnapshot> => {
      const snapshot = await this.sendRequest<NativeSurfaceSnapshot>('surface/navigate', {
        id,
        url,
        renderer: { type: 'url', target: url },
      })
      const intent = this.activeSurfaces.get(id)
      if (intent) intent.spec = { ...intent.spec, renderer: { type: 'url', target: url } }
      return snapshot
    },
    reload: (id: string): Promise<NativeSurfaceSnapshot> => {
      return this.sendRequest<NativeSurfaceSnapshot>('surface/reload', { id })
    },
    markReady: (id: string): Promise<NativeSurfaceSnapshot> => {
      return this.sendRequest<NativeSurfaceSnapshot>('surface/markReady', { id })
    },
    destroy: async (id: string): Promise<boolean> => {
      const intent = this.activeSurfaces.get(id)
      if (intent) {
        intent.isDisposed = true
        this.activeSurfaces.delete(id)
      }
      const res = await this.sendRequest<{ destroyed: boolean }>('surface/destroy', { id })
      return res.destroyed
    },
    query: (id: string): Promise<NativeSurfaceSnapshot> => {
      return this.sendRequest<NativeSurfaceSnapshot>('surface/query', { id })
    },
    getFocusState: (id: string): Promise<NativeSurfaceFocusState> => {
      return this.sendRequest<NativeSurfaceFocusState>('surface/getFocusState', { id })
    },
    getForegroundHwnd: async (): Promise<{ readonly hwnd: number }> => {
      return this.sendRequest<{ readonly hwnd: number }>('surface/getForegroundHwnd')
    },
    list: async (): Promise<readonly NativeSurfaceSnapshot[]> => {
      const res = await this.sendRequest<readonly NativeSurfaceSnapshot[] | { surfaces: readonly NativeSurfaceSnapshot[] }>('surface/list')
      if ('surfaces' in res) return res.surfaces
      return res
    },
    runtimeStatus: (): Promise<{ available: boolean; version?: string | undefined }> => {
      return this.sendRequest<{ available: boolean; version?: string | undefined }>('surface/runtimeStatus')
    },
    postMessage: async (id: string, message: unknown): Promise<boolean> => {
      const msgStr = typeof message === 'string' ? message : JSON.stringify(message)
      const res = await this.sendRequest<{ posted: boolean }>('surface/postMessage', { id, message: msgStr })
      return res.posted
    },
    onEvent: (listener: (event: NativeSurfaceEvent) => void): NativeSurfaceSubscription => {
      this.surfaceEventListeners.add(listener)
      let disposed = false
      return {
        dispose: (): Promise<boolean> => {
          if (disposed) return Promise.resolve(false)
          disposed = true
          this.surfaceEventListeners.delete(listener)
          return Promise.resolve(true)
        },
      }
    },
  }

  /** Native AppBar domain facade for Windows desktop work-area reservations. */
  readonly appBar = {
    register: async (spec: NativeAppBarSpec): Promise<NativePhysicalPixelRect> => {
      return this.sendRequest<NativePhysicalPixelRect>('appBar/register', spec)
    },
    unregister: async (id: string): Promise<boolean> => {
      const res = await this.sendRequest<{ unregistered: boolean }>('appBar/unregister', { id })
      return res.unregistered
    },
    getRegistered: async (): Promise<readonly NativeRegisteredAppBar[]> => {
      return this.sendRequest<readonly NativeRegisteredAppBar[]>('appBar/getRegistered')
    },
  }
}
