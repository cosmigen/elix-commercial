/**
 * Desktop Aggregator for ELIX Shell Namespace.
 *
 * Implements the Windows Desktop composite model:
 * Desktop Namespace
 * ├── Current User Desktop (%USERPROFILE%\Desktop or redirected)
 * └── Public Desktop (%PUBLIC%\Desktop or C:\Users\Public\Desktop)
 *
 * CRITICAL REQUIREMENTS:
 * 1. Resolves actual configured folders via KnownFolderResolver (never hardcoded C:\Users\...).
 * 2. When the same display name appears in both sources (e.g. "Notes.txt" in user
 *    desktop and "Notes.txt" in public desktop), they are distinct physical objects
 *    with distinct identities. They are NEVER merged solely by name.
 * 3. Both items are preserved with their respective source annotations:
 *    `'user-desktop'` vs `'public-desktop'`.
 * 4. Zero knowledge of Home coordinates, widgets, wallpapers, Dock, or surfaces.
 *
 * @module @deepseek-ai/dsh-shell-namespace/desktop
 */

import type { KnownFolderResolver } from './known-folders.ts'
import type { FileSystemProvider } from './file-system.ts'
import type { DesktopSnapshot, ShellItem, ShellItemId } from './types.ts'

/**
 * Composite Desktop Aggregator.
 */
export class DesktopAggregator {
  private readonly knownFolderResolver: KnownFolderResolver
  private readonly fileSystemProvider: FileSystemProvider

  constructor(options: {
    knownFolderResolver: KnownFolderResolver
    fileSystemProvider: FileSystemProvider
  }) {
    this.knownFolderResolver = options.knownFolderResolver
    this.fileSystemProvider = options.fileSystemProvider
  }

  /**
   * Aggregates and returns a snapshot of all active desktop sources.
   *
   * @param signal - Optional cancellation signal.
   * @returns Immutable DesktopSnapshot with aggregated items.
   */
  async getSnapshot(signal?: AbortSignal): Promise<DesktopSnapshot> {
    const [userRes, publicRes] = await Promise.all([
      this.knownFolderResolver.resolve('Desktop'),
      this.knownFolderResolver.resolve('PublicDesktop'),
    ])

    const userPath = userRes.available && userRes.path ? userRes.path : undefined
    const publicPath =
      publicRes.available && publicRes.path ? publicRes.path : undefined

    const userPromise = userPath
      ? this.fileSystemProvider.listDirectory(userPath, {
        source: 'user-desktop',
        signal,
      })
      : Promise.resolve([])

    const publicPromise = publicPath
      ? this.fileSystemProvider.listDirectory(publicPath, {
        source: 'public-desktop',
        signal,
      })
      : Promise.resolve([])

    const [userItems, publicItems] = await Promise.all([userPromise, publicPromise])

    // Merge strategy:
    // Identity must determine whether items are the same object.
    // If two items have distinct identities (even if their display names match),
    // BOTH are preserved in the desktop items array!
    const seenIds = new Set<ShellItemId>()
    const aggregated: ShellItem[] = []

    for (const item of userItems) {
      if (!seenIds.has(item.id)) {
        seenIds.add(item.id)
        aggregated.push(item)
      }
    }

    for (const item of publicItems) {
      if (!seenIds.has(item.id)) {
        seenIds.add(item.id)
        aggregated.push(item)
      }
    }

    return Object.freeze({
      items: Object.freeze(aggregated),
      userDesktopPath: userPath,
      publicDesktopPath: publicPath,
      timestamp: Date.now(),
    })
  }
}
