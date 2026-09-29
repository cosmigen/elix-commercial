import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import UiFoundationService from '../src/index.ts'

describe('UI Foundation - service authority', () => {
  const roots: string[] = []
  const contexts: Context[] = []

  afterEach(async () => {
    vi.useRealTimers()
    await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  })

  async function createService(previewTimeoutMs = 15_000): Promise<UiFoundationService> {
    const root = await mkdtemp(join(tmpdir(), 'elix-ui-service-'))
    roots.push(root)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(UiFoundationService, {
      enabled: true,
      persistencePath: join(root, 'prefs.json'),
      previewTimeoutMs,
    })
    return ctx.uiFoundation
  }

  it('applies defaults then preset, user, feature, monitor, app, and accessibility precedence', async () => {
    const service = await createService()
    await service.selectPreset('compact')
    await service.setUserPreferences({ appearance: { accentColor: '#112233' } })
    await service.setScopedPreferences('feature', 'home', { appearance: { density: 'comfortable' } })
    await service.setScopedPreferences('monitor', 'monitor-1', { appearance: { motionIntensity: 0.4 } })
    await service.setScopedPreferences('app', 'app-1', { appearance: { colorScheme: 'light' } })
    await service.setAccessibilityOverrides({ textScale: 1.8, reduceMotion: true })

    const resolved = service.resolvePreferences({
      featureId: 'home',
      monitorId: 'monitor-1',
      appId: 'app-1',
    })

    expect(resolved.desired.appearance.density).toBe('comfortable')
    expect(resolved.desired.appearance.accentColor).toBe('#112233')
    expect(resolved.desired.appearance.motionIntensity).toBe(0.4)
    expect(resolved.resolvedColorScheme).toBe('light')
    expect(resolved.applied.accessibility.textScale).toBe(1.8)
    expect(resolved.applied.accessibility.reduceMotion).toBe(true)
    expect(resolved.applied.appearance.motionIntensity).toBe(0)
  })

  it('keeps desired preferences separate from unsupported runtime capability fallbacks', async () => {
    const service = await createService()
    await service.setUserPreferences({
      appearance: { material: 'translucent', motionIntensity: 0.8 },
    })
    service.reportCapabilities({ transparency: false, backdropMaterial: false, animations: false })

    const resolved = service.resolvePreferences()
    expect(resolved.desired.appearance.material).toBe('translucent')
    expect(resolved.desired.appearance.motionIntensity).toBe(0.8)
    expect(resolved.applied.appearance.material).toBe('opaque')
    expect(resolved.applied.appearance.motionIntensity).toBe(0)
    expect(resolved.degradedReasons).toContain('transparency-capability-unavailable')
    expect(resolved.degradedReasons).toContain('animation-capability-unavailable')
  })

  it('reports an explicit fallback instead of persisting unstable Space identity', async () => {
    const service = await createService()
    expect(service.resolvePreferences({ spaceId: 'desktop-private-guid' }).scopeFallbacks)
      .toContain('space-scope-unavailable-until-phase-18')
    expect(service.exportPreferences()).not.toContain('desktop-private-guid')
  })

  it('previews without writing, commits on Keep, and reverts when the owner disappears', async () => {
    const service = await createService()
    const before = service.exportPreferences()
    const preview = service.beginPreview({ appearance: { colorScheme: 'light' } }, { ownerId: 'settings' })

    expect(service.resolvePreferences().resolvedColorScheme).toBe('light')
    expect(service.exportPreferences()).toBe(before)
    expect(await preview.keep()).toBe(true)
    expect(service.getPersistentDocument().userOverrides.appearance?.colorScheme).toBe('light')

    const second = service.beginPreview({ appearance: { colorScheme: 'dark' } }, { ownerId: 'settings' })
    expect(service.resolvePreferences().resolvedColorScheme).toBe('dark')
    expect(service.releasePreviewOwner('settings')).toBe(true)
    expect(second.revert()).toBe(false)
    expect(service.resolvePreferences().resolvedColorScheme).toBe('light')
  })

  it('automatically reverts an expired risky preview', async () => {
    const service = await createService(100)
    service.reportSystemAppearance({ colorScheme: 'dark', highContrast: false, reduceMotion: false })
    vi.useFakeTimers()
    service.beginPreview({ appearance: { colorScheme: 'light' } }, { ownerId: 'settings', timeoutMs: 100 })
    expect(service.resolvePreferences().resolvedColorScheme).toBe('light')

    await vi.advanceTimersByTimeAsync(101)
    expect(service.resolvePreferences().resolvedColorScheme).toBe('dark')
  })

  it('forces accessibility variants after decorative preferences', async () => {
    const service = await createService()
    await service.setUserPreferences({ appearance: { colorScheme: 'light', material: 'translucent' } })
    await service.setAccessibilityOverrides({ highContrast: true, reduceTransparency: true, textScale: 2 })

    const state = service.getState()
    expect(state.resolved.resolvedColorScheme).toBe('high-contrast')
    expect(state.resolved.applied.appearance.material).toBe('opaque')
    expect(state.tokens['--elix-text-scale']).toBe('2')
    expect(state.tokens['--elix-surface-background']).toBe('#000000')
  })
})
