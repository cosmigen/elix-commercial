/**
 * ELIX Phase 18B Shell Navigation.
 *
 * Converts global hotkeys or direct API calls into semantic shell commands. Space movement
 * delegates exclusively to the Phase 18A Spaces authority. Task switching consumes stable
 * Window Registry identities and commits activation through Window Control.
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { GlobalHotkeyEvent, GlobalInputSource } from '@deepseek-ai/dsh-global-input'
import type { ObservedSpaceSnapshot, SpaceId, SpacesSource } from '@deepseek-ai/dsh-spaces'
import type { WindowControlSource } from '@deepseek-ai/dsh-window-control'
import type { WindowId, WindowRegistrySource, WindowSnapshot } from '@deepseek-ai/dsh-window-registry'
import z from '@deepseek-ai/schemastery'
import {
  ShellNavigationError,
  type ShellNavigationBinding,
  type ShellNavigationBindingStatus,
  type ShellNavigationCommand,
  type ShellNavigationConfig,
  type ShellNavigationEvent,
  type ShellNavigationOrigin,
  type ShellNavigationSnapshot,
} from './types.ts'

export * from './types.ts'

const EMPTY_WINDOW_IDS: readonly WindowId[] = Object.freeze([])
const ACTIVATION_RETRY_DELAY_MS = 80
const ACTIVATION_ATTEMPTS = 2

export const DEFAULT_SHELL_NAVIGATION_BINDINGS: readonly ShellNavigationBinding[] = Object.freeze([
  Object.freeze({
    command: 'space.next',
    hotkey: Object.freeze({
      id: 'shell-nav.space.next',
      key: 'ArrowRight',
      modifiers: Object.freeze({ control: true, alt: true, shift: true }),
    }),
  }),
  Object.freeze({
    command: 'space.previous',
    hotkey: Object.freeze({
      id: 'shell-nav.space.previous',
      key: 'ArrowLeft',
      modifiers: Object.freeze({ control: true, alt: true, shift: true }),
    }),
  }),
  Object.freeze({
    command: 'overview.toggle',
    hotkey: Object.freeze({
      id: 'shell-nav.overview.toggle',
      key: 'O',
      modifiers: Object.freeze({ control: true, alt: true, shift: true }),
    }),
  }),
  Object.freeze({
    command: 'task-switcher.next',
    hotkey: Object.freeze({
      id: 'shell-nav.task-switcher.next',
      key: 'J',
      modifiers: Object.freeze({ control: true, alt: true, shift: true }),
    }),
  }),
  Object.freeze({
    command: 'task-switcher.previous',
    hotkey: Object.freeze({
      id: 'shell-nav.task-switcher.previous',
      key: 'K',
      modifiers: Object.freeze({ control: true, alt: true, shift: true }),
    }),
  }),
  Object.freeze({
    command: 'navigation.commit',
    hotkey: Object.freeze({
      id: 'shell-nav.navigation.commit',
      key: 'Enter',
      modifiers: Object.freeze({ control: true, alt: true, shift: true }),
    }),
  }),
  Object.freeze({
    command: 'navigation.cancel',
    hotkey: Object.freeze({
      id: 'shell-nav.navigation.cancel',
      key: 'Escape',
      modifiers: Object.freeze({ control: true, alt: true, shift: true }),
    }),
  }),
])

/** UI-independent semantic navigation and task-switch session authority. */
export class ShellNavigationService extends Service {
  static Config = z.object({
    enabled: z.boolean().default(true),
    registerDefaultBindings: z.boolean().default(true),
  })

  private readonly config: ShellNavigationConfig
  private readonly listeners = new Set<(event: ShellNavigationEvent) => void>()
  private readonly bindingStatuses = new Map<string, ShellNavigationBindingStatus>()
  private readonly commandByBindingId = new Map<string, ShellNavigationCommand>()
  private inputDisposer: (() => void) | undefined
  private disposed = false
  private revision = 0
  private commandTail: Promise<unknown> = Promise.resolve()
  private bindingsPromise: Promise<readonly ShellNavigationBindingStatus[]> | undefined
  private snapshot: ShellNavigationSnapshot = Object.freeze({
    revision: 0,
    mode: 'idle',
    taskSwitchOffset: 0,
    taskCandidateIds: EMPTY_WINDOW_IDS,
    capturedAt: Date.now(),
  })

  constructor(ctx: Context, config?: Partial<ShellNavigationConfig>) {
    super(ctx, 'shellNavigation')
    this.config = {
      enabled: config?.enabled ?? true,
      registerDefaultBindings: config?.registerDefaultBindings ?? true,
      bindings: config?.bindings,
      globalInput: config?.globalInput,
      spaces: config?.spaces,
      windowRegistry: config?.windowRegistry,
      windowControl: config?.windowControl,
    }
  }

  [Service.init](): void {
    if (!this.config.enabled) return

    this.attachGlobalInput()
    this.ctx.on('global-input/ready', () => {
      this.attachGlobalInput()
      if (this.config.registerDefaultBindings !== false) {
        void this.initializeBindings().catch(error => this.emitFault(error))
      }
    })

    if (this.config.registerDefaultBindings !== false) {
      void this.initializeBindings().catch(error => this.emitFault(error))
    }

    this.ctx.effect(() => () => {
      this.disposed = true
      this.inputDisposer?.()
      this.inputDisposer = undefined
      this.listeners.clear()
      this.commandByBindingId.clear()
      this.bindingStatuses.clear()
    }, 'shellNavigation.lifecycle')

    this.ctx.emit('shell-navigation/ready', this)
  }

  getSnapshot(): ShellNavigationSnapshot {
    return this.snapshot
  }

  getBindingStatuses(): readonly ShellNavigationBindingStatus[] {
    return Object.freeze([...this.bindingStatuses.values()])
  }

  subscribe(listener: (event: ShellNavigationEvent) => void): () => void {
    this.assertAvailable()
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async initializeBindings(): Promise<readonly ShellNavigationBindingStatus[]> {
    this.assertAvailable()
    if (this.bindingsPromise) return this.bindingsPromise
    const task = this.registerBindings().finally(() => {
      if (this.bindingsPromise === task) this.bindingsPromise = undefined
    })
    this.bindingsPromise = task
    return task
  }

  async execute(
    command: ShellNavigationCommand,
    origin: ShellNavigationOrigin = 'api',
  ): Promise<ShellNavigationSnapshot> {
    this.assertAvailable()
    return this.enqueueCommand(() => this.executeNow(command, origin))
  }

  executeLocalKey(key: 'Enter' | 'Escape'): Promise<ShellNavigationSnapshot> {
    return this.execute(key === 'Enter' ? 'navigation.commit' : 'navigation.cancel', 'local-ui')
  }

  private async registerBindings(): Promise<readonly ShellNavigationBindingStatus[]> {
    const input = this.globalInput
    const bindings = this.config.bindings ?? DEFAULT_SHELL_NAVIGATION_BINDINGS
    this.attachGlobalInput()

    for (const entry of bindings) {
      this.commandByBindingId.set(entry.hotkey.id, entry.command)
      try {
        const binding = await input.register(entry.hotkey)
        this.bindingStatuses.set(entry.hotkey.id, Object.freeze({
          command: entry.command,
          bindingId: entry.hotkey.id,
          state: 'registered',
          binding,
        }))
      } catch (error) {
        const state = errorCode(error) === 'HOTKEY_CONFLICT' ? 'conflict' : 'failed'
        const status: ShellNavigationBindingStatus = Object.freeze({
          command: entry.command,
          bindingId: entry.hotkey.id,
          state,
          error: errorMessage(error),
        })
        this.bindingStatuses.set(entry.hotkey.id, status)
        this.emitFault(new ShellNavigationError(
          'BINDING_REGISTRATION_FAILED',
          `Binding '${entry.hotkey.id}' for '${entry.command}' was ${state}: ${status.error ?? 'unknown error'}`,
          state === 'failed',
        ))
      }
    }

    return this.getBindingStatuses()
  }

  private attachGlobalInput(): void {
    if (this.inputDisposer || this.disposed) return
    const input = this.resolveGlobalInput(false)
    if (!input) return
    this.inputDisposer = input.subscribe(event => this.handleGlobalHotkey(event))
  }

  private handleGlobalHotkey(event: GlobalHotkeyEvent): void {
    const command = this.commandByBindingId.get(event.bindingId)
    if (!command) return
    void this.execute(command, 'global-hotkey').catch(error => this.emitFault(error))
  }

  private async executeNow(
    command: ShellNavigationCommand,
    origin: ShellNavigationOrigin,
  ): Promise<ShellNavigationSnapshot> {
    const previous = this.snapshot
    let next: ShellNavigationSnapshot

    switch (command) {
      case 'space.next':
        next = await this.switchRelativeSpace(1, command)
        break
      case 'space.previous':
        next = await this.switchRelativeSpace(-1, command)
        break
      case 'overview.toggle':
        next = this.replaceSnapshot({
          mode: previous.mode === 'overview' ? 'idle' : 'overview',
          currentSpaceId: this.currentSpaceId(),
          lastCommand: command,
        })
        break
      case 'task-switcher.next':
        next = this.stepTaskSwitcher(1, command)
        break
      case 'task-switcher.previous':
        next = this.stepTaskSwitcher(-1, command)
        break
      case 'navigation.commit':
        next = await this.commitNavigation(command)
        break
      case 'navigation.cancel':
        next = await this.cancelNavigation(command)
        break
    }

    const event: ShellNavigationEvent = Object.freeze({ command, origin, previous, current: next })
    this.ctx.emit('shell-navigation/event', event)
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch (error) {
        this.emitFault(error)
      }
    }
    return next
  }

  private async switchRelativeSpace(
    delta: -1 | 1,
    command: 'space.next' | 'space.previous',
  ): Promise<ShellNavigationSnapshot> {
    const spaces = this.spaces
    if (!spaces.getCapabilities().switchSpace) {
      throw new ShellNavigationError(
        'SPACE_SWITCH_UNAVAILABLE',
        `Phase 18A provider '${spaces.getCapabilities().provider}' cannot switch Spaces.`,
        true,
      )
    }

    const source = await spaces.refresh()
    const current = source.currentSpaceId
    if (!current) {
      throw new ShellNavigationError('CURRENT_SPACE_UNKNOWN', 'Phase 18A did not expose a current Space.', true)
    }

    const ordered = orderSpaces(source.spaces)
    const currentIndex = ordered.findIndex(space => space.id === current)
    if (currentIndex < 0 || ordered.length === 0) {
      throw new ShellNavigationError(
        'CURRENT_SPACE_UNKNOWN',
        `Current Space '${current}' is absent from the Phase 18A enumeration.`,
        true,
      )
    }

    const target = ordered[modulo(currentIndex + delta, ordered.length)]!
    const switched = target.id === current ? source : await spaces.switchSpace(target.id)
    return this.replaceSnapshot({
      mode: 'idle',
      currentSpaceId: switched.currentSpaceId ?? target.id,
      lastCommand: command,
    })
  }

  private stepTaskSwitcher(
    delta: -1 | 1,
    command: 'task-switcher.next' | 'task-switcher.previous',
  ): ShellNavigationSnapshot {
    const previous = this.snapshot
    const starting = previous.mode !== 'task-switcher' || previous.taskCandidateIds.length === 0
    const candidates = starting
      ? this.buildTaskCandidates()
      : this.reconcileTaskCandidates(previous.taskCandidateIds)

    if (candidates.length === 0) {
      throw new ShellNavigationError(
        'TASK_SWITCHER_EMPTY',
        'No eligible APPLICATION windows are available on the current Space.',
        true,
      )
    }

    const originalForegroundWindowId = starting
      ? this.windowRegistry.getForegroundWindow()?.id
      : previous.originalForegroundWindowId
    const offset = candidates.length === 1
      ? 0
      : (starting ? delta : previous.taskSwitchOffset + delta)
    const selectedWindowId = candidates[modulo(offset, candidates.length)]!

    return this.replaceSnapshot({
      mode: 'task-switcher',
      taskSwitchOffset: offset,
      taskCandidateIds: candidates,
      selectedWindowId,
      originalForegroundWindowId,
      currentSpaceId: this.currentSpaceId(),
      lastCommand: command,
    })
  }

  private buildTaskCandidates(): readonly WindowId[] {
    const registry = this.windowRegistry
    const spaces = this.spaces.getSnapshot()
    const currentSpaceId = spaces.currentSpaceId
    if (!currentSpaceId) {
      throw new ShellNavigationError('CURRENT_SPACE_UNKNOWN', 'Cannot build task candidates without a current Space.', true)
    }
    const currentSpace = spaces.spaces.find(space => space.id === currentSpaceId)
    if (!currentSpace) {
      throw new ShellNavigationError(
        'CURRENT_SPACE_UNKNOWN',
        `Current Space '${currentSpaceId}' is absent from the Phase 18A enumeration.`,
        true,
      )
    }

    const onCurrentSpace = new Set(currentSpace.windowIds)
    const foregroundId = registry.getForegroundWindow()?.id
    return Object.freeze(registry.getWindows()
      .filter(window => onCurrentSpace.has(window.id) && isTaskCandidate(window))
      .sort((left, right) => compareTaskCandidates(left, right, foregroundId))
      .map(window => window.id))
  }

  private reconcileTaskCandidates(previous: readonly WindowId[]): readonly WindowId[] {
    const registry = this.windowRegistry
    const spaces = this.spaces.getSnapshot()
    const currentSpace = spaces.spaces.find(space => space.id === spaces.currentSpaceId)
    if (!currentSpace) return this.buildTaskCandidates()

    const onCurrentSpace = new Set(currentSpace.windowIds)
    const live = previous.filter(id => {
      const window = registry.getWindow(id)
      return window !== undefined && onCurrentSpace.has(id) && isTaskCandidate(window)
    })
    return live.length > 0 ? Object.freeze(live) : this.buildTaskCandidates()
  }

  private async commitNavigation(command: 'navigation.commit'): Promise<ShellNavigationSnapshot> {
    const previous = this.snapshot
    if (previous.mode === 'task-switcher' && previous.selectedWindowId) {
      const selected = this.windowRegistry.getWindow(previous.selectedWindowId)
      if (!selected || !isTaskCandidate(selected)) {
        throw new ShellNavigationError(
          'TASK_TARGET_STALE',
          `Selected WindowId '${previous.selectedWindowId}' is no longer an eligible application window.`,
          true,
        )
      }
      await this.activateTaskTarget(previous.selectedWindowId)
    }

    return this.replaceSnapshot({
      mode: 'idle',
      currentSpaceId: this.currentSpaceId(),
      lastCommand: command,
    })
  }

  private async cancelNavigation(command: 'navigation.cancel'): Promise<ShellNavigationSnapshot> {
    const previous = this.snapshot
    if (previous.mode === 'task-switcher' && previous.originalForegroundWindowId) {
      const foreground = this.windowRegistry.getForegroundWindow()?.id
      const original = this.windowRegistry.getWindow(previous.originalForegroundWindowId)
      if (foreground !== previous.originalForegroundWindowId && original && isTaskCandidate(original)) {
        try {
          await this.activateTaskTarget(previous.originalForegroundWindowId)
        } catch (error) {
          this.emitFault(error)
        }
      }
    }

    return this.replaceSnapshot({
      mode: 'idle',
      currentSpaceId: this.currentSpaceId(),
      lastCommand: command,
    })
  }

  /**
   * Bounded activation confirmation. Windows may defer foreground transfer while restoring a
   * minimized app, so one short retry is allowed. We still refuse to report success until the
   * authoritative Registry or native observation confirms the selected WindowId is foreground.
   */
  private async activateTaskTarget(windowId: WindowId): Promise<void> {
    let lastFailure = 'Windows did not confirm foreground activation.'
    for (let attempt = 0; attempt < ACTIVATION_ATTEMPTS; attempt++) {
      try {
        const result = await this.windowControl.activate(windowId)
        if (result.accepted && result.completed && result.observation.foreground) {
          await this.windowRegistry.refresh().catch(error => this.emitFault(error))
          return
        }
        lastFailure = `accepted=${result.accepted}, completed=${result.completed}, foreground=${result.observation.foreground}`
      } catch (error) {
        lastFailure = errorMessage(error)
      }

      const refreshed = await this.windowRegistry.refresh().catch(error => {
        this.emitFault(error)
        return undefined
      })
      if (refreshed?.foregroundWindowId === windowId || this.windowRegistry.getForegroundWindow()?.id === windowId) {
        return
      }
      if (attempt + 1 < ACTIVATION_ATTEMPTS) await delay(ACTIVATION_RETRY_DELAY_MS)
    }

    throw new ShellNavigationError(
      'TASK_ACTIVATION_FAILED',
      `Windows did not foreground selected WindowId '${windowId}' after ${ACTIVATION_ATTEMPTS} bounded attempt(s): ${lastFailure}`,
      true,
    )
  }

  private replaceSnapshot(input: {
    readonly mode: ShellNavigationSnapshot['mode']
    readonly taskSwitchOffset?: number | undefined
    readonly taskCandidateIds?: readonly WindowId[] | undefined
    readonly selectedWindowId?: WindowId | undefined
    readonly originalForegroundWindowId?: WindowId | undefined
    readonly currentSpaceId?: SpaceId | undefined
    readonly lastCommand: ShellNavigationCommand
  }): ShellNavigationSnapshot {
    const taskCandidateIds = input.mode === 'task-switcher'
      ? Object.freeze([...(input.taskCandidateIds ?? EMPTY_WINDOW_IDS)])
      : EMPTY_WINDOW_IDS
    const next: ShellNavigationSnapshot = Object.freeze({
      revision: ++this.revision,
      mode: input.mode,
      taskSwitchOffset: input.mode === 'task-switcher' ? (input.taskSwitchOffset ?? 0) : 0,
      taskCandidateIds,
      ...(input.mode === 'task-switcher' && input.selectedWindowId
        ? { selectedWindowId: input.selectedWindowId }
        : {}),
      ...(input.mode === 'task-switcher' && input.originalForegroundWindowId
        ? { originalForegroundWindowId: input.originalForegroundWindowId }
        : {}),
      ...(input.currentSpaceId ? { currentSpaceId: input.currentSpaceId } : {}),
      lastCommand: input.lastCommand,
      capturedAt: Date.now(),
    })
    this.snapshot = next
    return next
  }

  private currentSpaceId(): SpaceId | undefined {
    return this.resolveSpaces(false)?.getCurrentSpaceId()
  }

  private enqueueCommand<T>(task: () => Promise<T>): Promise<T> {
    const run = this.commandTail.then(task, task)
    this.commandTail = run.then(() => undefined, () => undefined)
    return run
  }

  private get globalInput(): GlobalInputSource {
    const input = this.resolveGlobalInput(true)
    if (!input) throw new ShellNavigationError('GLOBAL_INPUT_UNAVAILABLE', 'Global Input service is unavailable.', true)
    return input
  }

  private get spaces(): SpacesSource {
    const spaces = this.resolveSpaces(true)
    if (!spaces) throw new ShellNavigationError('SPACES_UNAVAILABLE', 'Phase 18A Spaces service is unavailable.', true)
    return spaces
  }

  private get windowRegistry(): WindowRegistrySource {
    const registry = this.resolveWindowRegistry(true)
    if (!registry) {
      throw new ShellNavigationError('WINDOW_REGISTRY_UNAVAILABLE', 'Task switching requires Window Registry.', true)
    }
    return registry
  }

  private get windowControl(): WindowControlSource {
    const control = this.resolveWindowControl(true)
    if (!control) {
      throw new ShellNavigationError('WINDOW_CONTROL_UNAVAILABLE', 'Task switching requires Window Control.', true)
    }
    return control
  }

  private resolveGlobalInput(required: boolean): GlobalInputSource | undefined {
    const input = this.config.globalInput ?? (this.ctx.get('globalInput') as GlobalInputSource | undefined)
    if (!input && required) throw new ShellNavigationError('GLOBAL_INPUT_UNAVAILABLE', 'Global Input service is unavailable.', true)
    return input
  }

  private resolveSpaces(required: boolean): SpacesSource | undefined {
    const spaces = this.config.spaces ?? (this.ctx.get('spaces') as SpacesSource | undefined)
    if (!spaces && required) throw new ShellNavigationError('SPACES_UNAVAILABLE', 'Phase 18A Spaces service is unavailable.', true)
    return spaces
  }

  private resolveWindowRegistry(required: boolean): WindowRegistrySource | undefined {
    const registry = this.config.windowRegistry
      ?? (this.ctx.get('windowRegistry') as WindowRegistrySource | undefined)
    if (!registry && required) {
      throw new ShellNavigationError('WINDOW_REGISTRY_UNAVAILABLE', 'Window Registry service is unavailable.', true)
    }
    return registry
  }

  private resolveWindowControl(required: boolean): WindowControlSource | undefined {
    const control = this.config.windowControl
      ?? (this.ctx.get('windowControl') as WindowControlSource | undefined)
    if (!control && required) {
      throw new ShellNavigationError('WINDOW_CONTROL_UNAVAILABLE', 'Window Control service is unavailable.', true)
    }
    return control
  }

  private assertAvailable(): void {
    if (!this.config.enabled) throw new ShellNavigationError('SHELL_NAVIGATION_DISABLED', 'Shell Navigation is disabled.')
    if (this.disposed) throw new ShellNavigationError('SHELL_NAVIGATION_DISPOSED', 'Shell Navigation is disposed.')
  }

  private emitFault(error: unknown): void {
    const fault = error instanceof Error ? error : new Error(String(error))
    try {
      this.ctx.emit('shell-navigation/fault', fault)
    } catch {
      // Diagnostics cannot break navigation.
    }
  }
}

function orderSpaces(spaces: readonly ObservedSpaceSnapshot[]): readonly ObservedSpaceSnapshot[] {
  return [...spaces].sort((left, right) => {
    const leftIndex = left.index ?? Number.MAX_SAFE_INTEGER
    const rightIndex = right.index ?? Number.MAX_SAFE_INTEGER
    if (leftIndex !== rightIndex) return leftIndex - rightIndex
    return String(left.id).localeCompare(String(right.id))
  })
}

function isTaskCandidate(window: WindowSnapshot): boolean {
  return window.classification === 'APPLICATION'
    && window.isVisible
    && window.isEnabled
    && !window.isCloaked
}

function compareTaskCandidates(
  left: WindowSnapshot,
  right: WindowSnapshot,
  foregroundId: WindowId | undefined,
): number {
  if (left.id === foregroundId && right.id !== foregroundId) return -1
  if (right.id === foregroundId && left.id !== foregroundId) return 1
  if (left.updatedRevision !== right.updatedRevision) return right.updatedRevision - left.updatedRevision
  if (left.firstSeen !== right.firstSeen) return right.firstSeen - left.firstSeen
  return String(left.id).localeCompare(String(right.id))
}

function modulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined
  const code = Reflect.get(error, 'code')
  return typeof code === 'string' ? code : undefined
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export default ShellNavigationService
