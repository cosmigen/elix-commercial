import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createDefaultUiPersistentDocument,
  UiPreferencesPersistence,
} from '../src/index.ts'

describe('UI Foundation - persistence', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  })

  async function createStore(): Promise<{ store: UiPreferencesPersistence; filePath: string }> {
    const root = await mkdtemp(join(tmpdir(), 'elix-ui-foundation-'))
    roots.push(root)
    const filePath = join(root, 'prefs.json')
    return { store: new UiPreferencesPersistence({ filePath }), filePath }
  }

  it('round-trips a schema-v1 document and preserves the previous valid backup', async () => {
    const { store, filePath } = await createStore()
    const first = {
      ...createDefaultUiPersistentDocument(1),
      userOverrides: { appearance: { colorScheme: 'light' as const } },
    }
    const second = {
      ...first,
      userOverrides: { appearance: { colorScheme: 'dark' as const } },
      updatedAt: 2,
    }

    await store.save(first)
    await store.save(second)

    expect((await store.load()).document.userOverrides.appearance?.colorScheme).toBe('dark')
    const backup = JSON.parse(await readFile(`${filePath}.bak`, 'utf8')) as {
      userOverrides: { appearance: { colorScheme: string } }
    }
    expect(backup.userOverrides.appearance.colorScheme).toBe('light')
  })

  it('recovers a corrupt primary from the last valid backup', async () => {
    const { store, filePath } = await createStore()
    const first = {
      ...createDefaultUiPersistentDocument(1),
      userOverrides: { appearance: { density: 'compact' as const } },
    }
    const second = {
      ...first,
      userOverrides: { appearance: { density: 'comfortable' as const } },
      updatedAt: 2,
    }

    await store.save(first)
    await store.save(second)
    await writeFile(filePath, '{broken json', 'utf8')

    const recovered = await store.load()
    expect(recovered.source).toBe('backup')
    expect(recovered.document.userOverrides.appearance?.density).toBe('compact')
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toMatchObject({ schemaVersion: 1 })
  })

  it('migrates legacy preferences and writes the current schema', async () => {
    const { store, filePath } = await createStore()
    await writeFile(filePath, JSON.stringify({ schemaVersion: 0, theme: 'light', reducedMotion: true }), 'utf8')

    const loaded = await store.load()
    expect(loaded.source).toBe('migrated')
    expect(loaded.document.userOverrides.appearance?.colorScheme).toBe('light')
    expect(loaded.document.userOverrides.accessibility?.reduceMotion).toBe(true)
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toMatchObject({ schemaVersion: 1 })
  })
})
