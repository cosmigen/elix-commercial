/**
 * Public state and event types for the authoritative ELIX Window Registry Core.
 *
 * @module @deepseek-ai/dsh-window-registry/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { NativeBridgeClient } from '@deepseek-ai/dsh-native-core'
import type { MonitorId, PhysicalPixelRect } from '@deepseek-ai/dsh-windows-context'
import type { WindowRegistryService } from './index.ts'

/** Unique, stable identity for a top-level Windows window across its continuous lifetime. */
export type WindowId = Branded<'WindowId'>

/**
 * Functional classification of a top-level window.
 *
 * - `APPLICATION`: Standard user application window (e.g. Chrome, VS Code, Notepad).
 * - `SHELL`: Windows OS desktop shell window (Taskbar, Desktop, Start Menu, System Tray).
 * - `ELIX_SURFACE`: ELIX managed surface window (registered in Surface Core).
 * - `TOOL`: Tool palettes, floating utility windows, tooltips (`WS_EX_TOOLWINDOW`).
 * - `TRANSIENT`: Dialog boxes, context menus, popup menus, combo dropdowns.
 * - `SYSTEM`: Windows background system infrastructure (IME, OleMainThread, SystemSettings).
 * - `IGNORED`: Invisible, cloaked, or zero-sized helper windows.
 */
export type WindowClassification =
  | 'APPLICATION'
  | 'SHELL'
  | 'ELIX_SURFACE'
  | 'TOOL'
  | 'TRANSIENT'
  | 'SYSTEM'
  | 'IGNORED'

/** Current visual window display state. */
export type WindowState = 'normal' | 'minimized' | 'maximized' | 'hidden'

/** Immutable snapshot of a single tracked top-level window. */
export interface WindowSnapshot {
  /** Stable window identity preserved across host restarts, never equal to HWND. */
  readonly id: WindowId
  /** Native Win32 window handle. */
  readonly hwnd: number
  /** Owning process identifier. */
  readonly processId: number
  /** Owning Win32 thread identifier. */
  readonly threadId: number
  /** Raw Win32 FILETIME process-creation ticks transported through the bridge as a number. */
  readonly processCreationTime: number
  /** Fully-qualified executable binary path on disk, if resolvable. */
  readonly executablePath?: string | undefined
  /** Base executable file name (e.g. "code.exe"). */
  readonly executableName?: string | undefined
  /** UWP / MSIX Package Full Name, if running in an app package. */
  readonly packageFullName?: string | undefined
  /** Application User Model ID (AUMID), if assigned. */
  readonly aumid?: string | undefined
  /** Current window title / caption text. */
  readonly title: string
  /** Win32 window class name. */
  readonly className: string
  /** Physical pixel bounding rectangle on the virtual desktop. */
  readonly bounds: PhysicalPixelRect
  /** Functional classification. */
  readonly classification: WindowClassification
  /** Current window presentation state. */
  readonly state: WindowState
  /** Associated monitor derived authoritatively from Windows Context, if any. */
  readonly monitorId?: MonitorId | undefined
  /** Whether the window has WS_VISIBLE style. */
  readonly isVisible: boolean
  /** Whether the window is currently minimized (iconic). */
  readonly isMinimized: boolean
  /** Whether the window is currently maximized (zoomed). */
  readonly isMaximized: boolean
  /** Whether the window is cloaked by DWM (e.g. virtual desktop or suspended UWP). */
  readonly isCloaked: boolean
  /** Whether the window has WS_EX_TOOLWINDOW style. */
  readonly isToolWindow: boolean
  /** Whether the window is a known Windows shell component. */
  readonly isShellWindow: boolean
  /** Whether the window is enabled for user interaction. */
  readonly isEnabled: boolean
  /** Whether the window is currently the foreground active window. */
  readonly isForeground: boolean
  /** Timestamp in epoch milliseconds when this logical window identity was first observed. */
  readonly firstSeen: number
  /** Monotonic registry revision at which this window was created or last updated. */
  readonly updatedRevision: number
  /** Registry/host lifecycle generation to which this snapshot belongs. */
  readonly generation: number
  /** Local timestamp when this window snapshot was captured. */
  readonly capturedAt: number
}

/** Complete point-in-time snapshot of the authoritative Window Registry. */
export interface WindowRegistrySnapshot {
  /** Host/registry lifecycle generation. */
  readonly generation: number
  /** Monotonically increasing revision number within this generation. */
  readonly revision: number
  /** All currently active, tracked top-level windows. */
  readonly windows: readonly WindowSnapshot[]
  /** Stable identity of the current foreground window, if tracked. */
  readonly foregroundWindowId?: WindowId | undefined
  /** Local timestamp when this snapshot was committed. */
  readonly capturedAt: number
}

/** Describes a change in a specific property of a window. */
export interface WindowPropertyChange<T> {
  readonly id: WindowId
  readonly hwnd: number
  readonly previous: T
  readonly current: T
  readonly window: WindowSnapshot
}

/** Foreground activation transition event. */
export interface WindowForegroundChangeEvent {
  readonly previous: WindowSnapshot | null
  readonly current: WindowSnapshot | null
}

/** Notification for composite modifications to an existing window. */
export interface WindowChange {
  readonly id: WindowId
  readonly window: WindowSnapshot
  readonly previous: WindowSnapshot
  readonly changes: readonly ('title' | 'bounds' | 'state' | 'monitor' | 'classification' | 'foreground')[]
}

/** Read-only contract exposed by the authoritative Window Registry Core service. */
export interface WindowRegistrySource {
  /** Returns the current coherent snapshot of all windows. */
  getSnapshot(): WindowRegistrySnapshot
  /** Returns an array of all currently tracked windows. */
  getWindows(): readonly WindowSnapshot[]
  /** Finds a window by its stable WindowId. */
  getWindow(id: WindowId): WindowSnapshot | undefined
  /** Finds a window by its current Win32 HWND. */
  getByHwnd(hwnd: number): WindowSnapshot | undefined
  /** Finds all windows belonging to a given process ID. */
  getByProcessId(pid: number): readonly WindowSnapshot[]
  /** Returns the current foreground application window, if known. */
  getForegroundWindow(): WindowSnapshot | undefined
  /** Returns all windows intersecting or assigned to a specific monitor. */
  getWindowsForMonitor(monitorId: MonitorId): readonly WindowSnapshot[]
  /** Requests an immediate native enumeration recapture. */
  refresh(): Promise<WindowRegistrySnapshot>
  /** Subscribes to coherent registry snapshot replacements. */
  subscribe(listener: (snapshot: WindowRegistrySnapshot) => void): () => void
}

/** Construction options for WindowRegistryService. */
export interface WindowRegistryConfig {
  readonly enabled: boolean
  readonly bridge?: NativeBridgeClient | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    windowRegistry: WindowRegistryService
  }
  interface Events {
    /** @mode broadcast @param window Newly created window with minted stable WindowId. */
    'window-registry/window-created'(window: WindowSnapshot): void
    /** @mode broadcast @param window Window that has been destroyed or whose HWND was recycled. */
    'window-registry/window-destroyed'(window: WindowSnapshot): void
    /** @mode broadcast @param change Window whose title, bounds, state, monitor, or classification changed. */
    'window-registry/window-changed'(change: WindowChange): void
    /** @mode broadcast @param change Title change event. */
    'window-registry/window-title-changed'(change: WindowPropertyChange<string>): void
    /** @mode broadcast @param change Bounds change event. */
    'window-registry/window-bounds-changed'(change: WindowPropertyChange<PhysicalPixelRect>): void
    /** @mode broadcast @param change State change event. */
    'window-registry/window-state-changed'(change: WindowPropertyChange<WindowState>): void
    /** @mode broadcast @param event Foreground focus transition. */
    'window-registry/window-foreground-changed'(event: WindowForegroundChangeEvent): void
    /** @mode broadcast @param snapshot Coherent immutable registry snapshot replacement. */
    'window-registry/snapshot'(snapshot: WindowRegistrySnapshot): void
    /** @mode broadcast Recovery after native host restart or observer reconnect. */
    'window-registry/recovered'(): void
    /** @mode broadcast @param error Native observation fault; last known-good state is retained. */
    'window-registry/fault'(error: Error): void
    /** @mode broadcast @param service Initialized authoritative Window Registry service. */
    'window-registry/ready'(service: WindowRegistryService): void
  }
}
