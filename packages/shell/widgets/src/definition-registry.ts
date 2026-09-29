/**
 * Authoritative Widget Definition Registry for ELIX Widget Runtime.
 *
 * Enforces single-owner definition sovereignty, validates geometry constraints,
 * and provides versioned, safe registration and unregistration.
 *
 * @module @deepseek-ai/dsh-shell-widgets/definition-registry
 */

import type { WidgetDefinition } from './types.ts'

interface RegistryEntry {
  readonly definition: WidgetDefinition
  readonly version: number
}

/**
 * Validates widget definition geometry constraints.
 */
function validateDefinition(def: WidgetDefinition): void {
  if (!def.id || typeof def.id !== 'string' || def.id.trim().length === 0) {
    throw new Error('Widget definition id must be a non-empty string.')
  }
  if (!def.ownerId || typeof def.ownerId !== 'string' || def.ownerId.trim().length === 0) {
    throw new Error('Widget definition ownerId must be a non-empty string.')
  }
  if (!def.title || typeof def.title !== 'string' || def.title.trim().length === 0) {
    throw new Error('Widget definition title must be a non-empty string.')
  }

  if (def.defaultSize.width <= 0 || def.defaultSize.height <= 0) {
    throw new Error(
      `Invalid defaultSize for widget "${def.id}": width (${def.defaultSize.width}) and height (${def.defaultSize.height}) must be positive.`,
    )
  }

  if (def.minSize.width <= 0 || def.minSize.height <= 0) {
    throw new Error(
      `Invalid minSize for widget "${def.id}": width (${def.minSize.width}) and height (${def.minSize.height}) must be positive.`,
    )
  }

  if (def.defaultSize.width < def.minSize.width || def.defaultSize.height < def.minSize.height) {
    throw new Error(
      `Widget "${def.id}" defaultSize (${def.defaultSize.width}x${def.defaultSize.height}) cannot be smaller than minSize (${def.minSize.width}x${def.minSize.height}).`,
    )
  }

  if (def.maxSize !== undefined) {
    const maxSize = def.maxSize
    if (maxSize.width < def.minSize.width || maxSize.height < def.minSize.height) {
      throw new Error(
        `Widget "${def.id}" maxSize (${maxSize.width}x${maxSize.height}) cannot be smaller than minSize (${def.minSize.width}x${def.minSize.height}).`,
      )
    }
  }
}

/**
 * Registry storing all registered widget definitions.
 */
export class WidgetDefinitionRegistry {
  private readonly definitions = new Map<string, RegistryEntry>()
  private nextVersion = 1

  /**
   * Register a new or updated widget definition.
   *
   * @param def - Widget definition to register.
   * @returns Disposer function that safely unregisters this specific version.
   */
  register(def: WidgetDefinition): () => boolean {
    validateDefinition(def)

    const existing = this.definitions.get(def.id)
    if (existing !== undefined && existing.definition.ownerId !== def.ownerId) {
      throw new Error(
        `Widget definition '${def.id}' is already registered by owner '${existing.definition.ownerId}'. Owner '${def.ownerId}' cannot claim it.`,
      )
    }

    const version = this.nextVersion++
    this.definitions.set(def.id, { definition: { ...def }, version })

    let disposed = false
    return (): boolean => {
      if (disposed) return false
      disposed = true
      const current = this.definitions.get(def.id)
      if (current !== undefined && current.version === version) {
        this.definitions.delete(def.id)
        return true
      }
      return false
    }
  }

  /**
   * Unregister a widget definition by its identifier.
   */
  unregister(id: string): boolean {
    return this.definitions.delete(id)
  }

  /**
   * Retrieve a definition by its ID.
   */
  get(id: string): WidgetDefinition | undefined {
    return this.definitions.get(id)?.definition
  }

  /**
   * Check whether a definition exists.
   */
  has(id: string): boolean {
    return this.definitions.has(id)
  }

  /**
   * List all registered widget definitions.
   */
  list(): readonly WidgetDefinition[] {
    return Array.from(this.definitions.values(), entry => entry.definition)
  }

  /**
   * Retrieve all definitions owned by a specific owner ID.
   */
  getByOwner(ownerId: string): readonly WidgetDefinition[] {
    const results: WidgetDefinition[] = []
    for (const entry of this.definitions.values()) {
      if (entry.definition.ownerId === ownerId) {
        results.push(entry.definition)
      }
    }
    return results
  }

  /**
   * Remove all definitions registered by a specific owner.
   *
   * @param ownerId - Subsystem or plugin owner ID.
   * @returns Array of removed definition IDs.
   */
  removeByOwner(ownerId: string): readonly string[] {
    const removed: string[] = []
    for (const [id, entry] of this.definitions.entries()) {
      if (entry.definition.ownerId === ownerId) {
        this.definitions.delete(id)
        removed.push(id)
      }
    }
    return removed
  }

  /**
   * Clear all definitions from the registry.
   */
  clear(): void {
    this.definitions.clear()
  }
}
