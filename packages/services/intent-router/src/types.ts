/**
 * Authoritative types, data models, and contracts for the ELIX Intent Router and File Operations subsystem.
 *
 * @module @deepseek-ai/dsh-intent-router/types
 */

import type { AppId, AppLaunchOptions, AppLaunchResult } from '@deepseek-ai/dsh-app-registry'
import type { ProcessLaunchResult, Win32LaunchSpec, PackagedLaunchSpec } from '@deepseek-ai/dsh-native-core'
import type { ShellItem, ShellItemId } from '@deepseek-ai/dsh-shell-namespace'

export type {
  AppId,
  AppLaunchOptions,
  AppLaunchResult,
  ProcessLaunchResult,
  Win32LaunchSpec,
  PackagedLaunchSpec,
  ShellItem,
  ShellItemId,
}

/** Structural representation of an item activating from Home or desktop UI. */
export interface HomeActivationItem {
  readonly id: string
  readonly type: string
  readonly monitorId?: string | undefined
  readonly metadata?: Record<string, unknown> | undefined
}

/** Supported discriminated intent types for shell action routing. */
export type ShellIntentType =
  | 'open-app'
  | 'open-file'
  | 'open-folder'
  | 'open-shortcut'
  | 'reveal-in-folder'
  | 'rename'
  | 'delete'
  | 'move'
  | 'copy'
  | 'create-folder'
  | 'resolve-target'
  | 'get-available-actions'

/** Intent to activate an application by its registered AppId. */
export interface OpenAppIntent {
  readonly type: 'open-app'
  readonly appId: AppId
  readonly options?: AppLaunchOptions | undefined
}

/** Intent to open a file with its default system application. */
export interface OpenFileIntent {
  readonly type: 'open-file'
  readonly itemId: ShellItemId
}

/** Intent to open a directory container in the system file explorer. */
export interface OpenFolderIntent {
  readonly type: 'open-folder'
  readonly itemId: ShellItemId
}

/** Intent to activate a Windows shortcut (.lnk), resolving its effective target. */
export interface OpenShortcutIntent {
  readonly type: 'open-shortcut'
  readonly itemId: ShellItemId
}

/** Intent to open the containing folder and highlight/select the target item. */
export interface RevealInFolderIntent {
  readonly type: 'reveal-in-folder'
  readonly itemId: ShellItemId
}

/** Intent to rename a file, folder, or shortcut within its current container. */
export interface RenameIntent {
  readonly type: 'rename'
  readonly itemId: ShellItemId
  readonly newName: string
}

/** Intent to remove items from the filesystem. */
export interface DeleteIntent {
  readonly type: 'delete'
  readonly itemIds: readonly ShellItemId[]
  readonly permanent?: boolean | undefined
}

/** Intent to move one or more items to a destination container. */
export interface MoveIntent {
  readonly type: 'move'
  readonly itemIds: readonly ShellItemId[]
  readonly destinationId: ShellItemId
}

/** Intent to copy one or more items to a destination container. */
export interface CopyIntent {
  readonly type: 'copy'
  readonly itemIds: readonly ShellItemId[]
  readonly destinationId: ShellItemId
}

/** Intent to create a new folder inside a destination container. */
export interface CreateFolderIntent {
  readonly type: 'create-folder'
  readonly destinationId: ShellItemId
  readonly name: string
}

/** Intent to resolve the effective target and metadata of a shell item. */
export interface ResolveTargetIntent {
  readonly type: 'resolve-target'
  readonly itemId: ShellItemId
}

/** Intent to query the permissible actions available on a shell item. */
export interface GetAvailableActionsIntent {
  readonly type: 'get-available-actions'
  readonly itemId: ShellItemId
}

/** Discriminated union of all authoritative shell intents accepted by the Intent Router. */
export type ShellIntent =
  | OpenAppIntent
  | OpenFileIntent
  | OpenFolderIntent
  | OpenShortcutIntent
  | RevealInFolderIntent
  | RenameIntent
  | DeleteIntent
  | MoveIntent
  | CopyIntent
  | CreateFolderIntent
  | ResolveTargetIntent
  | GetAvailableActionsIntent

/** Authoritative outcome status classifications for intent execution. */
export type IntentStatus =
  | 'success'
  | 'unsupported'
  | 'not-found'
  | 'invalid-request'
  | 'permission-denied'
  | 'conflict'
  | 'cancelled'
  | 'native-failure'

/** Structured error payload preserving domain, error code, and underlying cause. */
export interface IntentError {
  readonly code: string
  readonly message: string
  readonly domain?: string | undefined
  readonly cause?: unknown
}

/** Classification of a shortcut's effective resolved target. */
export type ResolvedTargetKind =
  | 'app'
  | 'file'
  | 'folder'
  | 'url'
  | 'unsupported'

/** Resolved metadata and target classification of a shell item. */
export interface ResolvedTarget {
  readonly kind: ResolvedTargetKind
  readonly pathOrUri: string
  readonly appId?: AppId | undefined
  readonly shellItemId?: ShellItemId | undefined
  readonly arguments?: readonly string[] | undefined
  readonly workingDirectory?: string | undefined
  readonly isBroken?: boolean | undefined
}

/** Permissible actions on a shell item. */
export type AvailableAction =
  | 'open'
  | 'reveal-in-folder'
  | 'rename'
  | 'copy'
  | 'move'
  | 'delete'
  | 'create-folder'
  | 'resolve-target'

/** Typed result of an OpenApp intent. */
export interface OpenAppResult {
  readonly status: IntentStatus
  readonly appId: AppId
  readonly pid?: number | undefined
  readonly error?: IntentError | undefined
}

/** Typed result of an OpenFile intent. */
export interface OpenFileResult {
  readonly status: IntentStatus
  readonly itemId: ShellItemId
  readonly pid?: number | undefined
  readonly error?: IntentError | undefined
}

/** Typed result of an OpenFolder intent. */
export interface OpenFolderResult {
  readonly status: IntentStatus
  readonly itemId: ShellItemId
  readonly pid?: number | undefined
  readonly error?: IntentError | undefined
}

/** Typed result of an OpenShortcut intent. */
export interface OpenShortcutResult {
  readonly status: IntentStatus
  readonly itemId: ShellItemId
  readonly resolvedKind?: ResolvedTargetKind | undefined
  readonly target?: string | undefined
  readonly pid?: number | undefined
  readonly error?: IntentError | undefined
}

/** Typed result of a RevealInFolder intent. */
export interface RevealInFolderResult {
  readonly status: IntentStatus
  readonly itemId: ShellItemId
  readonly pid?: number | undefined
  readonly error?: IntentError | undefined
}

/** Typed result of a Rename intent. */
export interface RenameResult {
  readonly status: IntentStatus
  readonly itemId: ShellItemId
  readonly previousName?: string | undefined
  readonly newName?: string | undefined
  readonly item?: ShellItem | undefined
  readonly error?: IntentError | undefined
}

/** Typed result of a Delete intent. */
export interface DeleteResult {
  readonly status: IntentStatus
  readonly itemIds: readonly ShellItemId[]
  readonly deletedIds?: readonly ShellItemId[] | undefined
  readonly mode?: 'permanent' | 'recycle' | undefined
  readonly error?: IntentError | undefined
}

/** Per-item result of a Move operation. */
export interface MoveItemResult {
  readonly sourceId: ShellItemId
  readonly status: IntentStatus
  readonly destinationItem?: ShellItem | undefined
  readonly error?: IntentError | undefined
}

/** Typed result of a Move intent. */
export interface MoveResult {
  readonly status: IntentStatus
  readonly destinationId: ShellItemId
  readonly items: readonly MoveItemResult[]
  readonly error?: IntentError | undefined
}

/** Per-item result of a Copy operation. */
export interface CopyItemResult {
  readonly sourceId: ShellItemId
  readonly status: IntentStatus
  readonly destinationItem?: ShellItem | undefined
  readonly error?: IntentError | undefined
}

/** Typed result of a Copy intent. */
export interface CopyResult {
  readonly status: IntentStatus
  readonly destinationId: ShellItemId
  readonly items: readonly CopyItemResult[]
  readonly error?: IntentError | undefined
}

/** Typed result of a CreateFolder intent. */
export interface CreateFolderResult {
  readonly status: IntentStatus
  readonly destinationId: ShellItemId
  readonly name: string
  readonly item?: ShellItem | undefined
  readonly error?: IntentError | undefined
}

/** Typed result of a ResolveTarget intent. */
export interface ResolveTargetResult {
  readonly status: IntentStatus
  readonly itemId: ShellItemId
  readonly target?: ResolvedTarget | undefined
  readonly error?: IntentError | undefined
}

/** Typed result of a GetAvailableActions intent. */
export interface GetAvailableActionsResult {
  readonly status: IntentStatus
  readonly itemId: ShellItemId
  readonly actions: readonly AvailableAction[]
  readonly error?: IntentError | undefined
}

/** Discriminated union of all typed results returned by the Intent Router. */
export type ShellIntentResult =
  | OpenAppResult
  | OpenFileResult
  | OpenFolderResult
  | OpenShortcutResult
  | RevealInFolderResult
  | RenameResult
  | DeleteResult
  | MoveResult
  | CopyResult
  | CreateFolderResult
  | ResolveTargetResult
  | GetAvailableActionsResult

/** Configuration parameters for the IntentRouter service. */
export interface IntentRouterConfig {
  /** Whether the IntentRouter service is enabled. */
  enabled?: boolean | undefined
  /** Whether to project actual desktop items into Home on startup. */
  projectDesktopOnStartup?: boolean | undefined
  /** Whether to prefer Native Core for launch and file execution when available. */
  preferNative?: boolean | undefined
}

/** Process launch contract for executing Win32 and Packaged processes. */
export interface ProcessLauncher {
  /** Launches a Win32 executable directly with arguments. */
  launchWin32(spec: Win32LaunchSpec, options?: AppLaunchOptions): Promise<ProcessLaunchResult>
  /** Launches a packaged application via AUMID. */
  launchPackaged?(spec: PackagedLaunchSpec, options?: AppLaunchOptions): Promise<ProcessLaunchResult>
}
