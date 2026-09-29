import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import HomeService from '../src/index.ts'
import {
  DEFAULT_HOME_PERSONALIZATION_PRESETS,
  HomePersonalizationCoordinator,
  MIN_APPEARANCE_PREVIEW_TIMEOUT_MS,
} from '../src/personalization.ts'
import {
  WallpaperManager,
  validateWallpaperMediaSource,
} from '../src/wallpaper.ts'
import type { UiFoundationPersonalizationRef } from '../src/personalization.ts'
import type { MonitorInfo } from '../src/monitor.ts'

const MONITOR_A: MonitorInfo = {
  id: 'monitor-a',
  name: 'Display A',
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
  scaleFactor: 1,
  isPrimary: true,
}

const MONITOR_B: MonitorInfo = {
  id: 'monitor-b',
  name: 'Display B',
  bounds: { x: 1920, y: 0, width: 2560, height: 1440 },
  workArea: { x: 1920, y: 0, width: 2560, height: 1400 },
  scaleFactor: 1.25,
  isPrimary: false,
}

afterEach(() => {
  vi.useRealTimers()
})

describe('Home Phase 16C personalization', () => {
  it('keeps per-monitor wallpaper selection isolated from the global default', () => {
    const wallpaper = new WallpaperManager()

    expect(wallpaper.setActiveWallpaper('aurora-forest', MONITOR_B.id)).toBe(true)
    expect(wallpaper.getActiveWallpaper().id).toBe('elix-orange')
    expect(wallpaper.getActiveWallpaper(MONITOR_A.id).id).toBe('elix-orange')
    expect(wallpaper.getActiveWallpaper(MONITOR_B.id).id).toBe('aurora-forest')

    expect(wallpaper.resetMonitorOverride(MONITOR_B.id)).toBe(true)
    expect(wallpaper.getActiveWallpaper(MONITOR_B.id).id).toBe('elix-orange')
  })

  it('validates imported local wallpaper media and rejects remote or unsupported sources', () => {
    expect(validateWallpaperMediaSource('C:\\Users\\Anoop\\Pictures\\wallpaper.webp', 'image'))
      .toContain('wallpaper.webp')
    expect(validateWallpaperMediaSource('/home/user/Videos/wallpaper.webm', 'video'))
      .toContain('wallpaper.webm')
    expect(() => validateWallpaperMediaSource('https://example.com/wallpaper.jpg', 'image'))
      .toThrow('absolute local file path or file URL')
    expect(() => validateWallpaperMediaSource('C:\\Pictures\\wallpaper.svg', 'image'))
      .toThrow('Unsupported image wallpaper file type.')
  })

  it('previews monitor wallpaper without mutating durable preferences', () => {
    const wallpaper = new WallpaperManager()
    const publish = vi.fn()
    const coordinator = new HomePersonalizationCoordinator(wallpaper, {
      getUiFoundation: () => undefined,
      publish,
    })

    const before = wallpaper.getPreferences()
    const preview = coordinator.beginPreview(
      { wallpaper: { activeId: 'violet-circuit', dim: 20 } },
      { ownerId: 'settings', monitorId: MONITOR_B.id, timeoutMs: 10_000 },
    )

    expect(preview.deadline).toBeUndefined()
    expect(coordinator.getActiveWallpaper(MONITOR_A.id).id).toBe('elix-orange')
    expect(coordinator.getActiveWallpaper(MONITOR_B.id).id).toBe('violet-circuit')
    expect(coordinator.getDisplayPreferences(MONITOR_B.id).dim).toBe(20)
    expect(wallpaper.getPreferences()).toEqual(before)
    expect(publish).toHaveBeenCalled()

    expect(preview.revert()).toBe(true)
    expect(coordinator.getActiveWallpaper(MONITOR_B.id).id).toBe('elix-orange')
    expect(wallpaper.getPreferences()).toEqual(before)
  })

  it('keeps wallpaper identity and all effects consistent while one preview is edited', async () => {
    const wallpaper = new WallpaperManager()
    const coordinator = new HomePersonalizationCoordinator(wallpaper, {
      getUiFoundation: () => undefined,
      publish: vi.fn(),
    })
    const durableBefore = wallpaper.getPreferences()
    const preview = coordinator.beginPreview(
      { wallpaper: { activeId: 'aurora-forest' } },
      { ownerId: 'settings', monitorId: MONITOR_B.id, timeoutMs: 10_000 },
    )

    expect(preview.deadline).toBeUndefined()
    expect(preview.updateWallpaper({ fit: 'contain' })).toBe(true)
    expect(preview.updateWallpaper({ dim: 20 })).toBe(true)
    expect(preview.updateWallpaper({ blur: 8 })).toBe(true)
    expect(preview.updateWallpaper({ saturation: 125 })).toBe(true)

    expect(coordinator.getActiveWallpaper(MONITOR_B.id).id).toBe('aurora-forest')
    expect(coordinator.getDisplayPreferences(MONITOR_B.id)).toMatchObject({
      activeId: 'aurora-forest',
      fit: 'contain',
      dim: 20,
      blur: 8,
      saturation: 125,
    })
    expect(coordinator.getPreview()?.deadline).toBeUndefined()
    expect(wallpaper.getPreferences()).toEqual(durableBefore)

    await expect(preview.keep()).resolves.toBe(true)
    expect(wallpaper.getActiveWallpaper(MONITOR_B.id).id).toBe('aurora-forest')
    expect(wallpaper.getDisplayPreferences(MONITOR_B.id)).toMatchObject({
      fit: 'contain',
      dim: 20,
      blur: 8,
      saturation: 125,
    })
    expect(preview.updateWallpaper({ dim: 40 })).toBe(false)
  })

  it('never auto-reverts a wallpaper-only preview', async () => {
    vi.useFakeTimers()
    const wallpaper = new WallpaperManager()
    const coordinator = new HomePersonalizationCoordinator(wallpaper, {
      getUiFoundation: () => undefined,
      publish: vi.fn(),
      previewTimeoutMs: 500,
    })

    const preview = coordinator.beginPreview(
      { wallpaper: { activeId: 'aurora-forest' } },
      { ownerId: 'settings', timeoutMs: 500 },
    )
    expect(preview.deadline).toBeUndefined()
    expect(coordinator.getActiveWallpaper().id).toBe('aurora-forest')

    await vi.advanceTimersByTimeAsync(10 * 60_000)

    expect(coordinator.getPreview()?.id).toBe(preview.id)
    expect(coordinator.getActiveWallpaper().id).toBe('aurora-forest')
    expect(wallpaper.getActiveWallpaper().id).toBe('elix-orange')
    expect(preview.revert()).toBe(true)
  })

  it('keeps a monitor preview by committing only that monitor override', async () => {
    const wallpaper = new WallpaperManager()
    const coordinator = new HomePersonalizationCoordinator(wallpaper, {
      getUiFoundation: () => undefined,
      publish: vi.fn(),
    })

    const preview = coordinator.beginPreview(
      { wallpaper: { activeId: 'ember-night', fit: 'contain', dim: 14 } },
      { ownerId: 'settings', monitorId: MONITOR_B.id },
    )

    await expect(preview.keep()).resolves.toBe(true)
    expect(coordinator.getPreview()).toBeUndefined()
    expect(wallpaper.getActiveWallpaper()).toMatchObject({ id: 'elix-orange' })
    expect(wallpaper.getActiveWallpaper(MONITOR_B.id)).toMatchObject({ id: 'ember-night' })
    expect(wallpaper.getDisplayPreferences(MONITOR_B.id)).toMatchObject({ fit: 'contain', dim: 14 })
  })

  it('coordinates appearance preview with at least a 60 second safety window', () => {
    const wallpaper = new WallpaperManager()
    const uiRevert = vi.fn(() => true)
    const uiKeep = vi.fn(async () => true)
    const uiBeginPreview = vi.fn((
      _patch: Parameters<UiFoundationPersonalizationRef['beginPreview']>[0],
      options: Parameters<UiFoundationPersonalizationRef['beginPreview']>[1],
    ) => ({
      id: 'ui-preview',
      ownerId: options.ownerId,
      deadline: Date.now() + (options.timeoutMs ?? 0),
      keep: uiKeep,
      revert: uiRevert,
    }))
    const ui: UiFoundationPersonalizationRef = {
      beginPreview: uiBeginPreview,
      reset: vi.fn(async () => undefined),
    }
    const coordinator = new HomePersonalizationCoordinator(wallpaper, {
      getUiFoundation: () => ui,
      publish: vi.fn(),
      previewTimeoutMs: 1_000,
    })

    const startedAt = Date.now()
    const preview = coordinator.beginPreview(
      {
        wallpaper: { activeId: 'aurora-forest' },
        appearance: { appearance: { colorScheme: 'dark', accentColor: '#38bdf8' } },
      },
      { ownerId: 'settings', timeoutMs: 10_000 },
    )

    expect(uiBeginPreview).toHaveBeenCalledWith(
      expect.anything(),
      { ownerId: 'settings', timeoutMs: MIN_APPEARANCE_PREVIEW_TIMEOUT_MS },
    )
    expect(preview.deadline).toBeGreaterThanOrEqual(startedAt + MIN_APPEARANCE_PREVIEW_TIMEOUT_MS)
    expect(coordinator.releasePreviewOwner('settings')).toBe(true)
    expect(uiRevert).toHaveBeenCalledOnce()
    expect(wallpaper.getActiveWallpaper().id).toBe('elix-orange')
  })

  it('ships valid coordinated personalization presets', () => {
    const wallpaper = new WallpaperManager()
    const coordinator = new HomePersonalizationCoordinator(wallpaper, {
      getUiFoundation: () => undefined,
      publish: vi.fn(),
    })

    expect(coordinator.listPresets().map(preset => preset.id))
      .toEqual(DEFAULT_HOME_PERSONALIZATION_PRESETS.map(preset => preset.id))
    expect(coordinator.getPreset('elix-ember')).toMatchObject({
      title: 'ELIX Ember',
      wallpaper: { activeId: 'elix-orange' },
    })
  })

  it('projects per-monitor and transient wallpaper state into real Home snapshots', () => {
    const home = new HomeService(new Context(), {
      enabled: false,
      initialMonitors: [MONITOR_A, MONITOR_B],
    })

    home.wallpaper.setActiveWallpaper('aurora-forest', MONITOR_B.id)
    expect(home.getRendererSnapshot(MONITOR_A.id).wallpaper.source).toContain('#ff6b35')
    expect(home.getRendererSnapshot(MONITOR_B.id).wallpaper.source).toContain('#0b3c5d')

    const durableBefore = home.buildPersistentSnapshot().wallpaper
    const preview = home.personalization.beginPreview(
      { wallpaper: { activeId: 'violet-circuit', dim: 22 } },
      { ownerId: 'settings', monitorId: MONITOR_A.id, timeoutMs: 10_000 },
    )

    expect(preview.deadline).toBeUndefined()
    expect(home.getRendererSnapshot(MONITOR_A.id).wallpaper.source).toContain('#4a154b')
    expect(home.getRendererSnapshot(MONITOR_A.id).wallpaper.dim).toBe(22)
    expect(home.getRendererSnapshot(MONITOR_B.id).wallpaper.source).toContain('#0b3c5d')
    expect(home.buildPersistentSnapshot().wallpaper).toEqual(durableBefore)

    preview.revert()
    home.personalization.dispose()
  })

  it('reverts a monitor-scoped preview when that monitor disappears', () => {
    const wallpaper = new WallpaperManager()
    const coordinator = new HomePersonalizationCoordinator(wallpaper, {
      getUiFoundation: () => undefined,
      publish: vi.fn(),
    })
    coordinator.beginPreview(
      { wallpaper: { activeId: 'aurora-forest' } },
      { ownerId: 'settings', monitorId: MONITOR_B.id },
    )

    expect(coordinator.handleMonitorRemoved(MONITOR_A.id)).toBe(false)
    expect(coordinator.handleMonitorRemoved(MONITOR_B.id)).toBe(true)
    expect(coordinator.getPreview()).toBeUndefined()
  })
})
