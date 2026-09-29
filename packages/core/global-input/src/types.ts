/** Public contracts for ELIX Phase 18B Global Input. */

import type { NativeBridgeClient } from '@deepseek-ai/dsh-native-core'
import type { GlobalInputService } from './index.ts'

export type GlobalKey = string

export interface GlobalHotkeyModifiers {
  readonly alt?: boolean | undefined
  readonly control?: boolean | undefined
  readonly shift?: boolean | undefined
  readonly win?: boolean | undefined
}

export interface GlobalHotkeyBinding {
  /** Stable ELIX-owned identifier. */
  readonly id: string
  /** Normalized symbolic key, e.g. PageDown, O, F8, ArrowLeft. */
  readonly key: GlobalKey
  readonly modifiers: GlobalHotkeyModifiers
  /** Defaults to true. */
  readonly noRepeat?: boolean | undefined
}

export interface NormalizedGlobalHotkeyBinding {
  readonly id: string
  readonly key: string
  readonly virtualKey: number
  readonly modifiers: {
    readonly alt: boolean
    readonly control: boolean
    readonly shift: boolean
    readonly win: boolean
  }
  readonly noRepeat: boolean
}

export interface GlobalHotkeyEvent {
  readonly bindingId: string
  readonly key: string
  readonly virtualKey: number
  readonly modifiers: NormalizedGlobalHotkeyBinding['modifiers']
  readonly sequence: number
  readonly capturedAt: number
}

export interface NativeGlobalHotkeyRegistration {
  readonly bindingId: string
  readonly nativeId: number
  readonly binding: NormalizedGlobalHotkeyBinding
}

export interface NativeGlobalInputSnapshot {
  readonly provider: 'win32-register-hot-key'
  readonly registrations: readonly NativeGlobalHotkeyRegistration[]
}

export interface GlobalInputCapabilities {
  readonly provider: 'win32-register-hot-key'
  readonly systemWideHotkeys: boolean
  readonly noRepeat: boolean
  readonly arbitraryKeyLogging: false
}

export interface GlobalInputNativeAdapter {
  getGeneration(): number
  register(binding: NormalizedGlobalHotkeyBinding): Promise<NativeGlobalHotkeyRegistration>
  unregister(bindingId: string): Promise<boolean>
  snapshot(): Promise<NativeGlobalInputSnapshot>
  drainEvents(): Promise<readonly GlobalHotkeyEvent[]>
}

export interface GlobalInputSource {
  getCapabilities(): GlobalInputCapabilities
  getBindings(): readonly NormalizedGlobalHotkeyBinding[]
  register(binding: GlobalHotkeyBinding): Promise<NormalizedGlobalHotkeyBinding>
  unregister(bindingId: string): Promise<boolean>
  subscribe(listener: (event: GlobalHotkeyEvent) => void): () => void
  reconcile(): Promise<void>
}

export interface GlobalInputConfig {
  readonly enabled: boolean
  readonly bridge?: NativeBridgeClient | undefined
  readonly nativeAdapter?: GlobalInputNativeAdapter | undefined
  /** Native event drain interval. Defaults to 40ms. */
  readonly pollIntervalMs?: number | undefined
}

export type GlobalInputErrorCode =
  | 'GLOBAL_INPUT_DISABLED'
  | 'GLOBAL_INPUT_DISPOSED'
  | 'INVALID_BINDING'
  | 'DUPLICATE_BINDING_ID'
  | 'HOTKEY_CONFLICT'
  | 'NATIVE_GLOBAL_INPUT_UNAVAILABLE'
  | 'REGISTRATION_FAILED'
  | 'UNREGISTRATION_FAILED'

export class GlobalInputError extends Error {
  readonly code: GlobalInputErrorCode
  readonly retryable: boolean

  constructor(code: GlobalInputErrorCode, message: string, retryable = false) {
    super(message)
    this.name = 'GlobalInputError'
    this.code = code
    this.retryable = retryable
  }
}

declare module '@deepseek-ai/dsh-native-core' {
  interface NativeCapabilities {
    readonly globalInput?: boolean | undefined
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    globalInput: GlobalInputService
  }
  interface Events {
    /** @mode broadcast @param service Initialized Phase 18B global-input authority. */
    'global-input/ready'(service: GlobalInputService): void
    /** @mode broadcast @param event One explicitly registered global hotkey activation. */
    'global-input/hotkey'(event: GlobalHotkeyEvent): void
    /** @mode broadcast @param error Registration, provider, or recovery fault. */
    'global-input/fault'(error: Error): void
  }
}
