/**
 * Cross-provider deduplication and metadata reconciliation engine.
 *
 * Reconciles duplicate discoveries of the same physical application reported by
 * distinct Windows sources (e.g. Start Menu shortcuts, Registry uninstall entries,
 * and Packaged AUMID listings) into a singular, authoritative {@link AppRecord}.
 *
 * Implements strict identity precedence and metadata merging rules while ensuring
 * that distinct applications sharing the same display title are never erroneously merged.
 *
 * @module @deepseek-ai/dsh-app-registry/reconcile
 */

import type { AppId, AppRecord, DiscoveredApplication } from './types.ts'
import { normalizeDiscoveredApp, sanitizeString } from './normalize.ts'
import { normalizePathForIdentity } from './identity.ts'

/**
 * Priority ordering for discovery sources.
 * Higher numeric weight represents higher authoritative identity priority.
 */
const SOURCE_PRIORITY: Record<string, number> = {
  'packaged-apps': 50,
  'win32': 40,
  'start-menu-user': 30,
  'start-menu-system': 20,
  'registry': 10,
  'manual': 0,
}

/**
 * Evaluates whether a registry discovery correlates directly to an executable discovery.
 * Checks if the executable resides within the registry entry's InstallLocation,
 * or matches its DisplayIcon path.
 */
function matchesRegistryInstall(
  executablePath: string | undefined,
  registryApp: DiscoveredApplication,
): boolean {
  if (!executablePath) return false
  const normExe = normalizePathForIdentity(executablePath)

  if (registryApp.installLocation) {
    const normInstall = normalizePathForIdentity(registryApp.installLocation)
    if (normInstall.length > 0) {
      const normInstallDir = normInstall.endsWith('/') ? normInstall : `${normInstall}/`
      if (normExe.startsWith(normInstallDir)) {
        return true
      }
    }
  }

  if (registryApp.executablePath) {
    const normRegExe = normalizePathForIdentity(registryApp.executablePath)
    if (normRegExe.length > 0 && normExe === normRegExe) {
      return true
    }
  }

  return false
}

/**
 * Merges metadata from multiple raw discoveries that represent the same application.
 *
 * Precedence Rules:
 * - DisplayName: Start Menu / Packaged > Registry
 * - Publisher: Packaged / Registry > Shortcut
 * - Description: Shortcut description > Registry
 * - InstallLocation: Registry / Package > Shortcut
 * - Icon: Shortcut / Packaged > Registry DisplayIcon > Fallback
 * - Aliases: Union of all unique aliases
 *
 * @param discoveries - Group of correlated discoveries for one application.
 * @param existing - Existing catalog record, if any.
 * @param now - Current timestamp.
 * @returns Fully reconciled, authoritative AppRecord.
 */
export function reconcileApplicationGroup(
  discoveries: readonly DiscoveredApplication[],
  existing?: AppRecord,
  now = Date.now(),
): AppRecord {
  if (discoveries.length === 0) {
    throw new Error('reconcileApplicationGroup requires at least one discovery')
  }

  // Sort by source priority descending
  const sorted = [...discoveries].sort((a, b) => {
    const pA = SOURCE_PRIORITY[a.source] ?? 0
    const pB = SOURCE_PRIORITY[b.source] ?? 0
    return pB - pA
  })

  // Primary discovery is the highest-priority source
  const primary = sorted[0]
  if (!primary) {
    throw new Error('reconcileApplicationGroup requires at least one discovery')
  }

  // Aggregate publishers
  let resolvedPublisher: string | undefined
  for (const item of sorted) {
    if (item.publisher && item.publisher.trim().length > 0) {
      resolvedPublisher = item.publisher.trim()
      break
    }
  }

  // Aggregate descriptions
  let resolvedDescription: string | undefined
  for (const item of sorted) {
    if (item.description && item.description.trim().length > 0) {
      resolvedDescription = item.description.trim()
      break
    }
  }

  // Aggregate install locations
  let resolvedInstallLocation: string | undefined
  for (const item of sorted) {
    if (item.installLocation && item.installLocation.trim().length > 0) {
      resolvedInstallLocation = item.installLocation.trim()
      break
    }
  }

  // Aggregate all aliases
  const aliasSet = new Set<string>()
  for (const item of sorted) {
    for (const a of item.aliases ?? []) {
      const sanitized = sanitizeString(a)
      if (sanitized.length > 1) {
        aliasSet.add(sanitized.toLowerCase())
      }
    }
  }

  // Select best icon reference path
  let bestIconPath = primary.iconPath
  let bestIconIndex = primary.iconResourceIndex
  if (!bestIconPath) {
    for (const item of sorted) {
      if (item.iconPath) {
        bestIconPath = item.iconPath
        bestIconIndex = item.iconResourceIndex
        break
      }
    }
  }

  // Combine into a synthesized enriched discovery
  const enrichedDiscovery: DiscoveredApplication = {
    ...primary,
    publisher: resolvedPublisher ?? primary.publisher,
    description: resolvedDescription ?? primary.description,
    installLocation: resolvedInstallLocation ?? primary.installLocation,
    iconPath: bestIconPath,
    iconResourceIndex: bestIconIndex,
    aliases: Array.from(aliasSet),
  }

  return normalizeDiscoveredApp(enrichedDiscovery, existing, now)
}

/**
 * Deduplicates and reconciles a flat list of raw discoveries into a map of authoritative AppRecords.
 *
 * @param discoveries - All discoveries collected across all providers.
 * @param existingCatalog - Current catalog records for timestamp continuity.
 * @param now - Current timestamp.
 * @returns Map of AppId to authoritative AppRecord.
 */
export function deduplicateAndReconcile(
  discoveries: readonly DiscoveredApplication[],
  existingCatalog?: ReadonlyMap<AppId, AppRecord>,
  now = Date.now(),
): Map<AppId, AppRecord> {
  // Step 1: Pre-group by primary canonical AppId
  const candidateGroups = new Map<string, DiscoveredApplication[]>()

  // Separate registry-only entries for second-pass correlation
  const registryEntries: DiscoveredApplication[] = []

  for (const discovery of discoveries) {
    if (discovery.source === 'registry' && !discovery.executablePath) {
      registryEntries.push(discovery)
      continue
    }

    const tempRecord = normalizeDiscoveredApp(discovery, undefined, now)
    const key = tempRecord.id as string
    let group = candidateGroups.get(key)
    if (!group) {
      group = []
      candidateGroups.set(key, group)
    }
    group.push(discovery)
  }

  // Step 2: Correlate remaining registry entries with matching executable apps for enrichment
  for (const reg of registryEntries) {
    for (const group of candidateGroups.values()) {
      const representative = group[0]
      if (representative && matchesRegistryInstall(representative.executablePath, reg)) {
        group.push(reg)
        break
      }
    }
  }

  // Step 3: Reconcile each group into an authoritative AppRecord
  const resultMap = new Map<AppId, AppRecord>()

  for (const group of candidateGroups.values()) {
    const first = group[0]
    if (!first) continue
    const firstNorm = normalizeDiscoveredApp(first, undefined, now)
    const existing = existingCatalog?.get(firstNorm.id)
    const reconciled = reconcileApplicationGroup(group, existing, now)
    resultMap.set(reconciled.id, reconciled)
  }

  return resultMap
}
