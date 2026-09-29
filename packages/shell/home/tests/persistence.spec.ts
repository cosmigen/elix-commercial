import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_HOME_PREFERENCES,
  DEFAULT_WALLPAPER_PREFERENCES,
  HOME_SCHEMA_VERSION,
  HomePersistenceManager,
} from '../src/index.ts'
import type { HomeItem, HomePersistentState } from '../src/index.ts'

describe('HomePersistenceManager', () => {
  let tempDir: string
  let testFilePath: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'elix-home-persist-'))
    testFilePath = join(tempDir, 'state.json')
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('atomically saves and reloads desktop state', async () => {
    const manager = new HomePersistenceManager({ filePath: testFilePath })

    const sampleItems: HomeItem[] = [
      {
        id: 'shortcut-1',
        type: 'shortcut',
        monitorId: 'mon-1',
        position: { x: 100, y: 100 },
        size: { width: 84, height: 96 },
        metadata: { name: 'Browser', icon: 'chrome.svg' },
        createdAt: 1000,
        updatedAt: 1000,
      },
      {
        id: 'file-1',
        type: 'file',
        monitorId: 'mon-1',
        position: { x: 300, y: 100 },
        size: { width: 84, height: 96 },
        metadata: { filename: 'Document.pdf' },
        createdAt: 1000,
        updatedAt: 1000,
      },
    ]

    const stateToSave: HomePersistentState = {
      schemaVersion: HOME_SCHEMA_VERSION,
      items: sampleItems,
      widgets: [
        {
          id: 'widget-clock',
          definitionId: 'clock',
          ownerId: 'elix.builtin',
          monitorId: 'mon-1',
          position: { x: 300, y: 100 },
          size: { width: 258, height: 144 },
          zOrder: 1,
          configuration: { showSeconds: true },
          state: {},
          lifecycle: 'mounted',
          createdAt: 1000,
          updatedAt: 1000,
        },
      ],
      wallpaper: {
        ...DEFAULT_WALLPAPER_PREFERENCES,
        activeId: 'ember-night',
        blur: 15,
      },
      preferences: {
        ...DEFAULT_HOME_PREFERENCES,
        iconSize: 72,
      },
      updatedAt: Date.now(),
    }

    await manager.save(stateToSave)

    const loaded = await manager.load()
    expect(loaded.schemaVersion).toBe(HOME_SCHEMA_VERSION)
    expect(loaded.items).toHaveLength(2)
    expect(loaded.items[0]?.id).toBe('shortcut-1')
    expect(loaded.items[1]?.id).toBe('file-1')
    expect(loaded.widgets).toHaveLength(1)
    expect(loaded.widgets?.[0]?.id).toBe('widget-clock')
    expect(loaded.wallpaper.activeId).toBe('ember-night')
    expect(loaded.wallpaper.blur).toBe(15)
    expect(loaded.preferences.iconSize).toBe(72)
  })

  it('recovers gracefully from missing file with default state', async () => {
    const nonExistentPath = join(tempDir, 'does-not-exist.json')
    const manager = new HomePersistenceManager({ filePath: nonExistentPath })

    const state = await manager.load()
    expect(state.schemaVersion).toBe(HOME_SCHEMA_VERSION)
    expect(state.items).toEqual([])
    expect(state.wallpaper.activeId).toBe('elix-orange')
  })

  it('recovers gracefully from corrupted JSON file without crashing', async () => {
    await writeFile(testFilePath, 'INVALID { JSON CORRUPTED DATA !!', 'utf8')
    const manager = new HomePersistenceManager({ filePath: testFilePath })

    const state = await manager.load()
    expect(state.schemaVersion).toBe(HOME_SCHEMA_VERSION)
    expect(state.items).toEqual([])
  })
})
