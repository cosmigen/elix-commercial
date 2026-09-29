import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { createNativeBridge } from '@deepseek-ai/dsh-native-core'
import { SurfaceService } from '@deepseek-ai/dsh-surface'
import WindowsContextService from '@deepseek-ai/dsh-windows-context'
import ShellLayoutService from '@deepseek-ai/dsh-shell-layout'
import OverlayService from '@deepseek-ai/dsh-shell-overlay'
import {
  UiFoundationService,
} from '@deepseek-ai/dsh-ui-foundation'
import HomePlugin from '../../../packages/shell/home/src/index.ts'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function captureWindow(hwnd: number, name: string): void {
  const pngPath = path.resolve(process.cwd(), '.agents', 'reports', 'visual-audit', 'evidence', `${name}.png`)
  const captureScript = path.resolve(process.cwd(), '.audit', 'phase1-through-16d', 'capture_window.ps1')
  execFileSync('powershell.exe', [
    '-ExecutionPolicy', 'Bypass',
    '-File', captureScript,
    String(hwnd),
    pngPath,
  ], { stdio: 'inherit' })
  console.log(`[CAPTURED] ${path.basename(pngPath)}`)
}

async function main(): Promise<void> {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'elix-phase16c-visual-audit-'))
  const persistencePath = path.join(stateDir, 'home-state.json')
  const uiPreferencesPath = path.join(stateDir, 'ui-preferences.json')
  const webViewUserDataFolder = path.join(stateDir, 'webview2')
  const bridge = createNativeBridge({ supervisor: { autoRestart: true, initialBackoffMs: 20, maxBackoffMs: 100 } })
  const ctx = new Context()

  try {
    await bridge.connect()
    await ctx.plugin(WindowsContextService, { enabled: true, bridge })
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    await ctx.plugin(SurfaceService, { enabled: true, bridge, defaultUserDataFolder: webViewUserDataFolder })
    await ctx.plugin(ShellLayoutService, { enabled: true })
    await ctx.plugin(OverlayService, { enabled: true })
    await ctx.plugin(UiFoundationService, { enabled: true, persistencePath: uiPreferencesPath })
    await ctx.plugin(HomePlugin, {
      enabled: true,
      persistencePath,
      autoShowOnReady: true,
      snapToGrid: true,
      debugExclusions: false,
      zOrderPolicy: 'normal',
    })

    const primary = ctx.windowsContext.getPrimaryMonitor()
    const surface = ctx.home.surfaces.getSurfaces()[0]
    if (!surface) throw new Error('Phase 16C Home surface was not created')
    await surface.whenReady()
    await sleep(700)
    captureWindow(surface.windowHandle, 'P16C_personalization_runner_baseline')

    let preview = ctx.home.personalization.beginPresetPreview('elix-ember', { ownerId: 'visual-audit' })
    await sleep(500)
    if (ctx.home.personalization.getActiveWallpaper(primary.id).id !== 'elix-orange') {
      throw new Error('ELIX Ember preset did not select elix-orange')
    }
    captureWindow(surface.windowHandle, 'P16C_personalization_runner_ember')
    if (!(await preview.keep())) throw new Error('ELIX Ember preview did not commit')
    await ctx.home.saveState()

    preview = ctx.home.personalization.beginPresetPreview('aurora-focus', { ownerId: 'visual-audit' })
    await sleep(500)
    if (ctx.home.personalization.getActiveWallpaper(primary.id).id !== 'aurora-forest') {
      throw new Error('Aurora Focus preset did not select aurora-forest')
    }
    captureWindow(surface.windowHandle, 'P16C_personalization_runner_aurora')
    if (!(await preview.keep())) throw new Error('Aurora Focus preview did not commit')
    await ctx.home.saveState()

    preview = ctx.home.personalization.beginPreview({
      wallpaper: { activeId: 'elix-orange', fit: 'stretch', dim: 40, blur: 16, saturation: 150 },
    }, { ownerId: 'visual-audit', monitorId: primary.id })
    await sleep(500)
    const effects = ctx.home.personalization.getDisplayPreferences(primary.id)
    if (effects.activeId !== 'elix-orange' || effects.fit !== 'stretch' || effects.dim !== 40 || effects.blur !== 16 || effects.saturation !== 150) {
      throw new Error(`Wallpaper effect preview mismatch: ${JSON.stringify(effects)}`)
    }
    captureWindow(surface.windowHandle, 'P16C_personalization_runner_effects')
    if (!(await preview.keep())) throw new Error('Wallpaper effect preview did not commit')
    await ctx.home.saveState()
    const persisted = JSON.parse(fs.readFileSync(persistencePath, 'utf8')) as {
      wallpaper?: { monitorOverrides?: Record<string, { activeId?: string }> }
    }
    const persistedId = persisted.wallpaper?.monitorOverrides?.[primary.id]?.activeId
      ?? ctx.home.personalization.getActiveWallpaper(primary.id).id
    if (persistedId !== 'elix-orange') throw new Error(`Persisted wallpaper mismatch: ${persistedId}`)
    captureWindow(surface.windowHandle, 'P16C_personalization_runner_persisted')

    const beforeRevert = ctx.home.personalization.getActiveWallpaper(primary.id).id
    const revertPreview = ctx.home.personalization.beginPreview({ wallpaper: { activeId: 'violet-circuit' } }, { ownerId: 'visual-audit' })
    await sleep(250)
    if (ctx.home.personalization.getActiveWallpaper(primary.id).id !== 'violet-circuit') throw new Error('Revert preview did not become visible')
    if (!revertPreview.revert()) throw new Error('Revert preview refused to revert')
    await sleep(250)
    if (ctx.home.personalization.getActiveWallpaper(primary.id).id !== beforeRevert) throw new Error('Revert did not restore durable wallpaper')
    captureWindow(surface.windowHandle, 'P16C_personalization_runner_reverted')
    console.log('PHASE 16C VISUAL RUNNER PASSED')
  } finally {
    await ctx.fiber.dispose().catch(() => undefined)
    await bridge.dispose().catch(() => undefined)
    fs.rmSync(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
}

main().catch(error => {
  console.error('PHASE 16C VISUAL RUNNER FAILED')
  console.error(error)
  process.exitCode = 1
})
