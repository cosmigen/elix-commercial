/**
 * Native Shell Icon resolver backed by the Rust Native Core.
 *
 * Implements the ShellIconResolver contract with native Win32 icon and PE resource inspection.
 *
 * @module @deepseek-ai/dsh-native-core/adapters/icons
 */

import * as path from 'node:path'
import type { ShellIconDescriptor, ShellIconReference, ShellShortcutMetadata } from '../types.ts'
import type { NativeBridgeClient } from '../client.ts'

export type ShellItemKind =
  | 'file'
  | 'folder'
  | 'shortcut'
  | 'known-folder'
  | 'virtual'
  | 'system'

export interface ShellIconResolver {
  resolveReference(
    kind: ShellItemKind,
    filePath: string,
    extension?: string,
    shortcut?: ShellShortcutMetadata,
  ): ShellIconReference
}

const RESOURCE_EXTENSIONS = new Set(['.exe', '.dll', '.scr'])
const DIRECT_IMAGE_EXTENSIONS = new Set(['.ico', '.png', '.jpg', '.jpeg', '.svg', '.webp'])

/**
 * Shell icon resolver delegating to Rust Native Core.
 */
export class NativeShellIconResolver implements ShellIconResolver {
  private readonly client: NativeBridgeClient

  constructor(client: NativeBridgeClient) {
    this.client = client
  }

  resolveReference(
    kind: ShellItemKind,
    filePath: string,
    extension?: string,
    shortcut?: ShellShortcutMetadata,
  ): ShellIconReference {
    if (shortcut?.icon) {
      if (shortcut.icon.kind === 'resource') {
        return {
          kind: 'resource',
          sourcePath: shortcut.icon.sourcePath,
          resourceIndex: shortcut.icon.resourceIndex,
        }
      }
      return {
        kind: 'file',
        filePath: shortcut.icon.filePath,
      }
    }

    if (kind === 'folder') {
      return {
        kind: 'fallback',
        defaultIconId: 'generic-folder',
      }
    }

    if (kind === 'virtual' || kind === 'system') {
      return {
        kind: 'fallback',
        defaultIconId: 'generic-system',
      }
    }

    const ext = (extension ?? path.extname(filePath)).toLowerCase()

    if (DIRECT_IMAGE_EXTENSIONS.has(ext)) {
      return {
        kind: 'file',
        filePath,
      }
    }

    if (RESOURCE_EXTENSIONS.has(ext)) {
      return {
        kind: 'resource',
        sourcePath: filePath,
        resourceIndex: 0,
      }
    }

    if (ext.length > 1) {
      return {
        kind: 'extension',
        extension: ext,
      }
    }

    return {
      kind: 'fallback',
      defaultIconId: 'generic-file',
    }
  }

  /**
   * Asynchronously queries the native host for full shell icon descriptors.
   */
  async resolveDescriptor(filePath: string, isDirectory = false): Promise<ShellIconDescriptor> {
    return this.client.icons.resolve(filePath, isDirectory)
  }
}
