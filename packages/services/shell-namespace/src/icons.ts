/**
 * Shell icon reference resolution contracts and implementation.
 *
 * Decouples icon metadata description from heavy raster asset decoding.
 * Generates lightweight, strongly typed icon references (file, resource,
 * extension, shell-item, fallback) without eagerly decoding PE resources
 * or caching large image blobs.
 *
 * Phase 5/6 Rust Native Core will decode Win32 icon resources directly.
 *
 * @module @deepseek-ai/dsh-shell-namespace/icons
 */

import * as path from 'node:path'
import type {
  ShellIconReference,
  ShellItemKind,
  ShellShortcutMetadata,
} from './types.ts'

/** Image extensions that can be referenced directly as file icons. */
const DIRECT_IMAGE_EXTENSIONS = new Set([
  '.ico',
  '.png',
  '.jpg',
  '.jpeg',
  '.svg',
  '.webp',
])

/** Binary formats containing embedded icon resources. */
const RESOURCE_EXTENSIONS = new Set(['.exe', '.dll', '.scr'])

/**
 * Contract for resolving a lightweight ShellIconReference for a shell item.
 */
export interface ShellIconResolver {
  /**
   * Resolves an icon reference for a shell item.
   *
   * @param kind - Item classification kind.
   * @param filePath - Path to the item on disk.
   * @param extension - Optional lowercase file extension including dot.
   * @param shortcut - Optional shortcut metadata if kind is 'shortcut'.
   * @returns Strongly typed ShellIconReference.
   */
  resolveReference(
    kind: ShellItemKind,
    filePath: string,
    extension?: string,
    shortcut?: ShellShortcutMetadata,
  ): ShellIconReference
}

/**
 * Standard shell icon reference resolver.
 */
export class DefaultShellIconResolver implements ShellIconResolver {
  resolveReference(
    kind: ShellItemKind,
    filePath: string,
    extension?: string,
    shortcut?: ShellShortcutMetadata,
  ): ShellIconReference {
    // 1. If shortcut defines an explicit icon reference, use it
    if (shortcut?.icon) {
      return shortcut.icon
    }

    // 2. Folders
    if (kind === 'folder') {
      return {
        kind: 'fallback',
        defaultIconId: 'generic-folder',
      }
    }

    // 3. Known virtual or system
    if (kind === 'virtual' || kind === 'system') {
      return {
        kind: 'fallback',
        defaultIconId: 'generic-system',
      }
    }

    const ext = (extension ?? path.extname(filePath)).toLowerCase()

    // 4. Direct image files
    if (DIRECT_IMAGE_EXTENSIONS.has(ext)) {
      return {
        kind: 'file',
        filePath,
      }
    }

    // 5. Executables and DLLs
    if (RESOURCE_EXTENSIONS.has(ext)) {
      return {
        kind: 'resource',
        sourcePath: filePath,
        resourceIndex: 0,
      }
    }

    // 6. Shortcuts without explicit icon: inherit target's icon if target has recognizable extension
    if (kind === 'shortcut' || ext === '.lnk') {
      if (shortcut?.target) {
        const targetExt = path.extname(shortcut.target).toLowerCase()
        if (RESOURCE_EXTENSIONS.has(targetExt)) {
          return {
            kind: 'resource',
            sourcePath: shortcut.target,
            resourceIndex: 0,
          }
        }
        if (DIRECT_IMAGE_EXTENSIONS.has(targetExt)) {
          return {
            kind: 'file',
            filePath: shortcut.target,
          }
        }
        if (targetExt && targetExt.length > 1) {
          return {
            kind: 'extension',
            extension: targetExt,
          }
        }
      }
      return {
        kind: 'fallback',
        defaultIconId: 'generic-shortcut',
      }
    }

    // 7. Typed file extension reference
    if (ext && ext.length > 1) {
      return {
        kind: 'extension',
        extension: ext,
      }
    }

    // 8. Default fallback
    return {
      kind: 'fallback',
      defaultIconId: 'generic-file',
    }
  }
}
