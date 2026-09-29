/**
 * Authoritative Overlay Definition Registry for ELIX Overlay Core.
 *
 * Owns persistent overlay definitions registered by plugins, validates renderer
 * security specifications, enforces single-owner definition sovereignty,
 * and enables safe multi-owner unregistration and cleanup.
 *
 * @module @deepseek-ai/dsh-shell-overlay/definition-registry
 */

import type { OverlayDefinition } from './types.ts'

/**
 * Validates a surface renderer specification for security and structure.
 *
 * Enforces that shell overlay surfaces are restricted to local loopback HTTP(S),
 * about:blank, or direct HTML strings to prevent arbitrary remote code execution.
 *
 * @param renderer - Surface renderer specification.
 */
function validateRenderer(renderer: OverlayDefinition['renderer']): void {
  const untrusted = renderer as unknown
  if (!untrusted || typeof untrusted !== 'object') {
    throw new Error('Overlay renderer specification is required.')
  }

  if (renderer.type === 'url') {
    const url = renderer.target.trim()
    if (!url) {
      throw new Error('Overlay renderer URL target must not be empty.')
    }
    if (url.toLowerCase() === 'about:blank') {
      return
    }
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new Error(`Invalid renderer URL format: '${url}'`)
    }

    const protocol = parsed.protocol.toLowerCase()
    if (protocol !== 'http:' && protocol !== 'https:') {
      throw new Error(
        `Unsupported renderer URL protocol '${protocol}'. Only loopback http, https, and about:blank are permitted.`,
      )
    }
    const host = parsed.hostname.toLowerCase()
    const isLoopback =
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === '[::1]'

    if (!isLoopback) {
      throw new Error(
        `Security violation: non-loopback host '${host}' is not permitted for shell overlay renderer.`,
      )
    }
  } else {
    if (!renderer.target || renderer.target.trim().length === 0) {
      throw new Error('Overlay renderer HTML target must not be empty.')
    }
  }
}

/**
 * Authoritative registry tracking persistent overlay definitions.
 */
export class OverlayDefinitionRegistry {
  private readonly definitions = new Map<string, { definition: OverlayDefinition; version: number }>()
  private nextVersion = 1

  /**
   * Registers a new overlay definition.
   *
   * @param def - Overlay definition specification.
   * @returns Disposer function that safely unregisters this specific definition version, returning true if removed.
   */
  register(def: OverlayDefinition): () => boolean {
    if (!def.id || typeof def.id !== 'string' || def.id.trim().length === 0) {
      throw new Error('Overlay definition id must be a non-empty string.')
    }
    if (!def.ownerId || typeof def.ownerId !== 'string' || def.ownerId.trim().length === 0) {
      throw new Error('Overlay definition ownerId must be a non-empty string.')
    }
    const rawSize = def.size as unknown as OverlayDefinition['size'] | undefined
    if (!rawSize || rawSize.width <= 0 || rawSize.height <= 0) {
      throw new Error(
        `Invalid overlay size for '${def.id}': width (${rawSize?.width}) and height (${rawSize?.height}) must be positive.`,
      )
    }

    validateRenderer(def.renderer)

    const existing = this.definitions.get(def.id)
    if (existing && existing.definition.ownerId !== def.ownerId) {
      throw new Error(
        `Overlay definition '${def.id}' is already registered by owner '${existing.definition.ownerId}'. Owner '${def.ownerId}' cannot claim it.`,
      )
    }

    const version = this.nextVersion++
    this.definitions.set(def.id, { definition: def, version })

    let disposed = false
    return (): boolean => {
      if (disposed) return false
      disposed = true
      const current = this.definitions.get(def.id)
      if (current && current.version === version) {
        this.definitions.delete(def.id)
        return true
      }
      return false
    }
  }

  /**
   * Unregisters an overlay definition by identifier.
   *
   * @param id - Definition identifier.
   * @returns True if the definition was removed.
   */
  unregister(id: string): boolean {
    return this.definitions.delete(id)
  }

  /**
   * Retrieves an overlay definition by identifier.
   *
   * @param id - Definition identifier.
   * @returns The registered definition, or undefined if not found.
   */
  get(id: string): OverlayDefinition | undefined {
    return this.definitions.get(id)?.definition
  }

  /**
   * Returns a snapshot of all currently registered overlay definitions.
   */
  list(): readonly OverlayDefinition[] {
    return Array.from(this.definitions.values(), entry => entry.definition)
  }

  /**
   * Retrieves all overlay definitions owned by a specific subsystem or plugin.
   *
   * @param ownerId - Subsystem or plugin identifier.
   */
  getByOwner(ownerId: string): readonly OverlayDefinition[] {
    const results: OverlayDefinition[] = []
    for (const entry of this.definitions.values()) {
      if (entry.definition.ownerId === ownerId) {
        results.push(entry.definition)
      }
    }
    return results
  }

  /**
   * Removes all definitions registered by a specific owner (e.g. upon plugin unload).
   *
   * @param ownerId - Owning subsystem identifier.
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
   * Clears all definitions from the registry.
   */
  clear(): void {
    this.definitions.clear()
  }
}
