/** Atomic, versioned persistence for ELIX UI preferences. */

import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { writeFileAtomic, withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { createDefaultUiPersistentDocument, parseUiPersistentDocument } from './preference-schema.ts'
import type { UiPersistentPreferencesDocument } from './types.ts'

/** Load outcome used for diagnostics and recovery acceptance tests. */
export type UiPreferencesLoadSource = 'primary' | 'backup' | 'default' | 'migrated'

/** Result of loading UI preferences. */
export interface UiPreferencesLoadResult {
  readonly document: UiPersistentPreferencesDocument
  readonly source: UiPreferencesLoadSource
}

/** Persistence options for the Phase 16B preferences authority. */
export interface UiPreferencesPersistenceOptions {
  readonly filePath?: string | undefined
}

/** Default durable preference path. */
export function getDefaultUiPreferencesPath(): string {
  return dshHomePath('elix-ui-preferences.json')
}

async function readParsed(path: string): Promise<{ document: UiPersistentPreferencesDocument; migrated: boolean } | undefined> {
  try {
    const raw = await readFile(path, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    const version = typeof parsed === 'object' && parsed !== null
      ? (parsed as { readonly schemaVersion?: unknown }).schemaVersion
      : undefined
    return {
      document: parseUiPersistentDocument(parsed),
      migrated: version !== 1,
    }
  } catch {
    return undefined
  }
}

/** Atomic preference store with previous-valid backup recovery. */
export class UiPreferencesPersistence {
  readonly filePath: string
  readonly backupPath: string

  constructor(options?: UiPreferencesPersistenceOptions) {
    this.filePath = options?.filePath ?? getDefaultUiPreferencesPath()
    this.backupPath = `${this.filePath}.bak`
  }

  /** Load primary preferences, recover from backup when needed, or return defaults. */
  async load(): Promise<UiPreferencesLoadResult> {
    const primary = await readParsed(this.filePath)
    if (primary) {
      if (primary.migrated) {
        await this.save(primary.document)
        return { document: primary.document, source: 'migrated' }
      }
      return { document: primary.document, source: 'primary' }
    }

    const backup = await readParsed(this.backupPath)
    if (backup) {
      await this.ensureParentDirectory()
      await withFileLock(this.filePath, async () => {
        await writeFileAtomic(this.filePath, serializeDocument(backup.document), { mode: 0o600, dirMode: 0o700 })
      })
      return { document: backup.document, source: 'backup' }
    }

    return { document: createDefaultUiPersistentDocument(), source: 'default' }
  }

  /** Commit preferences atomically after preserving the last valid primary document. */
  async save(document: UiPersistentPreferencesDocument): Promise<void> {
    const validated = parseUiPersistentDocument(document)
    await this.ensureParentDirectory()
    await withFileLock(this.filePath, async () => {
      const previous = await readParsed(this.filePath)
      if (previous) {
        await writeFileAtomic(this.backupPath, serializeDocument(previous.document), { mode: 0o600, dirMode: 0o700 })
      }
      await writeFileAtomic(this.filePath, serializeDocument(validated), { mode: 0o600, dirMode: 0o700 })
    })
  }

  private async ensureParentDirectory(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
  }
}

function serializeDocument(document: UiPersistentPreferencesDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`
}
