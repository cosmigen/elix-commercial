import type { NativeBridgeClient } from '@deepseek-ai/dsh-native-core'
import type { WindowId } from '@deepseek-ai/dsh-window-registry'
import type { WindowPreviewService } from './service.ts'

/** Public lifecycle state of one logical preview lease. */
export type PreviewState =
  | 'live'
  | 'cached'
  | 'paused'
  | 'unavailable'
  | 'denied'
  | 'destroyed'

/** Native/rendering backend selected for a lease. */
export type PreviewBackend = 'dwm-thumbnail' | 'none'

/** Relative consumer importance used when the live-preview budget is saturated. */
export type PreviewImportance = 'critical' | 'high' | 'normal' | 'low'

/** How live source imagery is fitted into the requested consumer rectangle. */
export type PreviewFit = 'contain' | 'stretch'

/** Physical-pixel rectangle relative to the destination ELIX surface client area. */
export interface PreviewRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Request for one independently releasable preview consumer. */
export interface PreviewLeaseOptions {
  readonly sourceWindowId: WindowId
  readonly destinationSurfaceId: string
  readonly destinationRect: PreviewRect
  readonly consumerId: string
  readonly visible?: boolean | undefined
  readonly opacity?: number | undefined
  readonly importance?: PreviewImportance | undefined
  readonly desiredRefreshHz?: number | undefined
  readonly sourceClientAreaOnly?: boolean | undefined
  readonly fit?: PreviewFit | undefined
}

/** Public immutable lease state. No HWND or native thumbnail handle is exposed. */
export interface PreviewLeaseSnapshot {
  readonly id: string
  readonly sourceWindowId: WindowId
  readonly destinationSurfaceId: string
  readonly consumerId: string
  readonly state: PreviewState
  readonly backend: PreviewBackend
  readonly destinationRect: PreviewRect
  readonly effectiveRect: PreviewRect
  readonly visible: boolean
  readonly opacity: number
  readonly importance: PreviewImportance
  readonly desiredRefreshHz: number
  readonly sourceClientAreaOnly: boolean
  readonly fit: PreviewFit
  readonly contentWidth?: number | undefined
  readonly contentHeight?: number | undefined
  readonly reason?: string | undefined
  readonly updatedAt: number
  readonly freshAt?: number | undefined
}

/** Resource accounting exposed for diagnostics and acceptance tests. */
export interface PreviewStats {
  readonly totalLeases: number
  readonly live: number
  readonly cached: number
  readonly paused: number
  readonly unavailable: number
  readonly denied: number
  readonly destroyed: number
  readonly nativeBindings: number
  readonly maxLivePreviews: number
  readonly sessionLocked: boolean
}

/** Preview authority configuration. */
export interface WindowPreviewConfig {
  readonly enabled: boolean
  readonly maxLivePreviews: number
  readonly bridge?: NativeBridgeClient | undefined
}

/** Native DWM snapshot returned by the bridge. This type never leaves the backend layer. */
export interface NativePreviewSnapshot {
  readonly id: string
  readonly sourceHwnd: number
  readonly destinationHwnd: number
  readonly sourceWidth: number
  readonly sourceHeight: number
  readonly destinationRect: PreviewRect
  readonly opacity: number
  readonly sourceClientAreaOnly: boolean
  readonly visible: boolean
  readonly backend: 'dwm-thumbnail'
}

declare module '@deepseek-ai/dsh-native-core' {
  interface NativeCapabilities {
    readonly windowPreview?: boolean | undefined
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    windowPreview: WindowPreviewService
  }
  interface Events {
    /** @mode broadcast @param snapshot Complete state of the changed preview lease. */
    'window-preview/changed'(snapshot: PreviewLeaseSnapshot): void
    /** @mode broadcast @param service Initialized Phase 17A preview authority. */
    'window-preview/ready'(service: WindowPreviewService): void
    /** @mode broadcast @param error Reconciliation fault isolated from consumers. */
    'window-preview/fault'(error: Error): void
  }
}
