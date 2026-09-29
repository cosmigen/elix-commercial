/**
 * Atomic disk cache manager for the ELIX Application Registry catalog.
 *
 * Implements crash-safe, atomic serialization of discovered application metadata
 * to enable instant startup availability without blocking on expensive OS scans.
 *
 * Catches corruption or schema deviations gracefully, guaranteeing that a damaged
 * cache file will never crash the host runtime.
 *
 * @module @deepseek-ai/dsh-app-registry/cache
 */

import { readFile, rm } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { AppRecord, AppRegistryCacheData } from './types.ts'

/** Current cache schema format version. */
export const CACHE_SCHEMA_VERSION = 1

/** Default filename for serialized application catalog cache. */
export const DEFAULT_CACHE_FILENAME = 'app-registry-cache.json'

/**
 * Resolves the canonical cache file path on disk.
 *
 * @param customPath - Optional explicit filepath override.
 * @returns Absolute filesystem path.
 */
export function resolveDefaultCachePath(customPath?: string): string {
  if (customPath && customPath.trim().length > 0) {
    return customPath.trim()
  }
  return dshHomePath('cache', DEFAULT_CACHE_FILENAME)
}

/**
 * Options for configuring {@link AppRegistryCacheManager}.
 */
export interface CacheManagerOptions {
  readonly filePath?: string
}

/**
 * Manages atomic disk caching for the application registry catalog.
 */
export class AppRegistryCacheManager {
  private readonly filePath: string

  constructor(options?: CacheManagerOptions) {
    this.filePath = resolveDefaultCachePath(options?.filePath)
  }

  /**
   * The resolved absolute filesystem path where cache data is stored.
   */
  get path(): string {
    return this.filePath
  }

  /**
   * Loads and validates the application catalog from the atomic disk cache.
   *
   * @returns List of cached {@link AppRecord} items, or undefined if absent or invalid.
   */
  async load(): Promise<readonly AppRecord[] | undefined> {
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed: unknown = JSON.parse(raw)

      if (typeof parsed !== 'object' || parsed === null) {
        return undefined
      }

      const data = parsed as Record<string, unknown>
      if (data.version !== CACHE_SCHEMA_VERSION || !Array.isArray(data.apps)) {
        return undefined
      }

      // Basic validation of loaded records
      const validApps: AppRecord[] = []
      for (const item of data.apps) {
        if (typeof item === 'object' && item !== null) {
          const rec = item as Record<string, unknown>
          if (typeof rec.id === 'string' && typeof rec.displayName === 'string') {
            validApps.push(Object.freeze(rec as unknown as AppRecord))
          }
        }
      }

      return Object.freeze(validApps)
    } catch {
      // Return undefined on any file missing, permission, or JSON syntax errors
      return undefined
    }
  }

  /**
   * Atomically serializes the application catalog to disk.
   *
   * @param apps - Authoritative catalog records.
   */
  async save(apps: readonly AppRecord[]): Promise<void> {
    const payload: AppRegistryCacheData = {
      version: CACHE_SCHEMA_VERSION,
      timestamp: Date.now(),
      apps,
    }

    const content = JSON.stringify(payload, null, 2)
    await writeFileAtomic(this.filePath, content, {
      mode: 0o600,
    })
  }

  /**
   * Deletes the cache file if it exists.
   */
  async clear(): Promise<void> {
    try {
      await rm(this.filePath, { force: true })
    } catch {
      // Ignore deletion errors
    }
  }
}
