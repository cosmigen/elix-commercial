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

describe('Home Persistence Migration (v1 -> v2)', () => {
  let tempDir: string
  let testFilePath: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'elix-home-migration-'))
    testFilePath = join(tempDir, 'state.json')
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('migrates legacy schema v1 with embedded widget items to schema v2 WidgetInstances', async () => {
    // Write legacy Phase 8 schemaVersion 1 JSON with items containing a widget item
    const legacyV1Json = {
      schemaVersion: 1,
      items: [
        {
          id: 'shortcut-1',
          type: 'shortcut',
          monitorId: 'mon-1',
          position: { x: 50, y: 50 },
          size: { width: 84, height: 96 },
          metadata: { name: 'Terminal', icon: 'terminal.svg' },
          createdAt: 1000,
          updatedAt: 1000,
        },
        {
          id: 'legacy-widget-clock',
          type: 'widget',
          monitorId: 'mon-1',
          position: { x: 400, y: 150 },
          size: { width: 280, height: 160 },
          metadata: {
            widgetType: 'clock',
            configuration: { showSeconds: true, timezone: 'UTC' },
            state: { tickCount: 42 },
          },
          createdAt: 1200,
          updatedAt: 1250,
        },
      ],
      wallpaper: {
        ...DEFAULT_WALLPAPER_PREFERENCES,
        activeId: 'nebula',
      },
      preferences: {
        ...DEFAULT_HOME_PREFERENCES,
        snapToGrid: true,
      },
      updatedAt: 2000,
    }

    await writeFile(testFilePath, JSON.stringify(legacyV1Json, null, 2), 'utf8')

    const manager = new HomePersistenceManager({ filePath: testFilePath })
    const loaded = await manager.load()

    // Verifications
    expect(loaded.schemaVersion).toBe(HOME_SCHEMA_VERSION)
    expect(loaded.schemaVersion).toBe(2)

    // Verify legacy widget item was consumed and NOT left in items
    expect(loaded.items).toHaveLength(1)
    expect(loaded.items.some(it => it.type === 'widget')).toBe(false)
    expect(loaded.items.map(it => it.id)).toEqual(['shortcut-1'])

    // Verify widgets were extracted
    expect(loaded.widgets).toHaveLength(1)
    const clockWidget = loaded.widgets?.[0]
    expect(clockWidget?.id).toBe('legacy-widget-clock')
    expect(clockWidget?.definitionId).toBe('clock')
    expect(clockWidget?.ownerId).toBe('elix.builtin')
    expect(clockWidget?.monitorId).toBe('mon-1')
    expect(clockWidget?.position).toEqual({ x: 400, y: 150 })
    expect(clockWidget?.size).toEqual({ width: 280, height: 160 })
    expect(clockWidget?.configuration).toEqual({ showSeconds: true, timezone: 'UTC' })
    expect(clockWidget?.state).toEqual({ tickCount: 42 })
    expect(clockWidget?.lifecycle).toBe('mounted')

    // Save and re-load to ensure roundtrip persistence in v2
    await manager.save(loaded)
    const reloaded = await manager.load()
    expect(reloaded.schemaVersion).toBe(2)
    expect(reloaded.items).toHaveLength(1)
    expect(reloaded.items.some(it => it.type === 'widget')).toBe(false)
    expect(reloaded.widgets).toHaveLength(1)
    expect(reloaded.widgets?.[0]?.definitionId).toBe('clock')
  })

  it('migrates multiple legacy widgets cleanly without duplication', async () => {
    const multiLegacyV1 = {
      schemaVersion: 1,
      items: [
        {
          id: 'item-file-1',
          type: 'file',
          monitorId: 'mon-1',
          position: { x: 50, y: 50 },
          size: { width: 80, height: 90 },
          metadata: { filename: 'Notes.txt' },
        },
        {
          id: 'legacy-w1',
          type: 'widget',
          monitorId: 'mon-1',
          position: { x: 200, y: 100 },
          size: { width: 260, height: 130 },
          metadata: { widgetType: 'clock' },
        },
        {
          id: 'legacy-w2',
          type: 'widget',
          monitorId: 'mon-1',
          position: { x: 500, y: 100 },
          size: { width: 280, height: 260 },
          metadata: { widgetType: 'calendar' },
        },
        {
          id: 'item-file-2',
          type: 'file',
          monitorId: 'mon-1',
          position: { x: 50, y: 150 },
          size: { width: 80, height: 90 },
          metadata: { filename: 'Report.docx' },
        },
      ],
      wallpaper: DEFAULT_WALLPAPER_PREFERENCES,
      preferences: DEFAULT_HOME_PREFERENCES,
    }

    await writeFile(testFilePath, JSON.stringify(multiLegacyV1, null, 2), 'utf8')
    const manager = new HomePersistenceManager({ filePath: testFilePath })
    const loaded = await manager.load()

    // Assert items contains zero migrated widget items
    expect(loaded.items).toHaveLength(2)
    expect(loaded.items.every(it => it.type !== 'widget')).toBe(true)

    // Assert widgets contains exactly the two migrated instances
    expect(loaded.widgets).toHaveLength(2)
    expect(loaded.widgets?.map(w => w.id)).toEqual(['legacy-w1', 'legacy-w2'])
    expect(loaded.widgets?.map(w => w.definitionId)).toEqual(['clock', 'calendar'])

    // Idempotent: saving and reloading maintains exactly the same state
    await manager.save(loaded)
    const reloaded = await manager.load()
    expect(reloaded.items).toHaveLength(2)
    expect(reloaded.items.every(it => it.type !== 'widget')).toBe(true)
    expect(reloaded.widgets).toHaveLength(2)
  })

  it('preserves native schema v2 state with dedicated widgets array without re-migrating', async () => {
    const v2State = {
      schemaVersion: 2,
      items: [
        {
          id: 'file-1',
          type: 'file',
          monitorId: 'mon-1',
          position: { x: 100, y: 100 },
          size: { width: 84, height: 96 },
          metadata: { name: 'Document.pdf' },
          createdAt: 1000,
          updatedAt: 1000,
        },
      ],
      widgets: [
        {
          id: 'calendar-widget-1',
          definitionId: 'calendar',
          ownerId: 'custom.owner',
          monitorId: 'mon-1',
          position: { x: 500, y: 200 },
          size: { width: 320, height: 260 },
          zOrder: 2,
          configuration: {},
          state: { selectedDate: '2026-09-14' },
          lifecycle: 'mounted' as const,
          createdAt: 1000,
          updatedAt: 1000,
        },
      ],
      wallpaper: DEFAULT_WALLPAPER_PREFERENCES,
      preferences: DEFAULT_HOME_PREFERENCES,
      updatedAt: 3000,
    }

    await writeFile(testFilePath, JSON.stringify(v2State, null, 2), 'utf8')

    const manager = new HomePersistenceManager({ filePath: testFilePath })
    const loaded = await manager.load()

    expect(loaded.schemaVersion).toBe(2)
    expect(loaded.items).toHaveLength(1)
    expect(loaded.items[0]?.id).toBe('file-1')
    expect(loaded.widgets).toHaveLength(1)
    expect(loaded.widgets?.[0]?.id).toBe('calendar-widget-1')
    expect(loaded.widgets?.[0]?.definitionId).toBe('calendar')
    expect(loaded.widgets?.[0]?.ownerId).toBe('custom.owner')
    expect(loaded.widgets?.[0]?.zOrder).toBe(2)
  })
})
