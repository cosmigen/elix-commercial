import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createNativeBridge, type NativeBridgeClient } from '@deepseek-ai/dsh-native-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SurfaceService } from '../src/index.ts'

describe('Surface Core Live Windows Acceptance', () => {
  if (process.platform !== 'win32') {
    it.skip('Skipping Windows live tests on non-Windows platform', () => {})
    return
  }

  let bridge: NativeBridgeClient
  let ctx: Context
  let tempUserDataDir: string

  beforeAll(async () => {
    bridge = createNativeBridge()
    await bridge.connect()
    tempUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'elix-surface-live-'))

    ctx = new Context()
    ctx.plugin(SurfaceService, {
      enabled: true,
      bridge,
      defaultUserDataFolder: tempUserDataDir,
    })
    await new Promise(resolve => setTimeout(resolve, 50))
  })

  afterAll(async () => {
    await ctx.fiber.dispose()
    await bridge.dispose()
    try {
      fs.rmSync(tempUserDataDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup
    }
  })

  it('verifies host WebView2 runtime availability and version', async () => {
    const status = await ctx.surface.getRuntimeStatus()
    expect(status.available).toBe(true)
    expect(typeof status.version).toBe('string')
    expect(status.version).toMatch(/^\d+\.\d+\.\d+\.\d+$/)
  })

  it(
    'executes full live visual acceptance: HWND allocation, WebView2 hosting, ready-before-show, geometry, and teardown',
    async () => {
      const surfaceId = 'surface:test'
      const initialBounds = { x: 300, y: 200, width: 640, height: 480 }

      const acceptanceHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>ELIX Surface Core Acceptance</title>
  <style>
    body {
      margin: 0;
      padding: 24px;
      background: #0f172a;
      color: #f8fafc;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    h1 { margin: 0 0 16px 0; font-size: 22px; color: #38bdf8; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-weight: bold; background: #22c55e; color: #000; font-size: 12px; }
    .field { margin: 8px 0; font-size: 14px; }
    .label { color: #94a3b8; width: 100px; display: inline-block; }
    .val { color: #f8fafc; font-weight: 500; }
  </style>
</head>
<body>
  <h1>ELIX Surface Core</h1>
  <div class="field"><span class="label">Surface:</span> <span class="badge">READY</span></div>
  <div class="field"><span class="label">Surface ID:</span> <span class="val">${surfaceId}</span></div>
  <div class="field"><span class="label">Monitor:</span> <span class="val">primary</span></div>
  <div class="field"><span class="label">Bounds:</span> <span class="val">300, 200, 640x480</span></div>
  <div class="field"><span class="label">DPI:</span> <span class="val">authoritative</span></div>
  <div class="field"><span class="label">Scale:</span> <span class="val">100%</span></div>
  <div class="field"><span class="label">WebView2:</span> <span class="badge">READY</span></div>
</body>
</html>`

      // 1. Create native surface with visual acceptance HTML renderer and visible: true
      const surface = await ctx.surface.create({
        id: surfaceId,
        bounds: initialBounds,
        renderer: {
          type: 'html',
          target: acceptanceHtml,
        },
        focusPolicy: 'noActivate',
        zOrderPolicy: 'normal',
        skipTaskbar: true,
        transparent: false,
        visible: true,
      })

      expect(surface.id).toBe(surfaceId)
      expect(surface.hwnd).toBeGreaterThan(0)
      expect(surface.bounds).toEqual(initialBounds)

      // 2. Await readiness (proves ready-before-show gate and real WebView2 HTML navigation)
      const readyInstance = await surface.whenReady()
      expect(readyInstance.isReady()).toBe(true)

      // Brief dwell to ensure presentation is visible and painted
      await new Promise(r => setTimeout(r, 100))
      expect(surface.isVisible).toBe(true)

      // 3. Move surface
      const movedBounds = { x: 350, y: 250, width: 640, height: 480 }
      await surface.setBounds(movedBounds)
      expect(surface.bounds).toEqual(movedBounds)

      // 4. Resize surface
      const resizedBounds = { x: 350, y: 250, width: 800, height: 600 }
      await surface.setBounds(resizedBounds)
      expect(surface.bounds).toEqual(resizedBounds)

      // 5. Hide surface
      await surface.hide()
      expect(surface.isVisible).toBe(false)

      // 6. Show surface again (idempotent)
      await surface.show()
      expect(surface.isVisible).toBe(true)

      // 7. Reload surface WebView2
      await surface.reload()
      expect(surface.isVisible).toBe(true)

      // 8. Destroy surface
      const destroyed = await ctx.surface.destroy(surfaceId)
      expect(destroyed).toBe(true)
      expect(ctx.surface.get(surfaceId)).toBeUndefined()
    },
    15000,
  )

  it('verifies repeated surface create/destroy cycles are leak-free', async () => {
    for (let i = 0; i < 5; i++) {
      const id = `rapid-surface-${i}`
      const surface = await ctx.surface.create({
        id,
        bounds: { x: 200 + i * 20, y: 200 + i * 20, width: 400, height: 300 },
        visible: false,
      })
      expect(surface.hwnd).toBeGreaterThan(0)
      const destroyed = await ctx.surface.destroy(id)
      expect(destroyed).toBe(true)
    }
    expect(ctx.surface.list()).toHaveLength(0)
  })
})
