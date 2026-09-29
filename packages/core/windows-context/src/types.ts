/** Public state types for the authoritative Windows Context service. */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Stable/best-effort identity derived from Windows DisplayConfig target identity. */
export type MonitorId = Branded<'MonitorId'>

/** Coordinates and dimensions in virtual-screen physical pixels. */
export interface PhysicalPixelRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Immutable description of one connected Windows monitor. */
export interface WindowsMonitor {
  readonly id: MonitorId
  readonly deviceName: string
  readonly friendlyName?: string | undefined
  readonly bounds: PhysicalPixelRect
  readonly workArea: PhysicalPixelRect
  readonly dpiX: number
  readonly dpiY: number
  readonly scaleFactor: number
  readonly isPrimary: boolean
  readonly connector?: string | undefined
}

/** Transient state for the current foreground application window. */
export interface ForegroundWindowContext {
  /** Opaque HWND-derived value scoped to the current native-host session. */
  readonly nativeId: string
  readonly processId: number
  readonly threadId: number
  readonly monitorId: MonitorId
  readonly bounds: PhysicalPixelRect
  readonly isVisible: true
  readonly isMinimized: false
  readonly isCloaked: false
  readonly isToolWindow: false
  readonly isShellWindow: false
  readonly isFullscreen: boolean
  readonly fullscreenReason?: string | undefined
}

/** One coherent immutable monitor and foreground context revision. */
export interface WindowsContextSnapshot {
  readonly revision: number
  readonly monitors: readonly WindowsMonitor[]
  readonly primaryMonitorId: MonitorId
  readonly foreground: ForegroundWindowContext | null
  readonly capturedAt: number
}

/** Consumer-visible cause of a complete snapshot replacement. */
export type WindowsContextChangeReason =
  | 'initial'
  | 'topology'
  | 'dpi'
  | 'work-area'
  | 'foreground'
  | 'foreground-geometry'
  | 'fullscreen'
  | 'refresh'
  | 'recovered'

/** Complete snapshot notification emitted after a successful atomic replacement. */
export interface WindowsContextChange {
  readonly revision: number
  readonly reason: WindowsContextChangeReason
  readonly snapshot: WindowsContextSnapshot
}

/** Failure that left the previous known-good snapshot intact. */
export interface WindowsContextFault {
  readonly error: Error
  readonly snapshot: WindowsContextSnapshot | null
}

/** Read and observation operations exposed by `ctx.windowsContext`. */
export interface WindowsContextSource {
  getSnapshot(): WindowsContextSnapshot
  getMonitors(): readonly WindowsMonitor[]
  getMonitor(id: MonitorId): WindowsMonitor | undefined
  getPrimaryMonitor(): WindowsMonitor
  getForegroundContext(): ForegroundWindowContext | null
  refresh(): Promise<WindowsContextSnapshot>
  subscribe(listener: (change: WindowsContextChange) => void): () => void
}

/** Construction-only service options used for native bridge injection in tests. */
export interface WindowsContextConfig {
  readonly enabled: boolean
  readonly bridge?: import('@deepseek-ai/dsh-native-core').NativeBridgeClient | undefined
}
