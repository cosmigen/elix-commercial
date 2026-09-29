/**
 * Public type contracts for the ELIX Phase 16B UI foundation.
 *
 * @module @deepseek-ai/dsh-ui-foundation/types
 */

/** User-selected shell color-scheme policy. */
export type UiColorSchemePreference = 'system' | 'light' | 'dark'

/** Resolved renderer color scheme after system and accessibility policy. */
export type UiResolvedColorScheme = 'light' | 'dark' | 'high-contrast'

/** Shared shell density preference. */
export type UiDensity = 'compact' | 'standard' | 'comfortable'

/** Shared material preference. */
export type UiMaterial = 'auto' | 'opaque' | 'translucent'

/** Global appearance preferences. */
export interface UiAppearancePreferences {
  readonly colorScheme: UiColorSchemePreference
  readonly accentColor: string
  readonly density: UiDensity
  readonly material: UiMaterial
  readonly motionIntensity: number
}

/** Accessibility preferences that override decorative appearance. */
export interface UiAccessibilityPreferences {
  readonly highContrast: boolean
  readonly textScale: number
  readonly reduceMotion: boolean
  readonly reduceTransparency: boolean
  readonly alwaysShowFocus: boolean
  readonly largeHitTargets: boolean
}

/** Complete desired preference set before runtime capability fallback. */
export interface UiPreferences {
  readonly appearance: UiAppearancePreferences
  readonly accessibility: UiAccessibilityPreferences
}

/** Partial preference change used for global, preset, scoped, and preview values. */
export interface UiPreferencePatch {
  readonly appearance?: Partial<UiAppearancePreferences> | undefined
  readonly accessibility?: Partial<UiAccessibilityPreferences> | undefined
}

/** Stable scope identifiers supported by Phase 16B persistence. */
export interface UiPreferenceScope {
  readonly featureId?: string | undefined
  readonly monitorId?: string | undefined
  readonly appId?: string | undefined
  /** Spaces are not persisted until Phase 18 provides stable desktop identity. */
  readonly spaceId?: string | undefined
}

/** Named preference preset registered by built-in or future extension owners. */
export interface UiPreferencePreset {
  readonly id: string
  readonly title: string
  readonly preferences: UiPreferencePatch
}

/** System appearance facts reported by a renderer or future Windows provider. */
export interface UiSystemAppearance {
  readonly colorScheme: 'light' | 'dark'
  readonly highContrast: boolean
  readonly reduceMotion: boolean
}

/** Runtime rendering capabilities kept separate from desired user preferences. */
export interface UiRuntimeCapabilities {
  readonly transparency: boolean
  readonly animations: boolean
  readonly backdropMaterial: boolean
}

/** Persisted Phase 16B preference document. */
export interface UiPersistentPreferencesDocument {
  readonly schemaVersion: 1
  readonly selectedPresetId: string | null
  readonly userOverrides: UiPreferencePatch
  readonly featureOverrides: Readonly<Record<string, UiPreferencePatch>>
  readonly monitorOverrides: Readonly<Record<string, UiPreferencePatch>>
  readonly appOverrides: Readonly<Record<string, UiPreferencePatch>>
  readonly accessibilityOverrides: Partial<UiAccessibilityPreferences>
  readonly updatedAt: number
}

/** Resolved preference result for one consumer scope. */
export interface UiResolvedPreferences {
  readonly desired: UiPreferences
  readonly applied: UiPreferences
  readonly resolvedColorScheme: UiResolvedColorScheme
  readonly degradedReasons: readonly string[]
  readonly scopeFallbacks: readonly string[]
}

/** Active risky appearance preview. */
export interface UiPreferencePreview {
  readonly id: string
  readonly ownerId: string
  readonly patch: UiPreferencePatch
  readonly startedAt: number
  readonly deadline: number
}

/** Renderer-consumable shared UI state. */
export interface UiFoundationState {
  readonly revision: number
  readonly resolved: UiResolvedPreferences
  readonly tokens: Readonly<Record<string, string>>
  readonly preview?: UiPreferencePreview | undefined
}

/** Change notification emitted after committed or preview state changes. */
export interface UiFoundationChangeEvent {
  readonly reason:
    | 'loaded'
    | 'preferences'
    | 'preset'
    | 'scoped-preferences'
    | 'accessibility'
    | 'preview-started'
    | 'preview-kept'
    | 'preview-reverted'
    | 'system-appearance'
    | 'capabilities'
    | 'imported'
    | 'reset'
  readonly state: UiFoundationState
}

/** Handle returned for one risky preview transaction. */
export interface UiPreferencePreviewHandle {
  readonly id: string
  readonly ownerId: string
  readonly deadline: number
  keep(): Promise<boolean>
  revert(): boolean
}

/** Shared primitive categories supported by the interaction foundation. */
export type UiPrimitiveKind =
  | 'button'
  | 'toggle'
  | 'slider'
  | 'segmented'
  | 'menu'
  | 'submenu'
  | 'context-menu'
  | 'tooltip'
  | 'popover'
  | 'sheet'
  | 'dialog'
  | 'search'
  | 'list'
  | 'tabs'
  | 'toast'
  | 'empty'
  | 'loading'
  | 'error'
  | 'progress'
  | 'cancel'

/** Keyboard/focus contract for one shared primitive kind. */
export interface UiPrimitiveContract {
  readonly kind: UiPrimitiveKind
  readonly role: string
  readonly focusable: boolean
  readonly restoresFocus: boolean
  readonly escapeDismisses: boolean
  readonly outsideClickDismisses: boolean
  readonly activationKeys: readonly string[]
  readonly navigationKeys: readonly string[]
}

/** Normalized interaction decision returned by keyboard helpers. */
export type UiKeyAction =
  | 'activate'
  | 'dismiss'
  | 'previous'
  | 'next'
  | 'first'
  | 'last'
  | 'none'

/** Shared pointer and motion timing constants. */
export interface UiInteractionMetrics {
  readonly minimumHitTargetPx: number
  readonly largeHitTargetPx: number
  readonly dragThresholdPx: number
  readonly hoverDelayMs: number
  readonly submenuOpenDelayMs: number
  readonly submenuCloseDelayMs: number
}
