/** Public contracts for ELIX Phase 18B Shell Navigation. */

import type {
  GlobalHotkeyBinding,
  GlobalInputSource,
  NormalizedGlobalHotkeyBinding,
} from '@deepseek-ai/dsh-global-input'
import type { SpaceId, SpacesSource } from '@deepseek-ai/dsh-spaces'
import type { WindowControlSource } from '@deepseek-ai/dsh-window-control'
import type { WindowId, WindowRegistrySource } from '@deepseek-ai/dsh-window-registry'
import type { ShellNavigationService } from './index.ts'

export type ShellNavigationCommand =
  | 'space.next'
  | 'space.previous'
  | 'overview.toggle'
  | 'task-switcher.next'
  | 'task-switcher.previous'
  | 'navigation.commit'
  | 'navigation.cancel'

export type ShellNavigationMode = 'idle' | 'overview' | 'task-switcher'
export type ShellNavigationOrigin = 'api' | 'global-hotkey' | 'local-ui'

/**
 * UI-independent shell-navigation state.
 *
 * During a task-switcher session the candidate identities are stable Window Registry WindowIds.
 * Selection does not steal foreground focus. `navigation.commit` activates `selectedWindowId`
 * through Window Control; `navigation.cancel` abandons the selection and preserves/restores the
 * original foreground application when possible.
 */
export interface ShellNavigationSnapshot {
  readonly revision: number
  readonly mode: ShellNavigationMode
  readonly taskSwitchOffset: number
  readonly taskCandidateIds: readonly WindowId[]
  readonly selectedWindowId?: WindowId | undefined
  readonly originalForegroundWindowId?: WindowId | undefined
  readonly currentSpaceId?: SpaceId | undefined
  readonly lastCommand?: ShellNavigationCommand | undefined
  readonly capturedAt: number
}

export interface ShellNavigationEvent {
  readonly command: ShellNavigationCommand
  readonly origin: ShellNavigationOrigin
  readonly previous: ShellNavigationSnapshot
  readonly current: ShellNavigationSnapshot
  readonly bindingId?: string | undefined
}

/** Configurable global binding mapped to one semantic shell command. */
export interface ShellNavigationBinding {
  readonly command: ShellNavigationCommand
  readonly hotkey: GlobalHotkeyBinding
}

export type ShellNavigationBindingState = 'registered' | 'conflict' | 'failed'

export interface ShellNavigationBindingStatus {
  readonly command: ShellNavigationBinding['command']
  readonly bindingId: string
  readonly state: ShellNavigationBindingState
  readonly binding?: NormalizedGlobalHotkeyBinding | undefined
  readonly error?: string | undefined
}

export interface ShellNavigationConfig {
  readonly enabled: boolean
  readonly registerDefaultBindings?: boolean | undefined
  readonly bindings?: readonly ShellNavigationBinding[] | undefined
  readonly globalInput?: GlobalInputSource | undefined
  readonly spaces?: SpacesSource | undefined
  readonly windowRegistry?: WindowRegistrySource | undefined
  readonly windowControl?: WindowControlSource | undefined
}

export interface ShellNavigationSource {
  getSnapshot(): ShellNavigationSnapshot
  getBindingStatuses(): readonly ShellNavigationBindingStatus[]
  execute(command: ShellNavigationCommand, origin?: ShellNavigationOrigin): Promise<ShellNavigationSnapshot>
  executeLocalKey(key: 'Enter' | 'Escape'): Promise<ShellNavigationSnapshot>
  subscribe(listener: (event: ShellNavigationEvent) => void): () => void
  initializeBindings(): Promise<readonly ShellNavigationBindingStatus[]>
}

export type ShellNavigationErrorCode =
  | 'SHELL_NAVIGATION_DISABLED'
  | 'SHELL_NAVIGATION_DISPOSED'
  | 'GLOBAL_INPUT_UNAVAILABLE'
  | 'SPACES_UNAVAILABLE'
  | 'WINDOW_REGISTRY_UNAVAILABLE'
  | 'WINDOW_CONTROL_UNAVAILABLE'
  | 'SPACE_SWITCH_UNAVAILABLE'
  | 'CURRENT_SPACE_UNKNOWN'
  | 'TASK_SWITCHER_EMPTY'
  | 'TASK_TARGET_STALE'
  | 'TASK_ACTIVATION_FAILED'
  | 'BINDING_REGISTRATION_FAILED'

export class ShellNavigationError extends Error {
  readonly code: ShellNavigationErrorCode
  readonly retryable: boolean

  constructor(code: ShellNavigationErrorCode, message: string, retryable = false) {
    super(message)
    this.name = 'ShellNavigationError'
    this.code = code
    this.retryable = retryable
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    shellNavigation: ShellNavigationService
  }
  interface Events {
    /** @mode broadcast @param service Initialized Phase 18B shell-navigation authority. */
    'shell-navigation/ready'(service: ShellNavigationService): void
    /** @mode broadcast @param event Semantic navigation state transition. */
    'shell-navigation/event'(event: ShellNavigationEvent): void
    /** @mode broadcast @param error Binding or execution fault. */
    'shell-navigation/fault'(error: Error): void
  }
}
