/**
 * Input sanitization, security validation, and normalization for discovered applications.
 *
 * All OS-provided strings, paths, and metadata are treated as untrusted input.
 * This module enforces strict boundaries before raw discoveries become {@link AppRecord} entities.
 *
 * @module @deepseek-ai/dsh-app-registry/normalize
 */

import { basename, extname } from 'node:path'
import type {
  AppIconReference,
  AppLaunchSpec,
  AppRecord,
  DiscoveredApplication,
  FallbackIconReference,
  FileIconReference,
  PackagedIconReference,
  PackagedLaunchSpec,
  ResourceIconReference,
  ShortcutLaunchSpec,
  Win32LaunchSpec,
} from './types.ts'
import { buildCanonicalDescriptor, deriveAppId } from './identity.ts'

/** Unsafe control characters and null bytes regex. */
const CONTROL_CHARS_REGEX = /[\u0000-\u001F\u007F-\u009F]/g

/** Regex for validating canonical Windows AUMIDs. */
const AUMID_REGEX = /^[A-Za-z0-9._~-]+(![A-Za-z0-9._~-]+)?$/

/** Dangerous executable extensions or script formats disallowed from arbitrary direct launch. */
const DISALLOWED_EXTENSIONS = new Set(['.vbs', '.js', '.wsf', '.reg', '.ps1', '.hta'])

/**
 * Sanitizes arbitrary untrusted string input:
 * - Strips control characters and null bytes.
 * - Trims leading and trailing whitespace.
 * - Collapses consecutive whitespace into single spaces.
 *
 * @param input - Untrusted text from discovery.
 * @returns Cleaned string.
 */
export function sanitizeString(input: string | undefined): string {
  if (!input) return ''
  return input
    .replace(CONTROL_CHARS_REGEX, '')
    .trim()
    .replace(/\s+/g, ' ')
}

/**
 * Validates whether a path is structurally safe to reference.
 * Rejects control characters, invalid Windows path characters, and dangerous script extensions.
 *
 * @param filePath - Untrusted path from discovery.
 * @returns True if path is valid.
 */
export function isValidFilePath(filePath: string | undefined): boolean {
  if (!filePath) return false
  const cleaned = filePath.trim().replace(/^["']|["']$/g, '').trim()
  if (cleaned.length === 0 || cleaned.length > 32767) return false
  if (CONTROL_CHARS_REGEX.test(cleaned)) return false

  // Disallow forbidden Windows characters in paths (excluding drive colon and separators)
  const pathWithoutDrive = cleaned.replace(/^[A-Za-z]:/, '')
  if (/[<>:"|?*]/.test(pathWithoutDrive)) return false

  const ext = extname(cleaned).toLowerCase()
  if (DISALLOWED_EXTENSIONS.has(ext)) return false

  return true
}

/**
 * Validates whether an AUMID follows canonical Windows naming rules.
 *
 * @param aumid - Candidate Application User Model ID.
 * @returns True if valid.
 */
export function isValidAumid(aumid: string | undefined): boolean {
  if (!aumid) return false
  const trimmed = aumid.trim()
  return trimmed.length > 0 && trimmed.length <= 256 && AUMID_REGEX.test(trimmed)
}

/**
 * Resolves a normalized display name from discovery fields.
 *
 * @param discovery - Raw discovery data.
 * @returns Sanitized, non-empty display name.
 */
export function resolveDisplayName(discovery: DiscoveredApplication): string {
  const sanitizedName = sanitizeString(discovery.displayName)
  if (sanitizedName.length > 0) {
    // Strip trailing .lnk or .exe if accidentally left in name
    return sanitizedName.replace(/\.(lnk|exe|url)$/i, '')
  }

  if (discovery.executablePath) {
    const base = basename(discovery.executablePath)
    return base.replace(/\.exe$/i, '')
  }

  if (discovery.shortcutPath) {
    const base = basename(discovery.shortcutPath)
    return base.replace(/\.(lnk|url)$/i, '')
  }

  return 'Unknown Application'
}

/**
 * Derives normalized aliases and search keywords from an application discovery.
 *
 * @param discovery - Raw discovery data.
 * @param displayName - Normalized display name.
 * @returns Sorted, deduplicated list of search aliases.
 */
export function generateAliases(
  discovery: DiscoveredApplication,
  displayName: string,
): readonly string[] {
  const aliasSet = new Set<string>()

  // Add explicit aliases from discovery
  for (const alias of discovery.aliases ?? []) {
    const sanitized = sanitizeString(alias).toLowerCase()
    if (sanitized.length > 1 && sanitized !== displayName.toLowerCase()) {
      aliasSet.add(sanitized)
    }
  }

  // Add executable base name
  if (discovery.executablePath) {
    const exeName = basename(discovery.executablePath).toLowerCase()
    const exeWithoutExt = exeName.replace(/\.exe$/i, '')
    if (exeWithoutExt !== displayName.toLowerCase()) {
      aliasSet.add(exeWithoutExt)
    }
    if (exeName !== displayName.toLowerCase()) {
      aliasSet.add(exeName)
    }
  }

  // Add shortcut base name
  if (discovery.shortcutPath) {
    const shortcutBase = basename(discovery.shortcutPath).replace(/\.(lnk|url)$/i, '').toLowerCase()
    if (shortcutBase !== displayName.toLowerCase()) {
      aliasSet.add(shortcutBase)
    }
  }

  // Add package family name or AUMID tokens if packaged
  if (discovery.aumid) {
    const cleanAumid = discovery.aumid.toLowerCase()
    aliasSet.add(cleanAumid)
  }

  return Array.from(aliasSet).sort()
}

/**
 * Normalizes an icon reference from raw discovery properties.
 *
 * @param discovery - Discovered application.
 * @returns Strongly typed {@link AppIconReference}.
 */
export function resolveIconReference(discovery: DiscoveredApplication): AppIconReference {
  const { iconPath, iconResourceIndex, packageFamilyName, kind } = discovery

  if (iconPath && iconPath.trim().length > 0) {
    const rawCleaned = iconPath.trim().replace(/^["']|["']$/g, '').trim()

    // Check if icon path contains a comma-separated resource index (e.g. "shell32.dll,21" or "app.exe,-1")
    const commaIndex = rawCleaned.lastIndexOf(',')
    if (commaIndex > 0) {
      const pathPart = rawCleaned.slice(0, commaIndex).trim().replace(/^["']|["']$/g, '').trim()
      const indexPart = parseInt(rawCleaned.slice(commaIndex + 1).trim(), 10)
      if (!isNaN(indexPart) && isValidFilePath(pathPart)) {
        return {
          kind: 'resource',
          sourcePath: pathPart,
          resourceIndex: indexPart,
        }
      }
    }

    if (iconResourceIndex !== undefined && isValidFilePath(rawCleaned)) {
      return {
        kind: 'resource',
        sourcePath: rawCleaned,
        resourceIndex: iconResourceIndex,
      }
    }

    const ext = extname(rawCleaned).toLowerCase()
    if (['.ico', '.png', '.jpg', '.jpeg', '.svg'].includes(ext) && isValidFilePath(rawCleaned)) {
      return {
        kind: 'file',
        filePath: rawCleaned,
      }
    }

    if (isValidFilePath(rawCleaned)) {
      return {
        kind: 'resource',
        sourcePath: rawCleaned,
        resourceIndex: 0,
      }
    }
  }

  if (kind === 'packaged' && packageFamilyName) {
    return {
      kind: 'packaged',
      packageFamilyName: packageFamilyName.trim(),
      ...discovery.installLocation && isValidFilePath(discovery.installLocation)
        ? { fullPath: discovery.installLocation.trim().replace(/^["']|["']$/g, '').trim() }
        : {},
    }
  }

  return {
    kind: 'fallback',
    defaultIconId: kind === 'packaged' ? 'generic-app' : 'generic-executable',
  }
}

/**
 * Constructs a safe, typed {@link AppLaunchSpec} from raw discovery fields.
 *
 * @param discovery - Discovered application.
 * @returns Strongly typed launch specification.
 */
export function resolveLaunchSpec(discovery: DiscoveredApplication): AppLaunchSpec {
  const { kind, executablePath, aumid, packageFamilyName, shortcutPath, arguments: rawArgs, workingDirectory } = discovery

  // Sanitize arguments
  const args = rawArgs
    ?.map(a => sanitizeString(a))
    .filter(a => a.length > 0)

  // 1. Packaged
  if (kind === 'packaged' && aumid && isValidAumid(aumid)) {
    const cleanAumid = aumid.trim()
    const spec: PackagedLaunchSpec = {
      kind: 'packaged',
      aumid: cleanAumid,
      ...packageFamilyName ? { packageFamilyName: packageFamilyName.trim() } : {},
      ...args && args.length > 0 ? { arguments: args } : {},
    }
    return spec
  }

  // 2. Win32 Executable
  if (executablePath && isValidFilePath(executablePath)) {
    const cleanExe = executablePath.trim().replace(/^["']|["']$/g, '').trim()
    const cleanCwd = workingDirectory && isValidFilePath(workingDirectory)
      ? workingDirectory.trim().replace(/^["']|["']$/g, '').trim()
      : undefined
    const spec: Win32LaunchSpec = {
      kind: 'win32',
      executablePath: cleanExe,
      ...args && args.length > 0 ? { arguments: args } : {},
      ...cleanCwd ? { workingDirectory: cleanCwd } : {},
    }
    return spec
  }

  // 3. Shortcut-backed
  if (shortcutPath && isValidFilePath(shortcutPath)) {
    const cleanShortcut = shortcutPath.trim().replace(/^["']|["']$/g, '').trim()
    const target = executablePath && isValidFilePath(executablePath)
      ? executablePath.trim().replace(/^["']|["']$/g, '').trim()
      : cleanShortcut

    const cleanCwd = workingDirectory && isValidFilePath(workingDirectory)
      ? workingDirectory.trim().replace(/^["']|["']$/g, '').trim()
      : undefined

    const spec: ShortcutLaunchSpec = {
      kind: 'shortcut',
      shortcutPath: cleanShortcut,
      targetPath: target,
      ...args && args.length > 0 ? { arguments: args } : {},
      ...cleanCwd ? { workingDirectory: cleanCwd } : {},
    }
    return spec
  }

  // Fallback placeholder launch spec for unresolvable items
  const cleanFallbackExe = executablePath ? executablePath.trim().replace(/^["']|["']$/g, '').trim() : 'unknown.exe'
  return {
    kind: 'win32',
    executablePath: cleanFallbackExe,
  }
}

/**
 * Compares two icon references by value.
 *
 * @param a - First icon reference.
 * @param b - Second icon reference.
 * @returns True if both icon references define identical properties.
 */
export function areIconsEqual(a: AppIconReference, b: AppIconReference): boolean {
  if (a === b) return true
  if (a.kind !== b.kind) return false
  switch (a.kind) {
    case 'file':
      return a.filePath === (b as FileIconReference).filePath
    case 'resource':
      return (
        a.sourcePath === (b as ResourceIconReference).sourcePath &&
        a.resourceIndex === (b as ResourceIconReference).resourceIndex
      )
    case 'packaged':
      return (
        a.packageFamilyName === (b as PackagedIconReference).packageFamilyName &&
        a.relativePath === (b as PackagedIconReference).relativePath &&
        a.fullPath === (b as PackagedIconReference).fullPath
      )
    case 'fallback':
      return a.defaultIconId === (b as FallbackIconReference).defaultIconId
  }
}

/**
 * Compares two string arrays by value.
 *
 * @param a - First string array.
 * @param b - Second string array.
 * @returns True if arrays have identical elements in identical order.
 */
export function areStringArraysEqual(a?: readonly string[], b?: readonly string[]): boolean {
  if (a === b) return true
  const aEmpty = !a || a.length === 0
  const bEmpty = !b || b.length === 0
  if (aEmpty && bEmpty) return true
  if (!a || !b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/**
 * Compares two launch specifications by value.
 *
 * @param a - First launch spec.
 * @param b - Second launch spec.
 * @returns True if both specs specify identical execution parameters.
 */
export function areLaunchSpecsEqual(a: AppLaunchSpec, b: AppLaunchSpec): boolean {
  if (a === b) return true
  if (a.kind !== b.kind) return false
  switch (a.kind) {
    case 'win32': {
      const bWin = b as Win32LaunchSpec
      return (
        a.executablePath === bWin.executablePath &&
        a.workingDirectory === bWin.workingDirectory &&
        areStringArraysEqual(a.arguments, bWin.arguments)
      )
    }
    case 'packaged': {
      const bPkg = b as PackagedLaunchSpec
      return (
        a.aumid === bPkg.aumid &&
        a.packageFamilyName === bPkg.packageFamilyName &&
        areStringArraysEqual(a.arguments, bPkg.arguments)
      )
    }
    case 'shortcut': {
      const bSc = b as ShortcutLaunchSpec
      return (
        a.shortcutPath === bSc.shortcutPath &&
        a.targetPath === bSc.targetPath &&
        a.workingDirectory === bSc.workingDirectory &&
        areStringArraysEqual(a.arguments, bSc.arguments)
      )
    }
  }
}

/**
 * Evaluates whether any user-meaningful metadata changed between two application records.
 *
 * @param prev - Previous application record.
 * @param next - Candidate updated application record.
 * @returns True if any functional or visual property differs.
 */
export function hasAppRecordChanged(prev: AppRecord, next: AppRecord): boolean {
  if (prev.displayName !== next.displayName) return true
  if (prev.description !== next.description) return true
  if (prev.publisher !== next.publisher) return true
  if (prev.installLocation !== next.installLocation) return true
  if (prev.kind !== next.kind) return true
  if (!areIconsEqual(prev.icon, next.icon)) return true
  if (!areLaunchSpecsEqual(prev.launch, next.launch)) return true
  if (!areStringArraysEqual(prev.aliases, next.aliases)) return true
  return false
}

/**
 * Normalizes a raw discovered application into a fully typed, authoritative {@link AppRecord}.
 *
 * @param discovery - Raw provider discovery.
 * @param existingRecord - Optional prior record for preserving firstSeenAt timestamp.
 * @param now - Current timestamp in milliseconds.
 * @returns Fully normalized immutable AppRecord.
 */
export function normalizeDiscoveredApp(
  discovery: DiscoveredApplication,
  existingRecord?: AppRecord,
  now = Date.now(),
): AppRecord {
  const descriptor = buildCanonicalDescriptor(discovery)
  const id = deriveAppId(descriptor)
  const displayName = resolveDisplayName(discovery)
  const description = sanitizeString(discovery.description) || undefined
  const publisher = sanitizeString(discovery.publisher) || undefined
  const cleanInstallLocation = discovery.installLocation ? discovery.installLocation.trim().replace(/^["']|["']$/g, '').trim() : undefined
  const installLocation = isValidFilePath(cleanInstallLocation) ? cleanInstallLocation : undefined
  const aliases = generateAliases(discovery, displayName)
  const icon = resolveIconReference(discovery)
  const launch = resolveLaunchSpec(discovery)

  const isUnchanged = existingRecord !== undefined && !hasAppRecordChanged(existingRecord, {
    id,
    kind: descriptor.kind,
    displayName,
    ...description ? { description } : {},
    ...publisher ? { publisher } : {},
    icon,
    launch,
    source: discovery.source,
    aliases,
    ...installLocation ? { installLocation } : {},
    firstSeenAt: existingRecord.firstSeenAt,
    lastSeenAt: now,
    updatedAt: existingRecord.updatedAt,
  })

  const record: AppRecord = {
    id,
    kind: descriptor.kind,
    displayName,
    ...description ? { description } : {},
    ...publisher ? { publisher } : {},
    icon,
    launch,
    source: discovery.source,
    aliases,
    ...installLocation ? { installLocation } : {},
    firstSeenAt: existingRecord ? existingRecord.firstSeenAt : now,
    lastSeenAt: now,
    updatedAt: isUnchanged ? existingRecord.updatedAt : now,
  }

  return Object.freeze(record)
}
