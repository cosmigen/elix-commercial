/**
 * ELIX Phase 18B Global Input service.
 *
 * Owns explicit system-wide hotkey registrations and event delivery. It does not
 * observe arbitrary user keystrokes and contains no shell-navigation policy.
 */

import { Context, Service } from '@deepseek-ai/cordis'
import {
  getSharedNativeBridge,
  type NativeBridgeClient,
} from '@deepseek-ai/dsh-native-core'
import z from '@deepseek-ai/schemastery'
import { normalizeGlobalHotkeyBinding, sameGlobalHotkeyBinding } from './keymap.ts'
import {
  GlobalInputError,
  type GlobalHotkeyBinding,
  type GlobalHotkeyEvent,
  type GlobalInputCapabilities,
  type GlobalInputConfig,
  type GlobalInputNativeAdapter,
  type NativeGlobalHotkeyRegistration,
  type NativeGlobalInputSnapshot,
  type NormalizedGlobalHotkeyBinding,
} from './types.ts'

export * from './types.ts'
export * from './keymap.ts'

const CAPABILITIES: GlobalInputCapabilities = Object.freeze({
  provider: 'win32-register-hot-key',
  systemWideHotkeys: true,
  noRepeat: true,
  arbitraryKeyLogging: false,
})

class BridgeGlobalInputAdapter implements GlobalInputNativeAdapter {
  constructor(private readonly bridge: NativeBridgeClient) {}

  getGeneration(): number {
    return this.bridge.getHostGeneration()
  }

  private async ready(): Promise<void> {
    if (!this.bridge.isReady()) await this.bridge.connect()
  }

  async register(binding: NormalizedGlobalHotkeyBinding): Promise<NativeGlobalHotkeyRegistration> {
    await this.ready()
    return this.bridge.sendRequest<NativeGlobalHotkeyRegistration>('globalInput/register', { binding })
  }

  async unregister(bindingId: string): Promise<boolean> {
    await this.ready()
    const result = await this.bridge.sendRequest<{ readonly unregistered: boolean }>(
      'globalInput/unregister',
      { bindingId },
    )
    return result.unregistered
  }

  async snapshot(): Promise<NativeGlobalInputSnapshot> {
    await this.ready()
    return this.bridge.sendRequest<NativeGlobalInputSnapshot>('globalInput/snapshot', {})
  }

  async drainEvents(): Promise<readonly GlobalHotkeyEvent[]> {
    await this.ready()
    const result = await this.bridge.sendRequest<{ readonly events: readonly GlobalHotkeyEvent[] }>(
      'globalInput/drainEvents',
      {},
    )
    return result.events
  }
}

/** UI-independent authority for explicitly registered global hotkeys. */
export class GlobalInputService extends Service {
  static Config = z.object({
    enabled: z.boolean().default(true),
    pollIntervalMs: z.number().default(40),
  })

  private readonly config: GlobalInputConfig
  private readonly desired = new Map<string, NormalizedGlobalHotkeyBinding>()
  private readonly listeners = new Set<(event: GlobalHotkeyEvent) => void>()
  private bridgeInstance: NativeBridgeClient | undefined
  private adapterInstance: GlobalInputNativeAdapter | undefined
  private pollTimer: ReturnType<typeof setInterval> | undefined
  private pollActive = false
  private disposed = false
  private reconciledGeneration = -1
  private reconcilePromise: Promise<void> | undefined

  constructor(ctx: Context, config?: Partial<GlobalInputConfig>) {
    super(ctx, 'globalInput')
    this.config = {
      enabled: config?.enabled ?? true,
      bridge: config?.bridge,
      nativeAdapter: config?.nativeAdapter,
      pollIntervalMs: config?.pollIntervalMs ?? 40,
    }
  }

  [Service.init](): void {
    if (!this.config.enabled) return

    this.bridgeInstance = this.config.bridge ?? getSharedNativeBridge()
    this.adapterInstance = this.config.nativeAdapter
      ?? new BridgeGlobalInputAdapter(this.bridgeInstance)

    const interval = Math.max(20, this.config.pollIntervalMs ?? 40)
    this.pollTimer = setInterval(() => {
      void this.poll().catch(error => this.emitFault(error))
    }, interval)
    if (typeof this.pollTimer === 'object' && 'unref' in this.pollTimer) this.pollTimer.unref()

    this.ctx.effect(() => () => {
      this.disposed = true
      if (this.pollTimer) clearInterval(this.pollTimer)
      this.pollTimer = undefined
      const adapter = this.adapterInstance
      const ids = [...this.desired.keys()]
      this.desired.clear()
      this.listeners.clear()
      if (adapter) {
        void Promise.allSettled(ids.map(id => adapter.unregister(id)))
      }
      this.adapterInstance = undefined
      this.bridgeInstance = undefined
    }, 'globalInput.lifecycle')

    this.ctx.emit('global-input/ready', this)
  }

  getCapabilities(): GlobalInputCapabilities {
    return CAPABILITIES
  }

  getBindings(): readonly NormalizedGlobalHotkeyBinding[] {
    return Object.freeze([...this.desired.values()])
  }

  async register(binding: GlobalHotkeyBinding): Promise<NormalizedGlobalHotkeyBinding> {
    this.assertAvailable()
    const normalized = normalizeGlobalHotkeyBinding(binding)
    const current = this.desired.get(normalized.id)
    if (current) {
      if (sameGlobalHotkeyBinding(current, normalized)) return current
      throw new GlobalInputError(
        'DUPLICATE_BINDING_ID',
        `Global hotkey id '${normalized.id}' is already bound to ${describeBinding(current)}.`,
      )
    }

    try {
      await this.adapter.register(normalized)
      this.desired.set(normalized.id, normalized)
      this.reconciledGeneration = this.adapter.getGeneration()
      return normalized
    } catch (error) {
      throw normalizeNativeError(error, 'REGISTRATION_FAILED', `Failed to register ${describeBinding(normalized)}.`)
    }
  }

  async unregister(bindingId: string): Promise<boolean> {
    this.assertAvailable()
    if (!this.desired.has(bindingId)) return false
    try {
      const unregistered = await this.adapter.unregister(bindingId)
      if (unregistered) this.desired.delete(bindingId)
      return unregistered
    } catch (error) {
      throw normalizeNativeError(error, 'UNREGISTRATION_FAILED', `Failed to unregister '${bindingId}'.`)
    }
  }

  subscribe(listener: (event: GlobalHotkeyEvent) => void): () => void {
    this.assertAvailable()
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async reconcile(): Promise<void> {
    this.assertAvailable()
    if (this.reconcilePromise) return this.reconcilePromise
    const task = this.reconcileDesired().finally(() => {
      if (this.reconcilePromise === task) this.reconcilePromise = undefined
    })
    this.reconcilePromise = task
    return task
  }

  private async reconcileDesired(): Promise<void> {
    const generation = this.adapter.getGeneration()
    const snapshot = await this.adapter.snapshot()
    const current = new Map(snapshot.registrations.map(registration => [registration.bindingId, registration]))

    for (const binding of this.desired.values()) {
      const registration = current.get(binding.id)
      if (registration && sameGlobalHotkeyBinding(registration.binding, binding)) continue
      if (registration) await this.adapter.unregister(binding.id)
      try {
        await this.adapter.register(binding)
      } catch (error) {
        this.emitFault(normalizeNativeError(
          error,
          'REGISTRATION_FAILED',
          `Failed to restore ${describeBinding(binding)} after native-host generation ${generation}.`,
        ))
      }
    }
    this.reconciledGeneration = this.adapter.getGeneration()
  }

  private async poll(): Promise<void> {
    if (this.pollActive || this.disposed || !this.config.enabled) return
    this.pollActive = true
    try {
      const generation = this.adapter.getGeneration()
      if (generation !== this.reconciledGeneration && this.desired.size > 0) {
        await this.reconcile()
      }

      const events = await this.adapter.drainEvents()
      for (const event of events) {
        if (!this.desired.has(event.bindingId)) continue
        this.ctx.emit('global-input/hotkey', event)
        for (const listener of [...this.listeners]) {
          try {
            listener(event)
          } catch (error) {
            this.emitFault(error)
          }
        }
      }
    } finally {
      this.pollActive = false
    }
  }

  private get adapter(): GlobalInputNativeAdapter {
    this.assertAvailable()
    const adapter = this.adapterInstance
    if (!adapter) {
      throw new GlobalInputError(
        'NATIVE_GLOBAL_INPUT_UNAVAILABLE',
        'Global Input native adapter is unavailable.',
        true,
      )
    }
    return adapter
  }

  private assertAvailable(): void {
    if (!this.config.enabled) {
      throw new GlobalInputError('GLOBAL_INPUT_DISABLED', 'Global Input is disabled by configuration.')
    }
    if (this.disposed) {
      throw new GlobalInputError('GLOBAL_INPUT_DISPOSED', 'Global Input service is disposed.')
    }
  }

  private emitFault(error: unknown): void {
    const fault = error instanceof Error ? error : new Error(String(error))
    try {
      this.ctx.emit('global-input/fault', fault)
    } catch {
      // Diagnostic observers cannot break input delivery.
    }
  }
}

function nativeCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined
  const code = Reflect.get(error, 'code')
  return typeof code === 'string' ? code : undefined
}

function nativeMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message
  if (error && typeof error === 'object' && 'message' in error) {
    const message = Reflect.get(error, 'message')
    if (typeof message === 'string' && message.trim()) return message
  }
  return fallback
}

function normalizeNativeError(
  error: unknown,
  fallbackCode: 'REGISTRATION_FAILED' | 'UNREGISTRATION_FAILED',
  fallbackMessage: string,
): GlobalInputError {
  if (error instanceof GlobalInputError) return error
  const code = nativeCode(error)
  if (code === 'HOTKEY_CONFLICT' || code === 'WINDOWS_ERROR_0x80070581') {
    return new GlobalInputError('HOTKEY_CONFLICT', nativeMessage(error, fallbackMessage), false)
  }
  if (code === 'METHOD_NOT_FOUND' || code === 'NATIVE_GLOBAL_INPUT_UNAVAILABLE') {
    return new GlobalInputError('NATIVE_GLOBAL_INPUT_UNAVAILABLE', nativeMessage(error, fallbackMessage), true)
  }
  return new GlobalInputError(fallbackCode, nativeMessage(error, fallbackMessage), true)
}

function describeBinding(binding: NormalizedGlobalHotkeyBinding): string {
  const parts = [
    binding.modifiers.control ? 'Ctrl' : undefined,
    binding.modifiers.alt ? 'Alt' : undefined,
    binding.modifiers.shift ? 'Shift' : undefined,
    binding.modifiers.win ? 'Win' : undefined,
    binding.key,
  ].filter((part): part is string => Boolean(part))
  return `'${binding.id}' (${parts.join('+')})`
}

export default GlobalInputService
