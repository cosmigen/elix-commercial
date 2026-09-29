/**
 * Authoritative types and models for the ELIX Native Surface Core.
 *
 * @module @deepseek-ai/dsh-surface/types
 */

import type { NativeBridgeClient } from '@deepseek-ai/dsh-native-core'

/** Canonical physical-pixel bounding rectangle in virtual screen space. */
export interface PhysicalBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Focus and activation policy for an ELIX native surface. */
export type SurfaceFocusPolicy = 'normal' | 'noActivate'

/** Z-order stacking policy for an ELIX native surface. */
export type SurfaceZOrderPolicy = 'normal' | 'topmost' | 'bottom'

/** Content specification to initialize or navigate the surface's WebView2 instance. */
export type SurfaceRendererSpec =
  | { readonly type: 'url'; readonly target: string }
  | { readonly type: 'html'; readonly target: string }

/**
 * Authoritative lifecycle states of an ELIX native surface.
 *
 * Transitions:
 * ALLOCATED -> NATIVE_CREATED -> WEBVIEW_INITIALIZING -> WEBVIEW_CREATED
 * -> NAVIGATING -> RENDERER_READY -> READY -> VISIBLE / HIDDEN -> DESTROYING -> DISPOSED
 */
export type SurfaceLifecycleState =
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

/** Options when requesting creation of a new managed native surface. */
export interface SurfaceCreateOptions {
  /** Unique surface identifier (e.g. 'home-desktop-surface'). */
  readonly id: string
  /** Physical bounds in desktop virtual screen coordinates. */
  readonly bounds: PhysicalBounds
  /** Target renderer document or URL to host in WebView2. */
  readonly renderer?: SurfaceRendererSpec | undefined
  /** Monitor identifier this surface should be bound to. */
  readonly monitorId?: string | undefined
  /** Focus and activation policy. */
  readonly focusPolicy?: SurfaceFocusPolicy | undefined
  /** Desktop z-order stacking policy. */
  readonly zOrderPolicy?: SurfaceZOrderPolicy | undefined
  /** Whether the surface should avoid showing an icon in the Windows taskbar. */
  readonly skipTaskbar?: boolean | undefined
  /** Whether the surface supports DWM alpha blending for transparent visuals. */
  readonly transparent?: boolean | undefined
  /** Whether the surface should be shown immediately once ready. Defaults to false. */
  readonly visible?: boolean | undefined
  /** User data folder for WebView2 profile storage. */
  readonly userDataFolder?: string | undefined
}

/** Point-in-time snapshot of an active native surface. */
export interface SurfaceSnapshot {
  readonly id: string
  readonly hwnd: number
  readonly bounds: PhysicalBounds
  readonly state: SurfaceLifecycleState
  readonly visible: boolean
  readonly dpi: number
  readonly scaleFactor: number
  readonly focusPolicy: SurfaceFocusPolicy
  readonly zOrderPolicy: SurfaceZOrderPolicy
  readonly monitorId?: string | undefined
}

/** Authoritative real-time focus and foreground activation status for an ELIX native surface. */
export interface SurfaceFocusState {
  readonly id: string
  readonly hwnd: number
  readonly isForeground: boolean
  readonly foregroundHwnd: number
  readonly hasKeyboardFocus: boolean
}

/** Status of the host Microsoft Edge WebView2 runtime. */
export interface SurfaceRuntimeStatus {
  readonly available: boolean
  readonly version?: string | undefined
}

/** Construction and configuration options for SurfaceService. */
export interface SurfaceConfig {
  readonly enabled: boolean
  readonly bridge?: NativeBridgeClient | undefined
  readonly defaultUserDataFolder?: string | undefined
}
