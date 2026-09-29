import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  HOME_SCHEMA_VERSION,
  HomePersistenceManager,
  INITIAL_HOME_STATE,
} from '../src/persistence.ts'
import { WallpaperManager } from '../src/wallpaper.ts'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('Home Phase 16C personalization persistence', () => {
  it('round-trips per-monitor wallpaper overrides without a schema bump', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'elix-home-16c-persistence-'))
    temporaryDirectories.push(directory)
    const persistence = new HomePersistenceManager({ filePath: path.join(directory, 'home-state.json') })
    const wallpaper = new WallpaperManager()

    wallpaper.setActiveWallpaper('aurora-forest', 'monitor-b')
    wallpaper.updateEffects({ fit: 'contain', dim: 18, saturation: 112 }, 'monitor-b')

    await persistence.save({
      ...INITIAL_HOME_STATE,
      wallpaper: wallpaper.getPreferences(),
    })

    const loaded = await persistence.load()
    expect(loaded.schemaVersion).toBe(HOME_SCHEMA_VERSION)
    expect(loaded.wallpaper.monitorOverrides?.['monitor-b']).toEqual({
      activeId: 'aurora-forest',
      fit: 'contain',
      blur: 0,
      saturation: 112,
      dim: 18,
    })

    const restored = new WallpaperManager(loaded.wallpaper)
    expect(restored.getActiveWallpaper('monitor-b').id).toBe('aurora-forest')
    expect(restored.getDisplayPreferences('monitor-b')).toMatchObject({ fit: 'contain', dim: 18 })
  })
})
