/**
 * Native Windows Shell Link (.lnk) resolver backed by the Rust Native Core.
 *
 * Implements the ShellLinkResolver contract using native COM IShellLinkW / IPersistFile
 * over the typed bridge, completely replacing the PowerShell fallback adapter.
 *
 * @module @deepseek-ai/dsh-native-core/adapters/shortcuts
 */

import * as path from 'node:path'
import type { ShellShortcutMetadata } from '../types.ts'
import type { NativeBridgeClient } from '../client.ts'

export interface ShellLinkResolver {
  resolve(linkPath: string, signal?: AbortSignal): Promise<ShellShortcutMetadata | undefined>
  resolveBatch(
    linkPaths: readonly string[],
    signal?: AbortSignal,
  ): Promise<Map<string, ShellShortcutMetadata>>
}

/**
 * Shell Link resolver delegating to Rust Native Core COM implementation.
 */
export class NativeShellLinkResolver implements ShellLinkResolver {
  private readonly client: NativeBridgeClient
  private readonly cache = new Map<string, ShellShortcutMetadata>()

  constructor(client: NativeBridgeClient) {
    this.client = client
  }

  async resolve(linkPath: string, _signal?: AbortSignal): Promise<ShellShortcutMetadata | undefined> {
    const norm = path.resolve(linkPath)
    const cached = this.cache.get(norm)
    if (cached) return cached

    try {
      const meta = await this.client.shortcuts.resolve(norm)
      this.cache.set(norm, meta)
      return meta
    } catch {
      return undefined
    }
  }

  async resolveBatch(
    linkPaths: readonly string[],
    _signal?: AbortSignal,
  ): Promise<Map<string, ShellShortcutMetadata>> {
    const results = new Map<string, ShellShortcutMetadata>()
    if (linkPaths.length === 0) return results

    const missing: string[] = []
    for (const p of linkPaths) {
      const norm = path.resolve(p)
      const cached = this.cache.get(norm)
      if (cached) {
        results.set(norm, cached)
      } else {
        missing.push(norm)
      }
    }

    if (missing.length === 0) return results

    try {
      const map = await this.client.shortcuts.resolveBatch(missing)
      for (const [p, meta] of Object.entries(map)) {
        const norm = path.resolve(p)
        this.cache.set(norm, meta)
        results.set(norm, meta)
      }
    } catch {
      // Return partial cached results on error
    }

    return results
  }
}
