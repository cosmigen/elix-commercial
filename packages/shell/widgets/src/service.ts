/**
 * Authoritative Shell Widget Runtime Service for ELIX.
 *
 * Implements Cordis Service owning desktop widget definitions, instances,
 * lifecycle, persistent state, placement metadata, resize constraints,
 * and Home surface integration.
 *
 * @module @deepseek-ai/dsh-shell-widgets/service
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  BUILTIN_DEFINITIONS,
  notesIntentHandler,
  renderCalendarWidget,
  renderClockWidget,
  renderNotesWidget,
} from './builtin-widgets.ts'
import { WidgetDefinitionRegistry } from './definition-registry.ts'
import { WidgetInstanceRegistry } from './instance-registry.ts'
import { WidgetRendererRegistry } from './renderer-registry.ts'
import type {
  CreateWidgetInstanceOptions,
  Position,
  Size,
  UpdateWidgetInstancePatch,
  WidgetComponentRenderer,
  WidgetDefinition,
  WidgetInstance,
  WidgetInstanceLifecycle,
  WidgetInstanceRemovedEvent,
  WidgetIntentHandler,
} from './types.ts'

export interface WidgetServiceConfig {
  readonly enabled?: boolean | undefined
}

/**
 * Widget Runtime Service for ELIX.
 */
export class WidgetService extends Service {
  static Config = z.object({
    enabled: z.boolean().default(true),
  })

  private readonly definitions = new WidgetDefinitionRegistry()
  private readonly instances = new WidgetInstanceRegistry()
  private readonly renderers = new WidgetRendererRegistry()
  private isDisposed = false

  constructor(ctx: Context, config?: WidgetServiceConfig) {
    super(ctx, 'widgets')
    void config
  }

  [Service.init](): void {
    // 1. Register built-in component renderers
    this.renderers.registerComponent('clock', renderClockWidget)
    this.renderers.registerComponent('calendar', renderCalendarWidget)
    this.renderers.registerComponent('notes', renderNotesWidget, notesIntentHandler)

    // 2. Register built-in widget definitions
    for (const def of BUILTIN_DEFINITIONS) {
      this.definitions.register(def)
    }

    // Cordis lifecycle teardown
    this.ctx.effect(() => () => {
      this.dispose()
    }, 'widgets.lifecycle')

    this.ctx.emit('widgets/ready', this)
  }

  /**
   * Shuts down the Widget service.
   */
  dispose(): void {
    if (this.isDisposed) return
    this.isDisposed = true
    this.instances.clear()
    this.definitions.clear()
  }

  /**
   * Register a new or updated widget definition.
   *
   * @param def - Widget definition.
   * @returns Disposer function that unregisters the definition and cleans up active instances.
   */
  register(def: WidgetDefinition): () => boolean {
    const disposer = this.definitions.register(def)
    this.ctx.emit('widgets/definition-registered', { definition: def })

    return (): boolean => {
      const removed = disposer()
      if (removed) {
        const removedInstances = this.instances.removeByDefinition(def.id)
        for (const inst of removedInstances) {
          this.ctx.emit('widgets/instance-removed', {
            instanceId: inst.id,
            definitionId: inst.definitionId,
            monitorId: inst.monitorId,
          })
        }
        this.ctx.emit('widgets/definition-removed', {
          definitionId: def.id,
          ownerId: def.ownerId,
        })
      }
      return removed
    }
  }

  /**
   * Unregister a widget definition by identifier.
   */
  unregister(definitionId: string): boolean {
    const existing = this.definitions.get(definitionId)
    if (existing === undefined) return false

    const removed = this.definitions.unregister(definitionId)
    if (removed) {
      const removedInstances = this.instances.removeByDefinition(definitionId)
      for (const inst of removedInstances) {
        this.ctx.emit('widgets/instance-removed', {
          instanceId: inst.id,
          definitionId: inst.definitionId,
          monitorId: inst.monitorId,
        })
      }
      this.ctx.emit('widgets/definition-removed', {
        definitionId,
        ownerId: existing.ownerId,
      })
    }
    return removed
  }

  /**
   * Retrieve a definition by ID.
   */
  getDefinition(id: string): WidgetDefinition | undefined {
    return this.definitions.get(id)
  }

  /**
   * Check whether a definition exists.
   */
  hasDefinition(id: string): boolean {
    return this.definitions.has(id)
  }

  /**
   * List all registered widget definitions.
   */
  listDefinitions(): readonly WidgetDefinition[] {
    return this.definitions.list()
  }

  /**
   * Register a custom component renderer and optional intent handler.
   */
  registerComponent(
    componentName: string,
    renderer: WidgetComponentRenderer,
    intentHandler?: WidgetIntentHandler,
  ): () => void {
    return this.renderers.registerComponent(componentName, renderer, intentHandler)
  }

  /**
   * Create and place a new widget instance on a Home monitor.
   *
   * @param options - Instance placement and configuration options.
   * @returns Newly created WidgetInstance.
   */
  create(options: CreateWidgetInstanceOptions): WidgetInstance {
    const def = this.definitions.get(options.definitionId)
    if (def === undefined) {
      throw new Error(`Cannot create instance of unregistered widget definition "${options.definitionId}".`)
    }

    if (options.ownerId !== undefined && options.ownerId !== def.ownerId) {
      throw new Error(
        `Cannot create widget '${def.id}': ownerId mismatch (requested '${options.ownerId}', definition owned by '${def.ownerId}').`,
      )
    }

    const requestedSize = options.size ?? def.defaultSize
    const clampedSize = this.clampSize(requestedSize, def)

    const id = options.id ?? `widget-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    const now = Date.now()

    const instance: WidgetInstance = {
      id,
      definitionId: def.id,
      ownerId: def.ownerId, // Authoritative: strictly inherited from definition
      monitorId: options.monitorId,
      position: { x: options.position.x, y: options.position.y },
      size: clampedSize,
      zOrder: options.zOrder ?? this.instances.list().length + 1,
      configuration: { ...(def.defaultConfig ?? {}), ...(options.configuration ?? {}) },
      state: { ...(def.defaultState ?? {}), ...(options.state ?? {}) },
      lifecycle: 'mounted',
      suspended: false,
      createdAt: now,
      updatedAt: now,
    }

    this.instances.add(instance)
    this.ctx.emit('widgets/instance-created', { instance })
    return instance
  }

  /**
   * Remove an active widget instance from the desktop.
   */
  remove(instanceId: string): boolean {
    const existing = this.instances.get(instanceId)
    if (existing === undefined) return false

    const removed = this.instances.remove(instanceId)
    if (removed) {
      this.ctx.emit('widgets/instance-removed', {
        instanceId,
        definitionId: existing.definitionId,
        monitorId: existing.monitorId,
      })
    }
    return removed
  }

  /**
   * Update an active widget instance's geometry, monitor, or configuration.
   */
  update(instanceId: string, patch: UpdateWidgetInstancePatch): WidgetInstance | undefined {
    const existing = this.instances.get(instanceId)
    if (existing === undefined) return undefined

    const def = this.definitions.get(existing.definitionId)
    let size = patch.size
    if (size !== undefined && def !== undefined) {
      size = this.clampSize(size, def)
    }

    const finalPatch: UpdateWidgetInstancePatch = {
      ...patch,
      ...(size !== undefined ? { size } : {}),
    }

    const updated = this.instances.update(instanceId, finalPatch)
    if (updated !== undefined) {
      this.ctx.emit('widgets/instance-updated', { instance: updated, patch })
    }
    return updated
  }

  /**
   * Update a widget instance's internal runtime state (e.g. note content).
   */
  updateState(instanceId: string, statePatch: Record<string, unknown>): WidgetInstance | undefined {
    const existing = this.instances.get(instanceId)
    if (existing === undefined) return undefined

    const mergedState = { ...existing.state, ...statePatch }
    const updated = this.instances.update(instanceId, { state: mergedState })
    if (updated !== undefined) {
      this.ctx.emit('widgets/instance-state-changed', { instance: updated, state: mergedState })
      this.ctx.emit('widgets/instance-updated', { instance: updated, patch: { state: mergedState } })
    }
    return updated
  }

  /**
   * Retrieve an active instance by ID.
   */
  get(instanceId: string): WidgetInstance | undefined {
    return this.instances.get(instanceId)
  }

  /**
   * List all currently active widget instances across all monitors.
   */
  list(): readonly WidgetInstance[] {
    return this.instances.list()
  }

  /**
   * Retrieve all widget instances located on a specific monitor.
   */
  getForMonitor(monitorId: string): readonly WidgetInstance[] {
    return this.instances.getForMonitor(monitorId)
  }

  /**
   * Retrieve active (non-suspended) widget instances located on a specific monitor.
   */
  getActiveForMonitor(monitorId: string): readonly WidgetInstance[] {
    return this.instances.getForMonitor(monitorId).filter(i => i.lifecycle !== 'suspended' && !i.suspended)
  }

  /**
   * Remove a widget definition and all its instances.
   */
  removeByDefinition(definitionId: string): boolean {
    return this.unregister(definitionId)
  }

  /**
   * Register a listener for widget instance removal events.
   */
  onInstanceRemoved(listener: (event: WidgetInstanceRemovedEvent) => void): () => void {
    return this.ctx.on('widgets/instance-removed', listener)
  }

  /**
   * Bring a widget to the top of the desktop stacking order.
   */
  bringToFront(instanceId: string): void {
    this.instances.bringToFront(instanceId)
  }

  /**
   * Clean up all definitions and instances owned by a specific owner (e.g. plugin unload).
   *
   * @param ownerId - Subsystem or plugin owner ID.
   * @returns Array of removed instance IDs.
   */
  removeByOwner(ownerId: string): readonly string[] {
    // 1. Remove instances
    const removedInstances = this.instances.removeByOwner(ownerId)
    for (const inst of removedInstances) {
      this.ctx.emit('widgets/instance-removed', {
        instanceId: inst.id,
        definitionId: inst.definitionId,
        monitorId: inst.monitorId,
      })
    }

    // 2. Remove definitions
    const removedDefinitionIds = this.definitions.removeByOwner(ownerId)
    for (const defId of removedDefinitionIds) {
      this.ctx.emit('widgets/definition-removed', {
        definitionId: defId,
        ownerId,
      })
    }

    return removedInstances.map(i => i.id)
  }

  /**
   * Suspend all widget instances on a disconnected monitor without deleting their state.
   */
  suspendForMonitor(monitorId: string): readonly WidgetInstance[] {
    const suspended: WidgetInstance[] = []
    for (const inst of this.instances.getForMonitor(monitorId)) {
      if (inst.lifecycle !== 'suspended' && !inst.suspended) {
        const updated = this.instances.update(inst.id, { lifecycle: 'suspended', suspended: true })
        if (updated !== undefined) {
          suspended.push(updated)
          this.ctx.emit('widgets/instance-updated', { instance: updated, patch: { lifecycle: 'suspended', suspended: true } })
        }
      }
    }
    return suspended
  }

  /**
   * Restore suspended widget instances for a reconnected monitor.
   */
  restoreForMonitor(
    monitorId: string,
    bounds?: { x?: number; y?: number; width: number; height: number },
  ): readonly WidgetInstance[] {
    const restored: WidgetInstance[] = []
    for (const inst of this.instances.getForMonitor(monitorId)) {
      if (inst.lifecycle === 'suspended' || inst.suspended) {
        let position = inst.position
        if (bounds !== undefined) {
          const minX = bounds.x ?? 0
          const maxX = (bounds.x ?? 0) + Math.max(0, bounds.width - inst.size.width)
          const minY = bounds.y ?? 0
          const maxY = (bounds.y ?? 0) + Math.max(0, bounds.height - inst.size.height)
          position = {
            x: Math.max(minX, Math.min(maxX, position.x)),
            y: Math.max(minY, Math.min(maxY, position.y)),
          }
        }
        const updated = this.instances.update(inst.id, { lifecycle: 'mounted', suspended: false, position })
        if (updated !== undefined) {
          restored.push(updated)
          this.ctx.emit('widgets/instance-updated', { instance: updated, patch: { lifecycle: 'mounted', suspended: false, position } })
        }
      }
    }
    return restored
  }

  /**
   * Render the inner HTML content of an active widget instance.
   */
  renderWidget(instance: WidgetInstance, scaleFactor = 1): string {
    const def = this.definitions.get(instance.definitionId)
    if (def === undefined) {
      return `<div class="widget-missing-definition"><span>${escapeHtml(instance.definitionId)}</span></div>`
    }
    return this.renderers.render(instance, def, scaleFactor)
  }

  /**
   * Handle an interactive intent action directed at a widget instance.
   */
  async handleIntent(instanceId: string, action: string, payload: unknown): Promise<void> {
    const instance = this.instances.get(instanceId)
    if (instance === undefined) return

    const def = this.definitions.get(instance.definitionId)
    if (def === undefined) return

    const result = await this.renderers.handleIntent(instance, def, action, payload)
    if (result !== undefined && typeof result === 'object') {
      this.updateState(instanceId, result)
    }
  }

  /**
   * Restore persistent widget instances into the runtime.
   * Clears existing instances and populates the validated set.
   *
   * @param instances - Serialized widget instances to restore.
   * @param options - Optional restoration options including active monitor topology.
   */
  restoreInstances(
    instances: readonly unknown[],
    options?: { readonly activeMonitorIds?: readonly string[] | undefined },
  ): void {
    this.instances.clear()
    for (const raw of instances) {
      if (typeof raw !== 'object' || raw === null) continue
      const inst = raw as Record<string, unknown>
      if (typeof inst.id !== 'string' || !inst.id.trim()) continue
      if (typeof inst.definitionId !== 'string' || !inst.definitionId.trim()) continue

      const def = this.definitions.get(inst.definitionId)
      // Authoritative owner: strictly inherited from registered definition.
      // Persisted ownerId is NEVER trusted over definition ownerId.
      // If definition is unregistered, mark with unprivileged 'unresolved' authority.
      const ownerId = def !== undefined ? def.ownerId : 'unresolved'

      // Stale or destroyed persisted instances are dropped
      if (inst.lifecycle === 'destroyed') continue

      // Geometry normalization: size
      let size: Size
      const rawSize = typeof inst.size === 'object' && inst.size !== null
        ? (inst.size as Record<string, unknown>)
        : undefined
      if (
        rawSize !== undefined &&
        typeof rawSize.width === 'number' &&
        Number.isFinite(rawSize.width) &&
        rawSize.width > 0 &&
        typeof rawSize.height === 'number' &&
        Number.isFinite(rawSize.height) &&
        rawSize.height > 0
      ) {
        size = { width: rawSize.width, height: rawSize.height }
      } else if (def !== undefined) {
        size = { ...def.defaultSize }
      } else {
        size = { width: 100, height: 100 }
      }

      if (def !== undefined) {
        size = this.clampSize(size, def)
      }

      // Geometry normalization: position
      let position: Position
      const rawPos = typeof inst.position === 'object' && inst.position !== null
        ? (inst.position as Record<string, unknown>)
        : undefined
      if (
        rawPos !== undefined &&
        typeof rawPos.x === 'number' &&
        Number.isFinite(rawPos.x) &&
        typeof rawPos.y === 'number' &&
        Number.isFinite(rawPos.y)
      ) {
        position = { x: rawPos.x, y: rawPos.y }
      } else {
        position = { x: 0, y: 0 }
      }

      // Stacking order normalization
      const zOrder = typeof inst.zOrder === 'number' && Number.isFinite(inst.zOrder) && inst.zOrder > 0
        ? inst.zOrder
        : this.instances.list().length + 1

      // Lifecycle & monitor presence
      const targetMonitor = typeof inst.monitorId === 'string' && inst.monitorId.trim() ? inst.monitorId : 'primary'
      const isMonitorAbsent = options?.activeMonitorIds !== undefined && !options.activeMonitorIds.includes(targetMonitor)
      const isSuspended = inst.lifecycle === 'suspended' || inst.suspended === true || isMonitorAbsent
      const lifecycle: WidgetInstanceLifecycle = isSuspended
        ? 'suspended'
        : (inst.lifecycle === 'unmounted' ? 'unmounted' : 'mounted')
      const suspended = isSuspended

      const configuration = typeof inst.configuration === 'object' && inst.configuration !== null
        ? { ...(def?.defaultConfig ?? {}), ...(inst.configuration as Record<string, unknown>) }
        : { ...(def?.defaultConfig ?? {}) }

      const state = typeof inst.state === 'object' && inst.state !== null
        ? { ...(def?.defaultState ?? {}), ...(inst.state as Record<string, unknown>) }
        : { ...(def?.defaultState ?? {}) }

      const createdAt = typeof inst.createdAt === 'number' && Number.isFinite(inst.createdAt) ? inst.createdAt : Date.now()
      const updatedAt = typeof inst.updatedAt === 'number' && Number.isFinite(inst.updatedAt) ? inst.updatedAt : Date.now()

      this.instances.add({
        id: inst.id,
        definitionId: inst.definitionId,
        ownerId,
        monitorId: targetMonitor,
        position,
        size,
        zOrder,
        configuration,
        state,
        lifecycle,
        suspended,
        createdAt,
        updatedAt,
      })
    }
  }

  private clampSize(size: Size, def: WidgetDefinition): Size {
    const minW = def.minSize.width
    const minH = def.minSize.height
    const maxW = def.maxSize?.width ?? Number.POSITIVE_INFINITY
    const maxH = def.maxSize?.height ?? Number.POSITIVE_INFINITY

    return {
      width: Math.max(minW, Math.min(maxW, size.width)),
      height: Math.max(minH, Math.min(maxH, size.height)),
    }
  }
}

export default WidgetService

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}
