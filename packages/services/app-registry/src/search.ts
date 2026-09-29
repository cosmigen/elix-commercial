/**
 * Deterministic, lightweight application search and ranking engine.
 *
 * Evaluates candidate query tokens against application display titles, aliases,
 * publishers, and descriptions. Provides predictable, deterministic ranking
 * without heavyweight index dependencies.
 *
 * @module @deepseek-ai/dsh-app-registry/search
 */

import type { AppRecord, AppSearchOptions } from './types.ts'

/**
 * Calculates a match relevance score for an application against a query string.
 *
 * @param app - Catalog application record.
 * @param cleanQuery - Lowercased, trimmed search query.
 * @returns Numeric score (0 for no match, higher means more relevant).
 */
function computeAppSearchScore(app: AppRecord, cleanQuery: string): number {
  const name = app.displayName.toLowerCase()

  // 1. Exact name match
  if (name === cleanQuery) {
    return 1000
  }

  // 2. Name starts with query
  if (name.startsWith(cleanQuery)) {
    return 500
  }

  // 3. Word-boundary prefix match (e.g. "term" matches "Windows Terminal")
  const words = name.split(/[\s\-_\/]+/)
  for (const word of words) {
    if (word.startsWith(cleanQuery)) {
      return 300
    }
  }

  // 4. Substring in name
  if (name.includes(cleanQuery)) {
    return 200
  }

  // 5. Alias exact or prefix match
  for (const alias of app.aliases) {
    if (alias === cleanQuery) {
      return 150
    }
    if (alias.startsWith(cleanQuery)) {
      return 100
    }
  }

  // 6. Publisher match
  if (app.publisher && app.publisher.toLowerCase().includes(cleanQuery)) {
    return 50
  }

  // 7. Description match
  if (app.description && app.description.toLowerCase().includes(cleanQuery)) {
    return 20
  }

  return 0
}

/**
 * Searches and ranks applications from a catalog list.
 *
 * @param apps - Catalog application list.
 * @param rawQuery - User search query.
 * @param options - Filtering and limit options.
 * @returns Ranked list of matching AppRecords.
 */
export function searchApplications(
  apps: readonly AppRecord[],
  rawQuery: string,
  options?: AppSearchOptions,
): readonly AppRecord[] {
  const cleanQuery = rawQuery.trim().toLowerCase()
  if (cleanQuery.length === 0) {
    return []
  }

  const limit = options?.limit ?? 20
  const kindFilter = options?.kinds ? new Set(options.kinds) : undefined

  interface ScoredCandidate {
    app: AppRecord
    score: number
  }

  const candidates: ScoredCandidate[] = []

  for (const app of apps) {
    if (kindFilter && !kindFilter.has(app.kind)) {
      continue
    }

    const score = computeAppSearchScore(app, cleanQuery)
    if (score > 0) {
      candidates.push({ app, score })
    }
  }

  // Deterministic sorting: score DESC, displayName ASC, id ASC
  candidates.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score
    }
    const nameComp = a.app.displayName.localeCompare(b.app.displayName)
    if (nameComp !== 0) {
      return nameComp
    }
    return a.app.id.localeCompare(b.app.id)
  })

  const results = candidates.slice(0, limit).map(c => c.app)
  return Object.freeze(results)
}
