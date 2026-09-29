import type {
  NativeProcessEntry,
  NativeProcessSnapshot,
  ProcessEntry,
  ProcessIdentity,
  ProcessObservationChange,
  ProcessObservationSnapshot,
} from './types.ts'

export const EMPTY_PROCESS_OBSERVATION_SNAPSHOT: ProcessObservationSnapshot = Object.freeze({
  revision: 0,
  processes: Object.freeze([]),
  capturedAt: 0,
})

/** Pure process snapshot projector/differ used by the polling service and deterministic tests. */
export class ProcessObservationState {
  private snapshot = EMPTY_PROCESS_OBSERVATION_SNAPSHOT
  private initialized = false

  getSnapshot(): ProcessObservationSnapshot {
    return this.snapshot
  }

  apply(native: NativeProcessSnapshot): ProcessObservationChange | undefined {
    const projected = native.processes
      .map(process => projectProcess(process, native.capturedAt))
      .sort(compareProcesses)
    const previous = this.snapshot.processes
    const previousByKey = new Map(previous.map(process => [process.identityKey, process] as const))
    const nextByKey = new Map(projected.map(process => [process.identityKey, process] as const))

    const started = projected.filter(process => !previousByKey.has(process.identityKey))
    const exited = previous.filter(process => !nextByKey.has(process.identityKey))
    const updated = projected.filter((process) => {
      const prior = previousByKey.get(process.identityKey)
      return prior !== undefined && !sameProcessFacts(prior, process)
    })

    if (this.initialized && started.length === 0 && exited.length === 0 && updated.length === 0) {
      return undefined
    }

    const snapshot: ProcessObservationSnapshot = Object.freeze({
      revision: this.snapshot.revision + 1,
      processes: Object.freeze(projected),
      capturedAt: sanitizeTimestamp(native.capturedAt),
    })
    const change: ProcessObservationChange = Object.freeze({
      reason: this.initialized ? 'changed' : 'initial',
      snapshot,
      started: Object.freeze([...started]),
      exited: Object.freeze([...exited]),
      updated: Object.freeze([...updated]),
    })
    this.snapshot = snapshot
    this.initialized = true
    return change
  }
}

export function processIdentityKey(identity: ProcessIdentity): string {
  const pid = sanitizePid(identity.pid)
  const creationTime = sanitizeCreationTime(identity.creationTime)
  return creationTime > 0 ? `${pid}:${creationTime}` : `${pid}:unknown`
}

function projectProcess(native: NativeProcessEntry, capturedAt: number): ProcessEntry {
  const pid = sanitizePid(native.processId)
  const creationTime = sanitizeCreationTime(native.processCreationTime)
  const identity = Object.freeze({ pid, creationTime })
  return Object.freeze({
    identity,
    identityKey: processIdentityKey(identity),
    identityQuality: creationTime > 0 ? 'stable' : 'pid-only',
    parentPid: sanitizePid(native.parentProcessId),
    ...(cleanString(native.executablePath) ? { executablePath: cleanString(native.executablePath) } : {}),
    ...(cleanString(native.executableName) ? { executableName: cleanString(native.executableName) } : {}),
    ...(cleanString(native.packageFullName) ? { packageFullName: cleanString(native.packageFullName) } : {}),
    ...(cleanString(native.aumid) ? { aumid: cleanString(native.aumid) } : {}),
    observedAt: sanitizeTimestamp(capturedAt),
  })
}

function sameProcessFacts(left: ProcessEntry, right: ProcessEntry): boolean {
  return left.parentPid === right.parentPid
    && left.executablePath === right.executablePath
    && left.executableName === right.executableName
    && left.packageFullName === right.packageFullName
    && left.aumid === right.aumid
    && left.identityQuality === right.identityQuality
}

function compareProcesses(left: ProcessEntry, right: ProcessEntry): number {
  return left.identity.pid - right.identity.pid
    || left.identity.creationTime - right.identity.creationTime
    || left.identityKey.localeCompare(right.identityKey)
}

function sanitizePid(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function sanitizeCreationTime(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0
}

function sanitizeTimestamp(value: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : Date.now()
}

function cleanString(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  return normalized ? normalized : undefined
}
