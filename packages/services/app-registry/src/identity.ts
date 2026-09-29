/**
 * Deterministic, source-aware stable application identity generation.
 *
 * Implements canonical normalization and SHA-256 hashing to guarantee that:
 * 1. Rescanning or restarting ELIX produces the identical AppId.
 * 2. Minor updates to applications retain their identity.
 * 3. Two distinct applications sharing the same display name receive distinct IDs.
 * 4. File-system path variations (case differences, forward/backward slashes,
 *    and system drive letters) are normalized against canonical Windows known folders.
 *
 * @module @deepseek-ai/dsh-app-registry/identity
 */

import { createHash } from 'node:crypto'
import type { AppId, AppKind, DiscoveredApplication } from './types.ts'
import { makeAppId } from './types.ts'

/**
 * Descriptor components used to compute an authoritative application identity.
 */
export interface CanonicalAppDescriptor {
  readonly kind: AppKind
  readonly canonicalKey: string
}

/**
 * Standard known folder environment patterns mapped to invariant tokens.
 */
const KNOWN_FOLDER_MAPPINGS: readonly [string, RegExp][] = [
  ['%ProgramFiles(x86)%', /^[A-Z]:\\Program Files \(x86\)/i],
  ['%ProgramFiles%', /^[A-Z]:\\Program Files/i],
  ['%ProgramData%', /^[A-Z]:\\ProgramData/i],
  ['%SystemRoot%', /^[A-Z]:\\Windows/i],
  ['%LocalAppData%', /^[A-Z]:\\Users\\[^\\]+\\AppData\\Local/i],
  ['%AppData%', /^[A-Z]:\\Users\\[^\\]+\\AppData\\Roaming/i],
  ['%UserProfile%', /^[A-Z]:\\Users\\[^\\]+/i],
]

/**
 * Normalizes a Windows filesystem path into a canonical invariant representation.
 * 1. Converts backslashes to forward slashes.
 * 2. Strips duplicate slashes and trailing whitespace.
 * 3. Replaces dynamic machine/user prefixes (e.g. `C:\Users\Anoop\AppData\Local`)
 *    with invariant known folder tokens (`%LocalAppData%`).
 * 4. Lowercases the entire path for case-insensitive Windows filesystem equality.
 *
 * @param rawPath - Arbitrary filesystem or link target path.
 * @returns Normalized invariant path string.
 */
export function normalizePathForIdentity(rawPath: string): string {
  let normalized = rawPath.trim().replace(/^["']|["']$/g, '').trim()
  if (normalized.length === 0) return ''

  // Replace forward slashes with backslashes for Windows path comparison
  const backslashPath = normalized.replace(/\//g, '\\')

  // Check real environment variables first if available
  const envEntries: readonly [string, string | undefined][] = [
    ['%ProgramFiles(x86)%', process.env['ProgramFiles(x86)']],
    ['%ProgramFiles%', process.env['ProgramFiles']],
    ['%ProgramData%', process.env['ProgramData']],
    ['%SystemRoot%', process.env['SystemRoot'] ?? process.env['windir']],
    ['%LocalAppData%', process.env['LOCALAPPDATA']],
    ['%AppData%', process.env['APPDATA']],
    ['%UserProfile%', process.env['USERPROFILE']],
  ]

  for (const [token, envVal] of envEntries) {
    if (envVal && envVal.trim().length > 0) {
      const cleanEnv = envVal.trim().replace(/^["']|["']$/g, '').replace(/\//g, '\\')
      if (backslashPath.toLowerCase().startsWith(cleanEnv.toLowerCase())) {
        normalized = token + backslashPath.slice(cleanEnv.length)
        return normalized
          .replace(/\\/g, '/')
          .replace(/\/+/g, '/')
          .toLowerCase()
      }
    }
  }

  // Fallback to pattern matching for standard Windows paths
  for (const [token, regex] of KNOWN_FOLDER_MAPPINGS) {
    if (regex.test(backslashPath)) {
      normalized = backslashPath.replace(regex, token)
      break
    }
  }

  return normalized
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .toLowerCase()
}

/**
 * Normalizes an Application User Model ID (AUMID) or Package Family Name.
 *
 * @param rawAumid - Raw AUMID string from Windows Shell or Appx manifest.
 * @returns Trimmed, lowercased AUMID.
 */
export function normalizeAumidForIdentity(rawAumid: string): string {
  return rawAumid.trim().toLowerCase()
}

/**
 * Builds the canonical identity descriptor for a discovered application.
 *
 * Identity Precedence:
 * 1. Packaged: AUMID (e.g. `Microsoft.WindowsCalculator_8wekyb3d8bbwe!App`)
 * 2. Win32 with Registry Key: Normalized registry key name (e.g. `7-Zip` or `{GUID}`)
 * 3. Win32 / Shortcut with Target: Normalized target executable path (e.g. `%ProgramFiles%/7-Zip/7zFM.exe`)
 * 4. Shortcut fallback: Normalized relative shortcut location within Start Menu.
 *
 * @param discovery - Raw discovered application metadata.
 * @returns Canonical descriptor ready for deterministic hashing.
 */
export function buildCanonicalDescriptor(
  discovery: Pick<DiscoveredApplication, 'kind' | 'aumid' | 'executablePath' | 'rawId' | 'shortcutPath'>,
): CanonicalAppDescriptor {
  const { kind, aumid, executablePath, rawId, shortcutPath } = discovery

  if (kind === 'packaged' && aumid && aumid.trim().length > 0) {
    return {
      kind: 'packaged',
      canonicalKey: `aumid:${normalizeAumidForIdentity(aumid)}`,
    }
  }

  // If discovery came with an AUMID even if classified otherwise
  if (aumid && aumid.trim().length > 0 && !aumid.includes('\\') && !aumid.includes('/')) {
    return {
      kind: 'packaged',
      canonicalKey: `aumid:${normalizeAumidForIdentity(aumid)}`,
    }
  }

  if (executablePath && executablePath.trim().length > 0) {
    const normalizedExe = normalizePathForIdentity(executablePath)
    return {
      kind: 'win32',
      canonicalKey: `exe:${normalizedExe}`,
    }
  }

  if (rawId && rawId.trim().length > 0) {
    // Could be a registry key, e.g. "Google Chrome" or a GUID
    return {
      kind: kind === 'packaged' ? 'packaged' : 'win32',
      canonicalKey: `raw:${rawId.trim().toLowerCase()}`,
    }
  }

  if (shortcutPath && shortcutPath.trim().length > 0) {
    const normalizedShortcut = normalizePathForIdentity(shortcutPath)
    return {
      kind: 'shortcut',
      canonicalKey: `shortcut:${normalizedShortcut}`,
    }
  }

  // Extreme fallback: empty key
  return {
    kind,
    canonicalKey: 'empty-descriptor',
  }
}

/**
 * Computes a deterministic, collision-resistant AppId from a canonical descriptor.
 * Format: `app:<kind>:<16-char-sha256-hex>`
 *
 * @param descriptor - The canonical application descriptor.
 * @returns Branded deterministic AppId.
 */
export function deriveAppId(descriptor: CanonicalAppDescriptor): AppId {
  const input = `${descriptor.kind}|${descriptor.canonicalKey}`
  const hash = createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 16)
  return makeAppId(`app:${descriptor.kind}:${hash}`)
}
