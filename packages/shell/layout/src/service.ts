/**
 * Authoritative Shell Layout Service for ELIX OS.
 *
 * Owns per-monitor shell reservations, boundary lease authority, work-area
 * calculation, Home exclusion publishing, shell modes, fullscreen suspension,
 * and native AppBar synchronization/recovery.
 *
 * @module @deepseek-ai/dsh-shell-layout/service
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type {
  PhysicalPixelRect,
  WindowsContextChange,
  WindowsContextService,
  WindowsMonitor,
} from '@deepseek-ai/dsh-windows-context'
import z from '@deepseek-ai/schemastery'
import { HomePublisher, type HomeServiceRef } from './home-publisher.ts'
import { computeMonitorLayout, deriveMonitorEdgeRect, getReservationDepth } from './layout-engine.ts'
import { NativeWorkAreaSync, type NativeSyncItem } from './native-work-area-sync.ts'
import { ReservationRegistry } from './reservation-registry.ts'
import type {
  MonitorLayoutState,
  ShellBoundaryConflict,
  ShellLayoutChangeEvent,
  ShellLayoutConfig,
  ShellLayoutLifecycleState,
  ShellLayoutSource,
  ShellMode,
  ShellRecoverySnapshot,
  ShellReservation,
  ShellReservationHandle,
  ShellReservationSpec,
  ShellReservationUpdate,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    shellLayout: ShellLayoutService
    home?: HomeServiceRef | undefined
  }
  interface Events {
    /** @mode broadcast @param service Initialized Shell Layout service. */
    'shell-layout/ready'(service: ShellLayoutService): void
    /** @mode broadcast @param event Change notification event. */
    'shell-layout/change'(event: ShellLayoutChangeEvent): void
    /** @mode broadcast @param reservation Newly registered shell reservation. */
    'shell-layout/reservation-registered'(reservation: ShellReservation): void
    /** @mode broadcast @param reservation Updated shell reservation. */
    'shell-layout/reservation-updated'(reservation: ShellReservation): void
    /** @mode broadcast @param id Removed reservation identifier. */
    'shell-layout/reservation-removed'(id: string): void
    /** @mode broadcast @param affectedMonitorIds List of monitor IDs whose layout changed. */
    'shell-layout/layout-changed'(affectedMonitorIds: readonly string[]): void
    /** @mode broadcast @param monitorId Monitor where fullscreen state changed. */
    'shell-layout/fullscreen-policy-changed'(monitorId: string, isFullscreen: boolean): void
    /** @mode broadcast @param mode New shell mode. */
    'shell-layout/mode-changed'(mode: ShellMode): void
    /** @mode broadcast @param ownerId Owner whose generation was released. */
    'shell-layout/owner-released'(ownerId: string, ownerGeneration: number): void
    /** @mode broadcast @param service Initialized Home service. */
    'home/ready'?(service?: unknown): void
  }
}

/** Authoritative Shell Layout Service. */
export class ShellLayoutService extends Service implements ShellLayoutSource {
  static Config = z.object({
    enabled: z.boolean().default(true),
    syncNativeWorkArea: z.boolean().default(false),
  })

  private readonly config: ShellLayoutConfig
  private readonly registry = new ReservationRegistry()
  private readonly homePublisher: HomePublisher
  private readonly nativeSync: NativeWorkAreaSync
  private readonly changeListeners = new Set<(event: ShellLayoutChangeEvent) => void>()
  private readonly syntheticMonitors = new Map<string, WindowsMonitor>()
  private readonly knownMonitors = new Map<string, { bounds: PhysicalPixelRect; workArea: PhysicalPixelRect }>()
  private readonly lastFullscreenByMonitor = new Map<string, boolean>()
  private readonly ownerGenerations = new Map<string, number>()

  private lifecycleState: ShellLayoutLifecycleState = 'STARTING'
  private shellMode: ShellMode
  private recoveryGuardianReady: boolean
  /** Serializes topology/native reconciliation so context changes cannot commit out of order. */
  private reconciliationTail: Promise<void> = Promise.resolve()

  constructor(ctx: Context, config?: Partial<ShellLayoutConfig>) {
    super(ctx, 'shellLayout')
    this.config = {
      enabled: config?.enabled ?? true,
      syncNativeWorkArea: config?.syncNativeWorkArea ?? false,
      bridge: config?.bridge,
      shellMode: config?.shellMode ?? 'coexistence',
      allowTaskbarReplacement: config?.allowTaskbarReplacement ?? false,
      recoveryGuardianReady: config?.recoveryGuardianReady ?? false,
    }
    this.shellMode = this.config.shellMode ?? 'coexistence'
    this.recoveryGuardianReady = this.config.recoveryGuardianReady ?? false

    this.homePublisher = new HomePublisher(() => this.home)
    this.nativeSync = new NativeWorkAreaSync(
      this.config.bridge,
      this.config.syncNativeWorkArea,
      (id, approvedRect) => {
        this.reconcileNativeApprovedRect(id, approvedRect)
      },
    )
  }

  private get home(): HomeServiceRef | undefined {
    return this.ctx.get('home') as HomeServiceRef | undefined
  }

  private get windowsContext(): WindowsContextService | undefined {
    return this.ctx.get('windowsContext') as WindowsContextService | undefined
  }

  /** Initializes Shell Layout and its recovery subscriptions. */
  [Service.init](): void {
    if (!this.config.enabled) return

    const home = this.home
    if (home) {
      this.homePublisher.setHome(home)
    }

    const wc = this.windowsContext
    if (wc) {
      for (const monitor of wc.getMonitors()) {
        this.knownMonitors.set(monitor.id, monitor)
      }
    }

    const unbindWindowsContext = this.ctx.on('windows-context/change', (change) => {
      void this.enqueueReconciliation(() => this.handleWindowsContextChange(change))
    })

    const unbindHomeReady = this.ctx.on('home/ready', () => {
      const currentHome = this.home
      if (currentHome) {
        this.homePublisher.setHome(currentHome)
        this.syncAllToHome()
      }
    })

    this.ctx.effect(() => async () => {
      this.lifecycleState = 'DISPOSED'
      unbindWindowsContext()
      unbindHomeReady()
      this.registry.clear()
      this.homePublisher.dispose()
      await this.nativeSync.dispose()
      this.changeListeners.clear()
      this.lastFullscreenByMonitor.clear()
      this.knownMonitors.clear()
      this.ownerGenerations.clear()
    }, 'shellLayout.lifecycle')

    this.lifecycleState = 'ACTIVE'
    this.ctx.emit('shell-layout/ready', this)
  }

  private enqueueReconciliation(task: () => Promise<void>): Promise<void> {
    const execute = async (): Promise<void> => {
      if (this.lifecycleState === 'DISPOSED') return
      await task()
    }
    const run = this.reconciliationTail.then(execute, execute)
    this.reconciliationTail = run.catch(() => undefined)
    return run
  }

  private async handleWindowsContextChange(change: WindowsContextChange): Promise<void> {
    if (this.lifecycleState === 'DISPOSED') return

    this.lifecycleState = 'RECONCILING'

    try {
      const monitorMap = new Map<string, { id: string; bounds: PhysicalPixelRect; workArea: PhysicalPixelRect }>()
      for (const [id, monitor] of this.syntheticMonitors) {
        monitorMap.set(id, monitor)
      }
      for (const monitor of change.snapshot.monitors) {
        monitorMap.set(monitor.id, monitor)
      }
      const currentMonitors = Array.from(monitorMap.values())

      if (change.reason === 'recovered') {
        this.updateKnownMonitors(currentMonitors)
        await this.reconcileNativeAppBars()
      } else {
        await this.reconcileTopology(currentMonitors)
      }

      let fullscreenChanged = false
      for (const monitor of change.snapshot.monitors) {
        const monitorId = monitor.id as string
        const foreground = change.snapshot.foreground
        const isFullscreen =
          foreground !== null &&
          foreground.isFullscreen &&
          (foreground.monitorId as string) === monitorId
        const previousFullscreen = this.lastFullscreenByMonitor.get(monitorId) ?? false
        if (isFullscreen !== previousFullscreen) {
          fullscreenChanged = true
          this.lastFullscreenByMonitor.set(monitorId, isFullscreen)
          this.ctx.emit('shell-layout/fullscreen-policy-changed', monitorId, isFullscreen)
          this.emitLayoutChanged('fullscreen', undefined, monitorId, [monitorId])
        }
      }

      if (fullscreenChanged) {
        await this.reconcileNativeAppBars()
        this.syncAllToHome()
      }

      const affectedMonitorIds = change.snapshot.monitors.map(monitor => monitor.id as string)
      this.emitLayoutChanged(
        change.reason === 'recovered' ? 'recovered' : 'topology',
        undefined,
        undefined,
        affectedMonitorIds,
      )
    } finally {
      if (this.getLifecycleState() !== 'DISPOSED') {
        this.lifecycleState = 'ACTIVE'
      }
    }
  }

  getLifecycleState(): ShellLayoutLifecycleState {
    return this.lifecycleState
  }

  registerSyntheticMonitor(monitor: WindowsMonitor): void {
    this.syntheticMonitors.set(monitor.id, monitor)
    void this.enqueueReconciliation(() => this.reconcileTopology(this.getConnectedMonitors()))
    this.emitLayoutChanged('topology', undefined, monitor.id, [monitor.id])
  }

  removeSyntheticMonitor(monitorId: string): void {
    if (this.syntheticMonitors.delete(monitorId)) {
      void this.enqueueReconciliation(() => this.reconcileTopology(this.getConnectedMonitors()))
      this.emitLayoutChanged('topology', undefined, monitorId, [monitorId])
    }
  }

  /** Registers one owner-generation-scoped reservation lease. */
  registerReservation(spec: ShellReservationSpec): ShellReservationHandle {
    if (this.lifecycleState === 'DISPOSED') {
      throw new Error('Cannot register reservation on disposed ShellLayoutService.')
    }

    const ownerId = spec.ownerId.trim()
    const ownerGeneration = spec.ownerGeneration ?? 0
    const currentGeneration = this.ownerGenerations.get(ownerId)

    if (currentGeneration !== undefined && ownerGeneration < currentGeneration) {
      throw new Error(
        `Cannot register stale shell boundary lease for owner "${ownerId}" generation ${ownerGeneration}; current generation is ${currentGeneration}.`,
      )
    }

    if (currentGeneration === undefined || ownerGeneration > currentGeneration) {
      if (currentGeneration !== undefined) {
        this.releaseOlderOwnerGenerations(ownerId, ownerGeneration)
      }
      this.ownerGenerations.set(ownerId, ownerGeneration)
    }

    this.assertNoBoundaryConflict({ ...spec, ownerGeneration })

    const result = this.registry.register(
      { ...spec, ownerGeneration },
      (action, reservation) => {
        if (action === 'updated') {
          this.handleReservationUpdated(reservation)
        } else {
          this.handleReservationRemoved(reservation.id, reservation.monitorId)
        }
      },
    )

    const { reservation, isReplacement, previousReservation } = result
    this.publishReservationToHome(reservation)
    this.syncReservationToNative(reservation)

    const affected = new Set<string>()
    for (const monitorId of this.resolveAffectedMonitorIds(reservation.monitorId)) {
      affected.add(monitorId)
    }
    if (previousReservation && previousReservation.monitorId !== reservation.monitorId) {
      for (const monitorId of this.resolveAffectedMonitorIds(previousReservation.monitorId)) {
        affected.add(monitorId)
      }
    }

    this.ctx.emit(
      isReplacement ? 'shell-layout/reservation-updated' : 'shell-layout/reservation-registered',
      reservation,
    )
    this.emitLayoutChanged(
      isReplacement ? 'updated' : 'registered',
      reservation.id,
      reservation.monitorId,
      Array.from(affected),
    )

    const registryHandle = result.handle
    return {
      id: reservation.id,
      ownerId: reservation.ownerId,
      ownerGeneration: reservation.ownerGeneration,
      get: () => registryHandle.get(),
      update: (patch) => {
        if (!registryHandle.get()) {
          throw new Error(`Cannot update stale shell boundary lease "${reservation.id}".`)
        }
        this.assertOwnerLeaseCurrent(reservation.ownerId, reservation.ownerGeneration)
        return this.updateReservation(reservation.id, patch)
      },
      dispose: () => {
        if (!registryHandle.get()) return false
        if (!this.isOwnerLeaseCurrent(reservation.ownerId, reservation.ownerGeneration)) {
          return false
        }
        return registryHandle.dispose()
      },
    }
  }

  updateReservation(id: string, patch: ShellReservationUpdate): ShellReservation {
    if (this.lifecycleState === 'DISPOSED') {
      throw new Error('Cannot update reservation on disposed ShellLayoutService.')
    }

    const previous = this.registry.get(id)
    if (!previous) {
      throw new Error(`Cannot update non-existent shell reservation "${id}".`)
    }

    this.assertOwnerLeaseCurrent(previous.ownerId, previous.ownerGeneration)
    this.assertNoBoundaryConflict({
      ...previous,
      ...patch,
      id: previous.id,
      ownerId: previous.ownerId,
      ownerGeneration: previous.ownerGeneration,
      rect: patch.rect ? { ...patch.rect } : previous.rect,
    }, id)

    const updated = this.registry.update(id, patch)
    this.handleReservationUpdated(updated, previous.monitorId)
    return updated
  }

  removeReservation(id: string): boolean {
    if (this.lifecycleState === 'DISPOSED') return false

    const existing = this.registry.get(id)
    if (existing) {
      this.assertOwnerLeaseCurrent(existing.ownerId, existing.ownerGeneration)
    }

    const { removed, reservation } = this.registry.remove(id)
    if (removed && reservation) {
      this.handleReservationRemoved(id, reservation.monitorId)
      return true
    }
    return false
  }

  /** Releases exactly one owner generation and its native/Home projections. */
  releaseOwner(ownerId: string, ownerGeneration: number): number {
    if (!Number.isSafeInteger(ownerGeneration) || ownerGeneration < 0) {
      throw new RangeError('ownerGeneration must be a non-negative safe integer.')
    }

    const removed = this.registry.removeOwner(ownerId, ownerGeneration)
    for (const reservation of removed) {
      this.handleReservationRemoved(reservation.id, reservation.monitorId)
    }

    if (removed.length > 0) {
      this.ctx.emit('shell-layout/owner-released', ownerId, ownerGeneration)
      this.emitLayoutChanged('owner-released', undefined, undefined, this.resolveReservationMonitors(removed))
    }

    return removed.length
  }

  getOwnerGeneration(ownerId: string): number | undefined {
    return this.ownerGenerations.get(ownerId)
  }

  getReservation(id: string): ShellReservation | undefined {
    return this.registry.get(id)
  }

  getReservations(monitorId?: string): readonly ShellReservation[] {
    if (monitorId !== undefined) {
      return this.registry.getByMonitor(monitorId)
    }
    return this.registry.getAll()
  }

  getMonitorLayout(monitorId: string): MonitorLayoutState | undefined {
    const monitor = this.findMonitor(monitorId)
    if (!monitor) return undefined

    const isFullscreen = this.isFullscreenActive(monitorId)
    const reservations = this.registry.getByMonitor(monitorId).map(reservation =>
      this.shellMode === 'overlay'
        ? { ...reservation, affectsWorkArea: false }
        : reservation,
    )

    return computeMonitorLayout(
      monitorId,
      monitor.bounds,
      monitor.workArea,
      reservations,
      isFullscreen,
    )
  }

  getWorkArea(monitorId: string): PhysicalPixelRect | undefined {
    return this.getMonitorLayout(monitorId)?.computedWorkArea
  }

  isFullscreenActive(monitorId: string): boolean {
    const cached = this.lastFullscreenByMonitor.get(monitorId)
    if (cached !== undefined) return cached

    const foreground = this.windowsContext?.getForegroundContext()
    if (!foreground) return false
    return foreground.isFullscreen && (foreground.monitorId as string) === monitorId
  }

  getFullscreenPolicy(monitorId: string): { isFullscreen: boolean; occludesShellSurfaces: boolean } {
    const isFullscreen = this.isFullscreenActive(monitorId)
    return {
      isFullscreen,
      occludesShellSurfaces: isFullscreen,
    }
  }

  getShellMode(): ShellMode {
    return this.shellMode
  }

  /**
   * Changes shell cooperation mode. Replacement is deliberately fail-closed until
   * both platform validation and independent recovery supervision are enabled.
   */
  setShellMode(mode: ShellMode): void {
    if (mode === this.shellMode) return

    if (mode === 'replacement') {
      if (!this.config.allowTaskbarReplacement) {
        throw new Error('Shell replacement mode is not enabled on this build.')
      }
      if (!this.recoveryGuardianReady) {
        throw new Error('Shell replacement mode requires an active recovery guardian.')
      }
    }

    this.shellMode = mode
    void this.reconcileBoundaries()
    this.ctx.emit('shell-layout/mode-changed', mode)
    this.emitLayoutChanged('mode', undefined, undefined, this.getConnectedMonitors().map(monitor => monitor.id))
  }

  setRecoveryGuardianReady(ready: boolean): void {
    this.recoveryGuardianReady = ready
    if (!ready && this.shellMode === 'replacement') {
      this.shellMode = 'coexistence'
      void this.reconcileBoundaries()
      this.ctx.emit('shell-layout/mode-changed', this.shellMode)
      this.emitLayoutChanged('mode', undefined, undefined, this.getConnectedMonitors().map(monitor => monitor.id))
    }
  }

  getBoundaryConflicts(): readonly ShellBoundaryConflict[] {
    const reservations = this.registry.getAll()
      .filter(reservation => reservation.kind === 'edge' && reservation.edge)
    const conflicts: ShellBoundaryConflict[] = []

    for (let leftIndex = 0; leftIndex < reservations.length; leftIndex += 1) {
      const left = reservations[leftIndex]
      if (!left?.edge) continue
      for (let rightIndex = leftIndex + 1; rightIndex < reservations.length; rightIndex += 1) {
        const right = reservations[rightIndex]
        if (!right?.edge || left.edge !== right.edge) continue
        if (!this.monitorScopesOverlap(left.monitorId, right.monitorId)) continue
        if (left.conflictPolicy !== 'exclusive' && right.conflictPolicy !== 'exclusive') continue

        conflicts.push({
          monitorId: left.monitorId === 'all' ? right.monitorId : left.monitorId,
          edge: left.edge,
          reservationIds: [left.id, right.id],
          ownerIds: [left.ownerId, right.ownerId],
        })
      }
    }

    return Object.freeze(conflicts)
  }

  getRecoverySnapshot(): ShellRecoverySnapshot {
    return Object.freeze({
      shellMode: this.shellMode,
      recoveryGuardianReady: this.recoveryGuardianReady,
      reservations: Object.freeze(this.registry.getAll().map(reservation => Object.freeze({
        id: reservation.id,
        ownerId: reservation.ownerId,
        ownerGeneration: reservation.ownerGeneration,
        monitorId: reservation.monitorId,
        kind: reservation.kind,
        ...(reservation.edge ? { edge: reservation.edge } : {}),
        affectsWorkArea: reservation.affectsWorkArea,
        visible: reservation.visible,
      }))),
    })
  }

  /** Re-applies the complete valid boundary set after native shell disturbances. */
  async reconcileBoundaries(): Promise<void> {
    if (this.lifecycleState === 'DISPOSED') return
    await this.reconcileNativeAppBars()
    this.syncAllToHome()
    this.emitLayoutChanged('reconciled', undefined, undefined, this.getConnectedMonitors().map(monitor => monitor.id))
  }

  subscribe(listener: (event: ShellLayoutChangeEvent) => void): () => void {
    this.changeListeners.add(listener)
    return () => {
      this.changeListeners.delete(listener)
    }
  }

  reconcileNativeApprovedRect(id: string, approvedRect: PhysicalPixelRect): void {
    const parts = id.split('::')
    const baseId = parts[0] ?? id
    const reservation = this.registry.get(baseId)
    if (!reservation) return

    let effectiveToStore = approvedRect
    if (reservation.monitorId === 'all' && reservation.kind === 'edge' && reservation.edge) {
      const depth = reservation.edge === 'top' || reservation.edge === 'bottom'
        ? approvedRect.height
        : approvedRect.width
      effectiveToStore = {
        ...reservation.rect,
        ...(reservation.edge === 'top' || reservation.edge === 'bottom'
          ? { height: depth }
          : { width: depth }),
      }
    }

    const updated = this.registry.setEffectiveRect(baseId, effectiveToStore)
    if (!updated) return

    this.publishReservationToHome(updated)
    const affected = this.resolveAffectedMonitorIds(updated.monitorId)
    this.ctx.emit('shell-layout/reservation-updated', updated)
    this.emitLayoutChanged('reconciled', updated.id, updated.monitorId, affected)
  }

  private isOwnerLeaseCurrent(ownerId: string, ownerGeneration: number): boolean {
    const current = this.ownerGenerations.get(ownerId)
    return current === undefined || current === ownerGeneration
  }

  private assertOwnerLeaseCurrent(ownerId: string, ownerGeneration: number): void {
    const current = this.ownerGenerations.get(ownerId)
    if (current !== undefined && current !== ownerGeneration) {
      throw new Error(
        `Stale shell boundary lease for owner "${ownerId}" generation ${ownerGeneration}; current generation is ${current}.`,
      )
    }
  }

  private releaseOlderOwnerGenerations(ownerId: string, newGeneration: number): void {
    for (const reservation of this.registry.getByOwner(ownerId)) {
      if (reservation.ownerGeneration >= newGeneration) continue
      const removed = this.registry.remove(reservation.id)
      if (removed.removed && removed.reservation) {
        this.handleReservationRemoved(removed.reservation.id, removed.reservation.monitorId)
      }
    }
  }

  private assertNoBoundaryConflict(spec: ShellReservationSpec, ignoreId?: string): void {
    if (spec.kind !== 'edge' || !spec.edge) return

    const conflictPolicy = spec.conflictPolicy ?? 'stack'
    for (const existing of this.registry.getAll()) {
      if (existing.id === ignoreId || existing.id === spec.id) continue
      if (existing.kind !== 'edge' || existing.edge !== spec.edge) continue
      if (!this.monitorScopesOverlap(existing.monitorId, spec.monitorId)) continue
      if (existing.conflictPolicy !== 'exclusive' && conflictPolicy !== 'exclusive') continue

      throw new Error(
        `Shell edge conflict on ${spec.monitorId}:${spec.edge}; reservation "${spec.id}" conflicts with "${existing.id}" owned by "${existing.ownerId}".`,
      )
    }
  }

  private monitorScopesOverlap(left: string, right: string): boolean {
    return left === 'all' || right === 'all' || left === right
  }

  private isMonitorConnected(monitorId: string): boolean {
    if (this.syntheticMonitors.has(monitorId)) return true
    const wc = this.windowsContext
    if (!wc) return true
    return wc.getMonitors().some(monitor => monitor.id === monitorId)
  }

  private isReservationSuspendedOnMonitor(reservation: ShellReservation, monitorId: string): boolean {
    return reservation.suspendInFullscreen && this.isFullscreenActive(monitorId)
  }

  private shouldReserveNativeWorkArea(reservation: ShellReservation, monitorId: string): boolean {
    return (
      this.shellMode !== 'overlay' &&
      reservation.affectsWorkArea &&
      reservation.visible &&
      !this.isReservationSuspendedOnMonitor(reservation, monitorId)
    )
  }

  private syncReservationToNative(reservation: ShellReservation): void {
    if (reservation.monitorId === 'all') {
      if (reservation.kind !== 'edge' || !reservation.edge) return
      const depth = getReservationDepth(reservation)
      for (const monitor of this.getConnectedMonitors()) {
        const derived = deriveMonitorEdgeRect(reservation.edge, depth, monitor.bounds)
        void this.nativeSync.syncReservation({
          id: `${reservation.id}::${monitor.id}`,
          edge: reservation.edge,
          rect: derived,
          hwnd: reservation.hwnd,
          affectsWorkArea: this.shouldReserveNativeWorkArea(reservation, monitor.id),
          visible: reservation.visible && !this.isReservationSuspendedOnMonitor(reservation, monitor.id),
          kind: reservation.kind,
        })
      }
      return
    }

    if (this.isMonitorConnected(reservation.monitorId)) {
      void this.nativeSync.syncReservation({
        ...reservation,
        affectsWorkArea: this.shouldReserveNativeWorkArea(reservation, reservation.monitorId),
        visible: reservation.visible && !this.isReservationSuspendedOnMonitor(reservation, reservation.monitorId),
      })
    } else {
      void this.nativeSync.unreserve(reservation.id)
    }
  }

  private publishReservationToHome(reservation: ShellReservation): void {
    if (reservation.monitorId === 'all') {
      if (reservation.kind !== 'edge' || !reservation.edge) return
      const depth = getReservationDepth(reservation)
      for (const monitor of this.getConnectedMonitors()) {
        const compoundId = `${reservation.id}::${monitor.id}`
        if (!reservation.visible || this.isReservationSuspendedOnMonitor(reservation, monitor.id)) {
          this.homePublisher.unpublish(compoundId)
          continue
        }
        const derived = deriveMonitorEdgeRect(reservation.edge, depth, monitor.bounds)
        this.homePublisher.publish({
          ...reservation,
          id: compoundId,
          monitorId: monitor.id,
          rect: derived,
          effectiveRect: derived,
        })
      }
      return
    }

    if (
      this.isMonitorConnected(reservation.monitorId) &&
      reservation.visible &&
      !this.isReservationSuspendedOnMonitor(reservation, reservation.monitorId)
    ) {
      this.homePublisher.publish(reservation)
    } else {
      this.homePublisher.unpublish(reservation.id)
    }
  }

  private unreserveFromNative(id: string, monitorId: string): void {
    if (monitorId === 'all') {
      for (const monitor of this.getConnectedMonitors()) {
        void this.nativeSync.unreserve(`${id}::${monitor.id}`)
      }
    } else {
      void this.nativeSync.unreserve(id)
    }
  }

  private unpublishFromHome(id: string, monitorId: string): void {
    if (monitorId === 'all') {
      for (const monitor of this.getConnectedMonitors()) {
        this.homePublisher.unpublish(`${id}::${monitor.id}`)
      }
    } else {
      this.homePublisher.unpublish(id)
    }
  }

  private handleReservationUpdated(reservation: ShellReservation, oldMonitorId?: string): void {
    if (oldMonitorId && oldMonitorId !== reservation.monitorId) {
      this.unpublishFromHome(reservation.id, oldMonitorId)
      this.unreserveFromNative(reservation.id, oldMonitorId)
    }

    this.publishReservationToHome(reservation)
    this.syncReservationToNative(reservation)

    const affected = new Set<string>()
    for (const monitorId of this.resolveAffectedMonitorIds(reservation.monitorId)) {
      affected.add(monitorId)
    }
    if (oldMonitorId && oldMonitorId !== reservation.monitorId) {
      for (const monitorId of this.resolveAffectedMonitorIds(oldMonitorId)) {
        affected.add(monitorId)
      }
    }

    this.ctx.emit('shell-layout/reservation-updated', reservation)
    this.emitLayoutChanged(
      'updated',
      reservation.id,
      reservation.monitorId,
      Array.from(affected),
    )
  }

  private handleReservationRemoved(id: string, monitorId: string): void {
    this.unpublishFromHome(id, monitorId)
    this.unreserveFromNative(id, monitorId)

    const affected = this.resolveAffectedMonitorIds(monitorId)
    this.ctx.emit('shell-layout/reservation-removed', id)
    this.emitLayoutChanged('removed', id, monitorId, affected)
  }

  private updateKnownMonitors(
    currentMonitors: readonly { id: string; bounds: PhysicalPixelRect; workArea: PhysicalPixelRect }[],
  ): void {
    this.knownMonitors.clear()
    for (const monitor of currentMonitors) {
      this.knownMonitors.set(monitor.id, monitor)
    }
  }

  private async reconcileTopology(
    currentMonitors: readonly { id: string; bounds: PhysicalPixelRect; workArea: PhysicalPixelRect }[],
  ): Promise<void> {
    const currentMap = new Map(currentMonitors.map(monitor => [monitor.id, monitor]))
    const removedMonitorIds: string[] = []
    const addedMonitorIds: string[] = []

    for (const id of this.knownMonitors.keys()) {
      if (!currentMap.has(id)) removedMonitorIds.push(id)
    }
    for (const id of currentMap.keys()) {
      if (!this.knownMonitors.has(id)) addedMonitorIds.push(id)
    }

    for (const monitorId of removedMonitorIds) {
      this.knownMonitors.delete(monitorId)
      for (const reservation of this.registry.getAll()) {
        if (reservation.monitorId === monitorId) {
          await this.nativeSync.unreserve(reservation.id)
          this.homePublisher.unpublish(reservation.id)
        } else if (reservation.monitorId === 'all') {
          await this.nativeSync.unreserve(`${reservation.id}::${monitorId}`)
          this.homePublisher.unpublish(`${reservation.id}::${monitorId}`)
        }
      }
    }

    for (const monitorId of addedMonitorIds) {
      const monitor = currentMap.get(monitorId)
      if (!monitor) continue
      this.knownMonitors.set(monitorId, monitor)
      for (const reservation of this.registry.getAll()) {
        this.syncReservationToNative(reservation)
        this.publishReservationToHome(reservation)
      }
    }

    for (const [monitorId, monitor] of currentMap) {
      if (addedMonitorIds.includes(monitorId)) continue
      const old = this.knownMonitors.get(monitorId)
      this.knownMonitors.set(monitorId, monitor)
      if (
        old &&
        (old.bounds.x !== monitor.bounds.x ||
          old.bounds.y !== monitor.bounds.y ||
          old.bounds.width !== monitor.bounds.width ||
          old.bounds.height !== monitor.bounds.height)
      ) {
        for (const reservation of this.registry.getAll()) {
          this.syncReservationToNative(reservation)
          this.publishReservationToHome(reservation)
        }
      }
    }
  }

  private async reconcileNativeAppBars(): Promise<void> {
    const items: NativeSyncItem[] = []
    const connectedMonitors = this.getConnectedMonitors()

    for (const reservation of this.registry.getAll()) {
      if (reservation.kind !== 'edge' || !reservation.edge) continue

      if (reservation.monitorId === 'all') {
        const depth = getReservationDepth(reservation)
        for (const monitor of connectedMonitors) {
          const derived = deriveMonitorEdgeRect(reservation.edge, depth, monitor.bounds)
          items.push({
            id: `${reservation.id}::${monitor.id}`,
            edge: reservation.edge,
            rect: derived,
            hwnd: reservation.hwnd,
            affectsWorkArea: this.shouldReserveNativeWorkArea(reservation, monitor.id),
            visible: reservation.visible && !this.isReservationSuspendedOnMonitor(reservation, monitor.id),
            kind: reservation.kind,
          })
        }
      } else if (this.isMonitorConnected(reservation.monitorId)) {
        items.push({
          id: reservation.id,
          edge: reservation.edge,
          rect: reservation.rect,
          hwnd: reservation.hwnd,
          affectsWorkArea: this.shouldReserveNativeWorkArea(reservation, reservation.monitorId),
          visible: reservation.visible && !this.isReservationSuspendedOnMonitor(reservation, reservation.monitorId),
          kind: reservation.kind,
        })
      }
    }

    await this.nativeSync.reconcileAll(items, (id) => {
      const parts = id.split('::')
      const baseId = parts[0] ?? id
      return this.registry.get(baseId) !== undefined
    })
  }

  private syncAllToHome(): void {
    for (const reservation of this.registry.getAll()) {
      this.publishReservationToHome(reservation)
    }
  }

  private getConnectedMonitors(): readonly { id: string; bounds: PhysicalPixelRect; workArea: PhysicalPixelRect }[] {
    const list: { id: string; bounds: PhysicalPixelRect; workArea: PhysicalPixelRect }[] = []
    const seen = new Set<string>()
    for (const [id, monitor] of this.syntheticMonitors) {
      list.push(monitor)
      seen.add(id)
    }
    const wc = this.windowsContext
    if (wc) {
      for (const monitor of wc.getMonitors()) {
        const id = monitor.id as string
        if (!seen.has(id)) {
          list.push(monitor)
          seen.add(id)
        }
      }
    }
    return list
  }

  private emitLayoutChanged(
    type: ShellLayoutChangeEvent['type'],
    reservationId?: string,
    monitorId?: string,
    affectedMonitorIds: readonly string[] = [],
  ): void {
    const event: ShellLayoutChangeEvent = {
      type,
      ...(reservationId ? { reservationId } : {}),
      ...(monitorId ? { monitorId } : {}),
      affectedMonitorIds,
    }

    this.ctx.emit('shell-layout/change', event)
    this.ctx.emit('shell-layout/layout-changed', affectedMonitorIds)
    for (const listener of this.changeListeners) {
      try {
        listener(event)
      } catch {
        // Listener isolation is intentional.
      }
    }
  }

  private findMonitor(monitorId: string): { bounds: PhysicalPixelRect; workArea: PhysicalPixelRect } | undefined {
    if (this.syntheticMonitors.has(monitorId)) {
      return this.syntheticMonitors.get(monitorId)
    }
    const wcMonitor = this.windowsContext?.getMonitors()
      .find(monitor => (monitor.id as string) === monitorId)
    return wcMonitor
  }

  private resolveAffectedMonitorIds(monitorId: string): readonly string[] {
    if (monitorId === 'all') {
      const all = new Set<string>()
      for (const id of this.syntheticMonitors.keys()) all.add(id)
      const wc = this.windowsContext
      if (wc) {
        for (const monitor of wc.getMonitors()) all.add(monitor.id)
      }
      return Array.from(all)
    }
    return [monitorId]
  }

  private resolveReservationMonitors(reservations: readonly ShellReservation[]): readonly string[] {
    const monitors = new Set<string>()
    for (const reservation of reservations) {
      for (const monitorId of this.resolveAffectedMonitorIds(reservation.monitorId)) {
        monitors.add(monitorId)
      }
    }
    return Array.from(monitors)
  }
}

export default ShellLayoutService
