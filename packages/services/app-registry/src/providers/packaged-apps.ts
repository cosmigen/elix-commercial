/**
 * Windows Packaged Applications (MSIX / Appx / UWP) discovery provider.
 *
 * Utilizes Windows shell `Get-StartApps` and `Get-AppxPackage` commands through
 * the isolated PowerShell adapter to discover modern packaged apps and their canonical AUMIDs.
 *
 * @module @deepseek-ai/dsh-app-registry/providers/packaged-apps
 */

import type { AppDiscoveryProvider, DiscoveredApplication } from '../types.ts'
import { PowerShellAdapter } from '../powershell.ts'

/**
 * Raw item returned by PowerShell query for packaged applications.
 */
interface RawPackagedAppItem {
  Name: string
  AppID: string
  PackageFamilyName?: string | null
  Publisher?: string | null
  InstallLocation?: string | null
  Logo?: string | null
}

/**
 * PowerShell script to discover packaged applications and resolve their AUMID and package metadata.
 */
const PACKAGED_APPS_SCRIPT = `
$startApps = Get-StartApps | Where-Object { $_.AppID -like "*!*" }
$packages = Get-AppxPackage -ErrorAction SilentlyContinue | Select-Object Name, PackageFamilyName, Publisher, InstallLocation
$packageMap = @{}
foreach ($pkg in $packages) {
  if ($pkg.PackageFamilyName) {
    $packageMap[$pkg.PackageFamilyName] = $pkg
  }
}

$results = @()
foreach ($app in $startApps) {
  $pfn = ($app.AppID -split '!')[0]
  $pkgInfo = $packageMap[$pfn]
  $results += [PSCustomObject]@{
    Name = $app.Name
    AppID = $app.AppID
    PackageFamilyName = $pfn
    Publisher = if ($pkgInfo) { $pkgInfo.Publisher } else { $null }
    InstallLocation = if ($pkgInfo) { $pkgInfo.InstallLocation } else { $null }
  }
}
$results | ConvertTo-Json -Depth 2 -Compress
`

/** Custom scanner function for testing or platform mocking. */
export type PackagedAppsScanner = (signal?: AbortSignal) => Promise<readonly RawPackagedAppItem[]>

/**
 * Packaged applications discovery provider.
 */
export class PackagedAppsProvider implements AppDiscoveryProvider {
  readonly id = 'packaged-apps'

  private readonly psAdapter: PowerShellAdapter
  private readonly customScanner?: PackagedAppsScanner | undefined

  constructor(options?: {
    readonly psAdapter?: PowerShellAdapter | undefined
    readonly customScanner?: PackagedAppsScanner | undefined
  }) {
    this.psAdapter = options?.psAdapter ?? new PowerShellAdapter()
    this.customScanner = options?.customScanner
  }

  async discover(signal?: AbortSignal): Promise<readonly DiscoveredApplication[]> {
    let rawItems: readonly RawPackagedAppItem[] = []

    if (this.customScanner) {
      rawItems = await this.customScanner(signal)
    } else {
      const isAvailable = await this.psAdapter.isAvailable()
      if (!isAvailable) {
        return []
      }

      const output = await this.psAdapter.runScript<RawPackagedAppItem | RawPackagedAppItem[]>(
        PACKAGED_APPS_SCRIPT,
        { signal },
      )

      if (output) {
        rawItems = Array.isArray(output) ? output : [output]
      }
    }

    const discoveries: DiscoveredApplication[] = []

    for (const item of rawItems) {
      if (!item.Name || !item.AppID) continue

      const trimmedName = item.Name.trim()
      const trimmedAumid = item.AppID.trim()

      discoveries.push({
        source: 'packaged-apps',
        kind: 'packaged',
        rawId: trimmedAumid,
        aumid: trimmedAumid,
        displayName: trimmedName,
        packageFamilyName: item.PackageFamilyName ? item.PackageFamilyName.trim() : undefined,
        publisher: item.Publisher ? item.Publisher.trim() : undefined,
        installLocation: item.InstallLocation ? item.InstallLocation.trim() : undefined,
        iconPath: item.Logo ? item.Logo.trim() : undefined,
      })
    }

    return Object.freeze(discoveries)
  }
}
