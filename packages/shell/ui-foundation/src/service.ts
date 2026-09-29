/** Authoritative ELIX Phase 16B preferences, design-token, and accessibility service. */

import { Context, Service } from '@deepseek-ai/cordis'
import type { SurfaceInstance, SurfaceService } from '@deepseek-ai/dsh-surface'
import z from '@deepseek-ai/schemastery'
import { resolveDesignTokens } from './design-tokens.ts'
import { UiPreferencesPersistence } from './persistence.ts'
import {
  applyUiPreferencePatch,
  createDefaultUiPersistentDocument,
  DEFAULT_UI_PREFERENCES,
  mergeUiPreferencePatches,
  parseUiPersistentDocument,
} from './preference-schema.ts'
import { createUiFoundationStateMessage } from './renderer-bridge.ts'
import type {
  UiAccessibilityPreferences,
  UiFoundationChangeEvent,
  UiFoundationState,
  UiPersistentPreferencesDocument,
  UiPreferencePatch,
  UiPreferencePreset,
  UiPreferencePreview,
  UiPreferencePreviewHandle,
  UiPreferenceScope,
  UiPreferences,
  UiResolvedPreferences,
  UiRuntimeCapabilities,
  UiSystemAppearance,
} from './types.ts'

/** Configuration for the shared UI foundation. */
export interface UiFoundationConfig {
  readonly enabled: boolean
  readonly persistencePath?: string | undefined
  readonly previewTimeoutMs: number
}

interface HomeThemeConsumerRef {
  setThemeTokens(tokens: Record<string, string>): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    uiFoundation: UiFoundationService
  }
  interface Events {
    /** @mode broadcast @param service Initialized UI foundation service. */
    'ui-foundation/ready'(service: UiFoundationService): void
    /** @mode broadcast @param event Shared preference/design state change. */
    'ui-foundation/change'(event: UiFoundationChangeEvent): void
  }
}

/** Shared authority for shell preferences, design resolution, and risky appearance previews. */
export class UiFoundationService extends Service {
  static Config = z.object({
    enabled: z.boolean().default(true),
    persistencePath: z.string(),
    previewTimeoutMs: z.number().default(15_000),
  })

  private readonly config: UiFoundationConfig
  private readonly persistence: UiPreferencesPersistence
  private readonly presets = new Map<string, UiPreferencePreset>()
  private readonly listeners = new Set<(event: UiFoundationChangeEvent) => void>()
  private document: UiPersistentPreferencesDocument = createDefaultUiPersistentDocument()
  private systemAppearance: UiSystemAppearance | undefined
  private capabilities: UiRuntimeCapabilities = {
    transparency: true,
    animations: true,
    backdropMaterial: true,
  }
  private preview: UiPreferencePreview | undefined
  private previewTimer: NodeJS.Timeout | undefined
  private revision = 0
  private disposed = false

  constructor(ctx: Context, config?: Partial<UiFoundationConfig>) {
    super(ctx, 'uiFoundation')
    this.config = {
      enabled: config?.enabled ?? true,
      persistencePath: config?.persistencePath,
      previewTimeoutMs: config?.previewTimeoutMs ?? 15_000,
    }
    if (!Number.isFinite(this.config.previewTimeoutMs) || this.config.previewTimeoutMs <= 0) {
      throw new RangeError('previewTimeoutMs must be a positive finite number.')
    }
    this.persistence = new UiPreferencesPersistence({ filePath: this.config.persistencePath })
    this.registerBuiltInPresets()
  }

  /** Load durable preferences and connect renderer propagation. */
  async [Service.init](): Promise<void> {
    if (!this.config.enabled) return
    const loaded = await this.persistence.load()
    this.document = loaded.document

    const unbindSurfaceCreated = this.ctx.on('surface/created', (surface) => {
      this.applyCurrentStateToHome()
      void this.publishToSurface(surface)
    })
    const unbindSurfaceReady = this.ctx.on('surface/ready', (surface) => {
      this.applyCurrentStateToHome()
      void this.publishToSurface(surface)
    })
    const unbindSurfaceMessage = this.ctx.on('surface/message', ({ message }) => {
      this.handleSurfaceMessage(message)
    })

    this.ctx.effect(() => () => {
      this.disposed = true
      unbindSurfaceCreated()
      unbindSurfaceReady()
      unbindSurfaceMessage()
      this.clearPreviewTimer()
      this.listeners.clear()
    }, 'uiFoundation.lifecycle')

    this.revision = 1
    const state = this.getState()
    this.applyCurrentStateToHome(state)
    await this.broadcastState(state)
    this.ctx.emit('ui-foundation/ready', this)
    this.emitChange('loaded', state)
  }

  /** Subscribe to committed and preview preference changes. */
  subscribe(listener: (event: UiFoundationChangeEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Return the current durable preference document. */
  getPersistentDocument(): UiPersistentPreferencesDocument {
    return cloneDocument(this.document)
  }

  /** Return resolved state for an optional feature/monitor/app scope. */
  getState(scope: UiPreferenceScope = {}): UiFoundationState {
    const resolved = this.resolvePreferences(scope)
    return {
      revision: this.revision,
      resolved,
      tokens: resolveDesignTokens(resolved),
      ...(this.preview !== undefined ? { preview: { ...this.preview } } : {}),
    }
  }

  /** Resolve desired and applied preferences using Phase 16B precedence. */
  resolvePreferences(scope: UiPreferenceScope = {}): UiResolvedPreferences {
    const degradedReasons: string[] = []
    const scopeFallbacks: string[] = []
    let desired = clonePreferences(DEFAULT_UI_PREFERENCES)

    if (this.document.selectedPresetId !== null) {
      const preset = this.presets.get(this.document.selectedPresetId)
      if (preset) desired = applyUiPreferencePatch(desired, preset.preferences)
      else degradedReasons.push(`preset-unavailable:${this.document.selectedPresetId}`)
    }

    desired = applyUiPreferencePatch(desired, this.document.userOverrides)
    if (scope.featureId !== undefined) desired = applyScopePatch(desired, this.document.featureOverrides, scope.featureId)
    if (scope.monitorId !== undefined) desired = applyScopePatch(desired, this.document.monitorOverrides, scope.monitorId)
    if (scope.appId !== undefined) desired = applyScopePatch(desired, this.document.appOverrides, scope.appId)
    if (scope.spaceId !== undefined) scopeFallbacks.push('space-scope-unavailable-until-phase-18')
    if (this.preview !== undefined) desired = applyUiPreferencePatch(desired, this.preview.patch)
    desired = {
      ...desired,
      accessibility: {
        ...desired.accessibility,
        ...this.document.accessibilityOverrides,
      },
    }

    let resolvedColorScheme: UiResolvedPreferences['resolvedColorScheme']
    if (desired.accessibility.highContrast || this.systemAppearance?.highContrast === true) {
      resolvedColorScheme = 'high-contrast'
    } else if (desired.appearance.colorScheme === 'system') {
      if (this.systemAppearance === undefined) {
        resolvedColorScheme = 'dark'
        degradedReasons.push('system-color-scheme-unavailable')
      } else {
        resolvedColorScheme = this.systemAppearance.colorScheme
      }
    } else {
      resolvedColorScheme = desired.appearance.colorScheme
    }

    const systemReduceMotion = this.systemAppearance?.reduceMotion === true
    const materialUnavailable = !this.capabilities.transparency || !this.capabilities.backdropMaterial
    const animationsUnavailable = !this.capabilities.animations
    if (materialUnavailable && desired.appearance.material !== 'opaque') degradedReasons.push('transparency-capability-unavailable')
    if (animationsUnavailable && desired.appearance.motionIntensity > 0) degradedReasons.push('animation-capability-unavailable')

    const applied: UiPreferences = {
      appearance: {
        ...desired.appearance,
        material: desired.accessibility.reduceTransparency || materialUnavailable
          ? 'opaque'
          : desired.appearance.material === 'auto'
            ? 'translucent'
            : desired.appearance.material,
        motionIntensity: desired.accessibility.reduceMotion || systemReduceMotion || animationsUnavailable
          ? 0
          : desired.appearance.motionIntensity,
      },
      accessibility: {
        ...desired.accessibility,
        highContrast: resolvedColorScheme === 'high-contrast',
        reduceMotion: desired.accessibility.reduceMotion || systemReduceMotion || animationsUnavailable,
        reduceTransparency: desired.accessibility.reduceTransparency || materialUnavailable,
      },
    }

    return {
      desired,
      applied,
      resolvedColorScheme,
      degradedReasons: Object.freeze(degradedReasons),
      scopeFallbacks: Object.freeze(scopeFallbacks),
    }
  }

  /** Register a selectable preset. Disposal removes only that preset registration. */
  registerPreset(preset: UiPreferencePreset): () => void {
    if (!preset.id.trim()) throw new TypeError('Preset id must be non-empty.')
    if (!preset.title.trim()) throw new TypeError('Preset title must be non-empty.')
    if (this.presets.has(preset.id)) throw new Error(`UI preset ${JSON.stringify(preset.id)} is already registered.`)
    this.presets.set(preset.id, {
      id: preset.id,
      title: preset.title,
      preferences: clonePatch(preset.preferences),
    })
    return () => {
      if (this.presets.delete(preset.id) && this.document.selectedPresetId === preset.id) {
        void this.publish('preset')
      }
    }
  }

  /** List registered preference presets. */
  listPresets(): readonly UiPreferencePreset[] {
    return Array.from(this.presets.values()).map(preset => ({ ...preset, preferences: clonePatch(preset.preferences) }))
  }

  /** Select a registered preset or clear preset selection. */
  async selectPreset(id: string | null): Promise<void> {
    if (id !== null && !this.presets.has(id)) throw new Error(`Unknown UI preset ${JSON.stringify(id)}.`)
    await this.commitDocument({ ...this.document, selectedPresetId: id, updatedAt: Date.now() }, 'preset')
  }

  /** Update global user preferences. */
  async setUserPreferences(patch: UiPreferencePatch): Promise<void> {
    await this.commitDocument({
      ...this.document,
      userOverrides: mergeUiPreferencePatches(this.document.userOverrides, patch),
      updatedAt: Date.now(),
    }, 'preferences')
  }

  /** Set feature, monitor, or app-specific preferences. */
  async setScopedPreferences(kind: 'feature' | 'monitor' | 'app', id: string, patch: UiPreferencePatch): Promise<void> {
    if (!id.trim()) throw new TypeError('Scoped preference id must be non-empty.')
    const field = kind === 'feature' ? 'featureOverrides' : kind === 'monitor' ? 'monitorOverrides' : 'appOverrides'
    const current = this.document[field]
    const next = {
      ...current,
      [id]: mergeUiPreferencePatches(current[id] ?? {}, patch),
    }
    await this.commitDocument({ ...this.document, [field]: next, updatedAt: Date.now() }, 'scoped-preferences')
  }

  /** Apply accessibility overrides after every decorative preference layer. */
  async setAccessibilityOverrides(patch: Partial<UiAccessibilityPreferences>): Promise<void> {
    await this.commitDocument({
      ...this.document,
      accessibilityOverrides: { ...this.document.accessibilityOverrides, ...patch },
      updatedAt: Date.now(),
    }, 'accessibility')
  }

  /** Begin a non-persistent risky appearance preview with automatic revert. */
  beginPreview(patch: UiPreferencePatch, options: { readonly ownerId: string; readonly timeoutMs?: number }): UiPreferencePreviewHandle {
    if (!options.ownerId.trim()) throw new TypeError('Preview ownerId must be non-empty.')
    const timeoutMs = options.timeoutMs ?? this.config.previewTimeoutMs
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('Preview timeout must be positive.')
    this.clearPreviewTimer()
    const now = Date.now()
    const preview: UiPreferencePreview = {
      id: `ui-preview-${now}-${Math.random().toString(36).slice(2, 9)}`,
      ownerId: options.ownerId,
      patch: clonePatch(patch),
      startedAt: now,
      deadline: now + timeoutMs,
    }
    this.preview = preview
    this.previewTimer = setTimeout(() => {
      this.revertPreview(preview.id)
    }, timeoutMs)
    void this.publish('preview-started')
    return {
      id: preview.id,
      ownerId: preview.ownerId,
      deadline: preview.deadline,
      keep: () => this.keepPreview(preview.id),
      revert: () => this.revertPreview(preview.id),
    }
  }

  /** Commit an active preview into durable global user overrides. */
  async keepPreview(id: string): Promise<boolean> {
    const preview = this.preview
    if (!preview || preview.id !== id) return false
    const nextDocument: UiPersistentPreferencesDocument = {
      ...this.document,
      userOverrides: mergeUiPreferencePatches(this.document.userOverrides, preview.patch),
      updatedAt: Date.now(),
    }
    await this.persistence.save(nextDocument)
    this.document = nextDocument
    this.clearPreviewTimer()
    this.preview = undefined
    await this.publish('preview-kept')
    return true
  }

  /** Revert an active preview without touching durable preferences. */
  revertPreview(id: string): boolean {
    if (!this.preview || this.preview.id !== id) return false
    this.clearPreviewTimer()
    this.preview = undefined
    void this.publish('preview-reverted')
    return true
  }

  /** Auto-revert previews when their owning editor/plugin goes away. */
  releasePreviewOwner(ownerId: string): boolean {
    if (!this.preview || this.preview.ownerId !== ownerId) return false
    return this.revertPreview(this.preview.id)
  }

  /** Auto-revert if the Keep/Revert confirmation is no longer visible. */
  reportPreviewConfirmationVisible(id: string, visible: boolean): boolean {
    if (visible) return this.preview?.id === id
    return this.revertPreview(id)
  }

  /** Report current renderer/Windows appearance facts. */
  reportSystemAppearance(appearance: UiSystemAppearance): void {
    if (
      this.systemAppearance?.colorScheme === appearance.colorScheme &&
      this.systemAppearance.highContrast === appearance.highContrast &&
      this.systemAppearance.reduceMotion === appearance.reduceMotion
    ) return
    this.systemAppearance = { ...appearance }
    void this.publish('system-appearance')
  }

  /** Report runtime rendering capabilities without modifying desired preferences. */
  reportCapabilities(capabilities: Partial<UiRuntimeCapabilities>): void {
    this.capabilities = { ...this.capabilities, ...capabilities }
    void this.publish('capabilities')
  }

  /** Export only whitelisted preference state; runtime/window/process data is excluded. */
  exportPreferences(): string {
    return `${JSON.stringify(this.document, null, 2)}\n`
  }

  /** Strictly validate and atomically import a preference document. */
  async importPreferences(serialized: string): Promise<void> {
    const parsed: unknown = JSON.parse(serialized)
    const document = parseUiPersistentDocument(parsed)
    await this.commitDocument({ ...document, updatedAt: Date.now() }, 'imported')
  }

  /** Selectively reset preference state without affecting unrelated shell data. */
  async reset(kind: 'user' | 'feature' | 'monitor' | 'app' | 'accessibility' | 'all', id?: string): Promise<void> {
    let next = cloneDocument(this.document)
    if (kind === 'all') {
      next = createDefaultUiPersistentDocument()
    } else if (kind === 'user') {
      next = { ...next, userOverrides: {}, selectedPresetId: null, updatedAt: Date.now() }
    } else if (kind === 'accessibility') {
      next = { ...next, accessibilityOverrides: {}, updatedAt: Date.now() }
    } else {
      if (!id?.trim()) throw new TypeError(`${kind} reset requires a scope id.`)
      const field = kind === 'feature' ? 'featureOverrides' : kind === 'monitor' ? 'monitorOverrides' : 'appOverrides'
      const values = Object.fromEntries(Object.entries(next[field]).filter(([scopeId]) => scopeId !== id))
      next = { ...next, [field]: values, updatedAt: Date.now() }
    }
    await this.commitDocument(next, 'reset')
  }

  private registerBuiltInPresets(): void {
    this.presets.set('compact', {
      id: 'compact',
      title: 'Compact',
      preferences: { appearance: { density: 'compact' } },
    })
    this.presets.set('comfortable', {
      id: 'comfortable',
      title: 'Comfortable',
      preferences: { appearance: { density: 'comfortable' } },
    })
    this.presets.set('calm', {
      id: 'calm',
      title: 'Calm',
      preferences: { appearance: { motionIntensity: 0.45 }, accessibility: { reduceTransparency: true } },
    })
  }

  private async commitDocument(document: UiPersistentPreferencesDocument, reason: UiFoundationChangeEvent['reason']): Promise<void> {
    if (this.disposed) throw new Error('UiFoundationService is disposed.')
    await this.persistence.save(document)
    this.document = cloneDocument(document)
    await this.publish(reason)
  }

  private async publish(reason: UiFoundationChangeEvent['reason']): Promise<void> {
    if (this.disposed) return
    this.revision += 1
    const state = this.getState()
    this.applyCurrentStateToHome(state)
    await this.broadcastState(state)
    this.emitChange(reason, state)
  }

  private emitChange(reason: UiFoundationChangeEvent['reason'], state: UiFoundationState): void {
    const event: UiFoundationChangeEvent = { reason, state }
    for (const listener of this.listeners) listener(event)
    this.ctx.emit('ui-foundation/change', event)
  }

  private get surfaceService(): SurfaceService | undefined {
    return this.ctx.get('surface')
  }

  private applyCurrentStateToHome(state = this.getState()): void {
    const candidate = this.ctx.get('home') as unknown
    if (!candidate || typeof candidate !== 'object') return
    const home = candidate as Partial<HomeThemeConsumerRef>
    if (typeof home.setThemeTokens === 'function') {
      home.setThemeTokens({ ...state.tokens })
    }
  }

  private async broadcastState(state: UiFoundationState): Promise<void> {
    const surface = this.surfaceService
    if (!surface) return
    const message = createUiFoundationStateMessage(state)
    await Promise.allSettled(surface.list().map(instance => instance.postMessage(message)))
  }

  private async publishToSurface(surface: SurfaceInstance): Promise<void> {
    await surface.postMessage(createUiFoundationStateMessage(this.getState())).catch(() => false)
  }

  private handleSurfaceMessage(message: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(message)
    } catch {
      return
    }
    if (!parsed || typeof parsed !== 'object') return
    const candidate = parsed as Record<string, unknown>
    if (candidate.type !== 'elix/ui-foundation/system-appearance') return
    if (candidate.colorScheme !== 'light' && candidate.colorScheme !== 'dark') return
    if (typeof candidate.highContrast !== 'boolean' || typeof candidate.reduceMotion !== 'boolean') return
    this.reportSystemAppearance({
      colorScheme: candidate.colorScheme,
      highContrast: candidate.highContrast,
      reduceMotion: candidate.reduceMotion,
    })
  }

  private clearPreviewTimer(): void {
    if (this.previewTimer !== undefined) {
      clearTimeout(this.previewTimer)
      this.previewTimer = undefined
    }
  }
}

function applyScopePatch(
  preferences: UiPreferences,
  values: Readonly<Record<string, UiPreferencePatch>>,
  id: string,
): UiPreferences {
  const patch = values[id]
  return patch === undefined ? preferences : applyUiPreferencePatch(preferences, patch)
}

function clonePreferences(preferences: UiPreferences): UiPreferences {
  return {
    appearance: { ...preferences.appearance },
    accessibility: { ...preferences.accessibility },
  }
}

function clonePatch(patch: UiPreferencePatch): UiPreferencePatch {
  return {
    ...(patch.appearance !== undefined ? { appearance: { ...patch.appearance } } : {}),
    ...(patch.accessibility !== undefined ? { accessibility: { ...patch.accessibility } } : {}),
  }
}

function clonePatchMap(values: Readonly<Record<string, UiPreferencePatch>>): Readonly<Record<string, UiPreferencePatch>> {
  return Object.fromEntries(Object.entries(values).map(([id, patch]) => [id, clonePatch(patch)]))
}

function cloneDocument(document: UiPersistentPreferencesDocument): UiPersistentPreferencesDocument {
  return {
    schemaVersion: 1,
    selectedPresetId: document.selectedPresetId,
    userOverrides: clonePatch(document.userOverrides),
    featureOverrides: clonePatchMap(document.featureOverrides),
    monitorOverrides: clonePatchMap(document.monitorOverrides),
    appOverrides: clonePatchMap(document.appOverrides),
    accessibilityOverrides: { ...document.accessibilityOverrides },
    updatedAt: document.updatedAt,
  }
}

export default UiFoundationService
