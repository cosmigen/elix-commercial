/**
 * Demand-driven filesystem provider for the ELIX Shell Namespace.
 *
 * Responsibilities:
 * 1. Enumerate container children on demand (never recursively crawl whole disk).
 * 2. Classify items into file, folder, shortcut, reparse point.
 * 3. Extract accurate file timestamps (creation, modification) and size.
 * 4. Safe Unicode and long path support.
 * 5. Reparse point safety: Never follow symlinks or junctions into recursive loops;
 *    mark `reparsePoint: true` on attributes.
 * 6. Resilient error handling: Handle EACCES, EPERM, ENOENT gracefully; files
 *    disappearing during enumeration must never crash the host.
 * 7. Provide complete unhidden attributes (hidden, system, readOnly, etc.) so UI
 *    policies can be determined by downstream consumers.
 *
 * @module @deepseek-ai/dsh-shell-namespace/file-system
 */

import * as fs from 'node:fs/promises'
import type { Dirent, Stats } from 'node:fs'
import * as path from 'node:path'
import { runNativeCommand } from '@deepseek-ai/dsh-native-command'
import { deadline } from '@deepseek-ai/dsh-timeout'
import type { FileIdentityAdapter } from './identity.ts'
import { DefaultFileIdentityAdapter } from './identity.ts'
import type { ShellIconResolver } from './icons.ts'
import { DefaultShellIconResolver } from './icons.ts'
import type { ShellLinkResolver } from './shortcuts.ts'
import { DefaultShellLinkResolver } from './shortcuts.ts'
import type {
  ShellItem,
  ShellItemAttributes,
  ShellItemId,
  ShellItemKind,
  ShellItemSource,
} from './types.ts'

/**
 * Options for directory listing operations.
 */
export interface ListOptions {
  /** Contributing source to stamp on discovered items. */
  source?: ShellItemSource | undefined
  /** Parent container ID to stamp on children. */
  parentId?: ShellItemId | undefined
  /** Optional cancellation signal. */
  signal?: AbortSignal | undefined
}

/**
 * Normalizes Windows file paths safely, ensuring clean drive formatting
 * and handling extended-length long paths (`\\?\`) where appropriate.
 *
 * @param targetPath - Raw path.
 * @returns Normalized absolute path.
 */
export function normalizeFileSystemPath(targetPath: string): string {
  const clean = targetPath.replace(/^[\\/]{2}\?[\\/]/, '')
  const resolved = path.resolve(clean)
  // Ensure Windows drive letter is formatted consistently
  if (/^[a-zA-Z]:[\\/]/.test(resolved)) {
    return resolved.charAt(0).toUpperCase() + resolved.slice(1)
  }
  return resolved
}

/** Parsed Windows file attribute flags. */
export interface WindowsAttributesRecord {
  readonly hidden: boolean
  readonly system: boolean
  readonly readOnly: boolean
  readonly archive: boolean
  readonly offline: boolean
}

/**
 * Parses raw stdout output from Windows `attrib.exe`.
 *
 * @param stdout - Output from attrib.exe.
 * @returns Map of canonical lowercase paths to attribute flags.
 */
export function parseAttribOutput(stdout: string): Map<string, WindowsAttributesRecord> {
  const map = new Map<string, WindowsAttributesRecord>()
  const lines = stdout.split(/\r?\n/)
  for (const line of lines) {
    if (line.length < 19) continue
    const flags = line.slice(0, 18).toUpperCase()
    const filePath = line.slice(18).trim()
    if (!filePath) continue

    const norm = normalizeFileSystemPath(filePath).toLowerCase()
    map.set(norm, {
      hidden: flags.includes('H'),
      system: flags.includes('S'),
      readOnly: flags.includes('R'),
      archive: flags.includes('A'),
      offline: flags.includes('O') || flags.includes('U'),
    })
  }
  return map
}

/**
 * Queries real Windows file attributes via `attrib.exe` in a single non-blocking invocation.
 * Degrades cleanly to an empty map if attrib fails, times out, or runs on non-Windows.
 *
 * @param targetPath - Absolute directory or file path.
 * @param isDirectory - Whether the target is a directory container.
 * @param signal - Optional cancellation signal.
 * @param timeoutMs - Optional timeout in milliseconds (defaults to 2000ms).
 * @returns Map of canonical path to attribute flags.
 */
export async function queryWindowsAttributes(
  targetPath: string,
  isDirectory: boolean,
  signal?: AbortSignal,
  timeoutMs = 2_000,
): Promise<Map<string, WindowsAttributesRecord>> {
  if (process.platform !== 'win32') {
    return new Map()
  }

  try {
    using dl = deadline(signal, timeoutMs, 'QUERY_WINDOWS_ATTRIBUTES')
    const queryArg = isDirectory ? path.join(targetPath, '*') : targetPath
    const result = await runNativeCommand('attrib.exe', ['/d', queryArg], dl.signal)
    if (result.stdout) {
      return parseAttribOutput(result.stdout)
    }
  } catch {
    // Degrade cleanly if attrib fails (e.g. empty directory or access denied)
  }

  return new Map()
}

/**
 * Demand-driven filesystem provider.
 */
export class FileSystemProvider {
  private readonly identityAdapter: FileIdentityAdapter
  private readonly iconResolver: ShellIconResolver
  private readonly linkResolver: ShellLinkResolver
  private readonly lstatFn: (path: string) => Promise<Stats>
  private readonly readdirFn: (path: string, options: { withFileTypes: true }) => Promise<Dirent[]>

  constructor(options?: {
    identityAdapter?: FileIdentityAdapter | undefined
    iconResolver?: ShellIconResolver | undefined
    linkResolver?: ShellLinkResolver | undefined
    lstat?: ((path: string) => Promise<Stats>) | undefined
    readdir?: ((path: string, options: { withFileTypes: true }) => Promise<Dirent[]>) | undefined
  }) {
    this.identityAdapter = options?.identityAdapter ?? new DefaultFileIdentityAdapter()
    this.iconResolver = options?.iconResolver ?? new DefaultShellIconResolver()
    this.linkResolver = options?.linkResolver ?? new DefaultShellLinkResolver()
    this.lstatFn = options?.lstat ?? (p => fs.lstat(p))
    this.readdirFn = options?.readdir ?? ((p, o) => fs.readdir(p, o))
  }

  /**
   * Enumerates direct children of a single directory container.
   * Does NOT recurse into subdirectories or follow reparse points.
   *
   * @param containerPath - Directory path to list.
   * @param options - Listing options (source, parentId, signal).
   * @returns Readonly array of discovered ShellItems.
   */
  async listDirectory(
    containerPath: string,
    options?: ListOptions,
  ): Promise<readonly ShellItem[]> {
    const normContainer = normalizeFileSystemPath(containerPath)
    const source: ShellItemSource = options?.source ?? 'filesystem'
    const parentId = options?.parentId

    let entries: Dirent[]
    try {
      entries = await this.readdirFn(normContainer, { withFileTypes: true })
    } catch {
      // If directory does not exist or access is denied, return empty array safely
      return []
    }

    if (options?.signal?.aborted) {
      return []
    }

    // Query Windows attributes in a single batch pass for the entire container
    const attribMap = await queryWindowsAttributes(
      normContainer,
      true,
      options?.signal,
    )

    const items: ShellItem[] = []
    const lnkPathsToResolve: string[] = []

    // Pass 1: Stat each entry and assemble items
    for (const entry of entries) {
      if (options?.signal?.aborted) {
        break
      }

      const entryName = entry.name
      const fullPath = path.join(normContainer, entryName)

      let stats: Stats
      try {
        // Use lstat so symlinks and reparse points are not resolved transparently
        stats = await this.lstatFn(fullPath)
      } catch {
        // File may have been deleted between readdir and lstat or is inaccessible; skip cleanly
        continue
      }

      const isReparsePoint = entry.isSymbolicLink() || stats.isSymbolicLink()
      const isDir = !isReparsePoint && (entry.isDirectory() || stats.isDirectory())
      const isLnk = !isDir && entryName.toLowerCase().endsWith('.lnk')

      let kind: ShellItemKind
      if (isLnk) {
        kind = 'shortcut'
      } else if (isDir) {
        kind = 'folder'
      } else {
        kind = 'file'
      }

      const extension = isDir ? undefined : path.extname(entryName).toLowerCase()

      // Derive attributes with Windows attrib integration and fallback
      const normKey = normalizeFileSystemPath(fullPath).toLowerCase()
      const winAttrib = attribMap.get(normKey)

      const isReadOnly = winAttrib ? winAttrib.readOnly : (stats.mode & 0o222) === 0
      const isHidden = winAttrib
        ? (winAttrib.hidden || entryName.startsWith('.'))
        : entryName.startsWith('.')
      const isSystem = winAttrib ? winAttrib.system : false
      const isArchive = winAttrib ? winAttrib.archive : !isDir
      const isOffline = winAttrib ? winAttrib.offline : false

      const attributes: ShellItemAttributes = {
        hidden: isHidden,
        system: isSystem,
        readOnly: isReadOnly,
        archive: isArchive,
        directory: isDir,
        reparsePoint: isReparsePoint,
        offline: isOffline,
        temporary: false,
      }

      // Resolve file identity
      const identity = await this.identityAdapter.identify(fullPath, stats)

      // Initial icon reference (without shortcut metadata)
      const icon = this.iconResolver.resolveReference(kind, fullPath, extension)

      const item: ShellItem = {
        id: identity.id,
        kind,
        displayName: entryName,
        location: {
          path: fullPath,
          uri: `file:///${fullPath.replace(/\\/g, '/')}`,
        },
        parentId,
        source,
        attributes,
        icon,
        identityQuality: identity.quality,
        createdAt: stats.birthtimeMs > 0 ? stats.birthtimeMs : undefined,
        modifiedAt: stats.mtimeMs > 0 ? stats.mtimeMs : undefined,
        size: isDir ? undefined : stats.size,
        extension,
      }

      items.push(item)

      if (kind === 'shortcut') {
        lnkPathsToResolve.push(fullPath)
      }
    }

    // Pass 2: Batch resolve shortcut (.lnk) metadata if any shortcuts exist
    if (lnkPathsToResolve.length > 0) {
      try {
        const batchMeta = await this.linkResolver.resolveBatch(
          lnkPathsToResolve,
          options?.signal,
        )
        for (let i = 0; i < items.length; i++) {
          const it = items[i]
          if (it && it.kind === 'shortcut') {
            const meta = batchMeta.get(it.location.path)
            if (meta) {
              const updatedIcon = this.iconResolver.resolveReference(
                it.kind,
                it.location.path,
                it.extension,
                meta,
              )
              items[i] = {
                ...it,
                shortcut: meta,
                icon: updatedIcon,
              }
            }
          }
        }
      } catch {
        // Degrade cleanly if batch shortcut resolution encounters error
      }
    }

    return Object.freeze(items)
  }

  /**
   * Retrieves a single ShellItem by exact filesystem path.
   *
   * @param targetPath - Path to inspect.
   * @param options - Options (source, parentId, signal).
   * @returns Discovered ShellItem or undefined if not found.
   */
  async getItem(
    targetPath: string,
    options?: ListOptions,
  ): Promise<ShellItem | undefined> {
    const fullPath = normalizeFileSystemPath(targetPath)
    let stats: Stats
    try {
      stats = await this.lstatFn(fullPath)
    } catch {
      return undefined
    }

    const entryName = path.basename(fullPath)
    const isReparsePoint = stats.isSymbolicLink()
    const isDir = !isReparsePoint && stats.isDirectory()
    const isLnk = !isDir && entryName.toLowerCase().endsWith('.lnk')

    let kind: ShellItemKind
    if (isLnk) {
      kind = 'shortcut'
    } else if (isDir) {
      kind = 'folder'
    } else {
      kind = 'file'
    }

    const extension = isDir ? undefined : path.extname(entryName).toLowerCase()

    let winAttrib: WindowsAttributesRecord | undefined
    if (process.platform === 'win32') {
      try {
        const winAttribMap = await queryWindowsAttributes(
          fullPath,
          false,
          options?.signal,
        )
        winAttrib = winAttribMap.get(fullPath.toLowerCase())
      } catch {
        // Degrade cleanly
      }
    }

    const isReadOnly = winAttrib ? winAttrib.readOnly : (stats.mode & 0o222) === 0
    const isHidden = winAttrib
      ? (winAttrib.hidden || entryName.startsWith('.'))
      : entryName.startsWith('.')
    const isSystem = winAttrib ? winAttrib.system : false
    const isArchive = winAttrib ? winAttrib.archive : !isDir
    const isOffline = winAttrib ? winAttrib.offline : false

    const attributes: ShellItemAttributes = {
      hidden: isHidden,
      system: isSystem,
      readOnly: isReadOnly,
      archive: isArchive,
      directory: isDir,
      reparsePoint: isReparsePoint,
      offline: isOffline,
      temporary: false,
    }

    const identity = await this.identityAdapter.identify(fullPath, stats)

    let shortcutMeta = undefined
    if (kind === 'shortcut') {
      try {
        shortcutMeta = await this.linkResolver.resolve(fullPath, options?.signal)
      } catch {
        // Degrade cleanly
      }
    }

    const icon = this.iconResolver.resolveReference(
      kind,
      fullPath,
      extension,
      shortcutMeta,
    )

    return Object.freeze({
      id: identity.id,
      kind,
      displayName: entryName,
      location: {
        path: fullPath,
        uri: `file:///${fullPath.replace(/\\/g, '/')}`,
      },
      parentId: options?.parentId,
      source: options?.source ?? 'filesystem',
      attributes,
      icon,
      identityQuality: identity.quality,
      createdAt: stats.birthtimeMs > 0 ? stats.birthtimeMs : undefined,
      modifiedAt: stats.mtimeMs > 0 ? stats.mtimeMs : undefined,
      size: isDir ? undefined : stats.size,
      shortcut: shortcutMeta,
      extension,
    })
  }
}
