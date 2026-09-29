/** Public contracts for ELIX Phase 15/16D Application Runtime. */

import type {
  AppId,
  AppLaunchOptions,
  AppLaunchResult,
  AppRecord,
} from '@deepseek-ai/dsh-app-registry'
import type { ProcessEntry } from '@deepseek-ai/dsh-process-observation'
import type { WindowControlResult } from '@deepseek-ai/dsh-window-control'
import type { WindowId, WindowSnapshot } from '@deepseek-ai/dsh-window-registry'

/** Evidence used to associate one authoritative WindowId with an AppId. */
export type ApplicationWindowMatchKind = 'aumid' | 'executable-path' | 'shortcut-target'

/** Evidence used to associate one raw process identity with an AppId. */
export type ApplicationProcessMatchKind =
  | 'aumid'
  | 'executable-path'
  | 'shortcut-target'
  | 'launch-pid'
  | 'descendant'

/** Application-level runtime interpretation over raw process + window authorities. */
export type ApplicationRuntimeState = 'stopped' | 'background' | 'running'

/** Why an APPLICATION window is not currently attached to an AppId. */
export type UnmatchedApplicationWindowReason =
  | 'missing-identity-evidence'
  | 'no-catalog-match'
  | 'ambiguous-catalog-match'

/** Immutable record explaining an unmatched user-facing APPLICATION window. */
export interface UnmatchedApplicationWindow {
  readonly windowId: WindowId
  readonly reason: UnmatchedApplicationWindowReason
  readonly candidateAppIds: readonly AppId[]
}

/** One immutable active application-runtime projection. */
export interface ApplicationRuntimeEntry {
  readonly appId: AppId
  /** Current authoritative App Registry metadata; Application Runtime does not own a second catalog. */
  readonly app: AppRecord
  /** running when user-facing windows exist, background when only matched processes remain. */
  readonly state: Exclude<ApplicationRuntimeState, 'stopped'>
  /** Every currently matched raw process identity for the application. */
  readonly processes: readonly ProcessEntry[]
  /** Match provenance for each process identityKey. */
  readonly processMatchKinds: Readonly<Record<string, ApplicationProcessMatchKind>>
  /** Every currently matched APPLICATION window, including minimized windows. */
  readonly windows: readonly WindowSnapshot[]
  /** Windows eligible for user-facing activation right now, ordered by MRU. */
  readonly activatableWindowIds: readonly WindowId[]
  /** Per-application most-recently-used order, newest first. */
  readonly mruWindowIds: readonly WindowId[]
  readonly foregroundWindowId?: WindowId | undefined
  readonly visibleWindowCount: number
  readonly minimizedWindowCount: number
  readonly matchKinds: Readonly<Partial<Record<WindowId, ApplicationWindowMatchKind>>>
}

/** Coherent immutable snapshot derived from App Registry + Process Observation + Window Registry. */
export interface ApplicationRuntimeSnapshot {
  readonly revision: number
  readonly processObservationRevision: number
  readonly windowRegistryGeneration: number
  readonly windowRegistryRevision: number
  /** Applications currently proven active by a matched process and/or matched window. */
  readonly applications: readonly ApplicationRuntimeEntry[]
  /** Application-level MRU order, newest foreground application first. */
  readonly mruAppIds: readonly AppId[]
  readonly foregroundAppId?: AppId | undefined
  readonly unmatchedWindows: readonly UnmatchedApplicationWindow[]
  readonly capturedAt: number
}

/** Stable failure payload returned by mutation helpers without fabricating state. */
export interface ApplicationRuntimeActionFailure {
  readonly code: string
  readonly message: string
  readonly retryable: boolean
}

/** Result of app-level activation / launch orchestration. */
export interface ApplicationRuntimeActionResult {
  readonly appId: AppId
  readonly action: 'activated' | 'restored-and-activated' | 'launch-requested' | 'failed'
  readonly windowId?: WindowId | undefined
  readonly restoreResult?: WindowControlResult | undefined
  readonly activateResult?: WindowControlResult | undefined
  readonly launchResult?: AppLaunchResult | undefined
  /** For launch-requested this means the launch request completed successfully, not that a window exists yet. */
  readonly completed: boolean
  readonly failure?: ApplicationRuntimeActionFailure | undefined
}

/** Public read and app-level mutation surface. */
export interface ApplicationRuntimeSource {
  getSnapshot(): ApplicationRuntimeSnapshot
  /** Returns applications proven active by current process/window facts. */
  getApplications(): readonly ApplicationRuntimeEntry[]
  getApplication(appId: AppId): ApplicationRuntimeEntry | undefined
  /** Returns stopped when no current process/window evidence exists for the catalog AppId. */
  getApplicationState(appId: AppId): ApplicationRuntimeState
  getApplicationProcesses(appId: AppId): readonly ProcessEntry[]
  getApplicationWindows(appId: AppId): readonly WindowSnapshot[]
  hasObservedProcesses(appId: AppId): boolean
  hasObservedWindows(appId: AppId): boolean
  getForegroundApplication(): ApplicationRuntimeEntry | undefined
  getMostRecentWindow(appId: AppId): WindowSnapshot | undefined
  activateApplication(appId: AppId): Promise<ApplicationRuntimeActionResult>
  /** Explicitly requests a fresh launch even if the app already has observed processes/windows. */
  launchApplication(
    appId: AppId,
    options?: AppLaunchOptions,
  ): Promise<ApplicationRuntimeActionResult>
  launchOrActivate(
    appId: AppId,
    options?: AppLaunchOptions,
  ): Promise<ApplicationRuntimeActionResult>
  subscribe(listener: (snapshot: ApplicationRuntimeSnapshot) => void): () => void
}

export interface ApplicationRuntimeConfig {
  readonly enabled: boolean
}

/** Stable precondition/lifecycle error raised before orchestration begins. */
export class ApplicationRuntimeError extends Error {
  readonly code: string
  readonly retryable: boolean

  constructor(code: string, message: string, retryable = false) {
    super(message)
    this.name = 'ApplicationRuntimeError'
    this.code = code
    this.retryable = retryable
  }
}
