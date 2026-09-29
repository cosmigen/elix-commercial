import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { createNativeBridge } from '@deepseek-ai/dsh-native-core'
import { SurfaceService } from '@deepseek-ai/dsh-surface'
import WindowsContextService from '@deepseek-ai/dsh-windows-context'
import { describe, expect, it } from 'vitest'
import HomeService, { intersectsAnyExclusionZone } from '../src/index.ts'

describe('Home Renderer V1 live Windows acceptance', () => {
  it.skipIf(process.platform !== 'win32')(
    'creates the real per-monitor Home WebView, restores it after host recovery, and tears it down',
    async () => {
      const bridge = createNativeBridge({
        supervisor: { autoRestart: true, initialBackoffMs: 20, maxBackoffMs: 100 },
      })
      const stateDirectory = await mkdtemp(join(tmpdir(), 'elix-home-live-'))
      const context = new Context()
      try {
        await context.plugin(WindowsContextService, { enabled: true, bridge })
        await context.plugin(WebServer, { host: '127.0.0.1', port: 0 })
        await context.plugin(SurfaceService, {
          enabled: true,
          bridge,
          defaultUserDataFolder: join(stateDirectory, 'webview2'),
        })
        await context.plugin(HomeService, {
          enabled: true,
          persistencePath: join(stateDirectory, 'home-state.json'),
          autoShowOnReady: true,
          snapToGrid: true,
          debugExclusions: true,
        })
        expect(context.home.isRunning).toBe(true)

        const monitors = context.windowsContext.getMonitors()
        const primary = context.windowsContext.getPrimaryMonitor()
        const homeSurface = context.home.surfaces.getSurfaceForMonitor(primary.id)
        if (homeSurface === undefined) throw new Error('Home did not create a surface for the primary monitor.')
        await homeSurface.whenReady()
        await waitUntil(() => homeSurface.isVisible)

        console.info('HOME_WINDOWS_MONITORS ' + JSON.stringify(monitors.map(monitor => ({
          id: monitor.id,
          bounds: monitor.bounds,
          dpiX: monitor.dpiX,
          dpiY: monitor.dpiY,
          scaleFactor: monitor.scaleFactor,
          primary: monitor.isPrimary,
        }))))
        expect(context.home.surfaces.getSurfaces()).toHaveLength(monitors.length)
        expect(homeSurface.windowHandle).toBeGreaterThan(0)
        expect(homeSurface.getBounds()).toEqual(primary.bounds)

        const imagePath = join(stateDirectory, 'wallpaper.png')
        await writeFile(imagePath, Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l9LZ4AAAAABJRU5ErkJggg==',
          'base64',
        ))
        context.home.wallpaper.addWallpaperItem({
          id: 'live-test-image',
          name: 'Live acceptance image',
          kind: 'image',
          source: imagePath,
        })
        context.home.items.addItem({
          id: 'live-covered',
          type: 'shortcut',
          monitorId: primary.id,
          position: { x: primary.bounds.x + 220, y: primary.bounds.y + 180 },
          metadata: { name: 'Live Covered' },
        })
        context.home.items.addItem({
          id: 'live-stable',
          type: 'file',
          monitorId: primary.id,
          position: { x: primary.bounds.x + 24, y: primary.bounds.y + 24 },
          metadata: { filename: 'Live.txt' },
        })
        context.home.selection.select('live-stable')
        expect(context.home.selection.getSelectedIds()).toEqual(['live-stable'])

        const releaseExclusion = context.home.layout.registerExclusionZone({
          id: 'live-synthetic-dock',
          monitorId: primary.id,
          rect: {
            x: primary.bounds.x + 200,
            y: primary.bounds.y + 160,
            width: 220,
            height: 210,
          },
        })
        const reconciled = context.home.items.getItem('live-covered')
        expect(reconciled).toBeDefined()
        expect(reconciled === undefined || intersectsAnyExclusionZone(
          { ...reconciled.position, ...reconciled.size },
          context.home.layout.getExclusionZones(primary.id),
          primary.id,
        )).toBe(false)

        if (reconciled === undefined) throw new Error('Reconciled Home item disappeared.')
        const drag = context.home.startDragSession({
          mode: 'move',
          primaryItemId: reconciled.id,
          additionalItemIds: [],
          startPointer: reconciled.position,
          monitorId: primary.id,
        })
        drag.updatePointer({ x: reconciled.position.x + 310, y: reconciled.position.y + 190 })
        drag.commit()
        const dragged = context.home.items.getItem(reconciled.id)
        expect(dragged).toBeDefined()
        expect(((dragged?.position.x ?? 0) - primary.bounds.x - 24) % 98).toBe(0)
        expect(((dragged?.position.y ?? 0) - primary.bounds.y - 24) % 84).toBe(0)

        await context.home.hide()
        expect(homeSurface.isVisible).toBe(false)
        await context.home.show()
        expect(homeSurface.isVisible).toBe(true)
        await context.home.restart()
        expect(context.home.items.getItem('live-stable')).toBeDefined()

        const firstGeneration = bridge.getHostGeneration()
        const firstHwnd = homeSurface.windowHandle
        await bridge.crashHost()
        await waitUntil(() => bridge.getStatus() === 'ready' && bridge.getHostGeneration() > firstGeneration, 15_000)
        await waitUntil(() => homeSurface.windowHandle !== firstHwnd && homeSurface.isReady, 15_000)
        expect(context.home.items.getItem('live-covered')).toBeDefined()

        releaseExclusion()
        await context.home.saveState()
        await context.fiber.dispose()
        await bridge.dispose()
        expect(bridge.getStatus()).toBe('closed')
      } finally {
        await context.fiber.dispose()
        await bridge.dispose()
        await rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      }
    },
    45_000,
  )
})

async function waitUntil(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for live Home state.')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}
