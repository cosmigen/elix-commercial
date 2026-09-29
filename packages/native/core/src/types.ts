/**
//! Strongly typed contracts, models, and errors for the ELIX Native Core Bridge.
//!
//! Exposes domain models matching the Rust Native Core capabilities:
//! Known Folders, stable File Identity, COM Shell Links, Shell Icons,
//! Directory Change Watchers, and safe Process Launch.
//!
//! @module @deepseek-ai/dsh-native-core/types
*/

import type { Branded } from '@deepseek-ai/dsh-brand'

/**
 * Structured native error model returned by the Rust Native Core.
 */
export interface NativeError {
  readonly domain: string
  readonly code: string
  readonly message: string
  readonly nativeCode?: number | undefined
  readonly hresult?: number | undefined
  readonly retryable?: boolean | undefined
}

/**
 * Capabilities advertised by the Rust Native Core during handshake.
 */
export interface NativeCapabilities {
  readonly knownFolders: boolean
  readonly fileIdentity: boolean
  readonly shellLinks: boolean
  readonly shellIcons: boolean
  readonly namespaceWatch: boolean
  readonly processLaunch: boolean
  readonly processObservation?: boolean | undefined
  readonly windowsContext: boolean
  readonly surface: boolean
  readonly appBar?: boolean | undefined
  readonly windowRegistry?: boolean | undefined
  readonly windowControl?: boolean | undefined
}

/** Opaque stable/best-effort monitor identity projected from Windows DisplayConfig. */
export type NativeMonitorId = Branded<'MonitorId'>

/** Rectangle in virtual-screen physical pixel coordinates. */
export interface NativePhysicalPixelRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Raw native description of one connected monitor. */
export interface NativeWindowsMonitor {
  readonly id: NativeMonitorId
  readonly deviceName: string
  readonly friendlyName?: string | undefined
  readonly bounds: NativePhysicalPixelRect
  readonly workArea: NativePhysicalPixelRect
  readonly dpiX: number
  readonly dpiY: number
  readonly scaleFactor: number
  readonly isPrimary: boolean
  readonly connector?: string | undefined
}

/** Raw transient foreground-window context; the HWND-derived nativeId is not durable identity. */
export interface NativeForegroundWindowContext {
  readonly nativeId: string
  readonly processId: number
  readonly threadId: number
  readonly monitorId?: NativeMonitorId | undefined
  readonly bounds: NativePhysicalPixelRect
  readonly isVisible: boolean
  readonly isMinimized: boolean
  readonly isCloaked: boolean
  readonly isToolWindow: boolean
  readonly isShellWindow: boolean
  readonly isFullscreen: boolean
  readonly fullscreenReason?: string | undefined
}

/** Complete snapshot returned by the native Windows Context observer. */
export interface NativeWindowsContextSnapshot {
  readonly revision: number
  readonly monitors: readonly NativeWindowsMonitor[]
  readonly primaryMonitorId?: NativeMonitorId | undefined
  readonly foreground?: NativeForegroundWindowContext | null | undefined
  readonly capturedAt: number
}

/** Native reason for a complete Windows Context snapshot replacement. */
export type NativeWindowsContextChangeReason =
  | 'initial'
  | 'topology'
  | 'dpi'
  | 'work-area'
  | 'foreground'
  | 'foreground-geometry'
  | 'fullscreen'
  | 'refresh'
  | 'recovered'

/** Push event delivered for an observed native context replacement. */
export interface NativeWindowsContextChange {
  readonly reason: NativeWindowsContextChangeReason
  readonly snapshot: NativeWindowsContextSnapshot
}

/** Current native event-thread status. */
export interface NativeWindowsContextStatus {
  readonly observing: boolean
  readonly threadAlive: boolean
}

/** Disposable listener registration over the process-wide native observer. */
export interface NativeWindowsContextSubscription {
  dispose(): Promise<boolean>
}

/**
 * Handshake negotiation result received from native host process.
 */
export interface HandshakeResult {
  readonly protocolVersion: number
  readonly nativeVersion: string
  readonly capabilities: NativeCapabilities
}

/**
 * Current operational status of the Native Bridge client.
 */
export type BridgeStatus =
  | 'uninitialized'
  | 'connecting'
  | 'reconnecting'
  | 'ready'
  | 'faulted'
  | 'closed'

/**
 * Canonical Windows KnownFolder identifiers supported by ELIX.
 */
export type KnownFolderId =
  | 'Desktop'
  | 'PublicDesktop'
  | 'Documents'
  | 'PublicDocuments'
  | 'Downloads'
  | 'Pictures'
  | 'Music'
  | 'Videos'
  | 'StartMenu'
  | 'Programs'
  | 'Startup'
  | 'RecycleBin'

/**
 * Resolution output for a Windows Known Folder.
 */
export interface KnownFolderResolution {
  readonly id: KnownFolderId
  readonly path?: string | undefined
  readonly available: boolean
  readonly isVirtual: boolean
  readonly displayName: string
}

/**
 * File identity quality ranking.
 */
export type IdentityQuality =
  | 'native-stable'
  | 'filesystem-stable'
  | 'path-fallback'

/**
 * Strongly typed file identity returned by native file inspection.
 */
export interface FileIdentity {
  readonly id: Branded<'ShellItemId'>
  readonly quality: IdentityQuality
  readonly volumeSerialNumber?: string | undefined
  readonly fileId?: string | undefined
  readonly canonicalPath: string
}

/**
 * Lightweight icon reference extracted from shortcut metadata.
 */
export type ShortcutIconReference =
  | { readonly kind: 'resource'; readonly sourcePath: string; readonly resourceIndex: number }
  | { readonly kind: 'file'; readonly filePath: string }

/**
 * Metadata extracted from a Windows `.lnk` shortcut.
 */
export interface ShellShortcutMetadata {
  readonly target?: string | undefined
  readonly arguments?: readonly string[] | undefined
  readonly workingDirectory?: string | undefined
  readonly description?: string | undefined
  readonly icon?: ShortcutIconReference | undefined
  readonly isBroken: boolean
}

/**
 * Strongly typed shell icon reference.
 */
export type ShellIconReference =
  | { readonly kind: 'file'; readonly filePath: string }
  | { readonly kind: 'resource'; readonly sourcePath: string; readonly resourceIndex: number }
  | { readonly kind: 'extension'; readonly extension: string }
  | {
    readonly kind: 'fallback'
    readonly defaultIconId:
      | 'generic-file'
      | 'generic-folder'
      | 'generic-shortcut'
      | 'generic-drive'
      | 'generic-system'
  }

/**
 * Shell icon resolution descriptor.
 */
export interface ShellIconDescriptor {
  readonly reference: ShellIconReference
  readonly hasEmbeddedIcon: boolean
  readonly totalResourceIcons?: number | undefined
}

/**
 * Directory change notification types emitted by native watcher.
 */
export type WatcherChangeType =
  | 'added'
  | 'removed'
  | 'modified'
  | 'renamed'
  | 'buffer-overflow'
  | 'container-invalidated'

/**
 * Filesystem change event received from native watcher.
 */
export interface WatcherChangeEvent {
  readonly subscriptionId: number
  readonly containerPath: string
  readonly changeType: WatcherChangeType
  readonly fileName?: string | undefined
  readonly oldFileName?: string | undefined
}

/**
 * Win32 application launch request parameters for native host.
 */
export interface NativeWin32LaunchParams {
  readonly executablePath: string
  readonly arguments?: readonly string[] | undefined
  readonly workingDirectory?: string | undefined
}

/**
 * Packaged application launch request parameters for native host.
 */
export interface NativePackagedLaunchParams {
  readonly aumid: string
  readonly arguments?: readonly string[] | undefined
}

/**
 * Outcome of a process launch attempt.
 */
export interface ProcessLaunchResult {
  readonly success: boolean
  readonly pid?: number | undefined
  readonly error?: string | undefined
}

/**
 * Process supervision and auto-restart configuration.
 */
export interface NativeBridgeSupervisorOptions {
  /** Whether to automatically supervise and restart host upon unexpected exit. Default true. */
  autoRestart?: boolean | undefined
  /** Maximum consecutive restart attempts before entering 'faulted' state. Default 5. */
  maxRestarts?: number | undefined
  /** Initial restart backoff delay in milliseconds. Default 100. */
  initialBackoffMs?: number | undefined
  /** Maximum restart backoff delay in milliseconds. Default 2000. */
  maxBackoffMs?: number | undefined
  /** Healthy runtime required before the restart budget resets. Default 30000. */
  stabilityWindowMs?: number | undefined
}

/**
 * Bridge client configuration options.
 */
export interface NativeBridgeOptions {
  /** Explicit absolute path to elix-native-host.exe binary override. */
  binaryPath?: string | undefined
  /** Handshake deadline in milliseconds. Default 5000. */
  handshakeTimeoutMs?: number | undefined
  /** Request deadline in milliseconds. Default 5000. */
  requestTimeoutMs?: number | undefined
  /** Automatically attempt connection upon instantiation. Default false. */
  autoConnect?: boolean | undefined
  /** Process supervision options. */
  supervisor?: NativeBridgeSupervisorOptions | undefined
  /** Shorthand to enable or disable automatic process restart. Default true. */
  autoRestart?: boolean | undefined
  /** Enable diagnostic stderr output logging. Default false. */
  debug?: boolean | undefined
  /** Graceful and forced process-exit deadline in milliseconds. Default 1000 per stage. */
  shutdownTimeoutMs?: number | undefined
}

/** Canonical physical-pixel bounds for a native surface. */
export interface NativePhysicalBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Focus and activation policy for a native surface. */
export type NativeSurfaceFocusPolicy = 'normal' | 'noActivate'

/** Z-order placement policy for a native surface. */
export type NativeSurfaceZOrderPolicy = 'normal' | 'topmost' | 'bottom'

/** Renderer specification specifying content loaded in the surface's WebView2. */
export type NativeSurfaceRendererSpec =
  | { readonly type: 'url'; readonly target: string }
  | { readonly type: 'html'; readonly target: string }

/** Explicit lifecycle state of a native surface. */
export type NativeSurfaceLifecycleState =
  | 'ALLOCATED'
  | 'NATIVE_CREATED'
  | 'WEBVIEW_INITIALIZING'
  | 'WEBVIEW_CREATED'
  | 'NAVIGATING'
  | 'RENDERER_READY'
  | 'READY'
  | 'VISIBLE'
  | 'HIDDEN'
  | 'FAULTED'
  | 'DESTROYING'
  | 'DISPOSED'

/** Creation specification for a new native surface. */
export interface NativeSurfaceCreateOptions {
  readonly id: string
  readonly bounds: NativePhysicalBounds
  readonly renderer?: NativeSurfaceRendererSpec | undefined
  readonly monitorId?: string | undefined
  readonly focusPolicy?: NativeSurfaceFocusPolicy | undefined
  readonly zOrderPolicy?: NativeSurfaceZOrderPolicy | undefined
  readonly skipTaskbar?: boolean | undefined
  readonly transparent?: boolean | undefined
  readonly visible?: boolean | undefined
  readonly userDataFolder?: string | undefined
}

/** Point-in-time snapshot of an active native surface. */
export interface NativeSurfaceSnapshot {
  readonly id: string
  readonly hwnd: number
  readonly bounds: NativePhysicalBounds
  readonly state: NativeSurfaceLifecycleState
  readonly visible: boolean
  readonly dpi: number
  readonly scaleFactor: number
  readonly focusPolicy: NativeSurfaceFocusPolicy
  readonly zOrderPolicy: NativeSurfaceZOrderPolicy
  readonly monitorId?: string | undefined
}

/** Authoritative real-time focus and foreground activation status for a native surface. */
export interface NativeSurfaceFocusState {
  readonly id: string
  readonly hwnd: number
  readonly isForeground: boolean
  readonly foregroundHwnd: number
  readonly hasKeyboardFocus: boolean
}

/** Asynchronous event emitted by Surface Core. */
export type NativeSurfaceEvent =
  | { readonly type: 'created'; readonly snapshot: NativeSurfaceSnapshot }
  | { readonly type: 'nativeReady'; readonly id: string; readonly hwnd: number }
  | { readonly type: 'rendererReady'; readonly id: string }
  | { readonly type: 'shown'; readonly id: string }
  | { readonly type: 'hidden'; readonly id: string }
  | { readonly type: 'boundsChanged'; readonly id: string; readonly bounds: NativePhysicalBounds }
  | {
    readonly type: 'dpiChanged'
    readonly id: string
    readonly dpi: number
    readonly scaleFactor: number
    readonly suggestedBounds: NativePhysicalBounds
  }
  | { readonly type: 'fault'; readonly id: string; readonly error: NativeError }
  | { readonly type: 'destroyed'; readonly id: string }
  | { readonly type: 'inputKey'; readonly id: string; readonly key: string }
  | {
    readonly type: 'pointer'
    readonly id: string
    readonly action: string
    readonly x: number
    readonly y: number
  }
  | { readonly type: 'message'; readonly id: string; readonly message: string }

/** Active event subscription for native surface events. */
export interface NativeSurfaceSubscription {
  dispose(): Promise<boolean>
}

/** Screen edges on which an AppBar can dock to reserve desktop work area. */
export type NativeAppBarEdge = 'top' | 'bottom' | 'left' | 'right'

/** Registration specification for an AppBar reservation. */
export interface NativeAppBarSpec {
  readonly id: string
  readonly edge: NativeAppBarEdge
  readonly rect: NativePhysicalPixelRect
  readonly hwnd?: number | undefined
}

/** Point-in-time snapshot of an active AppBar registration. */
export interface NativeRegisteredAppBar {
  readonly id: string
  readonly edge: NativeAppBarEdge
  readonly rect: NativePhysicalPixelRect
  readonly hwnd: number
}

/** Raw description of one discovered top-level Windows window from the native host. */
export interface NativeRawWindow {
  readonly hwnd: number
  readonly processId: number
  readonly threadId: number
  readonly processCreationTime: number
  readonly executablePath?: string | undefined
  readonly executableName?: string | undefined
  readonly packageFullName?: string | undefined
  readonly aumid?: string | undefined
  readonly title: string
  readonly className: string
  readonly bounds: NativePhysicalPixelRect
  readonly isVisible: boolean
  readonly isMinimized: boolean
  readonly isMaximized: boolean
  readonly isCloaked: boolean
  readonly isToolWindow: boolean
  readonly isShellWindow: boolean
  readonly isEnabled: boolean
  readonly isForeground: boolean
  readonly monitorDeviceName?: string | undefined
}

/** Complete raw snapshot of active windows from native host. */
export interface NativeWindowRegistrySnapshot {
  readonly revision: number
  readonly windows: readonly NativeRawWindow[]
  readonly foregroundHwnd?: number | undefined
  readonly capturedAt: number
}

/** Native change event delivered for window registry changes. */
export interface NativeWindowRegistryChange {
  readonly reason: string
  readonly snapshot: NativeWindowRegistrySnapshot
  readonly window?: NativeRawWindow | undefined
  readonly destroyedHwnd?: number | undefined
  readonly foregroundHwnd?: number | undefined
}

/** Current native window registry observer thread status. */
export interface NativeWindowRegistryStatus {
  readonly observing: boolean
  readonly threadAlive: boolean
}

/** Disposable listener registration for window registry events. */
export interface NativeWindowRegistrySubscription {
  dispose(): Promise<boolean>
}
