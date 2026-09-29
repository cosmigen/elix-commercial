import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_WALLPAPER_PREFERENCES,
  DEFAULT_WALLPAPERS,
  WallpaperManager,
  computeWallpaperCssVariables,
  validateWallpaperItem,
} from '../src/wallpaper.ts'
import type { WallpaperItem, WallpaperPreferences } from '../src/wallpaper.ts'

describe('Wallpaper Module', () => {
  describe('validateWallpaperItem', () => {
    it('accepts valid wallpaper items of all supported kinds', () => {
      const gradient: WallpaperItem = {
        id: 'grad-1',
        name: 'Gradient Wallpaper',
        kind: 'gradient',
        source: 'linear-gradient(180deg, #111 0%, #222 100%)',
      }
      expect(validateWallpaperItem(gradient)).toEqual(gradient)

      const color: WallpaperItem = {
        id: 'color-1',
        name: 'Dark Color',
        kind: 'color',
        source: '#1a1a1a',
      }
      expect(validateWallpaperItem(color)).toEqual(color)

      const image: WallpaperItem = {
        id: 'img-1',
        name: 'Scenic View',
        kind: 'image',
        source: 'C:\\Users\\User\\Pictures\\wallpaper.jpg',
      }
      expect(validateWallpaperItem(image)).toEqual(image)

      const video: WallpaperItem = {
        id: 'vid-1',
        name: 'Loop Video',
        kind: 'video',
        source: '/home/user/videos/loop.mp4',
      }
      expect(validateWallpaperItem(video)).toEqual(video)

      const live: WallpaperItem = {
        id: 'live-1',
        name: 'Quiet Orbit Live',
        kind: 'live',
        source: 'quiet-orbit',
      }
      expect(validateWallpaperItem(live)).toEqual(live)
    })

    it('rejects unsupported kinds', () => {
      expect(() =>
        validateWallpaperItem({
          id: 'bad-kind',
          name: 'Bad',
          kind: 'svg' as unknown as WallpaperItem['kind'],
          source: '<svg></svg>',
        }),
      ).toThrow("Unsupported wallpaper kind 'svg'.")
    })

    it('rejects empty or excessively long identifiers and names', () => {
      expect(() =>
        validateWallpaperItem({
          id: '',
          name: 'Valid Name',
          kind: 'color',
          source: '#000',
        }),
      ).toThrow('Wallpaper id and name must contain between 1 and 128 characters.')

      expect(() =>
        validateWallpaperItem({
          id: 'valid-id',
          name: 'a'.repeat(129),
          kind: 'color',
          source: '#000',
        }),
      ).toThrow('Wallpaper id and name must contain between 1 and 128 characters.')
    })

    it('rejects invalid gradient and color sources', () => {
      expect(() =>
        validateWallpaperItem({
          id: 'bad-grad',
          name: 'Bad Gradient',
          kind: 'gradient',
          source: 'not-a-gradient',
        }),
      ).toThrow('Gradient wallpaper source must be one linear-gradient() or radial-gradient() value.')

      expect(() =>
        validateWallpaperItem({
          id: 'bad-color',
          name: 'Bad Color',
          kind: 'color',
          source: 'invalid-color-value',
        }),
      ).toThrow('Color wallpaper source must be a hexadecimal, rgb(), rgba(), hsl(), or hsla() value.')
    })

    it('rejects forbidden characters in media source paths', () => {
      expect(() =>
        validateWallpaperItem({
          id: 'bad-chars',
          name: 'XSS Attempt',
          kind: 'image',
          source: 'image.png" onclick="alert(1)',
        }),
      ).toThrow('image wallpaper source contains forbidden characters.')

      expect(() =>
        validateWallpaperItem({
          id: 'bad-tag',
          name: 'Tag Injection',
          kind: 'video',
          source: 'video.mp4<script>',
        }),
      ).toThrow('video wallpaper source contains forbidden characters.')

      expect(() =>
        validateWallpaperItem({
          id: 'null-byte',
          name: 'Null Byte',
          kind: 'image',
          source: 'image.png\x00.jpg',
        }),
      ).toThrow('image wallpaper source contains forbidden characters.')
    })

    it('rejects untrusted live wallpaper scenes', () => {
      expect(() =>
        validateWallpaperItem({
          id: 'fake-live',
          name: 'Fake Live',
          kind: 'live',
          source: 'untrusted-scene',
        }),
      ).toThrow("Unknown trusted live wallpaper scene 'untrusted-scene'.")
    })
  })

  describe('computeWallpaperCssVariables', () => {
    it('normalizes backslashes and quotes in image wallpaper sources', () => {
      const prefs: WallpaperPreferences = {
        activeId: 'custom-img',
        items: [
          {
            id: 'custom-img',
            name: 'Windows Path Wallpaper',
            kind: 'image',
            source: 'C:\\Users\\anoop\\Pictures\\wall.png',
          },
        ],
        fit: 'cover',
        blur: 10,
        saturation: 120,
        dim: 25,
      }

      const cssVars = computeWallpaperCssVariables(prefs)
      expect(cssVars['--home-wallpaper']).toBe('url("C:/Users/anoop/Pictures/wall.png")')
      expect(cssVars['--home-wallpaper-size']).toBe('cover')
      expect(cssVars['--home-wallpaper-repeat']).toBe('no-repeat')
      expect(cssVars['--home-wallpaper-blur']).toBe('10px')
      expect(cssVars['--home-wallpaper-saturation']).toBe('120%')
      expect(cssVars['--home-wallpaper-dim']).toBe('0.25')
    })

    it('handles different fit modes correctly', () => {
      const basePrefs: WallpaperPreferences = {
        ...DEFAULT_WALLPAPER_PREFERENCES,
        fit: 'stretch',
      }
      expect(computeWallpaperCssVariables(basePrefs)['--home-wallpaper-size']).toBe('100% 100%')

      const tilePrefs: WallpaperPreferences = {
        ...DEFAULT_WALLPAPER_PREFERENCES,
        fit: 'tile',
      }
      const tileVars = computeWallpaperCssVariables(tilePrefs)
      expect(tileVars['--home-wallpaper-size']).toBe('auto')
      expect(tileVars['--home-wallpaper-repeat']).toBe('repeat')
    })

    it('clamps blur, saturation, and dim values', () => {
      const extremePrefs: WallpaperPreferences = {
        ...DEFAULT_WALLPAPER_PREFERENCES,
        blur: 999,
        saturation: 500,
        dim: 200,
      }
      const vars = computeWallpaperCssVariables(extremePrefs)
      expect(vars['--home-wallpaper-blur']).toBe('50px')
      expect(vars['--home-wallpaper-saturation']).toBe('200%')
      expect(vars['--home-wallpaper-dim']).toBe('1')
    })
  })

  describe('WallpaperManager', () => {
    it('initializes with default preferences when none provided', () => {
      const manager = new WallpaperManager()
      const prefs = manager.getPreferences()
      expect(prefs.activeId).toBe(DEFAULT_WALLPAPER_PREFERENCES.activeId)
      expect(prefs.items.length).toBe(DEFAULT_WALLPAPERS.length)
      expect(manager.getActiveWallpaper().id).toBe(DEFAULT_WALLPAPER_PREFERENCES.activeId)
    })

    it('allows setting active wallpaper by ID', () => {
      const manager = new WallpaperManager()
      const changed = manager.setActiveWallpaper('aurora-forest')
      expect(changed).toBe(true)
      expect(manager.getActiveWallpaper().id).toBe('aurora-forest')

      const nonExistent = manager.setActiveWallpaper('does-not-exist')
      expect(nonExistent).toBe(false)
    })

    it('allows adding and activating custom wallpaper items', () => {
      const manager = new WallpaperManager()
      const custom: WallpaperItem = {
        id: 'my-custom',
        name: 'My Custom Wallpaper',
        kind: 'color',
        source: '#334455',
      }
      manager.addWallpaperItem(custom)
      expect(manager.getActiveWallpaper().id).toBe('my-custom')
      expect(manager.getPreferences().items.some(it => it.id === 'my-custom')).toBe(true)
    })

    it('notifies listeners on preference changes and unregisters cleanly', () => {
      const manager = new WallpaperManager()
      const listener = vi.fn()
      const unregister = manager.onChange(listener)

      manager.updateEffects({ blur: 15, dim: 50 })
      expect(listener).toHaveBeenCalledTimes(1)
      expect(manager.getPreferences().blur).toBe(15)
      expect(manager.getPreferences().dim).toBe(50)

      unregister()
      manager.updateEffects({ blur: 20 })
      expect(listener).toHaveBeenCalledTimes(1)
    })

    it('validates loaded preferences and sanitizes invalid fields', () => {
      const manager = new WallpaperManager()
      manager.loadPreferences({
        activeId: 'non-existent',
        items: [
          {
            id: 'valid-item',
            name: 'Valid',
            kind: 'color',
            source: '#112233',
          },
        ],
        fit: 'invalid-fit' as unknown as WallpaperPreferences['fit'],
        blur: -10,
        saturation: 300,
        dim: 150,
      })

      const prefs = manager.getPreferences()
      expect(prefs.activeId).toBe('valid-item')
      expect(prefs.fit).toBe('cover')
      expect(prefs.blur).toBe(0)
      expect(prefs.saturation).toBe(200)
      expect(prefs.dim).toBe(100)
    })
  })
})
