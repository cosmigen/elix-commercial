/**
 * Wallpaper and Desktop Background subsystem for ELIX Home Screen.
 * Provides theme-aware background rendering, per-monitor personalization, and
 * pure CSS styling projection.
 *
 * @module @deepseek-ai/dsh-home/wallpaper
 */

/** Visual media kind for wallpaper sources. */
export type WallpaperKind = 'image' | 'gradient' | 'color' | 'video' | 'live'

/** Trusted ELIX-owned live scenes available to the privileged Home renderer. */
export type LiveWallpaperScene = 'elix-flow' | 'quiet-orbit'

/** Sizing and placement options for desktop wallpaper. */
export type WallpaperFit = 'cover' | 'contain' | 'stretch' | 'tile' | 'center'

/** Individual wallpaper item descriptor. */
export interface WallpaperItem {
  readonly id: string
  readonly name: string
  readonly kind: WallpaperKind
  readonly source: string
}

/** Wallpaper selection/effects applied to one display scope. */
export interface WallpaperDisplayPreferences {
  readonly activeId: string
  readonly fit: WallpaperFit
  /** Gaussian blur applied to wallpaper in pixels (0 to 50). */
  readonly blur: number
  /** Color saturation percentage (0% to 200%). */
  readonly saturation: number
  /** Darkening overlay level (0 to 100%). */
  readonly dim: number
}

/** Partial display-level wallpaper mutation. */
export type WallpaperDisplayPatch = Partial<WallpaperDisplayPreferences>

const LIVE_WALLPAPER_SCENES = new Set<LiveWallpaperScene>(['elix-flow', 'quiet-orbit'])

/**
 * Complete durable wallpaper collection and visual preferences.
 *
 * The top-level display fields are the default used by all monitors. Stable
 * Windows Context monitor IDs may override only those display fields. The shared
 * wallpaper catalogue remains global so local media is not duplicated per display.
 */
export interface WallpaperPreferences extends WallpaperDisplayPreferences {
  readonly items: readonly WallpaperItem[]
  readonly monitorOverrides?: Readonly<Record<string, WallpaperDisplayPreferences>> | undefined
}

/** Default built-in wallpaper collection (preserving ELIX aesthetics). */
export const DEFAULT_WALLPAPERS = [
  {
    id: 'elix-orange',
    name: 'ELIX Orange Flow',
    kind: 'gradient',
    source: 'radial-gradient(circle at 50% 30%, #ff6b35 0%, #1a0f0a 70%, #080605 100%)',
  },
  {
    id: 'aurora-forest',
    name: 'Aurora Forest',
    kind: 'gradient',
    source: 'linear-gradient(135deg, #0b3c5d 0%, #328cc1 40%, #1d2731 100%)',
  },
  {
    id: 'ember-night',
    name: 'Ember Night',
    kind: 'gradient',
    source: 'linear-gradient(160deg, #2b1055 0%, #7597de 50%, #000000 100%)',
  },
  {
    id: 'violet-circuit',
    name: 'Violet Circuit',
    kind: 'gradient',
    source: 'radial-gradient(circle at 70% 60%, #4a154b 0%, #1f0824 50%, #09020b 100%)',
  },
  {
    id: 'quiet-orbit',
    name: 'Quiet Orbit',
    kind: 'live',
    source: 'quiet-orbit',
  },
] as const satisfies readonly WallpaperItem[]

/** Default wallpaper preferences configured with the default wallpaper collection. */
export const DEFAULT_WALLPAPER_PREFERENCES: WallpaperPreferences = {
  activeId: 'elix-orange',
  items: DEFAULT_WALLPAPERS,
  fit: 'cover',
  blur: 0,
  saturation: 100,
  dim: 0,
}

/** Resolve effective display preferences for one optional monitor. */
export function resolveWallpaperDisplayPreferences(
  preferences: WallpaperPreferences,
  monitorId?: string,
): WallpaperDisplayPreferences {
  const base: WallpaperDisplayPreferences = {
    activeId: preferences.activeId,
    fit: preferences.fit,
    blur: preferences.blur,
    saturation: preferences.saturation,
    dim: preferences.dim,
  }
  if (monitorId === undefined) return base
  const override = preferences.monitorOverrides?.[monitorId]
  return override === undefined ? base : { ...override }
}

/** Apply one display patch with the same clamping rules used by persistence. */
export function applyWallpaperDisplayPatch(
  base: WallpaperDisplayPreferences,
  patch: WallpaperDisplayPatch,
  availableItems: readonly WallpaperItem[],
): WallpaperDisplayPreferences {
  const requestedActiveId = patch.activeId ?? base.activeId
  const activeId = availableItems.some(item => item.id === requestedActiveId)
    ? requestedActiveId
    : base.activeId
  return {
    activeId,
    fit: patch.fit === undefined ? base.fit : validateWallpaperFit(patch.fit),
    blur: patch.blur === undefined ? base.blur : clampNumber(patch.blur, 0, 50, base.blur),
    saturation: patch.saturation === undefined
      ? base.saturation
      : clampNumber(patch.saturation, 0, 200, base.saturation),
    dim: patch.dim === undefined ? base.dim : clampNumber(patch.dim, 0, 100, base.dim),
  }
}

/**
 * Pure function converting wallpaper preferences into CSS custom properties.
 * @param prefs - Wallpaper preferences to convert.
 * @returns Map of CSS variable names to string values.
 */
export function computeWallpaperCssVariables(prefs: WallpaperPreferences): Record<string, string> {
  const active = prefs.items.find(it => it.id === prefs.activeId) ?? prefs.items[0] ?? DEFAULT_WALLPAPERS[0]
  const backgroundSource =
    active.kind === 'gradient'
      ? active.source
      : active.kind === 'image'
        ? `url("${active.source.replace(/\\/g, '/').replace(/["\r\n]/g, '')}")`
        : active.source

  const size =
    prefs.fit === 'stretch'
      ? '100% 100%'
      : prefs.fit === 'tile' || prefs.fit === 'center'
        ? 'auto'
        : prefs.fit

  return {
    '--home-wallpaper': backgroundSource,
    '--home-wallpaper-size': size,
    '--home-wallpaper-repeat': prefs.fit === 'tile' ? 'repeat' : 'no-repeat',
    '--home-wallpaper-blur': `${Math.max(0, Math.min(50, prefs.blur))}px`,
    '--home-wallpaper-saturation': `${Math.max(0, Math.min(200, prefs.saturation))}%`,
    '--home-wallpaper-dim': String(Math.max(0, Math.min(100, prefs.dim)) / 100),
  }
}

/** Callback function invoked when durable wallpaper preferences change. */
export type WallpaperChangeListener = (prefs: WallpaperPreferences) => void

/**
 * Manages wallpaper catalogue, default selection, per-monitor selection, and visual filters.
 * Preview state deliberately lives in the Phase 16C personalization coordinator so
 * preview changes never become durable merely because Home's save debounce fires.
 */
export class WallpaperManager {
  private currentPreferences: WallpaperPreferences
  private readonly listeners = new Set<WallpaperChangeListener>()

  constructor(initial?: WallpaperPreferences) {
    this.currentPreferences = normalizeWallpaperPreferences(initial ?? DEFAULT_WALLPAPER_PREFERENCES)
  }

  /** Return the complete durable wallpaper state. */
  getPreferences(): WallpaperPreferences {
    return cloneWallpaperPreferences(this.currentPreferences)
  }

  /** Return effective display preferences for the default scope or one monitor. */
  getDisplayPreferences(monitorId?: string): WallpaperDisplayPreferences {
    return resolveWallpaperDisplayPreferences(this.currentPreferences, monitorId)
  }

  /** Replace preferences restored from Home persistence after validating renderer inputs. */
  loadPreferences(preferences: WallpaperPreferences): void {
    this.currentPreferences = normalizeWallpaperPreferences(preferences)
    this.notify()
  }

  /** Return one wallpaper descriptor by stable identifier. */
  getWallpaperItem(id: string): WallpaperItem | undefined {
    const item = this.currentPreferences.items.find(candidate => candidate.id === id)
    return item === undefined ? undefined : { ...item }
  }

  /** Return the active wallpaper descriptor for the default scope or one monitor. */
  getActiveWallpaper(monitorId?: string): WallpaperItem {
    const display = this.getDisplayPreferences(monitorId)
    return this.currentPreferences.items.find(item => item.id === display.activeId)
      ?? this.currentPreferences.items[0]
      ?? DEFAULT_WALLPAPERS[0]
  }

  /** Subscribe to durable wallpaper modifications. */
  onChange(listener: WallpaperChangeListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Set the active wallpaper globally or for one stable monitor ID. */
  setActiveWallpaper(id: string, monitorId?: string): boolean {
    if (!this.currentPreferences.items.some(it => it.id === id)) return false
    this.applyDisplayPatch({ activeId: id }, monitorId)
    return true
  }

  /** Add or replace a custom wallpaper item and make it active in the requested scope. */
  addWallpaperItem(item: WallpaperItem, monitorId?: string): void {
    const validated = validateWallpaperItem(item)
    const existing = this.currentPreferences.items.filter(it => it.id !== validated.id)
    const items = [...existing, validated]
    const base = { ...this.currentPreferences, items }
    this.currentPreferences = monitorId === undefined
      ? { ...base, activeId: validated.id }
      : setMonitorDisplay(base, monitorId, {
        ...resolveWallpaperDisplayPreferences(base, monitorId),
        activeId: validated.id,
      })
    this.notify()
  }

  /** Remove a custom wallpaper and repair every scope that referenced it. */
  removeWallpaperItem(id: string): boolean {
    if (DEFAULT_WALLPAPERS.some(item => item.id === id)) return false
    const items = this.currentPreferences.items.filter(item => item.id !== id)
    if (items.length === this.currentPreferences.items.length) return false
    const fallbackId = items.some(item => item.id === this.currentPreferences.activeId)
      ? this.currentPreferences.activeId
      : items[0]?.id ?? DEFAULT_WALLPAPER_PREFERENCES.activeId
    const repairedOverrides: Record<string, WallpaperDisplayPreferences> = {}
    for (const [monitorId, display] of Object.entries(this.currentPreferences.monitorOverrides ?? {})) {
      repairedOverrides[monitorId] = {
        ...display,
        activeId: items.some(item => item.id === display.activeId) ? display.activeId : fallbackId,
      }
    }
    this.currentPreferences = {
      ...this.currentPreferences,
      items: items.length > 0 ? items : DEFAULT_WALLPAPERS.map(item => ({ ...item })),
      activeId: fallbackId,
      monitorOverrides: repairedOverrides,
    }
    this.notify()
    return true
  }

  /** Update visual effects globally or for one stable monitor ID. */
  updateEffects(
    effects: Partial<Pick<WallpaperDisplayPreferences, 'fit' | 'blur' | 'saturation' | 'dim'>>,
    monitorId?: string,
  ): void {
    this.applyDisplayPatch(effects, monitorId)
  }

  /** Apply a validated display-level patch globally or to one monitor. */
  applyDisplayPatch(patch: WallpaperDisplayPatch, monitorId?: string): void {
    const base = this.getDisplayPreferences(monitorId)
    if (patch.activeId !== undefined && !this.currentPreferences.items.some(item => item.id === patch.activeId)) {
      throw new Error(`Unknown wallpaper '${patch.activeId}'.`)
    }
    const nextDisplay = applyWallpaperDisplayPatch(base, patch, this.currentPreferences.items)
    this.currentPreferences = monitorId === undefined
      ? {
        ...this.currentPreferences,
        ...nextDisplay,
      }
      : setMonitorDisplay(this.currentPreferences, monitorId, nextDisplay)
    this.notify()
  }

  /** Remove one per-monitor override so that monitor follows the global wallpaper again. */
  resetMonitorOverride(monitorId: string): boolean {
    const id = validateMonitorId(monitorId)
    if (this.currentPreferences.monitorOverrides?.[id] === undefined) return false
    const monitorOverrides = Object.fromEntries(
      Object.entries(this.currentPreferences.monitorOverrides).filter(([candidate]) => candidate !== id),
    )
    this.currentPreferences = { ...this.currentPreferences, monitorOverrides }
    this.notify()
    return true
  }

  /** Restore shipped wallpaper selection/effects while retaining custom catalogue entries. */
  resetDisplay(monitorId?: string): void {
    if (monitorId !== undefined) {
      this.resetMonitorOverride(monitorId)
      return
    }
    this.currentPreferences = {
      ...this.currentPreferences,
      activeId: DEFAULT_WALLPAPER_PREFERENCES.activeId,
      fit: DEFAULT_WALLPAPER_PREFERENCES.fit,
      blur: DEFAULT_WALLPAPER_PREFERENCES.blur,
      saturation: DEFAULT_WALLPAPER_PREFERENCES.saturation,
      dim: DEFAULT_WALLPAPER_PREFERENCES.dim,
      monitorOverrides: {},
    }
    this.notify()
  }

  private notify(): void {
    const preferences = this.getPreferences()
    for (const listener of this.listeners) {
      try {
        listener(preferences)
      } catch (error) {
        console.error('Error in wallpaper change listener:', error)
      }
    }
  }
}

const ALLOWED_WALLPAPER_KINDS = new Set<string>(['image', 'gradient', 'color', 'video', 'live'])
const IMAGE_MEDIA_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'])
const VIDEO_MEDIA_EXTENSIONS = new Set(['.mp4', '.webm', '.mov'])

/** Validate a wallpaper before its source reaches the privileged renderer. */
export function validateWallpaperItem(item: WallpaperItem): WallpaperItem {
  const id = item.id.trim()
  const name = item.name.trim()
  if (id.length === 0 || id.length > 128 || name.length === 0 || name.length > 128) {
    throw new Error('Wallpaper id and name must contain between 1 and 128 characters.')
  }
  if (!ALLOWED_WALLPAPER_KINDS.has(item.kind)) {
    throw new Error(`Unsupported wallpaper kind '${item.kind}'.`)
  }
  if (item.kind === 'live' && !LIVE_WALLPAPER_SCENES.has(item.source as LiveWallpaperScene)) {
    throw new Error(`Unknown trusted live wallpaper scene '${item.source}'.`)
  }
  if (item.kind === 'gradient' && !/^(?:linear|radial)-gradient\([^;{}]+\)$/iu.test(item.source.trim())) {
    throw new Error('Gradient wallpaper source must be one linear-gradient() or radial-gradient() value.')
  }
  if (item.kind === 'color' && !/^(?:#[\da-f]{3,8}|(?:rgb|hsl)a?\([\d\s.,%+-]+\))$/iu.test(item.source.trim())) {
    throw new Error('Color wallpaper source must be a hexadecimal, rgb(), rgba(), hsl(), or hsla() value.')
  }
  if (item.kind === 'image' || item.kind === 'video') {
    validateWallpaperMediaSource(item.source, item.kind)
  }
  return { id, name, kind: item.kind, source: item.source.trim() }
}

/**
 * Validate local wallpaper media before import. Home only serves a closed set of image/video
 * formats and never forwards arbitrary remote URLs into its privileged renderer.
 */
export function validateWallpaperMediaSource(source: string, kind: 'image' | 'video'): string {
  const trimmed = source.trim()
  if (trimmed.length === 0) throw new Error(`${kind} wallpaper source must name a local media file.`)
  if (trimmed.length > 4096) throw new Error(`${kind} wallpaper source is too long.`)
  if (/[\x00-\x1F"<>]/.test(trimmed)) {
    throw new Error(`${kind} wallpaper source contains forbidden characters.`)
  }
  const looksLocal = trimmed.startsWith('/') || trimmed.startsWith('file://') || /^[a-z]:[\\/]/iu.test(trimmed)
  if (!looksLocal) throw new Error(`${kind} wallpaper source must be an absolute local file path or file URL.`)
  const withoutQuery = trimmed.split(/[?#]/u, 1)[0] ?? trimmed
  const extensionMatch = /\.[a-z0-9]+$/iu.exec(withoutQuery)
  const extension = extensionMatch?.[0]?.toLowerCase()
  const allowed = kind === 'image' ? IMAGE_MEDIA_EXTENSIONS : VIDEO_MEDIA_EXTENSIONS
  if (extension === undefined || !allowed.has(extension)) {
    throw new Error(`Unsupported ${kind} wallpaper file type.`)
  }
  return trimmed
}

function normalizeWallpaperPreferences(preferences: WallpaperPreferences): WallpaperPreferences {
  const items = preferences.items.map(validateWallpaperItem)
  const normalizedItems = items.length > 0 ? items : DEFAULT_WALLPAPERS.map(item => ({ ...item }))
  const fallbackDisplay: WallpaperDisplayPreferences = {
    activeId: normalizedItems.some(item => item.id === preferences.activeId)
      ? preferences.activeId
      : normalizedItems[0]?.id ?? DEFAULT_WALLPAPER_PREFERENCES.activeId,
    fit: validateWallpaperFit(preferences.fit),
    blur: clampNumber(preferences.blur, 0, 50, 0),
    saturation: clampNumber(preferences.saturation, 0, 200, 100),
    dim: clampNumber(preferences.dim, 0, 100, 0),
  }
  const monitorOverrides: Record<string, WallpaperDisplayPreferences> = {}
  for (const [rawMonitorId, candidate] of Object.entries(preferences.monitorOverrides ?? {})) {
    const monitorId = validateMonitorId(rawMonitorId)
    monitorOverrides[monitorId] = normalizeDisplayPreferences(candidate, fallbackDisplay, normalizedItems)
  }
  return {
    ...fallbackDisplay,
    items: normalizedItems.map(item => ({ ...item })),
    monitorOverrides,
  }
}

function normalizeDisplayPreferences(
  candidate: WallpaperDisplayPreferences,
  fallback: WallpaperDisplayPreferences,
  items: readonly WallpaperItem[],
): WallpaperDisplayPreferences {
  return {
    activeId: items.some(item => item.id === candidate.activeId) ? candidate.activeId : fallback.activeId,
    fit: validateWallpaperFit(candidate.fit),
    blur: clampNumber(candidate.blur, 0, 50, fallback.blur),
    saturation: clampNumber(candidate.saturation, 0, 200, fallback.saturation),
    dim: clampNumber(candidate.dim, 0, 100, fallback.dim),
  }
}

function cloneWallpaperPreferences(preferences: WallpaperPreferences): WallpaperPreferences {
  return {
    activeId: preferences.activeId,
    items: preferences.items.map(item => ({ ...item })),
    fit: preferences.fit,
    blur: preferences.blur,
    saturation: preferences.saturation,
    dim: preferences.dim,
    monitorOverrides: Object.fromEntries(
      Object.entries(preferences.monitorOverrides ?? {}).map(([monitorId, display]) => [monitorId, { ...display }]),
    ),
  }
}

function setMonitorDisplay(
  preferences: WallpaperPreferences,
  monitorId: string,
  display: WallpaperDisplayPreferences,
): WallpaperPreferences {
  const id = validateMonitorId(monitorId)
  return {
    ...preferences,
    monitorOverrides: {
      ...(preferences.monitorOverrides ?? {}),
      [id]: { ...display },
    },
  }
}

function validateMonitorId(value: string): string {
  const id = value.trim()
  if (id.length === 0 || id.length > 256 || /[\x00-\x1F]/u.test(id)) {
    throw new Error('Wallpaper monitor ID must contain between 1 and 256 safe characters.')
  }
  return id
}

function validateWallpaperFit(value: unknown): WallpaperFit {
  return value === 'cover' || value === 'contain' || value === 'stretch' || value === 'tile' || value === 'center'
    ? value
    : 'cover'
}

function clampNumber(value: number, minimum: number, maximum: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback
}
