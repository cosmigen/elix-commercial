/** Authoritative raw Windows process fact/lifecycle service for ELIX Phase 16D. */

import { Context, Service } from '@deepseek-ai/cordis'
import { getSharedNativeBridge } from '@deepseek-ai/dsh-native-core'
import z from '@deepseek-ai/schemastery'
import {
  EMPTY_PROCESS_OBSERVATION_SNAPSHOT,
  ProcessObservationState,
  processIdentityKey,
} from './state.ts'
import type {
  NativeProcessSnapshot,
  ProcessEntry,
  ProcessIdentity,
  ProcessObservationChange,
  ProcessObservationConfig,
  ProcessObservationSnapshot,
  ProcessObservationSource,
} from './types.ts'

export * from './types.ts'
export * from './state.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    processObservation: ProcessObservationService
  }
  interface Events {
    /** @mode broadcast @param service Initialized raw Process Observation authority. */
    'process-observation/ready'(service: ProcessObservationService): void
    /** @mode broadcast @param change Atomic raw process lifecycle replacement/delta. */
    'process-observation/change'(change: ProcessObservationChange): void
    /** @mode broadcast @param error Native capture failure; last good process snapshot remains valid. */
    'process-observation/fault'(error: Error): void
  }
}

/** Polling raw-process authority. It never launches, kills, or assigns AppIds. */
export class ProcessObservationService extends Service implements ProcessObservationSource {
  static Config = z.object({
    enabled: z.boolean().default(true),
    pollIntervalMs: z.number().default(1000),
  })

  private readonly config: ProcessObservationConfig
  private readonly state = new ProcessObservationState()
  private readonly listeners = new Set<(change: ProcessObservationChange) => void>()
  private refreshPromise: Promise<ProcessObservationSnapshot> | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private _ready = false
  private readonly lifecycle = { isDisposed: false }

  constructor(ctx: Context, config?: Partial<ProcessObservationConfig>) {
    super(ctx, 'processObservation')
    const pollIntervalMs = config?.pollIntervalMs ?? 1000
    if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 250) {
      throw new RangeError('Process Observation pollIntervalMs must be at least 250ms.')
    }
    this.config = {
      enabled: config?.enabled ?? true,
      pollIntervalMs: Math.trunc(pollIntervalMs),
      ...(config?.bridge === undefined ? {} : { bridge: config.bridge }),
      ...(config?.snapshotProvider === undefined ? {} : { snapshotProvider: config.snapshotProvider }),
    }
  }

  async [Service.init](): Promise<void> {
    if (!this.config.enabled) return

    this.ctx.effect(() => async () => {
      this.lifecycle.isDisposed = true
      if (this.timer !== null) clearInterval(this.timer)
      this.timer = null
      const refresh = this.refreshPromise
      await refresh?.catch(() => {})
      this.listeners.clear()
      this._ready = false
    }, 'processObservation.lifecycle')

    await this.refresh()
    if (this.lifecycle.isDisposed) return
    this._ready = true
    this.ctx.emit('process-observation/ready', this)

    this.timer = setInterval(() => {
      void this.refresh().catch((error: unknown) => {
        if (this.lifecycle.isDisposed) return
        this.ctx.emit(
          'process-observation/fault',
          error instanceof Error ? error : new Error(String(error)),
        )
      })
    }, this.config.pollIntervalMs)
  }

  get ready(): boolean {
    return this._ready && !this.lifecycle.isDisposed
  }

  getSnapshot(): ProcessObservationSnapshot {
    return this.state.getSnapshot()
  }

  getProcesses(): readonly ProcessEntry[] {
    return this.getSnapshot().processes
  }

  getProcess(identity: ProcessIdentity): ProcessEntry | undefined {
    const key = processIdentityKey(identity)
    return this.getProcesses().find(process => process.identityKey === key)
  }

  getProcessByPid(pid: number): ProcessEntry | undefined {
    return this.getProcesses().find(process => process.identity.pid === pid)
  }

  refresh(): Promise<ProcessObservationSnapshot> {
    if (!this.config.enabled) return Promise.resolve(EMPTY_PROCESS_OBSERVATION_SNAPSHOT)
    if (this.lifecycle.isDisposed) {
      return Promise.reject(new Error('Process Observation service is disposed.'))
    }
    if (this.refreshPromise !== null) return this.refreshPromise

    const operation = this.captureAndCommit().finally(() => {
      if (this.refreshPromise === operation) this.refreshPromise = null
    })
    this.refreshPromise = operation
    return operation
  }

  subscribe(listener: (change: ProcessObservationChange) => void): () => void {
    if (this.lifecycle.isDisposed) throw new Error('Process Observation service is disposed.')
    this.listeners.add(listener)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      this.listeners.delete(listener)
    }
  }

  private async captureAndCommit(): Promise<ProcessObservationSnapshot> {
    const native = await this.captureNativeSnapshot()
    if (this.lifecycle.isDisposed) return this.state.getSnapshot()
    const change = this.state.apply(native)
    if (change === undefined) return this.state.getSnapshot()

    for (const listener of [...this.listeners]) {
      try {
        listener(change)
      } catch (_listenerError) {
        // A consumer cannot corrupt the process authority or prevent other listeners.
      }
    }
    this.ctx.emit('process-observation/change', change)
    return change.snapshot
  }

  private captureNativeSnapshot(): Promise<NativeProcessSnapshot> {
    if (this.config.snapshotProvider !== undefined) return this.config.snapshotProvider()
    const bridge = this.config.bridge ?? getSharedNativeBridge()
    return bridge.sendRequest<NativeProcessSnapshot>('process/getSnapshot')
  }
}

export default ProcessObservationService
