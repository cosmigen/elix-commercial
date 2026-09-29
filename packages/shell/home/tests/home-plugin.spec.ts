import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { SurfaceService, type SurfaceCreateOptions } from '@deepseek-ai/dsh-surface'
import type { WindowsContextService } from '@deepseek-ai/dsh-windows-context'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HomePlugin, HomeService, intersectsAnyExclusionZone } from '../src/index.ts'
import type { MonitorInfo } from '../src/index.ts'
import { createMockSurfaceRuntime, type MockSurfaceRuntime } from './test-runtime.ts'

const monitor: MonitorInfo = {
  id: 'disp-test-1',
  name: 'Primary Screen',
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
  scaleFactor: 1,
  isPrimary: true,
}

interface BootedHome {
  readonly ctx: Context
  readonly runtime: MockSurfaceRuntime
  readonly rendererUrl: string
}

describe('HomeService renderer integration', () => {
  let tempDir: string
  let persistencePath: string
  const contexts: Context[] = []

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'elix-home-plugin-'))
    persistencePath = join(tempDir, 'home-state.json')
  })

  afterEach(async () => {
    await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
    await rm(tempDir, { recursive: true, force: true })
  })

  async function boot(config: Partial<{
    autoShowOnReady: boolean
    debugExclusions: boolean
    monitors: readonly MonitorInfo[]
  }> = {}): Promise<BootedHome> {
    const ctx = new Context()
    contexts.push(ctx)
    const runtime = createMockSurfaceRuntime()
    const currentMonitors = config.monitors ?? [monitor]
    ctx.windowsContext = {
      getMonitors: () => currentMonitors.map(projectTestMonitor),
      getMonitor: (id: string) => {
        const found = currentMonitors.find(candidate => candidate.id === id)
        return found === undefined ? undefined : projectTestMonitor(found)
      },
    } as unknown as WindowsContextService
    ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    await waitFor(() => (ctx.get('webServer')?.port ?? 0) > 0)
    ctx.plugin(SurfaceService, { enabled: true, bridge: runtime.bridge })
    await waitFor(() => ctx.get('surface') !== undefined)
    ctx.plugin(HomePlugin, {
      enabled: true,
      persistencePath,
      autoShowOnReady: config.autoShowOnReady ?? false,
      snapToGrid: true,
      debugExclusions: config.debugExclusions ?? false,
      initialMonitors: currentMonitors,
    })
    await waitFor(() => (ctx.get('home'))?.isRunning === true)
    const create = runtime.createOptions[0]
    if (create?.renderer?.type !== 'url') throw new Error('Home did not create a URL renderer surface.')
    return { ctx, runtime, rendererUrl: create.renderer.target }
  }

  it('does not require renderer infrastructure while disabled', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    ctx.plugin(HomePlugin, { enabled: false })
    await waitFor(() => ctx.get('home') !== undefined)
    expect(ctx.home).toBeInstanceOf(HomeService)
    expect(ctx.home.isRunning).toBe(false)
    expect(ctx.home.surfaces.getSurfaces()).toHaveLength(0)
  })

  it('creates one hidden Surface Core WebView and serves a CSP-restricted React document', async () => {
    const { ctx, runtime, rendererUrl } = await boot({ debugExclusions: true })
    const options = runtime.createOptions[0] as SurfaceCreateOptions
    expect(options.monitorId).toBe(monitor.id)
    expect(options.bounds).toEqual(monitor.bounds)
    expect(options.focusPolicy).toBe('noActivate')
    expect(options.zOrderPolicy).toBe('bottom')
    expect(options.skipTaskbar).toBe(true)
    expect(options.visible).toBe(false)
    expect(rendererUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/__elix\/home\/[\w-]+$/u)

    ctx.home.items.addItem({
      id: 'calculator',
      type: 'shortcut',
      monitorId: monitor.id,
      position: { x: 24, y: 24 },
      metadata: { name: 'Calculator', target: 'secret.exe', arguments: [] },
    })
    ctx.home.folders.createFolder({
      monitorId: monitor.id,
      position: { x: 122, y: 24 },
      name: 'Projects',
    })
    ctx.home.layout.registerExclusionZone({
      id: 'synthetic-dock',
      monitorId: monitor.id,
      rect: { x: 700, y: 970, width: 520, height: 90 },
    })

    const response = await fetch(rendererUrl)
    const html = await response.text()
    expect(response.status).toBe(200)
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(html).toContain('id="home-root"')
    expect(html).toContain('data-wallpaper-runtime="suspended"')
    expect(html).toContain('Calculator')
    expect(html).toContain('Projects')
    expect(html).toContain('Home exclusion')
    expect(html).not.toContain('secret.exe')
  })

  it('converts renderer-local selection, marquee, drag, activation, and context-menu intents', async () => {
    const scaledMonitor: MonitorInfo = {
      ...monitor,
      id: 'scaled-left',
      bounds: { x: -2560, y: -400, width: 2560, height: 1440 },
      workArea: { x: -2560, y: -400, width: 2560, height: 1400 },
      scaleFactor: 1.5,
    }
    const { ctx, rendererUrl } = await boot({ monitors: [scaledMonitor] })
    ctx.home.items.addItem({
      id: 'item-a',
      type: 'shortcut',
      monitorId: scaledMonitor.id,
      position: { x: -2500, y: -340 },
      metadata: { name: 'Alpha' },
    })
    ctx.home.items.addItem({
      id: 'item-b',
      type: 'file',
      monitorId: scaledMonitor.id,
      position: { x: -2320, y: -340 },
      metadata: { filename: 'Beta.txt' },
    })

    await postIntent(rendererUrl, { type: 'select', itemId: 'item-a', additive: false })
    expect(ctx.home.selection.getSelectedIds()).toEqual(['item-a'])

    await postIntent(rendererUrl, {
      type: 'marquee',
      rect: { x: 30, y: 30, width: 220, height: 100 },
      additive: false,
    })
    expect(ctx.home.selection.getSelectedIds()).toEqual(['item-a', 'item-b'])

    const activation: string[] = []
    const menus: Array<{ x: number; y: number }> = []
    ctx.on('home/item-activate-requested', item => activation.push(item.id))
    ctx.on('home/context-menu-requested', request => menus.push(request.position))
    await postIntent(rendererUrl, { type: 'activate', itemId: 'item-a' })
    await postIntent(rendererUrl, { type: 'contextMenu', itemId: 'item-a', position: { x: 20, y: 30 } })
    expect(activation).toEqual(['item-a'])
    expect(menus).toEqual([{ x: -2530, y: -355 }])

    ctx.home.layout.registerExclusionZone({
      id: 'floating',
      monitorId: scaledMonitor.id,
      rect: { x: -1900, y: 550, width: 500, height: 250 },
    })
    await postIntent(rendererUrl, {
      type: 'moveItems',
      primaryItemId: 'item-a',
      additionalItemIds: [],
      start: { x: 40, y: 40 },
      end: { x: 540, y: 700 },
    })
    const moved = ctx.home.items.getItem('item-a')!
    expect(intersectsAnyExclusionZone(
      { ...moved.position, ...moved.size },
      ctx.home.layout.getExclusionZones(scaledMonitor.id),
      scaledMonitor.id,
    )).toBe(false)
  })

  it('reconciles only already-placed items covered by a dynamic exclusion', async () => {
    const { ctx } = await boot()
    ctx.home.items.addItem({
      id: 'covered',
      type: 'shortcut',
      monitorId: monitor.id,
      position: { x: 220, y: 180 },
      metadata: { name: 'Covered' },
    })
    ctx.home.items.addItem({
      id: 'stable',
      type: 'shortcut',
      monitorId: monitor.id,
      position: { x: 24, y: 24 },
      metadata: { name: 'Stable' },
    })

    const dispose = ctx.home.layout.registerExclusionZone({
      id: 'future-shell-surface',
      monitorId: monitor.id,
      rect: { x: 200, y: 160, width: 220, height: 210 },
    })

    const covered = ctx.home.items.getItem('covered')
    expect(covered?.position).not.toEqual({ x: 220, y: 180 })
    expect(covered === undefined || intersectsAnyExclusionZone(
      { ...covered.position, ...covered.size },
      ctx.home.layout.getExclusionZones(monitor.id),
      monitor.id,
    )).toBe(false)
    expect(ctx.home.items.getItem('stable')?.position).toEqual({ x: 24, y: 24 })
    expect(ctx.home.items.getItems().map(item => item.id).sort()).toEqual(['covered', 'stable'])

    dispose()
    const returned = ctx.home.layout.resolvePlacement(
      { ...ctx.home.items.getItem('covered')!, position: { x: 220, y: 180 } },
      ctx.home.items.getItems().filter(item => item.id !== 'covered'),
      monitor.bounds,
      false,
    )
    expect(returned).toEqual({ x: 220, y: 180 })
  })

  it('rejects malformed, oversized, cross-origin, and stale renderer requests', async () => {
    const secondary: MonitorInfo = {
      ...monitor,
      id: 'disp-test-2',
      name: 'Secondary Screen',
      bounds: { x: 1920, y: 0, width: 1280, height: 1024 },
      workArea: { x: 1920, y: 0, width: 1280, height: 984 },
      isPrimary: false,
    }
    const { ctx, runtime, rendererUrl } = await boot({ monitors: [monitor, secondary] })
    const malformed = await fetch(rendererUrl + '/intent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'select', itemId: 42 }),
    })
    expect(malformed.status).toBe(400)

    const crossOrigin = await fetch(rendererUrl + '/intent', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://example.invalid' },
      body: JSON.stringify({ type: 'clearSelection' }),
    })
    expect(crossOrigin.status).toBe(403)

    const oversized = await fetch(rendererUrl + '/intent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'clearSelection', padding: 'x'.repeat(20_000) }),
    })
    expect(oversized.status).toBe(400)

    const secondaryRenderer = runtime.createOptions.find(option => option.monitorId === secondary.id)?.renderer
    if (secondaryRenderer?.type !== 'url') throw new Error('Home did not create the secondary renderer.')
    ctx.home.monitors.removeMonitor(secondary.id)
    await waitFor(() => ctx.home.surfaces.getSurfaces().length === 1)
    expect((await fetch(secondaryRenderer.target)).status).toBe(404)
  })

  it('serves byte ranges for video wallpaper and renders trusted live wallpaper without scripts', async () => {
    const videoPath = join(tempDir, 'wallpaper.mp4')
    await writeFile(videoPath, Buffer.from('0123456789abcdef'))
    const { ctx, rendererUrl } = await boot()
    ctx.home.wallpaper.addWallpaperItem({
      id: 'local-video',
      name: 'Local video',
      kind: 'video',
      source: videoPath,
    })

    const videoDocument = await (await fetch(rendererUrl)).text()
    expect(videoDocument).toContain('<video')
    expect(videoDocument).toContain('muted=""')
    const mediaResponse = await fetch(rendererUrl + '/wallpaper', {
      headers: { range: 'bytes=4-8' },
    })
    expect(mediaResponse.status).toBe(206)
    expect(mediaResponse.headers.get('content-range')).toBe('bytes 4-8/16')
    expect(await mediaResponse.text()).toBe('45678')

    expect(ctx.home.wallpaper.setActiveWallpaper('quiet-orbit')).toBe(true)
    const liveDocument = await (await fetch(rendererUrl)).text()
    expect(liveDocument).toContain('wallpaper-live-quiet-orbit')
    expect(liveDocument).not.toContain(videoPath)
  })

  it('rehydrates durable state across renderer reload and native-host surface recreation', async () => {
    const readyHwnds: number[] = []
    const { ctx, runtime, rendererUrl } = await boot()
    ctx.on('home/surface-ready', surface => readyHwnds.push(surface.windowHandle))
    ctx.home.items.addItem({
      id: 'durable-item',
      type: 'folder',
      monitorId: monitor.id,
      position: { x: 220, y: 180 },
      metadata: { name: 'Durable', color: 'mint', itemIds: [], isOpen: false },
    })
    await ctx.home.saveState()
    await ctx.home.restart()
    expect(runtime.reload).toHaveBeenCalled()
    expect((await (await fetch(rendererUrl)).text())).toContain('Durable')

    const surface = ctx.home.surfaces.getSurfaces()[0]!
    const recreatedHwnd = surface.windowHandle + 100
    runtime.emit({
      type: 'created',
      snapshot: {
        id: surface.surfaceId,
        hwnd: recreatedHwnd,
        bounds: monitor.bounds,
        state: 'NATIVE_CREATED',
        visible: false,
        dpi: 96,
        scaleFactor: 1,
        focusPolicy: 'noActivate',
        zOrderPolicy: 'bottom',
        monitorId: monitor.id,
      },
    })
    runtime.emit({ type: 'nativeReady', id: surface.surfaceId, hwnd: recreatedHwnd })
    runtime.emit({ type: 'rendererReady', id: surface.surfaceId })

    expect(surface.windowHandle).toBe(recreatedHwnd)
    expect(surface.isReady).toBe(true)
    expect(readyHwnds).toEqual([recreatedHwnd])
    expect((await (await fetch(rendererUrl)).text())).toContain('Durable')
    expect(ctx.home.items.getItems().filter(item => item.id === 'durable-item')).toHaveLength(1)
  })

  it('persists item placement and wallpaper preference across Home service restarts', async () => {
    const first = await boot()
    first.ctx.home.items.addItem({
      id: 'persisted-app',
      type: 'shortcut',
      monitorId: monitor.id,
      position: { x: 200, y: 150 },
      metadata: { name: 'Calculator' },
    })
    first.ctx.home.wallpaper.setActiveWallpaper('ember-night')
    await first.ctx.home.saveState()
    await first.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(first.ctx), 1)

    const second = await boot()
    expect(second.ctx.home.items.getItem('persisted-app')?.position).toEqual({ x: 200, y: 150 })
    expect(second.ctx.home.wallpaper.getPreferences().activeId).toBe('ember-night')
    expect(await (await fetch(second.rendererUrl)).text()).toContain('Calculator')
  })
})

function projectTestMonitor(value: MonitorInfo) {
  return {
    id: value.id,
    deviceName: value.name,
    friendlyName: value.name,
    isPrimary: value.isPrimary,
    bounds: value.bounds,
    workArea: value.workArea,
    dpiX: Math.round(96 * value.scaleFactor),
    dpiY: Math.round(96 * value.scaleFactor),
    scaleFactor: value.scaleFactor,
  }
}

async function postIntent(rendererUrl: string, intent: unknown): Promise<void> {
  const response = await fetch(rendererUrl + '/intent', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: new URL(rendererUrl).origin,
    },
    body: JSON.stringify(intent),
  })
  expect(response.status).toBe(204)
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for test runtime.')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
