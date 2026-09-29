/**
 * Authoritative Active Widget Instance Registry for ELIX Widget Runtime.
 *
 * Tracks currently placed widget instances on Home desktop monitors,
 * manages z-ordering, and enables safe cascade removal by owner or definition.
 *
 * @module @deepseek-ai/dsh-shell-widgets/instance-registry
 */

import type { UpdateWidgetInstancePatch, WidgetInstance } from './types.ts'

/**
 * Registry managing active widget instances placed on desktop surfaces.
 */
export class WidgetInstanceRegistry {
  private readonly instances = new Map<string, WidgetInstance>()
  private readonly ordering: string[] = []

  /**
   * Add a newly created widget instance.
   */
  add(instance: WidgetInstance): void {
    this.instances.set(instance.id, { ...instance })
    const idx = this.ordering.indexOf(instance.id)
    if (idx >= 0) {
      this.ordering.splice(idx, 1)
    }
    this.ordering.push(instance.id)
  }

  /**
   * Update an active instance with partial fields.
   * Preserves immutable id, definitionId, and ownerId.
   */
  update(instanceId: string, patch: UpdateWidgetInstancePatch): WidgetInstance | undefined {
    const existing = this.instances.get(instanceId)
    if (existing === undefined) return undefined

    const updated: WidgetInstance = {
      ...existing,
      ...(patch.position !== undefined ? { position: patch.position } : {}),
      ...(patch.size !== undefined ? { size: patch.size } : {}),
      ...(patch.monitorId !== undefined ? { monitorId: patch.monitorId } : {}),
      ...(patch.zOrder !== undefined ? { zOrder: patch.zOrder } : {}),
      ...(patch.configuration !== undefined ? { configuration: patch.configuration } : {}),
      ...(patch.state !== undefined ? { state: patch.state } : {}),
      ...(patch.lifecycle !== undefined ? { lifecycle: patch.lifecycle, suspended: patch.lifecycle === 'suspended' } : {}),
      ...(patch.suspended !== undefined ? { suspended: patch.suspended } : {}),
      id: existing.id,
      definitionId: existing.definitionId,
      ownerId: existing.ownerId,
      updatedAt: Date.now(),
    }
    this.instances.set(instanceId, updated)
    return updated
  }

  /**
   * Remove an instance by identifier.
   */
  remove(instanceId: string): boolean {
    const idx = this.ordering.indexOf(instanceId)
    if (idx >= 0) {
      this.ordering.splice(idx, 1)
    }
    return this.instances.delete(instanceId)
  }

  /**
   * Retrieve an instance by its identifier.
   */
  get(instanceId: string): WidgetInstance | undefined {
    return this.instances.get(instanceId)
  }

  /**
   * Check whether an instance exists.
   */
  has(instanceId: string): boolean {
    return this.instances.has(instanceId)
  }

  /**
   * Returns a snapshot of all currently active widget instances.
   */
  list(): readonly WidgetInstance[] {
    return Array.from(this.instances.values())
  }

  /**
   * Retrieve all widget instances located on a specific monitor.
   */
  getForMonitor(monitorId: string): readonly WidgetInstance[] {
    const results: WidgetInstance[] = []
    for (const inst of this.instances.values()) {
      if (inst.monitorId === monitorId) {
        results.push(inst)
      }
    }
    return results
  }

  /**
   * Remove all instances owned by a specific subsystem or plugin owner.
   *
   * @param ownerId - Subsystem identifier.
   * @returns Array of removed widget instances.
   */
  removeByOwner(ownerId: string): readonly WidgetInstance[] {
    const removed: WidgetInstance[] = []
    for (const [id, inst] of this.instances.entries()) {
      if (inst.ownerId === ownerId) {
        this.remove(id)
        removed.push(inst)
      }
    }
    return removed
  }

  /**
   * Remove all instances associated with a specific widget definition.
   *
   * @param definitionId - Definition identifier.
   * @returns Array of removed widget instances.
   */
  removeByDefinition(definitionId: string): readonly WidgetInstance[] {
    const removed: WidgetInstance[] = []
    for (const [id, inst] of this.instances.entries()) {
      if (inst.definitionId === definitionId) {
        this.remove(id)
        removed.push(inst)
      }
    }
    return removed
  }

  /**
   * Bring an instance to the top of the stacking order.
   */
  bringToFront(instanceId: string): void {
    const existing = this.instances.get(instanceId)
    if (existing === undefined) return

    const idx = this.ordering.indexOf(instanceId)
    if (idx >= 0) {
      this.ordering.splice(idx, 1)
    }
    this.ordering.push(instanceId)

    // Re-index zOrders
    for (let i = 0; i < this.ordering.length; i++) {
      const id = this.ordering[i]
      if (id !== undefined) {
        const item = this.instances.get(id)
        if (item !== undefined) {
          this.instances.set(id, { ...item, zOrder: i + 1 })
        }
      }
    }
  }

  /**
   * Clears all instances from the registry.
   */
  clear(): void {
    this.instances.clear()
    this.ordering.length = 0
  }
}
