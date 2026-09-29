/**
 * Windows Start Menu shortcut discovery provider.
 *
 * Scans both per-user and all-users Start Menu Programs directories for `.lnk` shortcuts.
 * Resolves shortcut target paths, working directories, arguments, and icon locations
 * via the isolated PowerShell adapter or custom scanner in a single batch query.
 *
 * @module @deepseek-ai/dsh-app-registry/providers/start-menu
 */

import type { AppDiscoveryProvider, DiscoveredApplication } from '../types.ts'
import { PowerShellAdapter } from '../powershell.ts'

/** Filter patterns for known non-application shortcut titles. */
const IGNORED_SHORTCUT_NAMES = /^(uninstall|unins[0-9]*|remove|readme|help|documentation|release notes|license|website|visit)/i

/**
 * Raw shortcut structure returned by the batch PowerShell script.
 */
interface RawShortcutItem {
  ShortcutPath: string
  Name: string
  TargetPath?: string | null
  Arguments?: string | null
  Description?: string | null
  IconLocation?: string | null
  WorkingDirectory?: string | null
}

/**
 * Script executed by PowerShell to batch-read all .lnk files under Start Menu directories.
 */
const START_MENU_BATCH_SCRIPT = `
$sh = New-Object -ComObject WScript.Shell
$dirs = @(
  [System.IO.Path]::Combine($env:APPDATA, 'Microsoft\\Windows\\Start Menu\\Programs'),
  [System.IO.Path]::Combine($env:ProgramData, 'Microsoft\\Windows\\Start Menu\\Programs')
)
$results = @()
foreach ($d in $dirs) {
  if (Test-Path $d) {
    Get-ChildItem -Path $d -Filter *.lnk -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object {
      try {
        $lnk = $sh.CreateShortcut($_.FullName)
        $results += [PSCustomObject]@{
          ShortcutPath = $_.FullName
          Name = $_.BaseName
          TargetPath = $lnk.TargetPath
          Arguments = $lnk.Arguments
          Description = $lnk.Description
          IconLocation = $lnk.IconLocation
          WorkingDirectory = $lnk.WorkingDirectory
        }
      } catch {}
    }
  }
}
$results | ConvertTo-Json -Depth 2 -Compress
`

/** Custom scanner function contract for headless testing or platform mocking. */
export type StartMenuScanner = (signal?: AbortSignal) => Promise<readonly RawShortcutItem[]>

/**
 * Start Menu application discovery provider.
 */
export class StartMenuProvider implements AppDiscoveryProvider {
  readonly id = 'start-menu'

  private readonly psAdapter: PowerShellAdapter
  private readonly customScanner?: StartMenuScanner | undefined

  constructor(options?: {
    readonly psAdapter?: PowerShellAdapter | undefined
    readonly customScanner?: StartMenuScanner | undefined
  }) {
    this.psAdapter = options?.psAdapter ?? new PowerShellAdapter()
    this.customScanner = options?.customScanner
  }

  async discover(signal?: AbortSignal): Promise<readonly DiscoveredApplication[]> {
    let rawShortcuts: readonly RawShortcutItem[] = []

    if (this.customScanner) {
      rawShortcuts = await this.customScanner(signal)
    } else {
      const isAvailable = await this.psAdapter.isAvailable()
      if (!isAvailable) {
        return []
      }

      const output = await this.psAdapter.runScript<RawShortcutItem | RawShortcutItem[]>(
        START_MENU_BATCH_SCRIPT,
        { signal },
      )

      if (output) {
        rawShortcuts = Array.isArray(output) ? output : [output]
      }
    }

    const discoveries: DiscoveredApplication[] = []

    for (const raw of rawShortcuts) {
      if (!raw.Name || !raw.ShortcutPath) continue

      const trimmedName = raw.Name.trim()
      if (IGNORED_SHORTCUT_NAMES.test(trimmedName)) {
        continue
      }

      const isUser = raw.ShortcutPath.toLowerCase().includes('\\users\\') || raw.ShortcutPath.toLowerCase().includes('/users/')
      const source = isUser ? 'start-menu-user' : 'start-menu-system'

      // Check if target is a known executable or general path
      const targetPath = raw.TargetPath ? raw.TargetPath.trim() : undefined
      const isExe = targetPath ? targetPath.toLowerCase().endsWith('.exe') : false

      discoveries.push({
        source,
        kind: isExe ? 'win32' : 'shortcut',
        displayName: trimmedName,
        description: raw.Description || undefined,
        executablePath: isExe ? targetPath : undefined,
        shortcutPath: raw.ShortcutPath,
        arguments: raw.Arguments ? [raw.Arguments.trim()] : undefined,
        workingDirectory: raw.WorkingDirectory || undefined,
        iconPath: raw.IconLocation || raw.TargetPath || raw.ShortcutPath,
      })
    }

    return Object.freeze(discoveries)
  }
}
