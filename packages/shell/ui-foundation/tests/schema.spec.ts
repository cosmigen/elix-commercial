import { describe, expect, it } from 'vitest'
import {
  applyUiPreferencePatch,
  createDefaultUiPersistentDocument,
  DEFAULT_UI_PREFERENCES,
  mergeUiPreferencePatches,
  parseUiPersistentDocument,
  parseUiPreferencePatch,
} from '../src/index.ts'

describe('UI Foundation - preference schema', () => {
  it('validates preference ranges and rejects unknown keys', () => {
    expect(parseUiPreferencePatch({
      appearance: { accentColor: '#22CC88', motionIntensity: 0.4 },
      accessibility: { textScale: 2, reduceMotion: true },
    })).toEqual({
      appearance: { accentColor: '#22cc88', motionIntensity: 0.4 },
      accessibility: { textScale: 2, reduceMotion: true },
    })

    expect(() => parseUiPreferencePatch({ appearance: { accentColor: 'green' } })).toThrow(/hex color/i)
    expect(() => parseUiPreferencePatch({ accessibility: { textScale: 2.1 } })).toThrow(/between 1 and 2/i)
    expect(() => parseUiPreferencePatch({ secret: 'must-not-import' })).toThrow(/unsupported key/i)
  })

  it('migrates the supported legacy v0 document into schema v1', () => {
    const migrated = parseUiPersistentDocument({
      schemaVersion: 0,
      theme: 'light',
      accentColor: '#3366FF',
      reducedMotion: true,
    })

    expect(migrated.schemaVersion).toBe(1)
    expect(migrated.userOverrides).toEqual({
      appearance: { colorScheme: 'light', accentColor: '#3366ff' },
      accessibility: { reduceMotion: true },
    })
  })

  it('merges nested patches without erasing unrelated preferences', () => {
    const merged = mergeUiPreferencePatches(
      { appearance: { density: 'compact' }, accessibility: { reduceMotion: true } },
      { appearance: { accentColor: '#112233' }, accessibility: { textScale: 1.5 } },
    )
    const resolved = applyUiPreferencePatch(DEFAULT_UI_PREFERENCES, merged)

    expect(resolved.appearance.density).toBe('compact')
    expect(resolved.appearance.accentColor).toBe('#112233')
    expect(resolved.accessibility.reduceMotion).toBe(true)
    expect(resolved.accessibility.textScale).toBe(1.5)
  })

  it('produces a privacy-safe empty durable document', () => {
    const document = createDefaultUiPersistentDocument(123)
    expect(document).toEqual({
      schemaVersion: 1,
      selectedPresetId: null,
      userOverrides: {},
      featureOverrides: {},
      monitorOverrides: {},
      appOverrides: {},
      accessibilityOverrides: {},
      updatedAt: 123,
    })
    expect(JSON.stringify(document)).not.toMatch(/hwnd|pid|notification/i)
  })
})
