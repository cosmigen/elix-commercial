/**
 * Native Windows Known Folder resolver backed by the Rust Native Core.
 *
 * Implements the standard KnownFolderResolver contract using native SHGetKnownFolderPath
 * queries over the typed bridge.
 *
 * @module @deepseek-ai/dsh-native-core/adapters/known-folders
 */

import type { KnownFolderId, KnownFolderResolution } from '../types.ts'
import type { NativeBridgeClient } from '../client.ts'

export interface KnownFolderResolver {
  resolve(id: KnownFolderId): Promise<KnownFolderResolution>
  resolveAll(): Promise<ReadonlyMap<KnownFolderId, KnownFolderResolution>>
}

/**
 * Known Folder resolver backed by the Rust Native Core.
 */
export class NativeKnownFolderResolver implements KnownFolderResolver {
  private readonly client: NativeBridgeClient

  constructor(client: NativeBridgeClient) {
    this.client = client
  }

  async resolve(id: KnownFolderId): Promise<KnownFolderResolution> {
    const raw = await this.client.knownFolders.resolve(id)
    return {
      id: raw.id,
      ...raw.path !== undefined ? { path: raw.path } : {},
      available: raw.available,
      isVirtual: raw.isVirtual,
      displayName: raw.displayName || raw.id,
    }
  }

  async resolveAll(): Promise<ReadonlyMap<KnownFolderId, KnownFolderResolution>> {
    const list = await this.client.knownFolders.resolveAll()
    const map = new Map<KnownFolderId, KnownFolderResolution>()
    for (const item of list) {
      map.set(item.id, {
        id: item.id,
        ...item.path !== undefined ? { path: item.path } : {},
        available: item.available,
        isVirtual: item.isVirtual,
        displayName: item.displayName || item.id,
      })
    }
    return map
  }
}
