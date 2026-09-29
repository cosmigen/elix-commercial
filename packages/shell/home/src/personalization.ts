/**
 * Phase 16C Home personalization coordinator.
 *
 * Wallpaper ownership remains in WallpaperManager. Normal shell appearance ownership
 * remains in UI Foundation. This coordinator only gives Home one transaction boundary
 * for presets and Keep/Revert previews that span both authorities.
 */

import type {
  UiPreferencePatch,
  UiPreferencePreviewHandle,
} from '@deepseek-ai/dsh-ui-foundation'
import type {
  WallpaperDisplayPatch,
  WallpaperDisplayPreferences,
  WallpaperItem,
  WallpaperManager,
} from './wallpaper.ts'
import { applyWallpaperDisplayPatch } from './wallpaper.ts'

/** Minimum safety window for previews that can change shared shell appearance. */
export const MIN_APPEARANCE_PREVIEW_TIMEOUT_MS = 60_000

/** Minimal UI Foundation surface consumed by Home personalization. */
export interface UiFoundationPersonalizationRef {
  beginPreview(
    patch: UiPreferencePatch,
    options: { readonly ownerId: string; readonly timeoutMs?: number },
  ): UiPreferencePreviewHandle
  reset(kind: 'user' | 'monitor', id?: string): Promise<void>
}

/** One reusable global personalization preset spanning wallpaper and shared appearance. */
export interface HomePersonalizationPreset {
  readonly id: string
  readonly title: string
  readonly description?: string | undefined
  readonly wallpaper?: WallpaperDisplayPatch | undefined
  readonly appearance?: UiPreferencePatch | undefined
}

/** Cross-authority preview request. */
export interface HomePersonalizationPatch {
  readonly wallpaper?: WallpaperDisplayPatch | undefined
  readonly appearance?: UiPreferencePatch | undefined
}

/** Current non-durable personalization preview. */
export interface HomePersonalizationPreview {
  readonly id: string
  readonly ownerId: string
  readonly monitorId?: string | undefined
  readonly patch: HomePersonalizationPatch
  readonly startedAt: number
  /** Present only for previews that include shell appearance changes. */
  readonly deadline?: number | undefined
}

/** Handle returned to future Settings/personalization UI. */
export interface HomePersonalizationPreviewHandle {
  readonly id: string
  readonly ownerId: string
  /** Present only for previews that include shell appearance changes. */
  readonly deadline?: number | undefined
  updateWallpaper(patch: WallpaperDisplayPatch): boolean
  keep(): Promise<boolean>
  revert(): boolean
}

export interface HomePersonalizationCoordinatorOptions {
  readonly getUiFoundation: () => UiFoundationPersonalizationRef | undefined
  readonly publish: () => void
  /** Default timeout for previews that include shell appearance changes. */
  readonly previewTimeoutMs?: number | undefined
}

interface ActivePreview extends HomePersonalizationPreview {
  readonly uiHandle?: UiPreferencePreviewHandle | undefined
}

/** Built-in presets reference existing Home wallpapers and 16B appearance fields only. */
export const DEFAULT_HOME_PERSONALIZATION_PRESETS: readonly HomePersonalizationPreset[] = Object.freeze([
  Object.freeze({
    id: 'elix-ember',
    title: 'ELIX Ember',
    description: 'Warm ELIX gradient with a dark shell and orange accent.',
    wallpaper: Object.freeze({ activeId: 'elix-orange', dim: 6, blur: 0, saturation: 108 }),
    appearance: Object.freeze({ appearance: Object.freeze({ colorScheme: 'dark', accentColor: '#ff6b35' }) }),
  }),
  Object.freeze({
    id: 'aurora-focus',
    title: 'Aurora Focus',
    description: 'Cool blue desktop with a focused dark shell.',
    wallpaper: Object.freeze({ activeId: 'aurora-forest', dim: 12, blur: 0, saturation: 105 }),
    appearance: Object.freeze({ appearance: Object.freeze({ colorScheme: 'dark', accentColor: '#38bdf8' }) }),
  }),
  Object.freeze({
    id: 'violet-night',
    title: 'Violet Night',
    description: 'Violet wallpaper and matching dark-shell accent.',
    wallpaper: Object.freeze({ activeId: 'violet-circuit', dim: 8, blur: 0, saturation: 110 }),
    appearance: Object.freeze({ appearance: Object.freeze({ colorScheme: 'dark', accentColor: '#a855f7' }) }),
  }),
  Object.freeze({
    id: 'quiet-orbit',
    title: 'Quiet Orbit',
    description: 'Trusted ELIX live scene with gentler shell motion.',
    wallpaper: Object.freeze({ activeId: 'quiet-orbit', dim: 10, blur: 0, saturation: 100 }),
    appearance: Object.freeze({ appearance: Object.freeze({ colorScheme: 'dark', motionIntensity: 0.45 }) }),
  }),
])

/**
 * Coordinates wallpaper and UI Foundation personalization without stealing either authority.
 * Wallpaper preview state is kept entirely in memory so Home's existing save debounce can
 * never persist an unconfirmed preview. Wallpaper-only previews have no timer; previews
 * that include shell appearance keep a safety deadline of at least 60 seconds.
 */
export class HomePersonalizationCoordinator {
  private readonly wallpaper: WallpaperManager
  private readonly options: Required<Pick<HomePersonalizationCoordinatorOptions, 'getUiFoundation' | 'publish'>> & {
    readonly previewTimeoutMs: number
  }
  private readonly presets = new Map<string, HomePersonalizationPreset>()
  private activePreview: ActivePreview | undefined
  private previewTimer: NodeJS.Timeout | undefined
  private disposed = false

  constructor(wallpaper: WallpaperManager, options: HomePersonalizationCoordinatorOptions) {
    this.wallpaper = wallpaper
    const timeout = options.previewTimeoutMs ?? MIN_APPEARANCE_PREVIEW_TIMEOUT_MS
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new RangeError('Home personalization appearance preview timeout must be a positive finite number.')
    }
    this.options = {
      getUiFoundation: options.getUiFoundation,
      publish: options.publish,
      previewTimeoutMs: Math.max(MIN_APPEARANCE_PREVIEW_TIMEOUT_MS, timeout),
    }
    for (const preset of DEFAULT_HOME_PERSONALIZATION_PRESETS) this.registerPreset(preset)
  }

  /** List all currently registered built-in/extension presets. */
  listPresets(): readonly HomePersonalizationPreset[] {
    return Array.from(this.presets.values()).map(clonePreset)
  }

  /** Register one preset; disposer removes only the exact registration. */
  registerPreset(preset: HomePersonalizationPreset): () => void {
    const normalized = normalizePreset(preset)
    if (this.presets.has(normalized.id)) {
      throw new Error(`Home personalization preset ${JSON.stringify(normalized.id)} is already registered.`)
    }
    this.validatePatch(normalized)
    this.presets.set(normalized.id, normalized)
    return () => {
      if (this.presets.get(normalized.id) === normalized) this.presets.delete(normalized.id)
    }
  }

  /** Return one registered preset without exposing mutable internal state. */
  getPreset(id: string): HomePersonalizationPreset | undefined {
    const preset = this.presets.get(id)
    return preset === undefined ? undefined : clonePreset(preset)
  }

  /** Return current transient preview metadata. */
  getPreview(): HomePersonalizationPreview | undefined {
    const preview = this.activePreview
    return preview === undefined ? undefined : clonePreview(preview)
  }

  /** Resolve effective wallpaper display values including the active transient preview. */
  getDisplayPreferences(monitorId?: string): WallpaperDisplayPreferences {
    const base = this.wallpaper.getDisplayPreferences(monitorId)
    const preview = this.activePreview
    if (preview?.patch.wallpaper === undefined) return base
    if (preview.monitorId !== undefined && preview.monitorId !== monitorId) return base
    return applyWallpaperDisplayPatch(base, preview.patch.wallpaper, this.wallpaper.getPreferences().items)
  }

  /** Return the effective active wallpaper including transient preview state. */
  getActiveWallpaper(monitorId?: string): WallpaperItem {
    const display = this.getDisplayPreferences(monitorId)
    return this.wallpaper.getWallpaperItem(display.activeId)
      ?? this.wallpaper.getActiveWallpaper(monitorId)
  }

  /**
   * Begin a non-durable preview. Wallpaper-only previews intentionally have no timer.
   * A preview that includes shell appearance gets a safety timeout of at least 60 seconds.
   */
  beginPreview(
    patch: HomePersonalizationPatch,
    options: { readonly ownerId: string; readonly monitorId?: string; readonly timeoutMs?: number },
  ): HomePersonalizationPreviewHandle {
    this.assertAvailable()
    const ownerId = options.ownerId.trim()
    if (ownerId.length === 0) throw new TypeError('Personalization preview ownerId must be non-empty.')
    const monitorId = options.monitorId?.trim()
    if (monitorId !== undefined && (monitorId.length === 0 || monitorId.length > 256)) {
      throw new TypeError('Personalization preview monitorId must be a non-empty stable monitor ID.')
    }
    if (monitorId !== undefined && patch.appearance !== undefined) {
      throw new Error('Monitor-scoped personalization previews may change wallpaper only; shell appearance preview is global.')
    }
    this.validatePatch(patch)

    const appearancePatch = patch.appearance
    const hasAppearance = appearancePatch !== undefined
    let timeoutMs: number | undefined
    if (hasAppearance) {
      const requestedTimeout = options.timeoutMs ?? this.options.previewTimeoutMs
      if (!Number.isFinite(requestedTimeout) || requestedTimeout <= 0) {
        throw new RangeError('Appearance preview timeout must be positive.')
      }
      timeoutMs = Math.max(MIN_APPEARANCE_PREVIEW_TIMEOUT_MS, requestedTimeout)
    }

    if (this.activePreview !== undefined) this.revertPreview(this.activePreview.id)

    const uiFoundation = !hasAppearance ? undefined : this.options.getUiFoundation()
    if (hasAppearance && uiFoundation === undefined) {
      throw new Error('UI Foundation is required for a personalization preview that changes shell appearance.')
    }

    const now = Date.now()
    const id = `home-personalization-${now}-${Math.random().toString(36).slice(2, 9)}`
    const uiHandle = appearancePatch === undefined
      ? undefined
      : uiFoundation?.beginPreview(
        appearancePatch,
        timeoutMs === undefined ? { ownerId } : { ownerId, timeoutMs },
      )
    const deadline = timeoutMs === undefined ? undefined : now + timeoutMs
    const preview: ActivePreview = {
      id,
      ownerId,
      ...(monitorId === undefined ? {} : { monitorId }),
      patch: clonePatch(patch),
      startedAt: now,
      ...(deadline === undefined ? {} : { deadline }),
      ...(uiHandle === undefined ? {} : { uiHandle }),
    }
    this.activePreview = preview
    if (timeoutMs !== undefined) {
      this.previewTimer = setTimeout(() => {
        this.revertPreview(id)
      }, timeoutMs)
    }
    this.options.publish()

    return {
      id,
      ownerId,
      ...(deadline === undefined ? {} : { deadline }),
      updateWallpaper: wallpaperPatch => this.updateWallpaperPreview(id, wallpaperPatch),
      keep: () => this.keepPreview(id),
      revert: () => this.revertPreview(id),
    }
  }

  /** Begin previewing a registered global wallpaper + shell appearance preset. */
  beginPresetPreview(
    presetId: string,
    options: { readonly ownerId: string; readonly timeoutMs?: number },
  ): HomePersonalizationPreviewHandle {
    const preset = this.presets.get(presetId)
    if (preset === undefined) throw new Error(`Unknown Home personalization preset ${JSON.stringify(presetId)}.`)
    return this.beginPreview({ wallpaper: preset.wallpaper, appearance: preset.appearance }, options)
  }

  /**
   * Update only the wallpaper portion of an active preview in place.
   * The effective wallpaper selection and every visual effect are folded into one complete
   * preview state so slider/button changes cannot fall back to durable wallpaper state.
   * Wallpaper-only previews remain untimed; coordinated appearance previews retain their
   * original safety deadline.
   */
  updateWallpaperPreview(id: string, patch: WallpaperDisplayPatch): boolean {
    this.assertAvailable()
    const preview = this.activePreview
    if (preview === undefined || preview.id !== id) return false
    if (patch.activeId !== undefined && this.wallpaper.getWallpaperItem(patch.activeId) === undefined) {
      throw new Error(`Unknown wallpaper '${patch.activeId}'.`)
    }

    const items = this.wallpaper.getPreferences().items
    const current = this.getDisplayPreferences(preview.monitorId)
    const next = applyWallpaperDisplayPatch(current, patch, items)
    const nextWallpaper: WallpaperDisplayPatch = {
      activeId: next.activeId,
      fit: next.fit,
      blur: next.blur,
      saturation: next.saturation,
      dim: next.dim,
    }
    this.activePreview = {
      ...preview,
      patch: {
        ...preview.patch,
        wallpaper: nextWallpaper,
      },
    }
    this.options.publish()
    return true
  }

  /** Keep an active preview and commit through each existing authority. */
  async keepPreview(id: string): Promise<boolean> {
    this.assertAvailable()
    const preview = this.activePreview
    if (preview === undefined || preview.id !== id) return false

    if (preview.uiHandle !== undefined) {
      const kept = await preview.uiHandle.keep()
      if (!kept) return false
    }

    this.clearTimer()
    this.activePreview = undefined
    if (preview.patch.wallpaper !== undefined) {
      this.wallpaper.applyDisplayPatch(preview.patch.wallpaper, preview.monitorId)
    }
    this.options.publish()
    return true
  }

  /** Revert one active preview without touching durable wallpaper preferences. */
  revertPreview(id: string): boolean {
    const preview = this.activePreview
    if (preview === undefined || preview.id !== id) return false
    this.clearTimer()
    this.activePreview = undefined
    preview.uiHandle?.revert()
    this.options.publish()
    return true
  }

  /** Revert if the owning Settings/personalization surface disappears. */
  releasePreviewOwner(ownerId: string): boolean {
    const preview = this.activePreview
    if (preview === undefined || preview.ownerId !== ownerId) return false
    return this.revertPreview(preview.id)
  }

  /** Revert if Keep/Revert confirmation is no longer visible. */
  reportPreviewConfirmationVisible(id: string, visible: boolean): boolean {
    if (visible) return this.activePreview?.id === id
    return this.revertPreview(id)
  }

  /** A monitor disappearing invalidates a monitor-scoped preview but not its durable override. */
  handleMonitorRemoved(monitorId: string): boolean {
    const preview = this.activePreview
    if (preview?.monitorId !== monitorId) return false
    return this.revertPreview(preview.id)
  }

  /** Apply a global coordinated preset immediately by using the validated preview/commit path. */
  async applyPreset(
    presetId: string,
    options: { readonly ownerId: string },
  ): Promise<boolean> {
    const preview = this.beginPresetPreview(presetId, options)
    return preview.keep()
  }

  /** Reset wallpaper plus the corresponding 16B appearance scope. */
  async reset(monitorId?: string): Promise<void> {
    if (this.activePreview !== undefined) this.revertPreview(this.activePreview.id)
    this.wallpaper.resetDisplay(monitorId)
    const uiFoundation = this.options.getUiFoundation()
    if (uiFoundation !== undefined) {
      if (monitorId === undefined) await uiFoundation.reset('user')
      else await uiFoundation.reset('monitor', monitorId)
    }
    this.options.publish()
  }

  /** Stop timers and guarantee no preview survives Home teardown. */
  dispose(): void {
    if (this.disposed) return
    if (this.activePreview !== undefined) this.revertPreview(this.activePreview.id)
    this.clearTimer()
    this.disposed = true
  }

  private validatePatch(patch: HomePersonalizationPatch): void {
    if (patch.wallpaper?.activeId !== undefined && this.wallpaper.getWallpaperItem(patch.wallpaper.activeId) === undefined) {
      throw new Error(`Unknown wallpaper '${patch.wallpaper.activeId}'.`)
    }
    if (patch.wallpaper !== undefined) {
      applyWallpaperDisplayPatch(
        this.wallpaper.getDisplayPreferences(),
        patch.wallpaper,
        this.wallpaper.getPreferences().items,
      )
    }
  }

  private clearTimer(): void {
    if (this.previewTimer !== undefined) {
      clearTimeout(this.previewTimer)
      this.previewTimer = undefined
    }
  }

  private assertAvailable(): void {
    if (this.disposed) throw new Error('HomePersonalizationCoordinator is disposed.')
  }
}

function normalizePreset(preset: HomePersonalizationPreset): HomePersonalizationPreset {
  const id = preset.id.trim()
  const title = preset.title.trim()
  if (id.length === 0 || id.length > 128) throw new TypeError('Personalization preset id must contain 1 to 128 characters.')
  if (title.length === 0 || title.length > 128) throw new TypeError('Personalization preset title must contain 1 to 128 characters.')
  return {
    id,
    title,
    ...(preset.description === undefined ? {} : { description: preset.description.trim().slice(0, 512) }),
    ...(preset.wallpaper === undefined ? {} : { wallpaper: { ...preset.wallpaper } }),
    ...(preset.appearance === undefined ? {} : { appearance: cloneUiPatch(preset.appearance) }),
  }
}

function clonePreset(preset: HomePersonalizationPreset): HomePersonalizationPreset {
  return {
    ...preset,
    ...(preset.wallpaper === undefined ? {} : { wallpaper: { ...preset.wallpaper } }),
    ...(preset.appearance === undefined ? {} : { appearance: cloneUiPatch(preset.appearance) }),
  }
}

function clonePatch(patch: HomePersonalizationPatch): HomePersonalizationPatch {
  return {
    ...(patch.wallpaper === undefined ? {} : { wallpaper: { ...patch.wallpaper } }),
    ...(patch.appearance === undefined ? {} : { appearance: cloneUiPatch(patch.appearance) }),
  }
}

function clonePreview(preview: ActivePreview): HomePersonalizationPreview {
  return {
    id: preview.id,
    ownerId: preview.ownerId,
    ...(preview.monitorId === undefined ? {} : { monitorId: preview.monitorId }),
    patch: clonePatch(preview.patch),
    startedAt: preview.startedAt,
    ...(preview.deadline === undefined ? {} : { deadline: preview.deadline }),
  }
}

function cloneUiPatch(patch: UiPreferencePatch): UiPreferencePatch {
  return {
    ...(patch.appearance === undefined ? {} : { appearance: { ...patch.appearance } }),
    ...(patch.accessibility === undefined ? {} : { accessibility: { ...patch.accessibility } }),
  }
}
