/**
 * Authoritative Active Overlay Instance Registry for ELIX Overlay Core.
 *
 * Tracks currently open and opening overlay instances, manages parent-child
 * nesting hierarchies with cycle prevention and depth limits, manages exclusive
 * groups and stacking order, and enables ordered descendant teardown.
 *
 * @module @deepseek-ai/dsh-shell-overlay/instance-registry
 */

import type { OverlayInstance } from './types.ts'

/**
 * Registry managing active, temporary overlay surface instances.
 */
export class OverlayInstanceRegistry {
  private readonly instances = new Map<string, OverlayInstance>()
  private readonly ordering: string[] = []

  /**
   * Adds a newly created overlay instance into the active registry.
   *
   * @param instance - The new OverlayInstance.
   */
  add(instance: OverlayInstance): void {
    this.instances.set(instance.instanceId, instance)
    const existingIndex = this.ordering.indexOf(instance.instanceId)
    if (existingIndex >= 0) {
      this.ordering.splice(existingIndex, 1)
    }
    this.ordering.push(instance.instanceId)

    // Register this instance as a child of its parent
    if (instance.parentInstanceId) {
      const parent = this.instances.get(instance.parentInstanceId)
      if (parent && !parent.childInstanceIds.includes(instance.instanceId)) {
        const updatedParent: OverlayInstance = {
          ...parent,
          childInstanceIds: [...parent.childInstanceIds, instance.instanceId],
        }
        this.instances.set(parent.instanceId, updatedParent)
      }
    }
  }

  /**
   * Updates an active instance with partial fields.
   *
   * @param instanceId - Identifier of the instance to update.
   * @param patch - Properties to update.
   * @returns Updated OverlayInstance, or undefined if not found.
   */
  update(instanceId: string, patch: Partial<OverlayInstance>): OverlayInstance | undefined {
    const existing = this.instances.get(instanceId)
    if (!existing) return undefined

    const updated: OverlayInstance = {
      ...existing,
      ...patch,
      instanceId: existing.instanceId,
      definitionId: existing.definitionId,
    }
    this.instances.set(instanceId, updated)
    return updated
  }

  /**
   * Removes an instance from the active registry and cleans up parent links.
   *
   * @param instanceId - Identifier of the instance to remove.
   * @returns True if removed.
   */
  remove(instanceId: string): boolean {
    const instance = this.instances.get(instanceId)
    if (!instance) return false

    // Detach from parent
    if (instance.parentInstanceId) {
      const parent = this.instances.get(instance.parentInstanceId)
      if (parent && parent.childInstanceIds.includes(instanceId)) {
        const updatedParent: OverlayInstance = {
          ...parent,
          childInstanceIds: parent.childInstanceIds.filter(id => id !== instanceId),
        }
        this.instances.set(parent.instanceId, updatedParent)
      }
    }

    const orderIdx = this.ordering.indexOf(instanceId)
    if (orderIdx >= 0) {
      this.ordering.splice(orderIdx, 1)
    }

    return this.instances.delete(instanceId)
  }

  /**
   * Retrieves an active overlay instance by identifier.
   *
   * @param instanceId - Instance identifier.
   */
  get(instanceId: string): OverlayInstance | undefined {
    return this.instances.get(instanceId)
  }

  /**
   * Returns a snapshot of all active overlay instances in chronological creation order.
   */
  list(): readonly OverlayInstance[] {
    const result: OverlayInstance[] = []
    for (const id of this.ordering) {
      const inst = this.instances.get(id)
      if (inst) result.push(inst)
    }
    return result
  }

  /**
   * Retrieves all active instances owned by a specific subsystem or plugin.
   *
   * @param ownerId - Subsystem or plugin identifier.
   */
  getByOwner(ownerId: string): readonly OverlayInstance[] {
    return this.list().filter(inst => inst.ownerId === ownerId)
  }

  /**
   * Retrieves all active instances associated with a logical stack group.
   *
   * @param group - Group identifier.
   */
  getByGroup(group: string): readonly OverlayInstance[] {
    return this.list().filter(inst => inst.stack.group === group)
  }

  private getStackLevelWeight(level?: 'normal' | 'modal' | 'tooltip'): number {
    switch (level) {
      case 'tooltip':
        return 30
      case 'modal':
        return 20
      case 'normal':
      default:
        return 10
    }
  }

  /**
   * Returns the topmost active overlay instance matching an optional filter.
   * Evaluates stack level ordering (tooltip > modal > normal) followed by chronological ordering.
   *
   * @param filter - Optional predicate to filter candidate instances.
   */
  getTopmost(filter?: (inst: OverlayInstance) => boolean): OverlayInstance | undefined {
    let bestInst: OverlayInstance | undefined = undefined
    let bestWeight = -1
    let bestIndex = -1

    for (let i = this.ordering.length - 1; i >= 0; i--) {
      const id = this.ordering[i]
      if (!id) continue
      const inst = this.instances.get(id)
      if (!inst || (filter && !filter(inst))) continue

      const weight = this.getStackLevelWeight(inst.stack.stackLevel)
      if (weight > bestWeight || (weight === bestWeight && i > bestIndex)) {
        bestInst = inst
        bestWeight = weight
        bestIndex = i
      }
    }
    return bestInst
  }

  /**
   * Validates parent-child nesting, enforcing maximum depth limits and cycle rejection.
   *
   * @param parentInstanceId - The target parent overlay instance ID.
   * @param maxDepth - Maximum permitted nesting depth (default 10).
   * @param candidateChildId - Optional child instance ID to prevent self-parenting and cyclic graphs.
   */
  validateNesting(parentInstanceId: string, maxDepth = 10, candidateChildId?: string): OverlayInstance {
    if (candidateChildId && parentInstanceId === candidateChildId) {
      throw new Error(`Cycle detected: overlay instance '${candidateChildId}' cannot be its own parent.`)
    }

    if (candidateChildId && this.isDescendant(parentInstanceId, candidateChildId)) {
      throw new Error(
        `Cycle detected: cannot attach '${candidateChildId}' to descendant '${parentInstanceId}'.`,
      )
    }

    const parent = this.instances.get(parentInstanceId)
    if (!parent) {
      throw new Error(`Parent overlay instance '${parentInstanceId}' does not exist.`)
    }

    if (parent.state === 'CLOSING' || parent.state === 'CLOSED' || parent.state === 'FAULTED') {
      throw new Error(
        `Cannot attach child overlay to parent '${parentInstanceId}' in state '${parent.state}'.`,
      )
    }

    // Compute nesting depth: 1 for new child + ancestor chain
    let depth = 1
    let current: OverlayInstance | undefined = parent
    const seen = new Set<string>()

    while (current) {
      depth++
      if (depth > maxDepth) {
        throw new Error(
          `Maximum overlay nesting depth (${maxDepth}) exceeded for parent '${parentInstanceId}'.`,
        )
      }
      if (seen.has(current.instanceId)) {
        throw new Error(`Cycle detected in overlay nesting hierarchy at instance '${current.instanceId}'.`)
      }
      seen.add(current.instanceId)
      if (!current.parentInstanceId) break
      current = this.instances.get(current.parentInstanceId)
    }

    return parent
  }

  /**
   * Retrieves all descendant instances of a parent in bottom-up post-order
   * (deepest children first), ensuring teardown proceeds from child to parent.
   *
   * @param instanceId - Root instance identifier.
   */
  getDescendants(instanceId: string): readonly OverlayInstance[] {
    const descendants: OverlayInstance[] = []
    const visited = new Set<string>()

    const walk = (currentId: string): void => {
      if (visited.has(currentId)) return
      visited.add(currentId)

      const inst = this.instances.get(currentId)
      if (!inst) return

      for (const childId of inst.childInstanceIds) {
        walk(childId)
      }

      if (currentId !== instanceId) {
        descendants.push(inst)
      }
    }

    walk(instanceId)
    return descendants
  }

  /**
   * Retrieves all ancestor instances of a given instance, from immediate parent up to root.
   *
   * @param instanceId - Target instance identifier.
   */
  getAncestors(instanceId: string): readonly OverlayInstance[] {
    const ancestors: OverlayInstance[] = []
    let current = this.instances.get(instanceId)
    const seen = new Set<string>()

    while (current?.parentInstanceId && !seen.has(current.parentInstanceId)) {
      seen.add(current.parentInstanceId)
      const parent = this.instances.get(current.parentInstanceId)
      if (parent) {
        ancestors.push(parent)
        current = parent
      } else {
        break
      }
    }

    return ancestors
  }

  /**
   * Checks whether candidateChild is a descendant of candidateParent.
   *
   * @param candidateChildId - Possible child instance ID.
   * @param candidateParentId - Possible parent instance ID.
   */
  isDescendant(candidateChildId: string, candidateParentId: string): boolean {
    const ancestors = this.getAncestors(candidateChildId)
    return ancestors.some(a => a.instanceId === candidateParentId)
  }

  /**
   * Clears all instances from the registry.
   */
  clear(): void {
    this.instances.clear()
    this.ordering.length = 0
  }
}
