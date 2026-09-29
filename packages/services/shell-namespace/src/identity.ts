/**
 * File identity abstraction and adapters for ELIX Shell Namespace.
 *
 * Implements the critical invariant: LOCATION MUST NOT EQUAL IDENTITY.
 * Renaming or moving a file on the same volume preserves its FileIdentity.
 *
 * On Windows NTFS/ReFS filesystems, Node's `stat.dev` maps to the volume serial
 * number and `stat.ino` maps to the 64-bit NTFS file reference number (File ID).
 * When available, identity quality is reported as 'filesystem-stable'.
 * When unavailable or zero (FAT, network, virtual), identity falls back to
 * 'path-fallback' with a deterministic SHA-256 digest.
 *
 * Phase 5 Rust Native Core will provide native 128-bit FILE_ID_INFO via
 * GetFileInformationByHandleEx with 'native-stable' quality behind this same contract.
 *
 * @module @deepseek-ai/dsh-shell-namespace/identity
 */

import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import type { Stats, BigIntStats } from 'node:fs'
import * as path from 'node:path'
import { makeShellItemId, type FileIdentity, type IdentityQuality, type ShellItemId } from './types.ts'

/**
 * Contract for resolving authoritative file identity from a filesystem path.
 */
export interface FileIdentityAdapter {
  /**
   * Resolves the identity of a file or folder at the given path.
   *
   * @param filePath - Absolute or relative filesystem path.
   * @param statObj - Optional pre-fetched Stats or BigIntStats object to avoid redundant disk I/O.
   * @returns Resolved FileIdentity with quality indicator.
   */
  identify(filePath: string, statObj?: Stats | BigIntStats): Promise<FileIdentity>
}

/**
 * Normalizes a filesystem path into a canonical comparison string.
 * Strips Windows extended-length prefix `\\?\` so both formats resolve identically.
 *
 * @param rawPath - Raw filesystem path.
 * @returns Canonicalized path string.
 */
export function normalizeCanonicalPath(rawPath: string): string {
  const clean = rawPath.replace(/^[\\/]{2}\?[\\/]/, '')
  const resolved = path.resolve(clean).replace(/\\/g, '/')
  // Normalize Windows drive letters to uppercase for consistency
  if (/^[a-zA-Z]:\//.test(resolved)) {
    return resolved.charAt(0).toUpperCase() + resolved.slice(1)
  }
  return resolved
}

/**
 * Computes a deterministic path-fallback identifier.
 *
 * @param canonicalPath - Canonicalized path.
 * @returns Formatted path-fallback ShellItemId.
 */
export function computePathFallbackId(canonicalPath: string): ShellItemId {
  const hash = createHash('sha256')
    .update(canonicalPath.toLowerCase())
    .digest('hex')
    .slice(0, 16)
  return makeShellItemId(`path:${hash}`)
}

/**
 * Standard filesystem identity adapter using OS volume serial number and file index.
 */
export class DefaultFileIdentityAdapter implements FileIdentityAdapter {
  async identify(filePath: string, statObj?: Stats | BigIntStats): Promise<FileIdentity> {
    const canonical = normalizeCanonicalPath(filePath)

    let stats: Stats | BigIntStats | undefined = statObj
    if (!stats) {
      try {
        stats = await fs.lstat(canonical, { bigint: true })
      } catch {
        // File might not exist or is inaccessible; return path fallback
        return {
          id: computePathFallbackId(canonical),
          quality: 'path-fallback',
          canonicalPath: canonical,
        }
      }
    }

    // On Windows NTFS and ReFS filesystems, stat.dev holds volume serial number
    // and stat.ino holds the 64-bit NTFS file reference index.
    const dev = typeof stats.dev === 'bigint' ? stats.dev : BigInt(stats.dev)
    const ino = typeof stats.ino === 'bigint' ? stats.ino : BigInt(stats.ino)

    if (dev !== 0n && ino !== 0n) {
      const volumeSerialNumber = BigInt.asUintN(32, dev).toString(16).padStart(8, '0')
      const fileId = BigInt.asUintN(64, ino).toString(16).padStart(16, '0')
      const id = makeShellItemId(`fs:${volumeSerialNumber}:${fileId}`)

      return {
        id,
        quality: 'filesystem-stable' as IdentityQuality,
        volumeSerialNumber,
        fileId,
        canonicalPath: canonical,
      }
    }

    // Inode unavailable or 0 (unsupported filesystem or network mount)
    return {
      id: computePathFallbackId(canonical),
      quality: 'path-fallback' as IdentityQuality,
      canonicalPath: canonical,
    }
  }
}
