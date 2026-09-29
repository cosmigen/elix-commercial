/** Raw process facts and lifecycle contracts for ELIX Phase 16D. */

import type { NativeBridgeClient } from '@deepseek-ai/dsh-native-core'

/** Native transport shape returned by process/getSnapshot. */
export interface NativeProcessEntry {
  readonly processId: number
  readonly parentProcessId: number
  /** Windows FILETIME creation timestamp. Zero means native access was unavailable. */
  readonly processCreationTime: number
  readonly executablePath?: string | undefined
  readonly executableName?: string | undefined
  readonly packageFullName?: string | undefined
  readonly aumid?: string | undefined
}

/** Native point-in-time process snapshot. */
export interface NativeProcessSnapshot {
  readonly processes: readonly NativeProcessEntry[]
  readonly capturedAt: number
}

/** PID + creation-time identity prevents a recycled PID from inheriting an old process identity. */
export interface ProcessIdentity {
  readonly pid: number
  readonly creationTime: number
}

/** Stable when creation time is available; PID-only is explicitly best-effort. */
export type ProcessIdentityQuality = 'stable' | 'pid-only'

/** One immutable raw process fact record. No AppId interpretation belongs here. */
export interface ProcessEntry {
  readonly identity: ProcessIdentity
  readonly identityKey: string
  readonly identityQuality: ProcessIdentityQuality
  readonly parentPid: number
  readonly executablePath?: string | undefined
  readonly executableName?: string | undefined
  readonly packageFullName?: string | undefined
  readonly aumid?: string | undefined
  readonly observedAt: number
}

/** Coherent immutable raw process snapshot. */
export interface ProcessObservationSnapshot {
  readonly revision: number
  readonly processes: readonly ProcessEntry[]
  readonly capturedAt: number
}

export type ProcessObservationChangeReason = 'initial' | 'changed'

/** One atomic replacement plus lifecycle delta from the previous snapshot. */
export interface ProcessObservationChange {
  readonly reason: ProcessObservationChangeReason
  readonly snapshot: ProcessObservationSnapshot
  readonly started: readonly ProcessEntry[]
  readonly exited: readonly ProcessEntry[]
  readonly updated: readonly ProcessEntry[]
}

export interface ProcessObservationSource {
  getSnapshot(): ProcessObservationSnapshot
  getProcesses(): readonly ProcessEntry[]
  getProcess(identity: ProcessIdentity): ProcessEntry | undefined
  getProcessByPid(pid: number): ProcessEntry | undefined
  refresh(): Promise<ProcessObservationSnapshot>
  subscribe(listener: (change: ProcessObservationChange) => void): () => void
}

export interface ProcessObservationConfig {
  readonly enabled: boolean
  /** Poll interval for raw process snapshots. Default 1000ms; minimum 250ms. */
  readonly pollIntervalMs: number
  /** Native bridge override for deterministic integration tests. */
  readonly bridge?: NativeBridgeClient | undefined
  /** Snapshot provider override for unit tests. */
  readonly snapshotProvider?: (() => Promise<NativeProcessSnapshot>) | undefined
}
