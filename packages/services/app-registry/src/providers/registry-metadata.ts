/**
 * Windows Registry Uninstall metadata discovery provider.
 *
 * Scans HKLM and HKCU CurrentVersion\\Uninstall registry branches to extract
 * installed application metadata for enrichment and reconciliation.
 *
 * Filters out system components, OS patches, updates, and non-application entries.
 *
 * @module @deepseek-ai/dsh-app-registry/providers/registry-metadata
 */

import type { AppDiscoveryProvider, DiscoveredApplication } from '../types.ts'
import { PowerShellAdapter } from '../powershell.ts'

/**
 * Raw item returned from Registry uninstall query.
 */
interface RawRegistryUninstallItem {
  KeyName: string
  DisplayName: string
  DisplayVersion?: string | null
  Publisher?: string | null
  InstallLocation?: string | null
  DisplayIcon?: string | null
  UninstallString?: string | null
}

/**
 * PowerShell script to query Windows Uninstall registry keys safely.
 */
const REGISTRY_UNINSTALL_SCRIPT = `
$keys = @(
  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\Software\\Wow6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)

$results = @()
foreach ($k in $keys) {
  Get-ItemProperty -Path $k -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.DisplayName -and -not $_.SystemComponent -and -not $_.ParentKeyName) {
      if ($_.DisplayName -notmatch '^(KB[0-9]+|Update for|Security Update)') {
        $results += [PSCustomObject]@{
          KeyName = $_.PSChildName
          DisplayName = $_.DisplayName
          DisplayVersion = $_.DisplayVersion
          Publisher = $_.Publisher
          InstallLocation = $_.InstallLocation
          DisplayIcon = $_.DisplayIcon
          UninstallString = $_.UninstallString
        }
      }
    }
  }
}
$results | ConvertTo-Json -Depth 2 -Compress
`

/** Custom scanner function for testing or platform mocking. */
export type RegistryMetadataScanner = (signal?: AbortSignal) => Promise<readonly RawRegistryUninstallItem[]>

/**
 * Windows Registry metadata discovery provider.
 */
export class RegistryMetadataProvider implements AppDiscoveryProvider {
  readonly id = 'registry-metadata'

  private readonly psAdapter: PowerShellAdapter
  private readonly customScanner?: RegistryMetadataScanner | undefined

  constructor(options?: {
    readonly psAdapter?: PowerShellAdapter | undefined
    readonly customScanner?: RegistryMetadataScanner | undefined
  }) {
    this.psAdapter = options?.psAdapter ?? new PowerShellAdapter()
    this.customScanner = options?.customScanner
  }

  async discover(signal?: AbortSignal): Promise<readonly DiscoveredApplication[]> {
    let rawItems: readonly RawRegistryUninstallItem[] = []

    if (this.customScanner) {
      rawItems = await this.customScanner(signal)
    } else {
      const isAvailable = await this.psAdapter.isAvailable()
      if (!isAvailable) {
        return []
      }

      const output = await this.psAdapter.runScript<RawRegistryUninstallItem | RawRegistryUninstallItem[]>(
        REGISTRY_UNINSTALL_SCRIPT,
        { signal },
      )

      if (output) {
        rawItems = Array.isArray(output) ? output : [output]
      }
    }

    const discoveries: DiscoveredApplication[] = []

    for (const item of rawItems) {
      if (!item.DisplayName || !item.KeyName) continue

      const trimmedName = item.DisplayName.trim()
      let executablePath: string | undefined

      // If DisplayIcon specifies an .exe directly, use it as a potential executable target
      if (item.DisplayIcon) {
        let iconCandidate = item.DisplayIcon.trim()
        const commaIdx = iconCandidate.lastIndexOf(',')
        if (commaIdx > 0) {
          iconCandidate = iconCandidate.slice(0, commaIdx).trim()
        }
        const cleanPath = iconCandidate.replace(/^["']|["']$/g, '').trim()
        if (cleanPath.toLowerCase().endsWith('.exe')) {
          executablePath = cleanPath
        }
      }

      discoveries.push({
        source: 'registry',
        kind: 'win32',
        rawId: item.KeyName.trim(),
        displayName: trimmedName,
        publisher: item.Publisher ? item.Publisher.trim() : undefined,
        installLocation: item.InstallLocation ? item.InstallLocation.trim() : undefined,
        executablePath,
        iconPath: item.DisplayIcon ? item.DisplayIcon.trim() : undefined,
        displayVersion: item.DisplayVersion ? item.DisplayVersion.trim() : undefined,
        aliases: [item.KeyName.trim()],
      })
    }

    return Object.freeze(discoveries)
  }
}
