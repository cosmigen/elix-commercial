/** Validated preference schema and deterministic precedence helpers. */

import type {
  UiAccessibilityPreferences,
  UiAppearancePreferences,
  UiPersistentPreferencesDocument,
  UiPreferencePatch,
  UiPreferences,
} from './types.ts'

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

/** Current durable preferences schema version. */
export const UI_PREFERENCES_SCHEMA_VERSION = 1

/** Shipped Phase 16B preference defaults. */
export const DEFAULT_UI_PREFERENCES: UiPreferences = Object.freeze({
  appearance: Object.freeze({
    colorScheme: 'system',
    accentColor: '#38bdf8',
    density: 'standard',
    material: 'auto',
    motionIntensity: 1,
  }),
  accessibility: Object.freeze({
    highContrast: false,
    textScale: 1,
    reduceMotion: false,
    reduceTransparency: false,
    alwaysShowFocus: false,
    largeHitTargets: false,
  }),
})

/** Empty durable document used when no saved configuration exists. */
export function createDefaultUiPersistentDocument(now = Date.now()): UiPersistentPreferencesDocument {
  return {
    schemaVersion: UI_PREFERENCES_SCHEMA_VERSION,
    selectedPresetId: null,
    userOverrides: {},
    featureOverrides: {},
    monitorOverrides: {},
    appOverrides: {},
    accessibilityOverrides: {},
    updatedAt: now,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const allowedSet = new Set(allowed)
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw new TypeError(`${path} contains unsupported key ${JSON.stringify(key)}.`)
    }
  }
}

function parseAppearancePatch(value: unknown, path: string): Partial<UiAppearancePreferences> {
  if (!isRecord(value)) throw new TypeError(`${path} must be an object.`)
  assertAllowedKeys(value, ['colorScheme', 'accentColor', 'density', 'material', 'motionIntensity'], path)
  const patch: Partial<Mutable<UiAppearancePreferences>> = {}

  if (value.colorScheme !== undefined) {
    if (value.colorScheme !== 'system' && value.colorScheme !== 'light' && value.colorScheme !== 'dark') {
      throw new TypeError(`${path}.colorScheme is invalid.`)
    }
    patch.colorScheme = value.colorScheme
  }
  if (value.accentColor !== undefined) {
    if (typeof value.accentColor !== 'string' || !/^#[0-9a-f]{6}$/i.test(value.accentColor)) {
      throw new TypeError(`${path}.accentColor must be a six-digit hex color.`)
    }
    patch.accentColor = value.accentColor.toLowerCase()
  }
  if (value.density !== undefined) {
    if (value.density !== 'compact' && value.density !== 'standard' && value.density !== 'comfortable') {
      throw new TypeError(`${path}.density is invalid.`)
    }
    patch.density = value.density
  }
  if (value.material !== undefined) {
    if (value.material !== 'auto' && value.material !== 'opaque' && value.material !== 'translucent') {
      throw new TypeError(`${path}.material is invalid.`)
    }
    patch.material = value.material
  }
  if (value.motionIntensity !== undefined) {
    if (
      typeof value.motionIntensity !== 'number' ||
      !Number.isFinite(value.motionIntensity) ||
      value.motionIntensity < 0 ||
      value.motionIntensity > 1
    ) {
      throw new RangeError(`${path}.motionIntensity must be between 0 and 1.`)
    }
    patch.motionIntensity = value.motionIntensity
  }
  return patch
}

function parseBoolean(
  value: unknown,
  path: string,
): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new TypeError(`${path} must be boolean.`)
  return value
}

function parseAccessibilityPatch(value: unknown, path: string): Partial<UiAccessibilityPreferences> {
  if (!isRecord(value)) throw new TypeError(`${path} must be an object.`)
  assertAllowedKeys(
    value,
    ['highContrast', 'textScale', 'reduceMotion', 'reduceTransparency', 'alwaysShowFocus', 'largeHitTargets'],
    path,
  )

  const highContrast = parseBoolean(value.highContrast, `${path}.highContrast`)
  const reduceMotion = parseBoolean(value.reduceMotion, `${path}.reduceMotion`)
  const reduceTransparency = parseBoolean(value.reduceTransparency, `${path}.reduceTransparency`)
  const alwaysShowFocus = parseBoolean(value.alwaysShowFocus, `${path}.alwaysShowFocus`)
  const largeHitTargets = parseBoolean(value.largeHitTargets, `${path}.largeHitTargets`)
  let textScale: number | undefined

  if (value.textScale !== undefined) {
    if (
      typeof value.textScale !== 'number' ||
      !Number.isFinite(value.textScale) ||
      value.textScale < 1 ||
      value.textScale > 2
    ) {
      throw new RangeError(`${path}.textScale must be between 1 and 2.`)
    }
    textScale = value.textScale
  }

  return {
    ...(highContrast !== undefined ? { highContrast } : {}),
    ...(textScale !== undefined ? { textScale } : {}),
    ...(reduceMotion !== undefined ? { reduceMotion } : {}),
    ...(reduceTransparency !== undefined ? { reduceTransparency } : {}),
    ...(alwaysShowFocus !== undefined ? { alwaysShowFocus } : {}),
    ...(largeHitTargets !== undefined ? { largeHitTargets } : {}),
  }
}

/** Parse one preference patch from JSON or another untrusted boundary. */
export function parseUiPreferencePatch(value: unknown, path = 'preferences'): UiPreferencePatch {
  if (!isRecord(value)) throw new TypeError(`${path} must be an object.`)
  assertAllowedKeys(value, ['appearance', 'accessibility'], path)
  return {
    ...(value.appearance !== undefined
      ? { appearance: parseAppearancePatch(value.appearance, `${path}.appearance`) }
      : {}),
    ...(value.accessibility !== undefined
      ? { accessibility: parseAccessibilityPatch(value.accessibility, `${path}.accessibility`) }
      : {}),
  }
}

function parsePatchMap(value: unknown, path: string): Readonly<Record<string, UiPreferencePatch>> {
  if (!isRecord(value)) throw new TypeError(`${path} must be an object.`)
  const result: Record<string, UiPreferencePatch> = {}
  for (const [key, candidate] of Object.entries(value)) {
    if (!key.trim()) throw new TypeError(`${path} contains an empty scope identifier.`)
    result[key] = parseUiPreferencePatch(candidate, `${path}.${key}`)
  }
  return result
}

/** Parse and migrate one durable preference document. */
export function parseUiPersistentDocument(value: unknown): UiPersistentPreferencesDocument {
  if (!isRecord(value)) throw new TypeError('UI preferences document must be an object.')

  const schemaVersion = value.schemaVersion ?? 0
  if (schemaVersion === 0) {
    assertAllowedKeys(value, ['schemaVersion', 'theme', 'accentColor', 'reducedMotion'], 'legacy preferences')
    const appearance: Partial<Mutable<UiAppearancePreferences>> = {}
    const accessibility: Partial<Mutable<UiAccessibilityPreferences>> = {}
    if (value.theme !== undefined) {
      if (value.theme !== 'system' && value.theme !== 'light' && value.theme !== 'dark') {
        throw new TypeError('legacy preferences.theme is invalid.')
      }
      appearance.colorScheme = value.theme
    }
    if (value.accentColor !== undefined) {
      Object.assign(appearance, parseAppearancePatch({ accentColor: value.accentColor }, 'legacy preferences'))
    }
    if (value.reducedMotion !== undefined) {
      if (typeof value.reducedMotion !== 'boolean') {
        throw new TypeError('legacy preferences.reducedMotion must be boolean.')
      }
      accessibility.reduceMotion = value.reducedMotion
    }
    return {
      ...createDefaultUiPersistentDocument(),
      userOverrides: {
        ...(Object.keys(appearance).length > 0 ? { appearance } : {}),
        ...(Object.keys(accessibility).length > 0 ? { accessibility } : {}),
      },
    }
  }

  if (schemaVersion !== UI_PREFERENCES_SCHEMA_VERSION) {
    throw new RangeError(`Unsupported UI preferences schema version ${JSON.stringify(schemaVersion)}.`)
  }

  assertAllowedKeys(
    value,
    [
      'schemaVersion',
      'selectedPresetId',
      'userOverrides',
      'featureOverrides',
      'monitorOverrides',
      'appOverrides',
      'accessibilityOverrides',
      'updatedAt',
    ],
    'UI preferences document',
  )

  if (value.selectedPresetId !== null && typeof value.selectedPresetId !== 'string') {
    throw new TypeError('selectedPresetId must be a string or null.')
  }
  if (typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)) {
    throw new TypeError('updatedAt must be a finite number.')
  }

  return {
    schemaVersion: 1,
    selectedPresetId: value.selectedPresetId,
    userOverrides: parseUiPreferencePatch(value.userOverrides ?? {}, 'userOverrides'),
    featureOverrides: parsePatchMap(value.featureOverrides ?? {}, 'featureOverrides'),
    monitorOverrides: parsePatchMap(value.monitorOverrides ?? {}, 'monitorOverrides'),
    appOverrides: parsePatchMap(value.appOverrides ?? {}, 'appOverrides'),
    accessibilityOverrides: parseAccessibilityPatch(
      value.accessibilityOverrides ?? {},
      'accessibilityOverrides',
    ),
    updatedAt: value.updatedAt,
  }
}

/** Merge one patch onto a complete preference set. */
export function applyUiPreferencePatch(base: UiPreferences, patch: UiPreferencePatch): UiPreferences {
  return {
    appearance: {
      ...base.appearance,
      ...(patch.appearance ?? {}),
    },
    accessibility: {
      ...base.accessibility,
      ...(patch.accessibility ?? {}),
    },
  }
}

/** Merge two patches while preserving nested preference groups. */
export function mergeUiPreferencePatches(
  base: UiPreferencePatch,
  patch: UiPreferencePatch,
): UiPreferencePatch {
  return {
    ...(base.appearance !== undefined || patch.appearance !== undefined
      ? { appearance: { ...(base.appearance ?? {}), ...(patch.appearance ?? {}) } }
      : {}),
    ...(base.accessibility !== undefined || patch.accessibility !== undefined
      ? { accessibility: { ...(base.accessibility ?? {}), ...(patch.accessibility ?? {}) } }
      : {}),
  }
}
