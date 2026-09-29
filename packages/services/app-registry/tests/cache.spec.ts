import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { AppRegistryCacheManager } from '../src/cache.ts'
import { normalizeDiscoveredApp } from '../src/normalize.ts'
import type { AppRecord } from '../src/types.ts'

describe('AppRegistryCacheManager', () => {
  const getTempPath = (): string => {
    return join(tmpdir(), `elix-app-cache-${randomBytes(6).toString('hex')}.json`)
  }

  it('saves and reloads normalized application catalog atomically', async () => {
    const filePath = getTempPath()
    const manager = new AppRegistryCacheManager({ filePath })

    const sampleApp: AppRecord = normalizeDiscoveredApp({
      source: 'start-menu-system',
      kind: 'win32',
      displayName: 'Test Editor',
      executablePath: 'C:\\Tools\\editor.exe',
      publisher: 'Test Publisher',
    })

    await manager.save([sampleApp])
    const loaded = await manager.load()

    expect(loaded).toBeDefined()
    expect(loaded?.length).toBe(1)
    expect(loaded?.[0]?.displayName).toBe('Test Editor')
    expect(loaded?.[0]?.id).toBe(sampleApp.id)

    await manager.clear()
  })

  it('recovers gracefully from non-existent cache file without throwing', async () => {
    const nonExistent = join(tmpdir(), `non-existent-${randomBytes(8).toString('hex')}.json`)
    const manager = new AppRegistryCacheManager({ filePath: nonExistent })

    const loaded = await manager.load()
    expect(loaded).toBeUndefined()
  })

  it('recovers gracefully from corrupted JSON cache file without throwing', async () => {
    const filePath = getTempPath()
    await writeFile(filePath, 'CORRUPTED JSON { invalid-content !!!', 'utf8')

    const manager = new AppRegistryCacheManager({ filePath })
    const loaded = await manager.load()
    expect(loaded).toBeUndefined()

    await manager.clear()
  })

  it('recovers gracefully from invalid schema format in cache file', async () => {
    const filePath = getTempPath()
    await writeFile(filePath, JSON.stringify({ version: 9999, apps: 'not-an-array' }), 'utf8')

    const manager = new AppRegistryCacheManager({ filePath })
    const loaded = await manager.load()
    expect(loaded).toBeUndefined()

    await manager.clear()
  })
})
