/** Immutable Windows Context normalization and revision state machine. */

import type {
  NativeForegroundWindowContext,
  NativeWindowsContextChange,
  NativeWindowsContextSnapshot,
  NativeWindowsMonitor,
} from '@deepseek-ai/dsh-native-core'
import type {
  ForegroundWindowContext,
  MonitorId,
  PhysicalPixelRect,
  WindowsContextChange,
  WindowsContextSnapshot,
  WindowsMonitor,
} from './types.ts'

/** Normalizes wire data before it becomes public Windows Context state. */
export function normalizeNativeSnapshot(
  input: NativeWindowsContextSnapshot,
  revision: number,
): WindowsContextSnapshot {
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) {
    throw new TypeError('Native Windows Context revision must be a positive safe integer.')
  }
  if (!Number.isFinite(input.capturedAt) || input.capturedAt < 0) {
    throw new TypeError('Native Windows Context capturedAt must be a non-negative number.')
  }
  if (!Array.isArray(input.monitors) || input.monitors.length === 0) {
    throw new TypeError('Native Windows Context must contain at least one monitor.')
  }
  const monitors = input.monitors.map(normalizeMonitor)
  const ids = new Set(monitors.map(monitor => monitor.id))
  if (ids.size !== monitors.length) {
    throw new TypeError('Native Windows Context contains duplicate monitor IDs.')
  }
  const primaries = monitors.filter(monitor => monitor.isPrimary)
  const primary = primaries[0]
  if (!primary || primaries.length !== 1 || input.primaryMonitorId !== primary.id) {
    throw new TypeError('Native Windows Context must identify exactly one matching primary monitor.')
  }
  const foreground = input.foreground === undefined || input.foreground === null
    ? null
    : normalizeForeground(input.foreground, ids)
  return Object.freeze({
    revision,
    monitors: Object.freeze(monitors),
    primaryMonitorId: primary.id,
    foreground,
    capturedAt: input.capturedAt,
  })
}

function normalizeMonitor(input: NativeWindowsMonitor): WindowsMonitor {
  if (typeof input.id !== 'string' || !input.id.startsWith('monitor:')) {
    throw new TypeError('Native monitor ID is invalid.')
  }
  if (typeof input.deviceName !== 'string' || input.deviceName.length === 0) {
    throw new TypeError('Native monitor deviceName is required.')
  }
  const dpiX = positiveNumber(input.dpiX, 'dpiX')
  const dpiY = positiveNumber(input.dpiY, 'dpiY')
  const scaleFactor = positiveNumber(input.scaleFactor, 'scaleFactor')
  if (Math.abs(scaleFactor - dpiX / 96) > 0.000_001) {
    throw new TypeError('Native monitor scaleFactor must equal dpiX / 96.')
  }
  return Object.freeze({
    id: input.id,
    deviceName: input.deviceName,
    ...(input.friendlyName === undefined ? {} : { friendlyName: input.friendlyName }),
    bounds: normalizeRect(input.bounds),
    workArea: normalizeRect(input.workArea),
    dpiX,
    dpiY,
    scaleFactor,
    isPrimary: input.isPrimary,
    ...(input.connector === undefined ? {} : { connector: input.connector }),
  })
}

function normalizeForeground(
  input: NativeForegroundWindowContext,
  monitorIds: ReadonlySet<MonitorId>,
): ForegroundWindowContext {
  if (
    !input.monitorId ||
    !monitorIds.has(input.monitorId) ||
    !input.isVisible ||
    input.isMinimized ||
    input.isCloaked ||
    input.isToolWindow ||
    input.isShellWindow
  ) {
    throw new TypeError('Native foreground context contains a filtered or unknown window.')
  }
  if (!Number.isSafeInteger(input.processId) || input.processId < 0) {
    throw new TypeError('Native foreground processId is invalid.')
  }
  if (!Number.isSafeInteger(input.threadId) || input.threadId < 0) {
    throw new TypeError('Native foreground threadId is invalid.')
  }
  return Object.freeze({
    nativeId: input.nativeId,
    processId: input.processId,
    threadId: input.threadId,
    monitorId: input.monitorId,
    bounds: normalizeRect(input.bounds),
    isVisible: true,
    isMinimized: false,
    isCloaked: false,
    isToolWindow: false,
    isShellWindow: false,
    isFullscreen: input.isFullscreen,
    ...(input.fullscreenReason === undefined ? {} : { fullscreenReason: input.fullscreenReason }),
  })
}

function normalizeRect(input: PhysicalPixelRect): PhysicalPixelRect {
  for (const [name, value] of Object.entries(input)) {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError(`Native physical rectangle ${name} must be a safe integer.`)
    }
  }
  if (input.width <= 0 || input.height <= 0) {
    throw new TypeError('Native physical rectangle dimensions must be positive.')
  }
  return Object.freeze({ x: input.x, y: input.y, width: input.width, height: input.height })
}

function positiveNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`Native monitor ${name} must be positive.`)
  }
  return value
}

/** Owns normalized snapshots and isolates consumer callbacks. */
export class WindowsContextState {
  private snapshot: WindowsContextSnapshot | null = null
  private readonly listeners = new Set<(change: WindowsContextChange) => void>()
  /** Native revision fence for the current observer/host generation. */
  private lastNativeRevision = 0

  /** Returns the current snapshot or fails before successful initialization. */
  getSnapshot(): WindowsContextSnapshot {
    if (!this.snapshot) throw new Error('Windows Context has not produced an initial snapshot.')
    return this.snapshot
  }

  /** Applies one validated native replacement and returns the consumer change if published. */
  apply(event: NativeWindowsContextChange): WindowsContextChange | null {
    const generationBoundary = event.reason === 'initial' || event.reason === 'recovered'
    if (!generationBoundary && event.snapshot.revision <= this.lastNativeRevision) {
      return null
    }

    const nextRevision = (this.snapshot?.revision ?? 0) + 1
    const next = normalizeNativeSnapshot(event.snapshot, nextRevision)

    // Only advance/reset the native fence after the incoming replacement validates. A recovered
    // observer may restart its native sequence, so recovery intentionally establishes a new base.
    this.lastNativeRevision = event.snapshot.revision

    const force = generationBoundary || event.reason === 'refresh'
    if (!force && this.snapshot && snapshotContent(this.snapshot) === snapshotContent(next)) return null
    this.snapshot = next
    const change = Object.freeze({
      revision: next.revision,
      reason: event.reason,
      snapshot: next,
    })
    for (const listener of this.listeners) {
      try {
        listener(change)
      } catch {
        // A consumer exception cannot prevent sibling listeners or future native changes.
      }
    }
    return change
  }

  /** Registers a listener and returns an idempotent disposer. */
  subscribe(listener: (change: WindowsContextChange) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}

function snapshotContent(snapshot: WindowsContextSnapshot): string {
  return JSON.stringify({
    monitors: snapshot.monitors,
    primaryMonitorId: snapshot.primaryMonitorId,
    foreground: snapshot.foreground,
  })
}
