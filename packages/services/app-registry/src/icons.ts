/**
 * Application icon reference models, resolver contracts, and fallback handlers.
 *
 * Implements an icon reference abstraction that decouples icon metadata from visual asset decoding.
 * True Windows PE resource decoding (.exe and .dll icon extraction) is explicitly deferred
 * to the future Rust Native Core. This module provides the stable resolution contract now.
 *
 * @module @deepseek-ai/dsh-app-registry/icons
 */

import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'
import type { AppIconReference, AppIconResolver, ResolvedIcon } from './types.ts'

/** Default placeholder URIs for generic system application icons. */
export const DEFAULT_FALLBACK_ICONS = {
  'generic-app': 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="48" height="48"><rect width="24" height="24" rx="4" fill="%233b82f6"/><path d="M7 7h10v10H7z" fill="%23ffffff"/></svg>',
  'generic-executable': 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="48" height="48"><rect width="24" height="24" rx="4" fill="%2364748b"/><path d="M8 8l8 4-8 4z" fill="%23ffffff"/></svg>',
  'generic-system': 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="48" height="48"><circle cx="12" cy="12" r="10" fill="%23475569"/><path d="M12 6v6l4 2" stroke="%23ffffff" stroke-width="2" fill="none"/></svg>',
} as const

/**
 * Default TypeScript application icon reference resolver.
 *
 * Handles file-based icons, packaged asset references, and fallbacks.
 * Resource icon references (.exe/.dll indices) are converted to file URLs if present,
 * or mapped to fallbacks pending the future Rust Native Core extraction engine.
 */
export class DefaultAppIconResolver implements AppIconResolver {
  resolve(reference: AppIconReference): Promise<ResolvedIcon> {
    let resolved: ResolvedIcon
    switch (reference.kind) {
      case 'file': {
        if (existsSync(reference.filePath)) {
          resolved = {
            uri: pathToFileURL(reference.filePath).href,
            isFallback: false,
          }
        } else {
          resolved = {
            uri: DEFAULT_FALLBACK_ICONS['generic-app'],
            isFallback: true,
          }
        }
        break
      }

      case 'packaged': {
        if (reference.fullPath && existsSync(reference.fullPath)) {
          resolved = {
            uri: pathToFileURL(reference.fullPath).href,
            isFallback: false,
          }
        } else {
          resolved = {
            uri: DEFAULT_FALLBACK_ICONS['generic-app'],
            isFallback: true,
          }
        }
        break
      }

      case 'resource': {
        // Native PE resource decoding is deferred to Phase 6 Rust Surface/Native Core.
        // For now, if the PE file exists on disk, expose its file URI or return fallback.
        if (existsSync(reference.sourcePath)) {
          resolved = {
            uri: pathToFileURL(reference.sourcePath).href,
            isFallback: false,
          }
        } else {
          resolved = {
            uri: DEFAULT_FALLBACK_ICONS['generic-executable'],
            isFallback: true,
          }
        }
        break
      }

      case 'fallback':
      default: {
        const id = reference.defaultIconId
        resolved = {
          uri: DEFAULT_FALLBACK_ICONS[id],
          isFallback: true,
        }
        break
      }
    }
    return Promise.resolve(resolved)
  }
}
