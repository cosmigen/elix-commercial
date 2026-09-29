import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { SurfaceService } from '@deepseek-ai/dsh-surface'
import { WidgetService } from '@deepseek-ai/dsh-shell-widgets'
import OverlayService from '@deepseek-ai/dsh-shell-overlay'
import HomePlugin, {
  buildHomeRendererCss,
  DEFAULT_THEME_TOKENS,
  FOLDER_ARM_DELAY_MS,
  generateThemeTokensCss,
  HomeService,
  renderHomeDocument,
  renderHomeRoot,
  THEME_COMPONENT_TOKENS,
  THEME_PRIMITIVE_TOKENS,
  THEME_SEMANTIC_TOKENS,
} from '../src/index.ts'
import type { MonitorInfo } from '../src/monitor.ts'
import { createMockSurfaceRuntime } from './test-runtime.ts'

describe('ELIX Phase 12 Theme Token Foundation & Visual Authority', () => {
  let tempDir: string
  const contexts: Context[] = []

  const monitor1: MonitorInfo = {
    id: 'mon-1',
    name: 'Primary Display',
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    scaleFactor: 1.0,
    isPrimary: true,
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'elix-home-theme-tokens-test-'))
  })

  afterEach(async () => {
    while (contexts.length > 0) {
      const ctx = contexts.pop()!
      await ctx.fiber.dispose()
    }
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  })

  async function boot(config?: Partial<Record<string, unknown>>): Promise<{
    ctx: Context
    home: HomeService
    overlay: OverlayService
    widgets: WidgetService
  }> {
    const ctx = new Context()
    contexts.push(ctx)
    const runtime = createMockSurfaceRuntime()

    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    await ctx.plugin(SurfaceService, { enabled: true, bridge: runtime.bridge })
    await ctx.plugin(WidgetService, { enabled: true })
    await ctx.plugin(OverlayService, { enabled: true })
    await ctx.plugin(HomePlugin, {
      enabled: true,
      persistencePath: join(tempDir, 'home-state.json'),
      initialMonitors: [monitor1],
      autoShowOnReady: false,
      ...config,
    })

    return { ctx, home: ctx.home, overlay: ctx.overlay, widgets: ctx.widgets }
  }

  describe('1. Three-Tier Token Architecture', () => {
    it('defines Level 1 Primitives (colors, radius, blur, fonts, motion)', () => {
      expect(THEME_PRIMITIVE_TOKENS['--elix-color-black']).toBe('#050608')
      expect(THEME_PRIMITIVE_TOKENS['--elix-color-white']).toBe('#ffffff')
      expect(THEME_PRIMITIVE_TOKENS['--elix-radius-lg']).toBe('12px')
      expect(THEME_PRIMITIVE_TOKENS['--elix-blur-lg']).toBe('22px')
      expect(THEME_PRIMITIVE_TOKENS['--elix-font-ui']).toContain('Segoe UI')
      expect(THEME_PRIMITIVE_TOKENS['--elix-motion-normal']).toBe('220ms')
      expect(THEME_PRIMITIVE_TOKENS['--elix-ease-standard']).toContain('cubic-bezier')
    })

    it('defines Level 2 Semantic Shell Tokens', () => {
      expect(THEME_SEMANTIC_TOKENS['--elix-surface-background']).toBe('#090b10')
      expect(THEME_SEMANTIC_TOKENS['--elix-text-primary']).toBe('#f8fafc')
      expect(THEME_SEMANTIC_TOKENS['--elix-accent']).toBe('#38bdf8')
      expect(THEME_SEMANTIC_TOKENS['--elix-danger']).toBe('#ef4444')
    })

    it('defines Level 3 Component Tokens for Home, items, folders, widgets, and menus', () => {
      expect(THEME_COMPONENT_TOKENS['--elix-home-background']).toBe('var(--elix-surface-background)')
      expect(THEME_COMPONENT_TOKENS['--elix-desktop-item-radius']).toBe('var(--elix-radius-lg)')
      expect(THEME_COMPONENT_TOKENS['--elix-folder-tile-radius']).toBe('var(--elix-radius-xl)')
      expect(THEME_COMPONENT_TOKENS['--elix-folder-overlay-radius']).toBe('var(--elix-radius-3xl)')
      expect(THEME_COMPONENT_TOKENS['--elix-widget-radius']).toBe('var(--elix-radius-2xl)')
      expect(THEME_COMPONENT_TOKENS['--elix-context-menu-radius']).toBe('var(--elix-radius-md)')
    })

    it('combines all tiers into DEFAULT_THEME_TOKENS', () => {
      expect(DEFAULT_THEME_TOKENS['--elix-color-black']).toBeDefined()
      expect(DEFAULT_THEME_TOKENS['--elix-surface-background']).toBeDefined()
      expect(DEFAULT_THEME_TOKENS['--elix-home-background']).toBeDefined()
      expect(DEFAULT_THEME_TOKENS['--elix-folder-open-duration']).toBe('var(--elix-motion-slow)')
    })
  })

  describe('2. CSS Generation & Variable Resolution', () => {
    it('generates CSS declarations for default tokens', () => {
      const css = generateThemeTokensCss()
      expect(css).toContain('--elix-home-background:var(--elix-surface-background);')
      expect(css).toContain('--elix-desktop-item-radius:var(--elix-radius-lg);')
      expect(css).toContain('--elix-context-menu-bg:var(--elix-surface-glass-heavy);')
    })

    it('applies token overrides cleanly in generateThemeTokensCss', () => {
      const css = generateThemeTokensCss({
        '--elix-accent': '#ff007f',
        '--elix-radius-lg': '20px',
      })
      expect(css).toContain('--elix-accent:#ff007f;')
      expect(css).toContain('--elix-radius-lg:20px;')
    })

    it('buildHomeRendererCss embeds tokens into :root and uses var(--elix-...) everywhere', () => {
      const css = buildHomeRendererCss()
      expect(css).toContain(':root{')
      expect(css).toContain('--elix-home-background')
      expect(css).toContain('var(--elix-desktop-item-radius)')
      expect(css).toContain('var(--elix-folder-tile-bg)')
      expect(css).toContain('var(--elix-widget-background)')
      expect(css).toContain('@media (prefers-reduced-motion:reduce)')
    })

    it('sizes App Folder icons and labels from the folder container', () => {
      const css = buildHomeRendererCss()
      expect(css).toContain('container-type:inline-size')
      expect(css).toContain('repeat(auto-fit,minmax(min(5.5rem,28cqi),1fr))')
      expect(css).toContain('inline-size:12cqi')
      expect(css).toContain('aspect-ratio:1')
      expect(css).toContain('white-space:normal')
      expect(css).not.toContain('.app-folder-icon-ring{width:48px;height:48px')
      expect(css).not.toContain('max-width:78px')
    })

    it('contains oversized desktop icon sources within preference-driven item geometry', async () => {
      const { home } = await boot()
      home.setPreferences({ iconSize: 96 })

      const snapshot = home.getRendererSnapshot('mon-1')
      const html = renderHomeRoot(snapshot)
      const css = buildHomeRendererCss()

      expect(snapshot.iconSize).toBe(96)
      expect(html).toContain('--elix-home-icon-size:96px')
      expect(css).toContain('inline-size:var(--elix-home-icon-size);inline-size:min(76cqi,56cqb)')
      expect(css).toContain('.item-icon img{position:absolute;inset:0;display:block;width:100%;height:100%;max-width:100%;max-height:100%;object-fit:contain')
      expect(css).toContain('.home-item-label{inline-size:100%;max-inline-size:100%')
      expect(css).toContain('font-size:clamp(.55rem,17cqi,.86rem)')
      expect(css).toContain('min-block-size:2.5em')
      expect(css).toContain('flex:none')
      expect(css).toContain('word-break:normal')
      expect(css).toContain('overflow:visible')
      expect(css).toContain('white-space:normal')
      expect(css).not.toContain('.home-item-visual{display:grid;place-items:center;width:64px;height:64px')
      expect(css).not.toContain('.item-icon{position:relative;display:grid;place-items:center;width:56px;height:56px')
    })
  })

  describe('3. Dynamic Token Overrides and Snapshot Cascading', () => {
    it('initializes HomeService with themeTokens and projects them into snapshots', async () => {
      const customTokens = {
        '--elix-accent': '#10b981',
        '--elix-desktop-item-radius': '16px',
      }
      const { home } = await boot({ themeTokens: customTokens })

      expect(home.getThemeTokens()).toEqual(customTokens)

      const snapshot = home.getRendererSnapshot('mon-1')
      expect(snapshot.themeTokens).toEqual(customTokens)
    })

    it('updates theme tokens dynamically via setThemeTokens and cascades into markup', async () => {
      const { home } = await boot()
      expect(home.getThemeTokens()).toBeUndefined()

      home.setThemeTokens({ '--elix-accent': '#f43f5e' })
      expect(home.getThemeTokens()).toEqual({ '--elix-accent': '#f43f5e' })

      const snapshot = home.getRendererSnapshot('mon-1')
      expect(snapshot.themeTokens).toEqual({ '--elix-accent': '#f43f5e' })

      const html = renderHomeRoot(snapshot)
      expect(html).toContain('--elix-accent:#f43f5e')

      const doc = renderHomeDocument(snapshot, 'test-nonce')
      expect(doc).toContain('--elix-accent:#f43f5e')
    })
  })

  describe('4. Fake UI Elimination & Empty Desktop Right-Click Behavior', () => {
    it('does not open any context menu when empty desktop is right-clicked', async () => {
      const { home, overlay } = await boot()

      await home.dispatchIntent('mon-1', {
        type: 'contextMenu',
        targetType: 'desktop',
        position: { x: 500, y: 400 },
      })

      expect(overlay.getActive().length).toBe(0)
    })

    it('does not open any context menu on empty desktop even when demoMode is enabled', async () => {
      const { home, overlay } = await boot({ demoMode: true })

      await home.dispatchIntent('mon-1', {
        type: 'contextMenu',
        targetType: 'desktop',
        position: { x: 500, y: 400 },
      })

      // Must be 0 - demoMode does not resurrect fake desktop context menu
      expect(overlay.getActive().length).toBe(0)
    })

    it('opens entity context menu when right-clicking an item', async () => {
      const { home, overlay } = await boot()

      const item = home.items.addItem({
        type: 'file',
        monitorId: 'mon-1',
        position: { x: 200, y: 150 },
        metadata: { name: 'Budget.xlsx' },
      })

      await home.dispatchIntent('mon-1', {
        type: 'contextMenu',
        targetType: 'item',
        itemId: item.id,
        position: { x: 250, y: 180 },
      })

      const activeOverlays = overlay.getActive()
      expect(activeOverlays.length).toBe(1)
      const menu = activeOverlays.find(o => o.definitionId === 'home-context-menu')
      expect(menu).toBeDefined()
    })

    it('opens folder context menu (Open, Rename, Delete) when right-clicking a folder', async () => {
      const { home, overlay } = await boot()

      const folder = home.folders.createFolder({
        monitorId: 'mon-1',
        position: { x: 300, y: 200 },
        name: 'Projects',
      })

      await home.dispatchIntent('mon-1', {
        type: 'contextMenu',
        targetType: 'folder',
        itemId: folder.id,
        position: { x: 320, y: 220 },
      })

      const activeOverlays = overlay.getActive()
      expect(activeOverlays.length).toBe(1)
    })

    it('opens widget context menu (Remove Widget, Reset Position) when right-clicking a widget', async () => {
      const { home, overlay, widgets } = await boot()

      const widget = widgets.create({
        definitionId: 'clock',
        monitorId: 'mon-1',
        position: { x: 400, y: 100 },
        size: { width: 260, height: 120 },
      })

      await home.dispatchIntent('mon-1', {
        type: 'contextMenu',
        targetType: 'widget',
        widgetId: widget.id,
        position: { x: 450, y: 120 },
      })

      const activeOverlays = overlay.getActive()
      expect(activeOverlays.length).toBe(1)
    })
  })

  describe('5. App Folder Tile & Dwell Timing Constants', () => {
    it('verifies folder creation dwell time is exactly 600ms', () => {
      expect(FOLDER_ARM_DELAY_MS).toBe(600)
    })

    it('renders AppFolderTile with token classes and preview grid for up to 9 items', async () => {
      const { home } = await boot()

      const childIds: string[] = []
      for (let i = 1; i <= 12; i++) {
        const item = home.items.addItem({
          type: 'shortcut',
          monitorId: 'mon-1',
          position: { x: 10 * i, y: 10 * i },
          metadata: { name: `App ${i}`, target: `app${i}.exe` },
        })
        childIds.push(item.id)
      }

      const folder = home.folders.createFolder({
        monitorId: 'mon-1',
        position: { x: 100, y: 100 },
        name: 'Suite',
        color: 'mint',
        initialItemIds: childIds,
      })
      void folder

      const snapshot = home.getRendererSnapshot('mon-1')
      const html = renderHomeRoot(snapshot)

      // Only first 9 children are shown in preview
      expect(html).toContain('class="app-folder-preview app-folder-mint"')
      expect(html).toContain('data-item-count="9"')
      expect(html).toContain('App 1')
      expect(html).toContain('App 9')
      expect(html).not.toContain('title="App 10"')
    })
  })
})
