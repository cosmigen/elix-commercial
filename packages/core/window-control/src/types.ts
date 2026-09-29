/** Public contracts for the authoritative ELIX Window Control service. */

import type { NativeBridgeClient } from '@deepseek-ai/dsh-native-core'
import type { WindowId } from '@deepseek-ai/dsh-window-registry'
import type { MonitorId, PhysicalPixelRect } from '@deepseek-ai/dsh-windows-context'

/** Primitive native command supported by Phase 14. */
export type WindowControlAction =
  | 'activate'
  | 'minimize'
  | 'maximize'
  | 'restore'
  | 'close'
  | 'setBounds'

/** Lifetime evidence passed to the native boundary for immediate HWND revalidation. */
export interface NativeWindowControlTarget {
  readonly hwnd: number
  readonly processId: number
  readonly threadId: number
  /** Raw Win32 FILETIME ticks from GetProcessTimes. Zero means unavailable. */
  readonly processCreationTime: number
  readonly className?: string | undefined
}

/** Immediate native observation following a command. */
export interface WindowControlObservation {
  readonly exists: boolean
  readonly visible: boolean
  readonly minimized: boolean
  readonly maximized: boolean
  readonly foreground: boolean
  readonly bounds?: PhysicalPixelRect | undefined
}

/**
 * Guarded native sizing/visible-frame evidence used by Phase 17B placement negotiation.
 *
 * Track dimensions are optional because the native layer may only be able to establish
 * structural resizability plus visible-frame geometry without synchronously interrogating
 * a potentially hung foreign UI thread. Application-specific sizing that is not available
 * here is still observed after mutation and reported as adjusted/refused placement.
 */
export interface WindowPlacementConstraints {
  /** Whether the target exposes a Win32 sizing frame (WS_THICKFRAME/WS_SIZEBOX). */
  readonly resizable: boolean
  readonly minTrackWidth?: number | undefined
  readonly minTrackHeight?: number | undefined
  readonly maxTrackWidth?: number | undefined
  readonly maxTrackHeight?: number | undefined
  /** Current DWM extended-frame bounds used by Registry/Window Control geometry contracts. */
  readonly visibleBounds: PhysicalPixelRect
  /** True only when application-specific min/max information was actually observed. */
  readonly appConstraintsObserved: boolean
}

/** Result returned to callers after the native operation is accepted. */
export interface WindowControlResult {
  readonly windowId: WindowId
  readonly action: WindowControlAction
  readonly hwnd: number
  readonly accepted: boolean
  /** True only if the requested effect was observed inside the bounded native confirmation window. */
  readonly completed: boolean
  readonly observation: WindowControlObservation
}

/** Positioning policy when moving a restored window to another monitor. */
export interface MoveToMonitorOptions {
  readonly placement?: 'preserve-offset' | 'center' | undefined
}

/** Public WindowId-based command surface. */
export interface WindowControlSource {
  activate(windowId: WindowId): Promise<WindowControlResult>
  minimize(windowId: WindowId): Promise<WindowControlResult>
  maximize(windowId: WindowId): Promise<WindowControlResult>
  restore(windowId: WindowId): Promise<WindowControlResult>
  close(windowId: WindowId): Promise<WindowControlResult>
  setBounds(windowId: WindowId, bounds: PhysicalPixelRect): Promise<WindowControlResult>
  move(windowId: WindowId, x: number, y: number): Promise<WindowControlResult>
  resize(windowId: WindowId, width: number, height: number): Promise<WindowControlResult>
  moveToMonitor(
    windowId: WindowId,
    monitorId: MonitorId,
    options?: MoveToMonitorOptions,
  ): Promise<WindowControlResult>
  /** Query guarded native sizing/visible-frame constraints without mutating the target. */
  getPlacementConstraints(windowId: WindowId): Promise<WindowPlacementConstraints>
}

/** Construction-only service options. */
export interface WindowControlConfig {
  readonly enabled: boolean
  readonly bridge?: NativeBridgeClient | undefined
}

/** Stable machine-readable precondition failure raised before native dispatch. */
export class WindowControlError extends Error {
  readonly code: string
  readonly retryable: boolean

  constructor(code: string, message: string, retryable = false) {
    super(message)
    this.name = 'WindowControlError'
    this.code = code
    this.retryable = retryable
  }
}
