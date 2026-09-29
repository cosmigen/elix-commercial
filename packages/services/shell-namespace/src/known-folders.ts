/**
 * Windows Known Folder resolution contracts and implementation.
 *
 * Windows Desktop is NOT simply `%USERPROFILE%\Desktop`. Known folders can be
 * redirected to OneDrive, network shares, secondary drives, or customized paths.
 *
 * This adapter queries the authoritative Windows Registry configuration
 * (`User Shell Folders`) with clean environment fallbacks, isolated behind
 * the KnownFolderResolver contract.
 *
 * Phase 5 Rust Native Core will implement SHGetKnownFolderPath behind this same contract.
 *
 * @module @deepseek-ai/dsh-shell-namespace/known-folders
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { runNativeCommand } from '@deepseek-ai/dsh-native-command'
import { deadline } from '@deepseek-ai/dsh-timeout'
import type { KnownFolderId, KnownFolderResolution } from './types.ts'

/**
 * Adapter contract for resolving Windows Known Folders.
 */
export interface KnownFolderResolver {
  /**
   * Resolves a single Known Folder by its canonical identifier.
   *
   * @param id - The KnownFolderId to resolve.
   * @returns Resolution metadata including path and availability.
   */
  resolve(id: KnownFolderId): Promise<KnownFolderResolution>

  /**
   * Resolves all supported Known Folders.
   *
   * @returns Readonly map of KnownFolderId to resolution.
   */
  resolveAll(): Promise<ReadonlyMap<KnownFolderId, KnownFolderResolution>>
}

/** Registry key names mapped to canonical KnownFolderId for HKCU. */
const HKCU_FOLDER_MAP: Readonly<Record<string, KnownFolderId>> = {
  Desktop: 'Desktop',
  Personal: 'Documents',
  '{374DE290-123F-4565-9164-39C4925E467B}': 'Downloads',
  Downloads: 'Downloads',
  'My Pictures': 'Pictures',
  '{0DDD015D-B06C-45D5-8C4C-F59713854639}': 'Pictures',
  'My Music': 'Music',
  '{4BD8D570-50BA-4FF6-A5EE-3829003C7D04}': 'Music',
  'My Video': 'Videos',
  '{1898EBFC-0863-42E6-9760-4CEE3A5AE535}': 'Videos',
  'Start Menu': 'StartMenu',
  Programs: 'Programs',
  Startup: 'Startup',
}

/** Registry key names mapped to canonical KnownFolderId for HKLM. */
const HKLM_FOLDER_MAP: Readonly<Record<string, KnownFolderId>> = {
  'Common Desktop': 'PublicDesktop',
  'Common Documents': 'PublicDocuments',
}

/**
 * Expands Windows environment variables like `%USERPROFILE%` or `%PUBLIC%` in strings.
 *
 * @param val - Raw string containing possible `%VAR%` placeholders.
 * @returns Expanded string.
 */
export function expandEnvironmentStrings(val: string): string {
  return val.replace(/%([^%]+)%/g, (_match, name: string) => {
    return process.env[name] ?? ''
  })
}

/**
 * Parses raw output from Windows `reg.exe query` command.
 *
 * @param stdout - Output from reg.exe query.
 * @returns Map of value name to expanded string data.
 */
export function parseRegQueryOutput(stdout: string): Map<string, string> {
  const map = new Map<string, string>()
  const lines = stdout.split(/\r?\n/)
  // Matches: "    Desktop    REG_EXPAND_SZ    C:\Users\..." or "    Desktop    REG_SZ    C:\..."
  const linePattern = /^\s*(?<name>.+?)\s+(?:REG_SZ|REG_EXPAND_SZ)\s+(?<data>.+)$/i

  for (const line of lines) {
    const match = linePattern.exec(line)
    if (match?.groups?.name && match.groups.data) {
      const name = match.groups.name.trim()
      const data = match.groups.data.trim()
      map.set(name, expandEnvironmentStrings(data))
    }
  }

  return map
}

/**
 * Authoritative Windows Known Folder resolver.
 * Reads Windows Registry User Shell Folders with environment fallbacks.
 */
export class WindowsKnownFolderResolver implements KnownFolderResolver {
  private cachedMap: Map<KnownFolderId, KnownFolderResolution> | null = null
  private readonly timeoutMs: number

  constructor(options?: { timeoutMs?: number }) {
    this.timeoutMs = options?.timeoutMs ?? 5_000
  }

  async resolve(id: KnownFolderId): Promise<KnownFolderResolution> {
    if (!this.cachedMap) {
      await this.refresh()
    }
    const res = this.cachedMap?.get(id)
    if (res) {
      return res
    }

    return this.getFallbackResolution(id)
  }

  async resolveAll(): Promise<ReadonlyMap<KnownFolderId, KnownFolderResolution>> {
    if (!this.cachedMap) {
      await this.refresh()
    }
    return this.cachedMap ?? new Map()
  }

  /**
   * Refreshes registry queries and updates cache.
   */
  async refresh(): Promise<void> {
    const map = new Map<KnownFolderId, KnownFolderResolution>()

    // Always provide RecycleBin virtual folder
    map.set('RecycleBin', {
      id: 'RecycleBin',
      available: true,
      isVirtual: true,
      displayName: 'Recycle Bin',
    })

    if (process.platform === 'win32') {
      await this.queryRegistryKey(
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders',
        HKCU_FOLDER_MAP,
        map,
      )
      await this.queryRegistryKey(
        'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders',
        HKLM_FOLDER_MAP,
        map,
      )
    }

    // Fill missing known folders with environment fallbacks
    const allIds: KnownFolderId[] = [
      'Desktop',
      'PublicDesktop',
      'Documents',
      'PublicDocuments',
      'Downloads',
      'Pictures',
      'Music',
      'Videos',
      'StartMenu',
      'Programs',
      'Startup',
    ]

    for (const id of allIds) {
      if (!map.has(id)) {
        map.set(id, this.getFallbackResolution(id))
      }
    }

    this.cachedMap = map
  }

  private async queryRegistryKey(
    key: string,
    folderMap: Readonly<Record<string, KnownFolderId>>,
    target: Map<KnownFolderId, KnownFolderResolution>,
  ): Promise<void> {
    try {
      using dl = deadline(undefined, this.timeoutMs, 'REG_QUERY_KNOWN_FOLDERS')
      const result = await runNativeCommand('reg.exe', ['query', key], dl.signal)
      if (result.stdout) {
        const parsed = parseRegQueryOutput(result.stdout)
        for (const [regName, regPath] of parsed) {
          const folderId = folderMap[regName]
          if (folderId && !target.has(folderId)) {
            const normalized = path.normalize(regPath)
            const available = fs.existsSync(normalized)
            target.set(folderId, {
              id: folderId,
              path: normalized,
              available,
              isVirtual: false,
              displayName: folderId,
            })
          }
        }
      }
    } catch {
      // Reg query failure degrades cleanly to fallbacks
    }
  }

  private getFallbackResolution(id: KnownFolderId): KnownFolderResolution {
    if (id === 'RecycleBin') {
      return {
        id: 'RecycleBin',
        available: true,
        isVirtual: true,
        displayName: 'Recycle Bin',
      }
    }

    const home = process.env.USERPROFILE || os.homedir()
    const pub = process.env.PUBLIC || 'C:\\Users\\Public'
    const appdata = process.env.APPDATA || path.join(home, 'AppData', 'Roaming')

    let dirPath: string
    switch (id) {
      case 'Desktop':
        dirPath = path.join(home, 'Desktop')
        break
      case 'PublicDesktop':
        dirPath = path.join(pub, 'Desktop')
        break
      case 'Documents':
        dirPath = path.join(home, 'Documents')
        break
      case 'PublicDocuments':
        dirPath = path.join(pub, 'Documents')
        break
      case 'Downloads':
        dirPath = path.join(home, 'Downloads')
        break
      case 'Pictures':
        dirPath = path.join(home, 'Pictures')
        break
      case 'Music':
        dirPath = path.join(home, 'Music')
        break
      case 'Videos':
        dirPath = path.join(home, 'Videos')
        break
      case 'StartMenu':
        dirPath = path.join(appdata, 'Microsoft', 'Windows', 'Start Menu')
        break
      case 'Programs':
        dirPath = path.join(appdata, 'Microsoft', 'Windows', 'Start Menu', 'Programs')
        break
      case 'Startup':
        dirPath = path.join(appdata, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
        break
    }

    const normalized = path.normalize(dirPath)
    return {
      id,
      path: normalized,
      available: fs.existsSync(normalized),
      isVirtual: false,
      displayName: id,
    }
  }
}

/**
 * In-memory Known Folder resolver for testing and platform mocking.
 */
export class InMemoryKnownFolderResolver implements KnownFolderResolver {
  private readonly map = new Map<KnownFolderId, KnownFolderResolution>()

  constructor(initial?: Partial<Record<KnownFolderId, string | KnownFolderResolution>>) {
    if (initial) {
      for (const [key, val] of Object.entries(initial)) {
        const id = key as KnownFolderId
        if (typeof val === 'string') {
          this.map.set(id, {
            id,
            path: val,
            available: true,
            isVirtual: false,
            displayName: id,
          })
        } else {
          this.map.set(id, val)
        }
      }
    }
    if (!this.map.has('RecycleBin')) {
      this.map.set('RecycleBin', {
        id: 'RecycleBin',
        available: true,
        isVirtual: true,
        displayName: 'Recycle Bin',
      })
    }
  }

  resolve(id: KnownFolderId): Promise<KnownFolderResolution> {
    const found = this.map.get(id)
    if (found) {
      return Promise.resolve(found)
    }
    return Promise.resolve({
      id,
      available: false,
      isVirtual: id === 'RecycleBin',
      displayName: id,
    })
  }

  resolveAll(): Promise<ReadonlyMap<KnownFolderId, KnownFolderResolution>> {
    return Promise.resolve(new Map(this.map))
  }

  setFolder(id: KnownFolderId, resolution: KnownFolderResolution | string): void {
    if (typeof resolution === 'string') {
      this.map.set(id, {
        id,
        path: resolution,
        available: true,
        isVirtual: false,
        displayName: id,
      })
    } else {
      this.map.set(id, resolution)
    }
  }
}
