/**
 * Authoritative ELIX Phase 18A Spaces service.
 *
 * Stable cross-process membership reads always use Microsoft's documented
 * IVirtualDesktopManager surface. When the isolated Windows Shell provider
 * runtime-probes successfully, the same authority upgrades to complete desktop
 * enumeration, switching, create/remove/rename, arbitrary application moves,
 * and native change detection. Any Shell failure falls back to the documented
 * read provider instead of taking Spaces down.
 *
 * @module @deepseek-ai/dsh-spaces
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { getSharedNativeBridge, type NativeBridgeClient } from '@deepseek-ai/dsh-native-core'
import type {
  WindowId,
  WindowRegistrySource,
  WindowSnapshot,
} from '@deepseek-ai/dsh-window-registry'
import z from '@deepseek-ai/schemastery'
import {
  nativeDesktopIdFromSpaceId,
  sameWindowLifetime,
  spaceIdFromNativeDesktopId,
} from './invariant.ts'
import type {
  ObservedSpaceSnapshot,
  SpaceId,
  SpacesCapabilities,
  SpacesConfig,
  SpacesErrorCode,
  SpacesSnapshot,
  SpacesSource,
  WindowSpaceMembership,
} from './types.ts'

export * from './types.ts'

interface NativeWindowTarget {
  readonly hwnd: number
  readonly processId: number
  readonly threadId: number
  readonly processCreationTime: number
  readonly className: string
}

interface NativeSpaceMembership {
  readonly hwnd: number
  readonly desktopId: string
  readonly onCurrentDesktop: boolean
}

interface NativeShellSpace {
  readonly desktopId: string
  readonly index: number
  readonly name: string
  readonly isCurrent: boolean
}

interface NativeShellSpacesSnapshot {
  readonly provider: 'windows-shell-virtual-desktop'
  readonly backendVersion: string
  readonly spaces: readonly NativeShellSpace[]
  readonly currentDesktopId: string
  readonly nativeNotifications: boolean
  readonly notificationGeneration: number
}

interface NativeShellNotificationStatus {
  readonly generation: number
  readonly active: boolean
}

const PUBLIC_CAPABILITIES: SpacesCapabilities = Object.freeze({
  provider: 'windows-public-virtual-desktop-manager',
  windowMembership: true,
  currentWindowMembership: true,
  moveWindow: false,
  enumerateSpaces: false,
  switchSpace: false,
  createSpace: false,
  removeSpace: false,
  renameSpace: false,
  nativeNotifications: false,
})

const SHELL_CAPABILITIES_WITH_NOTIFICATIONS: SpacesCapabilities = Object.freeze({
  provider: 'windows-shell-virtual-desktop',
  windowMembership: true,
  currentWindowMembership: true,
  moveWindow: true,
  enumerateSpaces: true,
  switchSpace: true,
  createSpace: true,
  removeSpace: true,
  renameSpace: true,
  nativeNotifications: true,
})

const SHELL_CAPABILITIES_WITH_POLLING: SpacesCapabilities = Object.freeze({
  ...SHELL_CAPABILITIES_WITH_NOTIFICATIONS,
  nativeNotifications: false,
})

/** Stable, machine-readable service error for Phase 18A Spaces consumers. */
export class SpacesError extends Error {
  readonly code: SpacesErrorCode
  readonly retryable: boolean

  constructor(code: SpacesErrorCode, message: string, retryable = false) {
    super(message)
    this.name = 'SpacesError'
    this.code = code
    this.retryable = retryable
  }
}

/** Runtime-qualified Windows virtual-desktop authority. */
export class SpacesService extends Service implements SpacesSource {
  static Config = z.object({ enabled: z.boolean().default(true) })

  private readonly config: SpacesConfig
  private bridgeInstance: NativeBridgeClient | null = null
  private registryInstance: WindowRegistrySource | undefined
  private registryDisposer: (() => void) | undefined
  private readonly listeners = new Set<(snapshot: SpacesSnapshot) => void>()
  private readonly activeMoves = new Set<WindowId>()
  private disposed = false
  private revision = 0
  private requestedRefresh = 0
  private completedRefresh = 0
  private refreshWorker: Promise<void> | undefined
  private capabilities: SpacesCapabilities = PUBLIC_CAPABILITIES
  private lastShellNotificationGeneration = 0
  private lastShellFingerprint = ''
  private lastPublicShellProbeAt = 0
  private pollTimer: ReturnType<typeof setInterval> | undefined
  private snapshot: SpacesSnapshot = Object.freeze({
    revision: 0,
    spaces: Object.freeze([]),
    unresolvedWindowIds: Object.freeze([]),
    capabilities: PUBLIC_CAPABILITIES,
    completeness: 'observed-application-windows',
    capturedAt: 0,
  })

  constructor(ctx: Context, config?: Partial<SpacesConfig>) {
    super(ctx, 'spaces')
    this.config = {
      enabled: config?.enabled ?? true,
      bridge: config?.bridge,
      shellChangePollMs: config?.shellChangePollMs ?? 400,
    }
  }

  [Service.init](): void {
    if (!this.config.enabled) return
    this.bridgeInstance = this.config.bridge ?? getSharedNativeBridge()
    this.attachRegistry(this.ctx.get('windowRegistry') as WindowRegistrySource | undefined)

    this.ctx.on('window-registry/ready', service => {
      this.attachRegistry(service)
    })
    this.ctx.on('window-registry/recovered', () => {
      void this.scheduleRefresh().catch(error => this.emitFault(error))
    })

    const interval = Math.max(200, this.config.shellChangePollMs ?? 400)
    this.pollTimer = setInterval(() => {
      void this.pollShellChanges().catch(error => this.emitFault(error))
    }, interval)
    if (typeof this.pollTimer === 'object' && 'unref' in this.pollTimer) {
      this.pollTimer.unref()
    }

    this.ctx.effect(() => () => {
      this.disposed = true
      if (this.pollTimer) clearInterval(this.pollTimer)
      this.pollTimer = undefined
      this.registryDisposer?.()
      this.registryDisposer = undefined
      this.registryInstance = undefined
      this.bridgeInstance = null
      this.listeners.clear()
      this.activeMoves.clear()
    }, 'spaces.lifecycle')

    this.ctx.emit('spaces/ready', this)
    void this.scheduleRefresh().catch(error => this.emitFault(error))
  }

  getCapabilities(): SpacesCapabilities {
    return this.capabilities
  }

  getSnapshot(): SpacesSnapshot {
    return this.snapshot
  }

  getObservedSpaces(): readonly ObservedSpaceSnapshot[] {
    return this.snapshot.spaces
  }

  getCurrentSpaceId(): SpaceId | undefined {
    return this.snapshot.currentSpaceId
  }

  async getWindowSpace(windowId: WindowId): Promise<WindowSpaceMembership> {
    this.assertAvailable()
    return this.queryMembership(this.resolveApplicationWindow(windowId))
  }

  async isWindowOnCurrentSpace(windowId: WindowId): Promise<boolean> {
    return (await this.getWindowSpace(windowId)).onCurrentSpace
  }

  async moveWindowToSpace(
    windowId: WindowId,
    spaceId: SpaceId,
  ): Promise<WindowSpaceMembership> {
    this.assertCapability('moveWindow')
    if (this.activeMoves.has(windowId)) {
      throw new SpacesError(
        'OPERATION_CONFLICT',
        `A Spaces move is already active for WindowId '${windowId}'.`,
        true,
      )
    }

    const nativeDesktopId = this.requireObservedSpace(spaceId)
    const window = this.resolveApplicationWindow(windowId)
    this.activeMoves.add(windowId)
    try {
      const native = await this.bridge.sendRequest<NativeSpaceMembership>('spaces/shellMoveWindow', {
        target: this.buildNativeTarget(window),
        desktopId: nativeDesktopId,
      })
      this.refenceWindowLifetime(window)
      const committedSpaceId = this.spaceIdFromNative(native.desktopId)
      if (native.hwnd !== window.hwnd || committedSpaceId !== spaceId) {
        throw new SpacesError(
          'MOVE_NOT_CONFIRMED',
          `Windows Shell did not confirm WindowId '${windowId}' on requested SpaceId '${spaceId}'.`,
          true,
        )
      }
      const membership = this.freezeMembership(windowId, committedSpaceId, native.onCurrentDesktop)
      await this.scheduleRefresh()
      return membership
    } catch (error) {
      throw this.normalizeNativeError(error, 'MOVE_FAILED', `Failed to move WindowId '${windowId}'.`)
    } finally {
      this.activeMoves.delete(windowId)
    }
  }

  async switchSpace(spaceId: SpaceId): Promise<SpacesSnapshot> {
    this.assertCapability('switchSpace')
    const desktopId = this.requireObservedSpace(spaceId)
    try {
      const native = await this.bridge.sendRequest<NativeShellSpacesSnapshot>('spaces/shellSwitch', {
        desktopId,
      })
      if (this.spaceIdFromNative(native.currentDesktopId) !== spaceId) {
        throw new SpacesError(
          'SWITCH_FAILED',
          `Windows Shell did not commit Space '${spaceId}' as current.`,
          true,
        )
      }
      return await this.scheduleRefresh()
    } catch (error) {
      throw this.normalizeNativeError(error, 'SWITCH_FAILED', `Failed to switch to Space '${spaceId}'.`)
    }
  }

  async createSpace(name?: string): Promise<ObservedSpaceSnapshot> {
    this.assertCapability('createSpace')
    try {
      const native = await this.bridge.sendRequest<NativeShellSpace>('spaces/shellCreate', {
        ...(name === undefined ? {} : { name }),
      })
      const createdId = this.spaceIdFromNative(native.desktopId)
      const refreshed = await this.scheduleRefresh()
      const created = refreshed.spaces.find(space => space.id === createdId)
      if (!created) {
        throw new SpacesError(
          'CREATE_FAILED',
          `Created Space '${createdId}' was absent from the verification snapshot.`,
          true,
        )
      }
      return created
    } catch (error) {
      throw this.normalizeNativeError(error, 'CREATE_FAILED', 'Failed to create a Windows Space.')
    }
  }

  async removeSpace(spaceId: SpaceId, fallbackSpaceId?: SpaceId): Promise<SpacesSnapshot> {
    this.assertCapability('removeSpace')
    const desktopId = this.requireObservedSpace(spaceId)
    const fallback = fallbackSpaceId ?? this.chooseRemovalFallback(spaceId)
    if (fallback === spaceId) {
      throw new SpacesError('REMOVE_FAILED', 'Removal fallback cannot be the target Space.')
    }
    const fallbackDesktopId = this.requireObservedSpace(fallback)

    try {
      await this.bridge.sendRequest<NativeShellSpacesSnapshot>('spaces/shellRemove', {
        desktopId,
        fallbackDesktopId,
      })
      const refreshed = await this.scheduleRefresh()
      if (refreshed.spaces.some(space => space.id === spaceId)) {
        throw new SpacesError(
          'REMOVE_FAILED',
          `Removed Space '${spaceId}' is still present after verification.`,
          true,
        )
      }
      return refreshed
    } catch (error) {
      throw this.normalizeNativeError(error, 'REMOVE_FAILED', `Failed to remove Space '${spaceId}'.`)
    }
  }

  async renameSpace(spaceId: SpaceId, name: string): Promise<ObservedSpaceSnapshot> {
    this.assertCapability('renameSpace')
    const desktopId = this.requireObservedSpace(spaceId)
    try {
      await this.bridge.sendRequest<NativeShellSpace>('spaces/shellRename', { desktopId, name })
      const refreshed = await this.scheduleRefresh()
      const renamed = refreshed.spaces.find(space => space.id === spaceId)
      if (!renamed || renamed.name !== name) {
        throw new SpacesError(
          'RENAME_FAILED',
          `Windows Shell did not verify name '${name}' for Space '${spaceId}'.`,
          true,
        )
      }
      return renamed
    } catch (error) {
      throw this.normalizeNativeError(error, 'RENAME_FAILED', `Failed to rename Space '${spaceId}'.`)
    }
  }

  refresh(): Promise<SpacesSnapshot> {
    this.assertAvailable()
    return this.scheduleRefresh()
  }

  subscribe(listener: (snapshot: SpacesSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private get registry(): WindowRegistrySource {
    const registry = this.registryInstance
      ?? (this.ctx.get('windowRegistry') as WindowRegistrySource | undefined)
    if (!registry) {
      throw new SpacesError(
        'WINDOW_REGISTRY_UNAVAILABLE',
        'Spaces requires Window Registry as the sole WindowId authority.',
        true,
      )
    }
    if (!this.registryInstance) this.attachRegistry(registry)
    return registry
  }

  private get bridge(): NativeBridgeClient {
    this.assertAvailable()
    return this.bridgeInstance ?? this.config.bridge ?? getSharedNativeBridge()
  }

  private assertAvailable(): void {
    if (!this.config.enabled) {
      throw new SpacesError('SPACES_DISABLED', 'Spaces is disabled by configuration.')
    }
    if (this.disposed) {
      throw new SpacesError('SPACES_DISPOSED', 'Spaces service is disposed.')
    }
  }

  private assertCapability(capability: keyof SpacesCapabilities): void {
    this.assertAvailable()
    if (capability === 'provider' || this.capabilities[capability] !== true) {
      throw new SpacesError(
        'CAPABILITY_UNAVAILABLE',
        `Spaces capability '${String(capability)}' is unavailable from provider '${this.capabilities.provider}'.`,
        false,
      )
    }
  }

  private attachRegistry(registry: WindowRegistrySource | undefined): void {
    if (!registry || this.registryInstance === registry || this.disposed) return
    this.registryDisposer?.()
    this.registryInstance = registry
    this.registryDisposer = registry.subscribe(() => {
      void this.scheduleRefresh().catch(error => this.emitFault(error))
    })
  }

  private resolveApplicationWindow(windowId: WindowId): WindowSnapshot {
    const window = this.registry.getWindow(windowId)
    if (!window) {
      throw new SpacesError(
        'STALE_WINDOW_ID',
        `WindowId '${windowId}' is no longer present in Window Registry.`,
        true,
      )
    }
    if (window.classification !== 'APPLICATION') {
      throw new SpacesError(
        'TARGET_NOT_APPLICATION',
        `WindowId '${windowId}' is classified as ${window.classification}; Spaces accepts APPLICATION windows only.`,
      )
    }
    return window
  }

  private buildNativeTarget(window: WindowSnapshot): NativeWindowTarget {
    return {
      hwnd: window.hwnd,
      processId: window.processId,
      threadId: window.threadId,
      processCreationTime: window.processCreationTime,
      className: window.className,
    }
  }

  private requireObservedSpace(spaceId: SpaceId): string {
    const nativeDesktopId = nativeDesktopIdFromSpaceId(spaceId)
    if (!nativeDesktopId) {
      throw new SpacesError('STALE_SPACE_ID', `SpaceId '${spaceId}' is not a valid ELIX SpaceId.`)
    }
    if (!this.snapshot.spaces.some(space => space.id === spaceId)) {
      throw new SpacesError(
        'STALE_SPACE_ID',
        `SpaceId '${spaceId}' is not present in the current Spaces snapshot.`,
        true,
      )
    }
    return nativeDesktopId
  }

  private chooseRemovalFallback(spaceId: SpaceId): SpaceId {
    if (this.snapshot.spaces.length <= 1) {
      throw new SpacesError('REMOVE_FAILED', 'Windows must retain at least one Space.')
    }
    const ordered = [...this.snapshot.spaces].sort((left, right) =>
      (left.index ?? Number.MAX_SAFE_INTEGER) - (right.index ?? Number.MAX_SAFE_INTEGER),
    )
    const index = ordered.findIndex(space => space.id === spaceId)
    if (index < 0) throw new SpacesError('STALE_SPACE_ID', `SpaceId '${spaceId}' is not current.`)
    return ordered[index + 1]?.id ?? ordered[index - 1]!.id
  }

  private async queryMembership(window: WindowSnapshot): Promise<WindowSpaceMembership> {
    try {
      const native = await this.bridge.sendRequest<NativeSpaceMembership>('spaces/queryWindow', {
        target: this.buildNativeTarget(window),
      })
      this.refenceWindowLifetime(window)
      if (native.hwnd !== window.hwnd) {
        throw new SpacesError(
          'STALE_WINDOW_ID',
          `Native Spaces response no longer matches WindowId '${window.id}'.`,
          true,
        )
      }
      return this.freezeMembership(
        window.id,
        this.spaceIdFromNative(native.desktopId),
        native.onCurrentDesktop,
      )
    } catch (error) {
      throw this.normalizeNativeError(
        error,
        'MEMBERSHIP_QUERY_FAILED',
        `Failed to query Space membership for WindowId '${window.id}'.`,
      )
    }
  }

  private refenceWindowLifetime(before: WindowSnapshot): void {
    const current = this.registry.getWindow(before.id)
    if (!current || !sameWindowLifetime(before, current)) {
      throw new SpacesError(
        'STALE_WINDOW_ID',
        `WindowId '${before.id}' changed lifetime while a Spaces operation was in flight.`,
        true,
      )
    }
  }

  private spaceIdFromNative(desktopId: string): SpaceId {
    try {
      return spaceIdFromNativeDesktopId(desktopId)
    } catch {
      throw new SpacesError(
        'NATIVE_SPACES_UNAVAILABLE',
        `Native Spaces returned invalid desktop GUID '${desktopId}'.`,
      )
    }
  }

  private freezeMembership(
    windowId: WindowId,
    spaceId: SpaceId,
    onCurrentSpace: boolean,
  ): WindowSpaceMembership {
    return Object.freeze({
      windowId,
      spaceId,
      onCurrentSpace,
      capturedAt: Date.now(),
    })
  }

  /** Queues one logical reconciliation request and waits for that exact generation. */
  private async scheduleRefresh(): Promise<SpacesSnapshot> {
    this.assertAvailable()
    const requested = ++this.requestedRefresh

    while (!this.disposed && this.completedRefresh < requested) {
      await this.ensureRefreshWorker()
    }

    this.assertAvailable()
    return this.snapshot
  }

  private ensureRefreshWorker(): Promise<void> {
    if (this.refreshWorker) return this.refreshWorker

    let worker: Promise<void>
    worker = this.runRefreshWorker().finally(() => {
      if (this.refreshWorker === worker) this.refreshWorker = undefined
    })
    this.refreshWorker = worker
    return worker
  }

  private async runRefreshWorker(): Promise<void> {
    while (!this.disposed && this.completedRefresh < this.requestedRefresh) {
      const target = this.requestedRefresh
      await this.reconcile()
      this.completedRefresh = target
    }
  }

  private async reconcile(): Promise<void> {
    const shell = await this.tryShellSnapshot()
    if (shell) {
      await this.reconcileShell(shell)
      return
    }
    await this.reconcilePublic()
  }

  private async tryShellSnapshot(): Promise<NativeShellSpacesSnapshot | undefined> {
    const wasShell = this.capabilities.provider === 'windows-shell-virtual-desktop'
    try {
      const snapshot = await this.bridge.sendRequest<NativeShellSpacesSnapshot>('spaces/shellSnapshot', {})
      if (
        snapshot.provider !== 'windows-shell-virtual-desktop'
        || !Array.isArray(snapshot.spaces)
        || snapshot.spaces.length === 0
        || typeof snapshot.currentDesktopId !== 'string'
      ) {
        throw new SpacesError(
          'SHELL_PROVIDER_UNAVAILABLE',
          'Native Shell Spaces probe returned an invalid snapshot.',
          true,
        )
      }
      const current = this.spaceIdFromNative(snapshot.currentDesktopId)
      const ids = new Set(snapshot.spaces.map(space => this.spaceIdFromNative(space.desktopId)))
      if (!ids.has(current) || ids.size !== snapshot.spaces.length) {
        throw new SpacesError(
          'SHELL_PROVIDER_UNAVAILABLE',
          'Native Shell Spaces probe returned inconsistent or duplicate desktop identities.',
          true,
        )
      }

      this.capabilities = snapshot.nativeNotifications
        ? SHELL_CAPABILITIES_WITH_NOTIFICATIONS
        : SHELL_CAPABILITIES_WITH_POLLING
      this.lastShellNotificationGeneration = snapshot.notificationGeneration
      this.lastShellFingerprint = shellFingerprint(snapshot)
      return snapshot
    } catch (error) {
      this.capabilities = PUBLIC_CAPABILITIES
      this.lastShellFingerprint = ''
      if (wasShell) this.emitFault(this.normalizeNativeError(
        error,
        'SHELL_PROVIDER_UNAVAILABLE',
        'Windows Shell Spaces provider became unavailable; falling back to documented membership reads.',
      ))
      return undefined
    }
  }

  private async reconcileShell(shell: NativeShellSpacesSnapshot): Promise<void> {
    const applications = this.registry
      .getWindows()
      .filter(window => window.classification === 'APPLICATION')
    const unresolvedWindowIds: WindowId[] = []
    const windowIdsBySpace = new Map<SpaceId, WindowId[]>()
    const shellIds = new Set<SpaceId>()

    for (const space of shell.spaces) {
      const id = this.spaceIdFromNative(space.desktopId)
      shellIds.add(id)
      windowIdsBySpace.set(id, [])
    }

    for (const window of applications) {
      try {
        const membership = await this.queryMembership(window)
        const bucket = windowIdsBySpace.get(membership.spaceId)
        if (!bucket) {
          unresolvedWindowIds.push(window.id)
          continue
        }
        bucket.push(window.id)
      } catch (error) {
        unresolvedWindowIds.push(window.id)
        if (!this.isTransientWindowRace(error)) this.emitFault(error)
      }
    }

    const currentSpaceId = this.spaceIdFromNative(shell.currentDesktopId)
    if (!shellIds.has(currentSpaceId)) {
      throw new SpacesError(
        'INCONSISTENT_CURRENT_SPACE',
        `Windows Shell current Space '${currentSpaceId}' is not in its enumerated set.`,
        true,
      )
    }

    const spaces = shell.spaces
      .map(space => {
        const id = this.spaceIdFromNative(space.desktopId)
        return Object.freeze<ObservedSpaceSnapshot>({
          id,
          index: space.index,
          name: space.name,
          windowIds: Object.freeze([...(windowIdsBySpace.get(id) ?? [])]),
          isCurrent: id === currentSpaceId,
        })
      })
      .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))

    this.publishSnapshot({
      spaces,
      unresolvedWindowIds,
      currentSpaceId,
      capabilities: this.capabilities,
      completeness: 'complete-shell-enumeration',
    })
  }

  private async reconcilePublic(): Promise<void> {
    const applications = this.registry
      .getWindows()
      .filter(window => window.classification === 'APPLICATION')
    const memberships: WindowSpaceMembership[] = []
    const unresolvedWindowIds: WindowId[] = []

    for (const window of applications) {
      try {
        memberships.push(await this.queryMembership(window))
      } catch (error) {
        unresolvedWindowIds.push(window.id)
        if (!this.isTransientWindowRace(error)) this.emitFault(error)
      }
    }

    const bySpace = new Map<SpaceId, { windowIds: WindowId[], isCurrent: boolean }>()
    let currentSpaceId: SpaceId | undefined

    for (const membership of memberships) {
      const record = bySpace.get(membership.spaceId) ?? { windowIds: [], isCurrent: false }
      record.windowIds.push(membership.windowId)
      record.isCurrent ||= membership.onCurrentSpace
      bySpace.set(membership.spaceId, record)

      if (membership.onCurrentSpace) {
        if (currentSpaceId && currentSpaceId !== membership.spaceId) {
          throw new SpacesError(
            'INCONSISTENT_CURRENT_SPACE',
            `Windows reported multiple current SpaceIds ('${currentSpaceId}' and '${membership.spaceId}').`,
            true,
          )
        }
        currentSpaceId = membership.spaceId
      }
    }

    const spaces = Array.from(bySpace.entries())
      .sort(([left], [right]) => String(left).localeCompare(String(right)))
      .map(([id, value]) => Object.freeze<ObservedSpaceSnapshot>({
        id,
        windowIds: Object.freeze([...value.windowIds]),
        isCurrent: value.isCurrent,
      }))

    this.publishSnapshot({
      spaces,
      unresolvedWindowIds,
      ...(currentSpaceId ? { currentSpaceId } : {}),
      capabilities: PUBLIC_CAPABILITIES,
      completeness: 'observed-application-windows',
    })
  }

  private publishSnapshot(input: {
    readonly spaces: readonly ObservedSpaceSnapshot[]
    readonly unresolvedWindowIds: readonly WindowId[]
    readonly currentSpaceId?: SpaceId | undefined
    readonly capabilities: SpacesCapabilities
    readonly completeness: SpacesSnapshot['completeness']
  }): void {
    const next: SpacesSnapshot = Object.freeze({
      revision: ++this.revision,
      spaces: Object.freeze([...input.spaces]),
      unresolvedWindowIds: Object.freeze([...input.unresolvedWindowIds]),
      ...(input.currentSpaceId ? { currentSpaceId: input.currentSpaceId } : {}),
      capabilities: input.capabilities,
      completeness: input.completeness,
      capturedAt: Date.now(),
    })

    this.capabilities = input.capabilities
    this.snapshot = next
    this.ctx.emit('spaces/snapshot', next)
    for (const listener of [...this.listeners]) {
      try {
        listener(next)
      } catch (error) {
        this.emitFault(error)
      }
    }
  }

  private async pollShellChanges(): Promise<void> {
    if (this.disposed) return

    if (this.capabilities.provider !== 'windows-shell-virtual-desktop') {
      const now = Date.now()
      if (now - this.lastPublicShellProbeAt < 3_000) return
      this.lastPublicShellProbeAt = now
      const shell = await this.tryShellSnapshot()
      if (shell) await this.scheduleRefresh()
      return
    }

    if (this.capabilities.nativeNotifications) {
      try {
        const status = await this.bridge.sendRequest<NativeShellNotificationStatus>(
          'spaces/shellNotificationStatus',
          {},
        )
        if (!status.active || status.generation !== this.lastShellNotificationGeneration) {
          this.lastShellNotificationGeneration = status.generation
          await this.scheduleRefresh()
        }
        return
      } catch {
        await this.scheduleRefresh()
        return
      }
    }

    try {
      const shell = await this.bridge.sendRequest<NativeShellSpacesSnapshot>('spaces/shellSnapshot', {})
      const fingerprint = shellFingerprint(shell)
      if (fingerprint !== this.lastShellFingerprint) {
        this.lastShellFingerprint = fingerprint
        await this.scheduleRefresh()
      }
    } catch {
      await this.scheduleRefresh()
    }
  }

  private isTransientWindowRace(error: unknown): boolean {
    return error instanceof SpacesError && error.code === 'STALE_WINDOW_ID'
  }

  private normalizeNativeError(
    error: unknown,
    fallbackCode: SpacesErrorCode,
    fallbackMessage: string,
  ): SpacesError {
    if (error instanceof SpacesError) return error
    const code = nativeErrorCode(error)
    if (code === 'STALE_WINDOW_ID' || code === 'IDENTITY_UNVERIFIABLE') {
      return new SpacesError('STALE_WINDOW_ID', nativeErrorMessage(error, fallbackMessage), true)
    }
    if (code === 'STALE_SPACE_ID' || code === 'INVALID_SPACE_ID') {
      return new SpacesError('STALE_SPACE_ID', nativeErrorMessage(error, fallbackMessage), true)
    }
    if (code === 'SHELL_MOVE_NOT_COMMITTED') {
      return new SpacesError('MOVE_NOT_CONFIRMED', nativeErrorMessage(error, fallbackMessage), true)
    }
    if (
      code === 'VIRTUAL_DESKTOP_MANAGER_UNAVAILABLE'
      || code === 'METHOD_NOT_FOUND'
      || code === 'SHELL_ENUMERATION_FAILED'
      || code === 'SHELL_CURRENT_FAILED'
    ) {
      return new SpacesError(
        fallbackCode === 'MEMBERSHIP_QUERY_FAILED' ? 'NATIVE_SPACES_UNAVAILABLE' : 'SHELL_PROVIDER_UNAVAILABLE',
        nativeErrorMessage(error, fallbackMessage),
        true,
      )
    }
    return new SpacesError(fallbackCode, nativeErrorMessage(error, fallbackMessage), true)
  }

  private emitFault(error: unknown): void {
    const fault = error instanceof Error ? error : new Error(String(error))
    try {
      this.ctx.emit('spaces/fault', fault)
    } catch {
      // Fault observers are diagnostics only and must never break Spaces reconciliation.
    }
  }
}

function shellFingerprint(snapshot: NativeShellSpacesSnapshot): string {
  return JSON.stringify({
    currentDesktopId: snapshot.currentDesktopId,
    spaces: snapshot.spaces.map(space => [space.desktopId, space.index, space.name]),
  })
}

function nativeErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined
  const code = Reflect.get(error, 'code')
  return typeof code === 'string' ? code : undefined
}

function nativeErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message
  if (error && typeof error === 'object' && 'message' in error) {
    const message = Reflect.get(error, 'message')
    if (typeof message === 'string' && message.trim()) return message
  }
  return fallback
}

export default SpacesService
