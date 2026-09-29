/**
 * Public contracts for the ELIX Phase 18A Spaces authority.
 *
 * The service dynamically selects the richest runtime-qualified provider:
 * a Windows Shell provider for complete desktop lifecycle/control, with the
 * documented IVirtualDesktopManager provider retained as a safe read fallback.
 *
 * @module @deepseek-ai/dsh-spaces/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { NativeBridgeClient } from '@deepseek-ai/dsh-native-core'
import type { WindowId } from '@deepseek-ai/dsh-window-registry'
import type { SpacesService } from './index.ts'

/** Stable ELIX identity for a Windows virtual desktop GUID. */
export type SpaceId = Branded<'SpaceId'>

export type SpacesProvider =
  | 'windows-shell-virtual-desktop'
  | 'windows-public-virtual-desktop-manager'

/** Capability contract. Values are runtime-qualified and never simulated. */
export interface SpacesCapabilities {
  readonly provider: SpacesProvider
  readonly windowMembership: boolean
  readonly currentWindowMembership: boolean
  readonly moveWindow: boolean
  readonly enumerateSpaces: boolean
  readonly switchSpace: boolean
  readonly createSpace: boolean
  readonly removeSpace: boolean
  readonly renameSpace: boolean
  readonly nativeNotifications: boolean
}

/** Window membership returned for one live Window Registry WindowId. */
export interface WindowSpaceMembership {
  readonly windowId: WindowId
  readonly spaceId: SpaceId
  readonly onCurrentSpace: boolean
  readonly capturedAt: number
}

/** One Windows virtual desktop. `index`/`name` are present with the Shell provider. */
export interface ObservedSpaceSnapshot {
  readonly id: SpaceId
  readonly index?: number | undefined
  readonly name?: string | undefined
  readonly windowIds: readonly WindowId[]
  readonly isCurrent: boolean
}

/**
 * Coherent Spaces snapshot. `complete-shell-enumeration` includes empty desktops;
 * fallback snapshots contain only desktops observed through queryable application windows.
 */
export interface SpacesSnapshot {
  readonly revision: number
  readonly spaces: readonly ObservedSpaceSnapshot[]
  readonly unresolvedWindowIds: readonly WindowId[]
  readonly currentSpaceId?: SpaceId | undefined
  readonly capabilities: SpacesCapabilities
  readonly completeness: 'complete-shell-enumeration' | 'observed-application-windows'
  readonly capturedAt: number
}

export interface SpacesSource {
  getCapabilities(): SpacesCapabilities
  getSnapshot(): SpacesSnapshot
  getObservedSpaces(): readonly ObservedSpaceSnapshot[]
  getCurrentSpaceId(): SpaceId | undefined
  getWindowSpace(windowId: WindowId): Promise<WindowSpaceMembership>
  isWindowOnCurrentSpace(windowId: WindowId): Promise<boolean>
  moveWindowToSpace(windowId: WindowId, spaceId: SpaceId): Promise<WindowSpaceMembership>
  switchSpace(spaceId: SpaceId): Promise<SpacesSnapshot>
  createSpace(name?: string): Promise<ObservedSpaceSnapshot>
  removeSpace(spaceId: SpaceId, fallbackSpaceId?: SpaceId): Promise<SpacesSnapshot>
  renameSpace(spaceId: SpaceId, name: string): Promise<ObservedSpaceSnapshot>
  refresh(): Promise<SpacesSnapshot>
  subscribe(listener: (snapshot: SpacesSnapshot) => void): () => void
}

export interface SpacesConfig {
  readonly enabled: boolean
  readonly bridge?: NativeBridgeClient | undefined
  /** Polls the native notification generation only; full reconciliation runs only on change. */
  readonly shellChangePollMs?: number | undefined
}

export type SpacesErrorCode =
  | 'SPACES_DISABLED'
  | 'SPACES_DISPOSED'
  | 'WINDOW_REGISTRY_UNAVAILABLE'
  | 'STALE_WINDOW_ID'
  | 'TARGET_NOT_APPLICATION'
  | 'STALE_SPACE_ID'
  | 'CAPABILITY_UNAVAILABLE'
  | 'OPERATION_CONFLICT'
  | 'NATIVE_SPACES_UNAVAILABLE'
  | 'SHELL_PROVIDER_UNAVAILABLE'
  | 'MEMBERSHIP_QUERY_FAILED'
  | 'MOVE_FAILED'
  | 'MOVE_NOT_CONFIRMED'
  | 'SWITCH_FAILED'
  | 'CREATE_FAILED'
  | 'REMOVE_FAILED'
  | 'RENAME_FAILED'
  | 'INCONSISTENT_CURRENT_SPACE'

declare module '@deepseek-ai/dsh-native-core' {
  interface NativeCapabilities {
    readonly spaces?: boolean | undefined
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    spaces: SpacesService
  }
  interface Events {
    /** @mode broadcast @param service Initialized Phase 18A Spaces authority. */
    'spaces/ready'(service: SpacesService): void
    /** @mode broadcast @param snapshot Coherent Spaces snapshot replacement. */
    'spaces/snapshot'(snapshot: SpacesSnapshot): void
    /** @mode broadcast @param error Native/reconciliation fault; last known-good state is retained. */
    'spaces/fault'(error: Error): void
  }
}
