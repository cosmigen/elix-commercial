/**
 * Authoritative Shell Overlay Core Service for ELIX.
 *
 * Implements cordis Service owning temporary shell surfaces such as context menus,
 * flyouts, anchored panels, previews, and submenus with deterministic placement,
 * surface lifecycle management, stacking, focus policy, and safe multi-owner cleanup.
 *
 * @module @deepseek-ai/dsh-shell-overlay/service
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { SurfaceFocusPolicy, SurfaceService } from '@deepseek-ai/dsh-surface'
import type {
  PhysicalPixelRect,
  WindowsContextChange,
  WindowsContextService,
} from '@deepseek-ai/dsh-windows-context'
import z from '@deepseek-ai/schemastery'
import { resolveAnchorRect, selectMonitor } from './anchor-resolver.ts'
import { OverlayDefinitionRegistry } from './definition-registry.ts'
import { OverlayInstanceRegistry } from './instance-registry.ts'
import { computePlacement } from './placement-engine.ts'
import type {
  OverlayAnchor,
  OverlayBoundsConstraint,
  OverlayChangeEvent,
  OverlayCloseOptions,
  OverlayConfig,
  OverlayClosingEvent,
  OverlayClosedEvent,
  OverlayDefinition,
  OverlayFaultedEvent,
  OverlayFocusPolicy,
  OverlayInstance,
  OverlayOpeningEvent,
  OverlayOpenedEvent,
  OverlayOpenOptions,
  OverlayPlacement,
  OverlayPlacementChangedEvent,
  OverlayPoint,
  OverlayRegisteredEvent,
  OverlaySize,
  OverlayUnregisteredEvent,
  OwnerCleanupResult,
} from './types.ts'

/** Minimal interface for Shell Layout service reference. */
interface ShellLayoutRef {
  getWorkArea(monitorId: string): PhysicalPixelRect | undefined
  isFullscreenActive(monitorId: string): boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    overlay: OverlayService
  }
  interface Events {
    /** @mode broadcast @param service Initialized Overlay Core service. */
    'overlay/ready'(service: OverlayService): void
    /** @mode broadcast @param event Registered overlay definition event. */
    'overlay/registered'(event: OverlayRegisteredEvent): void
    /** @mode broadcast @param event Unregistered overlay definition event. */
    'overlay/unregistered'(event: OverlayUnregisteredEvent): void
    /** @mode broadcast @param event Opening overlay instance event. */
    'overlay/opening'(event: OverlayOpeningEvent): void
    /** @mode broadcast @param event Opened overlay instance event. */
    'overlay/opened'(event: OverlayOpenedEvent): void
    /** @mode broadcast @param event Closing overlay instance event. */
    'overlay/closing'(event: OverlayClosingEvent): void
    /** @mode broadcast @param event Closed overlay instance event. */
    'overlay/closed'(event: OverlayClosedEvent): void
    /** @mode broadcast @param event Placement changed overlay instance event. */
    'overlay/placement-changed'(event: OverlayPlacementChangedEvent): void
    /** @mode broadcast @param event Overlay faulted event. */
    'overlay/faulted'(event: OverlayFaultedEvent): void
  }
}

/**
 * Overlay Service for ELIX.
 */
export class OverlayService extends Service {
  static Config = z.object({
    enabled: z.boolean().default(true),
    defaultOffset: z.number().default(4),
    maxNestingDepth: z.number().default(10),
  })

  private readonly config: OverlayConfig
  private readonly definitions = new OverlayDefinitionRegistry()
  private readonly instances = new OverlayInstanceRegistry()
  private readonly changeListeners = new Set<(event: OverlayChangeEvent) => void>()
  private unbindWindows?: () => void
  private unbindDestroyed?: () => void
  private unbindFault?: () => void
  private unbindInputKey?: () => void
  private unbindPointer?: () => void
  private generationCounter = 0
  private isDisposed = false

  constructor(ctx: Context, config?: Partial<OverlayConfig>) {
    super(ctx, 'overlay')
    this.config = {
      enabled: config?.enabled ?? true,
      defaultOffset: config?.defaultOffset ?? 4,
      maxNestingDepth: config?.maxNestingDepth ?? 10,
    }
  }

  private get windowsContext(): WindowsContextService | undefined {
    const fromStore = this.ctx.get('windowsContext')
    if (fromStore !== undefined) return fromStore
    try {
      return Reflect.get(this.ctx, 'windowsContext')
    } catch (_uninjectable) {
      return undefined
    }
  }

  private get surfaceService(): SurfaceService | undefined {
    const fromStore = this.ctx.get('surface')
    if (fromStore !== undefined) return fromStore
    try {
      return Reflect.get(this.ctx, 'surface')
    } catch (_uninjectable) {
      return undefined
    }
  }

  private get shellLayout(): ShellLayoutRef | undefined {
    const fromStore = this.ctx.get('shellLayout') as ShellLayoutRef | undefined
    if (fromStore !== undefined) return fromStore
    try {
      return Reflect.get(this.ctx, 'shellLayout') as ShellLayoutRef | undefined
    } catch (_uninjectable) {
      return undefined
    }
  }

  /**
   * Initializes the Overlay subsystem and hooks into Windows Context and Surface Core.
   */
  [Service.init](): void {
    if (!this.config.enabled) return

    // 1. Listen for Windows Context topology, DPI, and foreground changes
    this.unbindWindows = this.ctx.on('windows-context/change', (change: WindowsContextChange) => {
      this.handleWindowsContextChange(change)
    })

    // 2. Listen for Surface Core destruction or faults
    this.unbindDestroyed = this.ctx.on('surface/destroyed', ({ id }) => {
      this.handleSurfaceDestroyed(id)
    })

    this.unbindFault = this.ctx.on('surface/fault', ({ surface, error }) => {
      this.handleSurfaceFault(surface.id, error)
    })

    // 3. Listen for real hardware keyboard Escape input from Surface Core
    this.unbindInputKey = this.ctx.on('surface/input-key', (event) => {
      if (event.key === 'Escape') {
        void this.notifyEscapeKey()
      }
    })

    // 4. Listen for real pointer down input from Surface Core for outside-click dismissal
    this.unbindPointer = this.ctx.on('surface/pointer', (event) => {
      if (event.action === 'down') {
        void this.notifyOutsideClick(event.point, event.surface.id)
      }
    })

    // Cordis lifecycle teardown
    this.ctx.effect(() => () => {
      void this.dispose()
    }, 'overlay.lifecycle')

    this.ctx.emit('overlay/ready', this)
  }

  /**
   * Shuts down the Overlay service, closing all open instances, destroying surfaces,
   * and unbinding all event listeners.
   */
  async dispose(): Promise<void> {
    if (this.isDisposed) return
    this.isDisposed = true

    this.unbindWindows?.()
    this.unbindDestroyed?.()
    this.unbindFault?.()
    this.unbindInputKey?.()
    this.unbindPointer?.()

    const active = this.instances.list()
    const surfaceSvc = this.surfaceService
    for (const inst of active) {
      if (surfaceSvc) {
        await surfaceSvc.destroy(inst.surfaceId).catch(() => {})
      }
    }
    this.definitions.clear()
    this.instances.clear()
    this.changeListeners.clear()
  }

  /**
   * Subscribes to all overlay events (registration, unregistration, opening, opened,
   * closing, closed, placement changes, and faults).
   *
   * @param listener - Callback function receiving overlay change events.
   * @returns Disposer function to cancel subscription.
   */
  subscribe(listener: (event: OverlayChangeEvent) => void): () => void {
    this.changeListeners.add(listener)
    return () => {
      this.changeListeners.delete(listener)
    }
  }

  /**
   * Registers a new persistent overlay definition.
   *
   * @param def - Overlay definition specification.
   * @returns Unregister disposer function.
   */
  register(def: OverlayDefinition): () => void {
    const disposer = this.definitions.register(def)
    this.emitEvent({ type: 'registered', definition: def })

    let unregistered = false
    return () => {
      if (unregistered) return
      unregistered = true
      const removed = disposer()
      if (removed) {
        void this.closeByDefinition(def.id, 'plugin-unload')
        this.emitEvent({
          type: 'unregistered',
          definitionId: def.id,
          ownerId: def.ownerId,
        })
      }
    }
  }

  /**
   * Unregisters an overlay definition by identifier and terminates active instances of it.
   *
   * @param id - Definition identifier.
   * @returns True if unregistered.
   */
  unregister(id: string): boolean {
    const def = this.definitions.get(id)
    if (!def) return false
    const removed = this.definitions.unregister(id)
    if (removed) {
      void this.closeByDefinition(id, 'plugin-unload')
      this.emitEvent({
        type: 'unregistered',
        definitionId: id,
        ownerId: def.ownerId,
      })
    }
    return removed
  }

  /**
   * Retrieves a registered overlay definition by identifier.
   *
   * @param id - Definition identifier.
   */
  getDefinition(id: string): OverlayDefinition | undefined {
    return this.definitions.get(id)
  }

  /**
   * Lists all currently registered overlay definitions.
   */
  listDefinitions(): readonly OverlayDefinition[] {
    return this.definitions.list()
  }

  /**
   * Completely cleans up all definitions and closes all active overlays owned by a specific plugin.
   *
   * @param ownerId - Subsystem or plugin identifier.
   * @param options - Optional close options.
   * @returns Cleanup result containing count of closed instances and removed definition IDs.
   */
  async cleanupOwner(ownerId: string, options?: OverlayCloseOptions): Promise<OwnerCleanupResult> {
    const closedInstances = await this.closeByOwner(ownerId, options)
    const removedDefinitions = this.unregisterByOwner(ownerId)
    return { closedInstances, removedDefinitions }
  }

  /**
   * Unregisters all definitions registered by a specific owner and closes their instances.
   *
   * @param ownerId - Owning subsystem identifier.
   * @returns Array of removed definition IDs.
   */
  unregisterByOwner(ownerId: string): readonly string[] {
    const defs = this.definitions.getByOwner(ownerId)
    const removedIds = this.definitions.removeByOwner(ownerId)
    for (const def of defs) {
      void this.closeByDefinition(def.id, 'plugin-unload')
      this.emitEvent({
        type: 'unregistered',
        definitionId: def.id,
        ownerId: def.ownerId,
      })
    }
    return removedIds
  }

  /**
   * Opens an overlay instance based on a registered definition.
   *
   * Coordinates anchor resolution, monitor selection, deterministic placement,
   * Surface Core allocation, ready-before-show verification, and stacking.
   *
   * @param options - Parameters for opening the overlay.
   * @returns The active OverlayInstance.
   */
  async open(options: OverlayOpenOptions): Promise<OverlayInstance> {
    if (this.isDisposed) {
      throw new Error('OverlayService is disposed.')
    }

    const def = this.definitions.get(options.definitionId)
    if (!def) {
      throw new Error(`Cannot open overlay: definition '${options.definitionId}' is not registered.`)
    }

    if (options.ownerId !== undefined && options.ownerId !== def.ownerId) {
      throw new Error(
        `Cannot open overlay '${def.id}': ownerId mismatch (requested '${options.ownerId}', definition owned by '${def.ownerId}').`,
      )
    }

    const ownerId = def.ownerId

    // 1. Validate parent-child nesting if parentInstanceId provided
    if (options.parentInstanceId) {
      this.instances.validateNesting(
        options.parentInstanceId,
        this.config.maxNestingDepth ?? 10,
      )
    }

    const generation = ++this.generationCounter
    const instanceId = `${def.id}-${generation}-${Date.now()}`
    const surfaceId = `overlay-surf-${instanceId}`

    // 2. Resolve anchor and monitor
    const monitors = this.windowsContext?.getMonitors() ?? []
    const anchorRect = resolveAnchorRect(options.anchor, (refId: string) => {
      const byInst = this.instances.get(refId)
      if (byInst) return byInst.actualBounds
      const bySurf = this.surfaceService?.get(refId)
      if (bySurf) return bySurf.bounds
      const byInstSurf = this.instances.list().find(i => i.surfaceId === refId)
      if (byInstSurf) return byInstSurf.actualBounds
      return undefined
    })
    const monitor = selectMonitor(anchorRect, monitors)

    // 3. Resolve available boundary box
    const boundsConstraint: OverlayBoundsConstraint = def.boundsConstraint ?? 'workArea'
    let availableBounds = monitor.workArea

    if (boundsConstraint === 'monitorBounds') {
      availableBounds = monitor.bounds
    }

    // Check Shell Layout integration if present
    if (this.shellLayout) {
      if (this.shellLayout.isFullscreenActive(monitor.id)) {
        availableBounds = monitor.bounds
      } else if (boundsConstraint === 'workArea') {
        const layoutWorkArea = this.shellLayout.getWorkArea(monitor.id)
        if (layoutWorkArea) {
          availableBounds = layoutWorkArea
        }
      }
    }

    // 4. Compute deterministic placement
    const offset = options.offset ?? def.placementOffset ?? this.config.defaultOffset ?? 4
    const requestedPlacement: OverlayPlacement = options.placement ?? def.defaultPlacement ?? 'auto'
    const size: OverlaySize = options.size ?? def.size

    const placementResult = computePlacement({
      anchorRect,
      size,
      requestedPlacement,
      offset,
      availableBounds,
      monitor,
    })

    const focusPolicy: OverlayFocusPolicy = def.focusPolicy ?? 'activate'
    const dismissPolicy = {
      outsideClick: true,
      escape: true,
      onLostFocus: false,
      onMonitorDisconnect: 'close' as const,
      ...def.dismiss,
    }
    const stackPolicy = {
      stackLevel: 'normal' as const,
      ...def.stack,
    }
    const recoveryPolicy = def.recovery ?? 'close'

    // 5. Create instance model in CREATING state and add immediately to prevent race conditions
    const instance: OverlayInstance = {
      instanceId,
      definitionId: def.id,
      ownerId,
      surfaceId,
      monitorId: monitor.id,
      anchor: options.anchor,
      resolvedAnchorRect: anchorRect,
      requestedSize: size,
      actualBounds: placementResult.bounds,
      requestedPlacement,
      effectivePlacement: placementResult.effectivePlacement,
      parentInstanceId: options.parentInstanceId,
      childInstanceIds: [],
      focusPolicy,
      dismiss: dismissPolicy,
      stack: stackPolicy,
      recovery: recoveryPolicy,
      boundsConstraint,
      state: 'CREATING',
      generation,
      createdAt: Date.now(),
      metadata: options.metadata,
    }

    this.instances.add(instance)
    this.emitEvent({ type: 'opening', instance })

    // 6. Handle exclusive group stacking policy
    if (def.stack?.group && def.stack.exclusive) {
      const existingInGroup = this.instances.getByGroup(def.stack.group)
      for (const sibling of existingInGroup) {
        if (
          sibling.instanceId !== instanceId &&
          sibling.state !== 'CLOSING' &&
          sibling.state !== 'CLOSED' &&
          (!options.parentInstanceId || !this.instances.isDescendant(options.parentInstanceId, sibling.instanceId))
        ) {
          await this.close(sibling.instanceId, { reason: 'group-exclusive' })
        }
      }
    }

    // 7. Surface Core creation & ready-before-show enforcement
    const surfaceService = this.surfaceService
    if (!surfaceService) {
      const err = new Error('SurfaceService is not available in context.')
      this.instances.update(instanceId, { state: 'FAULTED' })
      this.instances.remove(instanceId)
      this.emitEvent({ type: 'faulted', instanceId, definitionId: def.id, error: err })
      throw err
    }

    const surfaceFocusPolicy: SurfaceFocusPolicy = focusPolicy === 'activate' ? 'normal' : 'noActivate'

    const shouldAbort = (): boolean => {
      if (this.isDisposed) return true
      if (!this.definitions.get(def.id)) return true
      const curr = this.instances.get(instanceId)
      if (!curr || curr.state === 'CLOSING' || curr.state === 'CLOSED') return true
      if (options.parentInstanceId) {
        const parentInst = this.instances.get(options.parentInstanceId)
        if (!parentInst || parentInst.state === 'CLOSING' || parentInst.state === 'CLOSED') return true
      }
      if (def.stack?.group && def.stack.exclusive) {
        const newerInGroup = this.instances
          .getByGroup(def.stack.group)
          .some(s => s.instanceId !== instanceId && s.generation > generation)
        if (newerInGroup) return true
      }
      return false
    }

    try {
      this.instances.update(instanceId, { state: 'OPENING' })

      const surface = await surfaceService.create({
        id: surfaceId,
        bounds: placementResult.bounds,
        renderer: def.renderer,
        monitorId: monitor.id,
        focusPolicy: surfaceFocusPolicy,
        zOrderPolicy: 'topmost',
        skipTaskbar: focusPolicy !== 'activate',
        transparent: true,
        visible: false,
      })

      // Race check: instance may have been cancelled during surface creation
      if (shouldAbort()) {
        await surface.destroy().catch(() => {})
        this.instances.update(instanceId, { state: 'CLOSED' })
        this.instances.remove(instanceId)
        return { ...instance, state: 'CLOSED' }
      }

      await surface.whenReady()

      // Race check: instance may have been cancelled during renderer readiness
      if (shouldAbort()) {
        await surface.destroy().catch(() => {})
        this.instances.update(instanceId, { state: 'CLOSED' })
        this.instances.remove(instanceId)
        return { ...instance, state: 'CLOSED' }
      }

      await surface.show()

      // Race check: instance may have been cancelled during surface show
      if (shouldAbort()) {
        await surface.destroy().catch(() => {})
        this.instances.update(instanceId, { state: 'CLOSED' })
        this.instances.remove(instanceId)
        return { ...instance, state: 'CLOSED' }
      }

      const openedInstance = this.instances.update(instanceId, {
        state: 'OPEN',
        surface,
      }) ?? {
        ...instance,
        state: 'OPEN' as const,
        surface,
      }

      this.emitEvent({ type: 'opened', instance: openedInstance })
      return openedInstance
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      this.instances.update(instanceId, { state: 'FAULTED' })
      await surfaceService.destroy(surfaceId).catch(() => {})
      this.instances.remove(instanceId)
      this.emitEvent({ type: 'faulted', instanceId, definitionId: def.id, error })
      throw error
    }
  }

  /**
   * Closes an active overlay instance and cleanly tears down native surfaces.
   *
   * Enforces that all descendant popups (e.g. submenus) are closed first.
   *
   * @param instanceId - Instance identifier.
   * @param options - Close options and reason.
   * @returns True if the instance was closed, false if not found or already closing.
   */
  async close(instanceId: string, options?: OverlayCloseOptions): Promise<boolean> {
    const inst = this.instances.get(instanceId)
    if (!inst || inst.state === 'CLOSED') {
      return false
    }

    if (inst.state === 'CLOSING') {
      return false
    }

    const reason = options?.reason ?? 'explicit'

    // 1. Mark CLOSING and notify
    this.instances.update(instanceId, { state: 'CLOSING' })
    this.emitEvent({ type: 'closing', instance: inst, reason })

    // 2. Close all descendant popups first (deepest children first)
    const descendants = this.instances.getDescendants(instanceId)
    for (const descendant of descendants) {
      if (descendant.state !== 'CLOSING' && descendant.state !== 'CLOSED') {
        await this.close(descendant.instanceId, { reason: 'parent-close' })
      }
    }

    // 3. Destroy native surface
    if (this.surfaceService) {
      await this.surfaceService.destroy(inst.surfaceId).catch(() => {})
    }

    // 4. Mark CLOSED and unregister instance
    this.instances.update(instanceId, { state: 'CLOSED' })
    this.instances.remove(instanceId)

    this.emitEvent({
      type: 'closed',
      instanceId,
      definitionId: inst.definitionId,
      ownerId: inst.ownerId,
      reason,
    })

    return true
  }

  /**
   * Closes all currently active overlay instances.
   *
   * @param options - Close options and reason.
   * @returns Total number of instances closed.
   */
  async closeAll(options?: OverlayCloseOptions): Promise<number> {
    const active = this.instances.list()
    let closedCount = 0

    // Close from topmost / deepest down to root
    for (let i = active.length - 1; i >= 0; i--) {
      const inst = active[i]
      if (inst && inst.state !== 'CLOSING' && inst.state !== 'CLOSED') {
        const closed = await this.close(inst.instanceId, options)
        if (closed) closedCount++
      }
    }

    return closedCount
  }

  /**
   * Closes all active overlay instances registered by a specific owner plugin.
   *
   * @param ownerId - Subsystem or plugin identifier.
   * @param options - Close options.
   * @returns Number of instances closed.
   */
  async closeByOwner(ownerId: string, options?: OverlayCloseOptions): Promise<number> {
    const active = this.instances.getByOwner(ownerId)
    let closedCount = 0

    for (let i = active.length - 1; i >= 0; i--) {
      const inst = active[i]
      if (inst && inst.state !== 'CLOSING' && inst.state !== 'CLOSED') {
        const closed = await this.close(inst.instanceId, {
          reason: options?.reason ?? 'owner-close',
        })
        if (closed) closedCount++
      }
    }

    return closedCount
  }

  /**
   * Closes all active overlay instances derived from a specific definition.
   */
  private async closeByDefinition(definitionId: string, reason: string): Promise<number> {
    const matching = this.instances.list().filter(i => i.definitionId === definitionId)
    let count = 0
    for (const inst of matching) {
      if (inst.state !== 'CLOSING' && inst.state !== 'CLOSED') {
        const closed = await this.close(inst.instanceId, {
          reason: reason as OverlayCloseOptions['reason'],
        })
        if (closed) count++
      }
    }
    return count
  }

  /**
   * Retrieves an active overlay instance by identifier.
   *
   * @param instanceId - Instance identifier.
   */
  getInstance(instanceId: string): OverlayInstance | undefined {
    return this.instances.get(instanceId)
  }

  /**
   * Returns all active overlay instances.
   */
  getActive(): readonly OverlayInstance[] {
    return this.instances
      .list()
      .filter(i => i.state === 'OPEN' || i.state === 'OPENING' || i.state === 'CREATING')
  }

  /**
   * Returns the topmost active overlay instance matching an optional filter.
   * Prioritizes stackLevel ordering (tooltip > modal > normal) followed by chronological ordering.
   *
   * @param filter - Optional filter predicate.
   */
  getTopmost(filter?: (inst: OverlayInstance) => boolean): OverlayInstance | undefined {
    return this.instances.getTopmost((inst) => {
      if (inst.state !== 'OPEN' && inst.state !== 'OPENING' && inst.state !== 'CREATING') return false
      return !filter || filter(inst)
    })
  }

  /**
   * Repositions an existing active overlay instance, optionally updating its anchor.
   * Repositions surface-relative child submenus recursively.
   *
   * @param instanceId - Active instance identifier.
   * @param newAnchor - Optional new anchor specification.
   * @returns Updated OverlayInstance.
   */
  async reposition(instanceId: string, newAnchor?: OverlayAnchor): Promise<OverlayInstance> {
    const inst = this.instances.get(instanceId)
    if (!inst || inst.state !== 'OPEN') {
      throw new Error(`Cannot reposition overlay '${instanceId}': instance is not in OPEN state.`)
    }

    const anchor = newAnchor ?? inst.anchor
    const monitors = this.windowsContext?.getMonitors() ?? []
    const anchorRect = resolveAnchorRect(anchor, (refId: string) => {
      const byInst = this.instances.get(refId)
      if (byInst) return byInst.actualBounds
      const bySurf = this.surfaceService?.get(refId)
      if (bySurf) return bySurf.bounds
      const byInstSurf = this.instances.list().find(i => i.surfaceId === refId)
      if (byInstSurf) return byInstSurf.actualBounds
      return undefined
    })
    const monitor = selectMonitor(anchorRect, monitors)

    let availableBounds = monitor.workArea
    if (inst.boundsConstraint === 'monitorBounds') {
      availableBounds = monitor.bounds
    }
    if (this.shellLayout) {
      if (this.shellLayout.isFullscreenActive(monitor.id)) {
        availableBounds = monitor.bounds
      } else if (inst.boundsConstraint === 'workArea') {
        const layoutWorkArea = this.shellLayout.getWorkArea(monitor.id)
        if (layoutWorkArea) availableBounds = layoutWorkArea
      }
    }

    const def = this.definitions.get(inst.definitionId)
    const offset = def?.placementOffset ?? this.config.defaultOffset ?? 4

    const result = computePlacement({
      anchorRect,
      size: inst.requestedSize,
      requestedPlacement: inst.requestedPlacement,
      offset,
      availableBounds,
      monitor,
    })

    const previousBounds = inst.actualBounds
    if (inst.surface) {
      await inst.surface.setBounds(result.bounds)
    }

    const updated = this.instances.update(instanceId, {
      anchor,
      resolvedAnchorRect: anchorRect,
      monitorId: monitor.id,
      actualBounds: result.bounds,
      effectivePlacement: result.effectivePlacement,
    }) ?? {
      ...inst,
      anchor,
      resolvedAnchorRect: anchorRect,
      monitorId: monitor.id,
      actualBounds: result.bounds,
      effectivePlacement: result.effectivePlacement,
    }

    this.emitEvent({
      type: 'placement-changed',
      instance: updated,
      previousBounds,
      newBounds: result.bounds,
    })

    // Reposition any surface-relative descendant submenus attached to this instance
    for (const childId of inst.childInstanceIds) {
      const child = this.instances.get(childId)
      if (child && child.state === 'OPEN' && child.anchor.type === 'surface-relative') {
        await this.reposition(childId).catch(() => {})
      }
    }

    return updated
  }

  /**
   * Dismisses popups via Escape key press.
   *
   * Dismisses the topmost eligible overlay. If nested popups exist,
   * the child popup is dismissed first.
   *
   * @returns The instance ID of the dismissed popup, if any.
   */
  async notifyEscapeKey(): Promise<string | undefined> {
    if (this.isDisposed) return undefined

    const topmost = this.getTopmost((inst) => {
      if (inst.dismiss.escape === false) return false
      // If this instance has open children that also handle escape, those children must close first
      const openChildren = this.instances
        .getDescendants(inst.instanceId)
        .filter(
          d =>
            (d.state === 'OPEN' || d.state === 'OPENING' || d.state === 'CREATING') &&
            d.dismiss.escape !== false,
        )
      return openChildren.length === 0
    })
    if (!topmost) return undefined

    await this.close(topmost.instanceId, { reason: 'escape' })
    return topmost.instanceId
  }

  /**
   * Processes an outside-click notification.
   *
   * Evaluates all open overlays whose dismiss policy specifies outsideClick !== false.
   * Closes any overlay whose bounds (and descendant bounds) do not contain the clicked point
   * or whose surface does not match hitSurfaceId.
   *
   * @param point - Physical click coordinate in virtual-screen space.
   * @param hitSurfaceId - Surface identifier where click occurred, if known.
   * @returns Array of closed instance IDs.
   */
  async notifyOutsideClick(point?: OverlayPoint, hitSurfaceId?: string): Promise<readonly string[]> {
    if (this.isDisposed) return []

    const active = this.getActive().filter(i => i.dismiss.outsideClick !== false)
    const closed: string[] = []

    // Evaluate root overlays first (those without parents)
    const rootOverlays = active.filter(i => !i.parentInstanceId)

    for (const root of rootOverlays) {
      const tree = [root, ...this.instances.getDescendants(root.instanceId)]

      let isInside = false

      if (hitSurfaceId) {
        if (tree.some(item => item.surfaceId === hitSurfaceId)) {
          isInside = true
        }
      }

      if (!isInside && point) {
        for (const item of tree) {
          const b = item.actualBounds
          if (
            point.x >= b.x &&
            point.x < b.x + b.width &&
            point.y >= b.y &&
            point.y < b.y + b.height
          ) {
            isInside = true
            break
          }
        }
      }

      if (!isInside) {
        const didClose = await this.close(root.instanceId, { reason: 'outside-click' })
        if (didClose) {
          closed.push(root.instanceId)
        }
      }
    }

    return closed
  }

  // --- Internal Event Handlers ---

  private emitEvent(event: OverlayChangeEvent): void {
    switch (event.type) {
      case 'registered':
        this.ctx.emit('overlay/registered', { definition: event.definition })
        break
      case 'unregistered':
        this.ctx.emit('overlay/unregistered', { definitionId: event.definitionId, ownerId: event.ownerId })
        break
      case 'opening':
        this.ctx.emit('overlay/opening', { instance: event.instance })
        break
      case 'opened':
        this.ctx.emit('overlay/opened', { instance: event.instance })
        break
      case 'closing':
        this.ctx.emit('overlay/closing', { instance: event.instance, reason: event.reason })
        break
      case 'closed':
        this.ctx.emit('overlay/closed', {
          instanceId: event.instanceId,
          definitionId: event.definitionId,
          ownerId: event.ownerId,
          reason: event.reason,
        })
        break
      case 'placement-changed':
        this.ctx.emit('overlay/placement-changed', {
          instance: event.instance,
          previousBounds: event.previousBounds,
          newBounds: event.newBounds,
        })
        break
      case 'faulted':
        this.ctx.emit('overlay/faulted', {
          instanceId: event.instanceId,
          definitionId: event.definitionId,
          error: event.error,
        })
        break
    }

    for (const listener of this.changeListeners) {
      try {
        listener(event)
      } catch (_err) {
        // Listener failure must not derail overlay engine
      }
    }
  }

  private handleWindowsContextChange(change: WindowsContextChange): void {
    if (this.isDisposed) return

    if (change.reason === 'topology') {
      const activeMonitors = new Set<string>(change.snapshot.monitors.map(m => m.id as string))
      const active = this.getActive()

      for (const inst of active) {
        if (!activeMonitors.has(inst.monitorId)) {
          if (inst.dismiss.onMonitorDisconnect === 'reposition') {
            void this.reposition(inst.instanceId).catch(() => {})
          } else {
            void this.close(inst.instanceId, { reason: 'monitor-disconnect' }).catch(() => {})
          }
        }
      }
    } else if (change.reason === 'dpi' || change.reason === 'work-area') {
      const active = this.getActive()
      for (const inst of active) {
        void this.reposition(inst.instanceId).catch(() => {})
      }
    } else if (change.reason === 'foreground') {
      const foreground = change.snapshot.foreground
      if (!foreground) return

      const active = this.getActive()
      const rootOverlays = active.filter(i => !i.parentInstanceId)
      for (const root of rootOverlays) {
        if (root.dismiss.outsideClick === false && !root.dismiss.onLostFocus) continue
        const tree = [root, ...this.instances.getDescendants(root.instanceId)]
        const fgHwnd = foreground.nativeId.startsWith('hwnd:')
          ? parseInt(foreground.nativeId.slice(5), 16)
          : parseInt(foreground.nativeId, 10)
        const matchingHwnd = !isNaN(fgHwnd) && tree.some(item => item.surface?.hwnd === fgHwnd)
        if (!matchingHwnd) {
          void this.close(root.instanceId, { reason: 'outside-click' }).catch(() => {})
        }
      }
    }
  }

  private handleSurfaceDestroyed(surfaceId: string): void {
    if (this.isDisposed) return

    const active = this.instances.list().find(i => i.surfaceId === surfaceId)
    if (!active || active.state === 'CLOSING' || active.state === 'CLOSED') {
      return
    }

    if (active.recovery === 'recreate') {
      void this.reopenRecoverable(active).catch(() => {})
    } else {
      void this.close(active.instanceId, { reason: 'fault' }).catch(() => {})
    }
  }

  private handleSurfaceFault(surfaceId: string, error: Error): void {
    if (this.isDisposed) return

    const active = this.instances.list().find(i => i.surfaceId === surfaceId)
    if (!active) return

    this.instances.update(active.instanceId, { state: 'FAULTED' })
    this.emitEvent({
      type: 'faulted',
      instanceId: active.instanceId,
      definitionId: active.definitionId,
      error,
    })

    if (active.recovery === 'recreate') {
      void this.reopenRecoverable(active).catch(() => {})
    } else {
      void this.close(active.instanceId, { reason: 'fault' }).catch(() => {})
    }
  }

  private async reopenRecoverable(inst: OverlayInstance): Promise<void> {
    try {
      await this.close(inst.instanceId, { reason: 'fault' })
      await this.open({
        definitionId: inst.definitionId,
        anchor: inst.anchor,
        ownerId: inst.ownerId,
        parentInstanceId: inst.parentInstanceId,
        placement: inst.requestedPlacement,
        size: inst.requestedSize,
        metadata: inst.metadata,
      })
    } catch {
      // Reopen failed; overlay remains closed
    }
  }
}
