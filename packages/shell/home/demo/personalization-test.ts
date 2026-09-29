import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as readline from 'node:readline'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { createNativeBridge } from '@deepseek-ai/dsh-native-core'
import { SurfaceService } from '@deepseek-ai/dsh-surface'
import type { SurfaceInstance } from '@deepseek-ai/dsh-surface'
import WindowsContextService from '@deepseek-ai/dsh-windows-context'
import type { WindowsMonitor } from '@deepseek-ai/dsh-windows-context'
import ShellLayoutService from '@deepseek-ai/dsh-shell-layout'
import OverlayService from '@deepseek-ai/dsh-shell-overlay'
import {
  generateThemeTokensCss,
  generateUiFoundationCss,
  UI_FOUNDATION_RENDERER_BRIDGE_SCRIPT,
  UiFoundationService,
} from '@deepseek-ai/dsh-ui-foundation'
import HomePlugin from '../src/index.ts'
import type { HomePersonalizationPreviewHandle } from '../src/personalization.ts'

const TOKEN_CSS = generateThemeTokensCss()
const FOUNDATION_CSS = generateUiFoundationCss()
const INTERNET_WALLPAPER_ID = 'nasa-earth-internet'
const INTERNET_WALLPAPER_URL = 'https://upload.wikimedia.org/wikipedia/commons/e/e5/Earth_.jpg'
const DEBUG_LOG_PATH = path.join(os.tmpdir(), 'elix-phase16c-personalization-debug.jsonl')

async function downloadInternetWallpaper(destination: string): Promise<boolean> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 12_000)
  try {
    const response = await fetch(INTERNET_WALLPAPER_URL, {
      signal: controller.signal,
      headers: { 'user-agent': 'ELIX-Phase16C-Acceptance/1.0' },
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
    if (!contentType.startsWith('image/jpeg')) throw new Error(`Unexpected content type ${contentType}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length < 1024 || bytes.length > 10 * 1024 * 1024) {
      throw new Error(`Unexpected image size ${bytes.length} bytes`)
    }
    fs.writeFileSync(destination, bytes)
    return true
  } catch (error) {
    console.warn('Phase 16C: unable to download NASA/Wikimedia test wallpaper:', error)
    return false
  } finally {
    clearTimeout(timeout)
  }
}

function controlHtml(internetWallpaperReady: boolean): string {
  const internetButton = internetWallpaperReady
    ? `<button class="elix-control elix-button wide" onclick="send('wallpaper:${INTERNET_WALLPAPER_ID}')">NASA Earth — real internet photo</button>`
    : '<button class="elix-control elix-button wide" disabled>NASA Earth photo unavailable — check internet</button>'

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ELIX Phase 16C Personalization</title>
<style>
:root{${TOKEN_CSS}}
${FOUNDATION_CSS}
html,body{width:100%;min-height:100%;margin:0;overflow:auto}
body{padding:22px;background:var(--elix-surface-background);color:var(--elix-text-primary);font-family:var(--elix-font-ui)}
h1{font-size:20px;margin:0 0 4px}.muted{color:var(--elix-text-muted)}
section{margin-top:16px;padding:14px;border:1px solid var(--elix-surface-border);border-radius:var(--elix-radius-xl);background:var(--elix-surface-glass)}
h2{font-size:14px;margin:0 0 10px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
button{width:100%;min-width:0;white-space:normal}.wide{grid-column:1/-1}
.status{margin-top:16px;padding:12px;border:1px solid var(--elix-divider);border-radius:var(--elix-radius-md);font-family:var(--elix-font-mono);font-size:12px;line-height:1.5;white-space:pre-wrap}
.hint{margin-top:8px;font-size:12px;color:var(--elix-text-muted);line-height:1.45}
</style>
</head>
<body>
<h1>ELIX Home Personalization <span class="muted">PHASE 16C</span></h1>
<div class="muted">Wallpaper-only previews have no timeout. Save to JSON commits the preview and immediately flushes Home persistence.</div>
<section>
<h2>Target display</h2>
<div class="grid"><button class="elix-control elix-button wide" onclick="send('target-next')">Next monitor — panel moves there</button></div>
</section>
<section>
<h2>Coordinated presets — wallpaper + 16B appearance</h2>
<div class="grid">
<button class="elix-control elix-button" onclick="send('preset:elix-ember')">ELIX Ember</button>
<button class="elix-control elix-button" onclick="send('preset:aurora-focus')">Aurora Focus</button>
<button class="elix-control elix-button" onclick="send('preset:violet-night')">Violet Night</button>
<button class="elix-control elix-button" onclick="send('preset:quiet-orbit')">Quiet Orbit</button>
</div>
</section>
<section>
<h2>Wallpaper preview</h2>
<div class="grid">
${internetButton}
<button class="elix-control elix-button" onclick="send('wallpaper:elix-orange')">Orange gradient</button>
<button class="elix-control elix-button" onclick="send('wallpaper:aurora-forest')">Aurora gradient</button>
<button class="elix-control elix-button" onclick="send('wallpaper:ember-night')">Ember Night</button>
<button class="elix-control elix-button" onclick="send('wallpaper:violet-circuit')">Violet</button>
</div>
<div class="hint">NASA Earth is only a selectable test asset. Once any wallpaper is selected, every fit/effect control edits that same selected wallpaper state.</div>
</section>
<section>
<h2>Fit + effects preview</h2>
<div class="hint">No control in this section chooses a wallpaper ID. It only mutates the current wallpaper state's fit/effects.</div>
<div class="grid">
<button class="elix-control elix-button" onclick="send('fit:cover')">Fill / Cover</button>
<button class="elix-control elix-button" onclick="send('fit:contain')">Fit / Contain</button>
<button class="elix-control elix-button" onclick="send('fit:stretch')">Stretch</button>
<button class="elix-control elix-button" onclick="send('fit:center')">Center</button>
<button class="elix-control elix-button" onclick="send('fit:tile')">Tile</button>
<button class="elix-control elix-button" onclick="send('dim:+')">Dim +20</button>
<button class="elix-control elix-button" onclick="send('dim:-')">Dim -20</button>
<button class="elix-control elix-button" onclick="send('blur:+')">Blur +8</button>
<button class="elix-control elix-button" onclick="send('blur:-')">Blur -8</button>
<button class="elix-control elix-button" onclick="send('saturation:+')">Saturation +25</button>
<button class="elix-control elix-button" onclick="send('saturation:-')">Saturation -25</button>
</div>
</section>
<section>
<h2>Preview / persistence transaction</h2>
<div class="grid">
<button class="elix-control elix-button" onclick="send('keep')">Keep (commit)</button>
<button class="elix-control elix-button" onclick="send('revert')">Revert</button>
<button class="elix-control elix-button wide" onclick="send('save')">Save to JSON now</button>
<button class="elix-control elix-button" onclick="send('follow-global')">Monitor follows global</button>
<button class="elix-control elix-button" onclick="send('reset-target')">Reset target</button>
<button class="elix-control elix-button wide" onclick="send('reset-all')">Reset all personalization</button>
</div>
<div class="hint">Keep commits into the durable WallpaperManager and Home normally autosaves shortly after. Save to JSON now additionally awaits Home.saveState() so the JSON file can be inspected immediately.</div>
</section>
<div id="status" class="status" aria-live="polite">Starting…</div>
<script>${UI_FOUNDATION_RENDERER_BRIDGE_SCRIPT}</script>
<script>
function send(action){if(window.chrome&&window.chrome.webview)window.chrome.webview.postMessage({type:'phase16c/action',action:action});}
if(window.chrome&&window.chrome.webview){window.chrome.webview.addEventListener('message',function(event){var d=event.data;if(d&&d.type==='phase16c/status'){document.getElementById('status').textContent=d.text;}});}
</script>
</body>
</html>`
}

function panelBoundsFor(monitor: WindowsMonitor): { x: number; y: number; width: number; height: number } {
  const width = Math.min(560, Math.max(420, monitor.workArea.width - 80))
  const height = Math.min(780, Math.max(560, monitor.workArea.height - 80))
  return {
    x: monitor.workArea.x + Math.round((monitor.workArea.width - width) / 2),
    y: monitor.workArea.y + Math.round((monitor.workArea.height - height) / 2),
    width,
    height,
  }
}

async function movePanelToMonitor(panel: SurfaceInstance, monitor: WindowsMonitor): Promise<void> {
  await panel.setBounds(panelBoundsFor(monitor))
  await panel.show()
}

export async function runPersonalizationVisualTest(): Promise<void> {
  console.log('Starting ELIX Phase 16C Home personalization acceptance harness...')
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'elix-phase16c-'))
  const bridge = createNativeBridge({ supervisor: { autoRestart: true, initialBackoffMs: 20, maxBackoffMs: 100 } })
  const ctx = new Context()
  let previewObserver: NodeJS.Timeout | undefined
  let unbindWallpaperDebug: (() => void) | undefined

  fs.writeFileSync(DEBUG_LOG_PATH, '')
  console.log(`Phase 16C debug log: ${DEBUG_LOG_PATH}`)

  try {
    await ctx.plugin(WindowsContextService, { enabled: true, bridge })
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    await ctx.plugin(SurfaceService, {
      enabled: true,
      bridge,
      defaultUserDataFolder: path.join(stateDir, 'webview2'),
    })
    await ctx.plugin(ShellLayoutService, { enabled: true })
    await ctx.plugin(OverlayService, { enabled: true })
    await ctx.plugin(UiFoundationService, {
      enabled: true,
      persistencePath: path.join(stateDir, 'ui-preferences.json'),
    })
    await ctx.plugin(HomePlugin, {
      enabled: true,
      persistencePath: path.join(stateDir, 'home-state.json'),
      autoShowOnReady: true,
      snapToGrid: true,
      debugExclusions: false,
      zOrderPolicy: 'normal',
    })

    const monitors = ctx.windowsContext.getMonitors()
    const firstMonitor = monitors[0]
    if (firstMonitor === undefined) throw new Error('Phase 16C acceptance requires at least one active monitor.')
    let targetIndex = 0
    let activePreview: HomePersonalizationPreviewHandle | undefined
    let debugSequence = 0

    const internetWallpaperPath = path.join(stateDir, 'nasa-earth-internet.jpg')
    const internetWallpaperReady = await downloadInternetWallpaper(internetWallpaperPath)
    if (internetWallpaperReady) {
      ctx.home.wallpaper.addWallpaperItem({
        id: INTERNET_WALLPAPER_ID,
        name: 'NASA Earth — Wikimedia',
        kind: 'image',
        source: internetWallpaperPath,
      })
      ctx.home.wallpaper.setActiveWallpaper('elix-orange')
    }

    const primary = ctx.windowsContext.getPrimaryMonitor()
    const panel = await ctx.surface.create({
      id: 'phase16c-personalization-panel',
      bounds: panelBoundsFor(primary),
      renderer: { type: 'html', target: controlHtml(internetWallpaperReady) },
      visible: true,
      zOrderPolicy: 'topmost',
    })
    await panel.whenReady()

    const target = () => monitors[targetIndex % monitors.length] ?? firstMonitor
    const targetName = () => {
      const current = target()
      return current.friendlyName ?? current.deviceName
    }
    const debugState = (event: string, action?: string, extra: Record<string, unknown> = {}): void => {
      try {
        const current = target()
        const effectiveDisplay = ctx.home.personalization.getDisplayPreferences(current.id)
        const effectiveWallpaper = ctx.home.personalization.getActiveWallpaper(current.id)
        const durableDisplay = ctx.home.wallpaper.getDisplayPreferences(current.id)
        const durableWallpaper = ctx.home.wallpaper.getActiveWallpaper(current.id)
        const preview = ctx.home.personalization.getPreview()
        fs.appendFileSync(DEBUG_LOG_PATH, `${JSON.stringify({
          sequence: ++debugSequence,
          timestamp: new Date().toISOString(),
          event,
          ...(action === undefined ? {} : { action }),
          monitorId: current.id,
          effective: {
            wallpaperId: effectiveWallpaper.id,
            ...effectiveDisplay,
          },
          durable: {
            wallpaperId: durableWallpaper.id,
            ...durableDisplay,
          },
          preview: preview === undefined
            ? null
            : {
              id: preview.id,
              ownerId: preview.ownerId,
              monitorId: preview.monitorId ?? null,
              startedAt: preview.startedAt,
              deadline: preview.deadline ?? null,
              hasAppearance: preview.patch.appearance !== undefined,
              wallpaperPatch: preview.patch.wallpaper ?? null,
            },
          ...extra,
        })}\n`)
      } catch (error) {
        console.warn('Phase 16C debug logger failed:', error)
      }
    }
    const status = async (message: string): Promise<void> => {
      const current = target()
      const display = ctx.home.personalization.getDisplayPreferences(current.id)
      const wallpaper = ctx.home.personalization.getActiveWallpaper(current.id)
      const preview = ctx.home.personalization.getPreview()
      const previewText = preview === undefined
        ? 'none'
        : preview.deadline === undefined
          ? 'ACTIVE — wallpaper-only, no timeout'
          : `ACTIVE until ${new Date(preview.deadline).toLocaleTimeString()}`
      const text = [
        `Target: ${targetName()} (${current.id})`,
        `Wallpaper: ${wallpaper.name} [${wallpaper.id}] | fit=${display.fit} | dim=${display.dim}% | blur=${display.blur}px | saturation=${display.saturation}%`,
        `Internet photo: ${internetWallpaperReady ? 'READY — NASA/Wikimedia downloaded locally' : 'UNAVAILABLE'}`,
        `Preview: ${previewText}`,
        `Home JSON: ${ctx.home.persistence.filePath}`,
        `Debug log: ${DEBUG_LOG_PATH}`,
        message,
      ].join('\n')
      console.log(text.replaceAll('\n', ' | '))
      await panel.postMessage({ type: 'phase16c/status', text }).catch(() => false)
    }

    unbindWallpaperDebug = ctx.home.wallpaper.onChange(() => {
      debugState('durable-wallpaper-change')
    })

    let observedPreviewId = ctx.home.personalization.getPreview()?.id
    previewObserver = setInterval(() => {
      const currentPreviewId = ctx.home.personalization.getPreview()?.id
      if (currentPreviewId === observedPreviewId) return
      debugState('preview-transition-observed', undefined, {
        previousPreviewId: observedPreviewId ?? null,
        currentPreviewId: currentPreviewId ?? null,
      })
      observedPreviewId = currentPreviewId
    }, 250)

    const startWallpaperPreview = async (patch: Parameters<typeof ctx.home.personalization.beginPreview>[0]): Promise<void> => {
      const wallpaperPatch = patch.wallpaper
      if (wallpaperPatch === undefined) return
      const currentPreview = ctx.home.personalization.getPreview()
      const targetMonitorId = target().id
      const canUpdate = activePreview !== undefined
        && currentPreview !== undefined
        && currentPreview.id === activePreview.id
        && (currentPreview.monitorId === undefined || currentPreview.monitorId === targetMonitorId)

      if (canUpdate) {
        activePreview.updateWallpaper(wallpaperPatch)
      } else {
        activePreview?.revert()
        activePreview = ctx.home.personalization.beginPreview(
          { wallpaper: wallpaperPatch },
          {
            ownerId: 'phase16c-personalization-panel',
            monitorId: targetMonitorId,
          },
        )
      }
      await status('Stable preview updated in place. The selected wallpaper ID stays constant while fit/effects change.')
    }

    ctx.on('surface/message', ({ surface, message }) => {
      if (surface.id !== panel.id) return
      let parsed: unknown
      try { parsed = JSON.parse(message) } catch { return }
      if (parsed === null || typeof parsed !== 'object') return
      const action = (parsed as { readonly type?: string; readonly action?: string }).action
      if ((parsed as { readonly type?: string }).type !== 'phase16c/action' || action === undefined) return

      debugState('action-before', action)
      void (async () => {
        if (action === 'target-next') {
          activePreview?.revert()
          activePreview = undefined
          targetIndex = (targetIndex + 1) % monitors.length
          await movePanelToMonitor(panel, target())
          await status(monitors.length === 1
            ? 'Only one monitor is connected, so the panel remains on this display.'
            : 'Changed target monitor and moved this control panel onto it.')
          return
        }
        if (action.startsWith('preset:')) {
          activePreview?.revert()
          activePreview = ctx.home.personalization.beginPresetPreview(action.slice('preset:'.length), {
            ownerId: 'phase16c-personalization-panel',
          })
          await status('Coordinated preset preview started globally. Appearance safety timeout is at least 60 seconds; fit/effect edits stay in this same preview.')
          return
        }
        if (action.startsWith('wallpaper:')) {
          await startWallpaperPreview({ wallpaper: { activeId: action.slice('wallpaper:'.length) } })
          return
        }
        if (action.startsWith('fit:')) {
          const fit = action.slice('fit:'.length)
          if (fit === 'cover' || fit === 'contain' || fit === 'stretch' || fit === 'center' || fit === 'tile') {
            await startWallpaperPreview({ wallpaper: { fit } })
          }
          return
        }
        if (action === 'dim:+' || action === 'dim:-') {
          const current = ctx.home.personalization.getDisplayPreferences(target().id)
          const delta = action === 'dim:+' ? 20 : -20
          await startWallpaperPreview({ wallpaper: { dim: Math.max(0, Math.min(100, current.dim + delta)) } })
          return
        }
        if (action === 'blur:+' || action === 'blur:-') {
          const current = ctx.home.personalization.getDisplayPreferences(target().id)
          const delta = action === 'blur:+' ? 8 : -8
          await startWallpaperPreview({ wallpaper: { blur: Math.max(0, Math.min(50, current.blur + delta)) } })
          return
        }
        if (action === 'saturation:+' || action === 'saturation:-') {
          const current = ctx.home.personalization.getDisplayPreferences(target().id)
          const delta = action === 'saturation:+' ? 25 : -25
          await startWallpaperPreview({ wallpaper: { saturation: Math.max(0, Math.min(200, current.saturation + delta)) } })
          return
        }
        if (action === 'keep') {
          const kept = activePreview === undefined ? false : await activePreview.keep()
          activePreview = undefined
          await status(kept
            ? 'Preview committed to the durable authority. Home will persist it through its normal save debounce.'
            : 'No current preview to keep.')
          return
        }
        if (action === 'save') {
          const kept = activePreview === undefined ? false : await activePreview.keep()
          activePreview = undefined
          if (!kept) {
            await status('No current preview to save. Select/edit a wallpaper first.')
            return
          }
          await ctx.home.saveState()
          const saved = JSON.parse(fs.readFileSync(ctx.home.persistence.filePath, 'utf8')) as {
            readonly wallpaper?: { readonly activeId?: string; readonly monitorOverrides?: Record<string, { readonly activeId?: string }> }
          }
          const savedId = saved.wallpaper?.monitorOverrides?.[target().id]?.activeId ?? saved.wallpaper?.activeId ?? 'unknown'
          debugState('json-save-complete', action, { savedWallpaperId: savedId, persistencePath: ctx.home.persistence.filePath })
          await status(`SAVED TO JSON NOW. Persisted wallpaper for this target resolves to [${savedId}]. The file is ready to inspect immediately.`)
          return
        }
        if (action === 'revert') {
          const reverted = activePreview?.revert() ?? false
          activePreview = undefined
          await status(reverted ? 'Preview reverted without persistence.' : 'No current preview to revert.')
          return
        }
        if (action === 'follow-global') {
          activePreview?.revert()
          activePreview = undefined
          const changed = ctx.home.wallpaper.resetMonitorOverride(target().id)
          await status(changed ? 'Target monitor now follows global wallpaper settings.' : 'Target monitor already followed global settings.')
          return
        }
        if (action === 'reset-target') {
          activePreview?.revert()
          activePreview = undefined
          await ctx.home.personalization.reset(target().id)
          await status('Target monitor personalization reset.')
          return
        }
        if (action === 'reset-all') {
          activePreview?.revert()
          activePreview = undefined
          await ctx.home.personalization.reset()
          await status('Global Home personalization and normal UI appearance reset.')
        }
      })().then(() => {
        debugState('action-after', action)
      }).catch((error: unknown) => {
        debugState('action-error', action, {
          error: error instanceof Error ? error.message : String(error),
        })
        console.error(error)
        void status(`ERROR: ${error instanceof Error ? error.message : String(error)}`)
      })
    })

    debugState('harness-ready')
    await status('Ready. Wallpaper-only edits have no timeout. Use Save to JSON now when you want to prove the selected state is durable.')
    console.log('PASS criteria:')
    console.log('1. Wallpaper-only previews never auto-revert, regardless of how long you edit.')
    console.log('2. Coordinated presets that include shell appearance have a safety timeout of at least 60 seconds.')
    console.log('3. Any selected wallpaper remains selected while fit, dim, blur, and saturation change.')
    console.log('4. Save to JSON now commits the preview and immediately writes Home persistence.')
    console.log('5. After Save, Preview becomes none and Durable matches the selected wallpaper/effects.')
    console.log(`Home JSON (while harness is running): ${ctx.home.persistence.filePath}`)
    console.log(`Debug log: ${DEBUG_LOG_PATH}`)
    console.log('Type q and Enter in this terminal to exit.')

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    await new Promise<void>((resolve) => {
      rl.on('line', (line) => {
        if (line.trim().toLowerCase() !== 'q') return
        activePreview?.revert()
        activePreview = undefined
        rl.close()
        resolve()
      })
    })

    debugState('harness-exit')
    if (previewObserver !== undefined) clearInterval(previewObserver)
    previewObserver = undefined
    unbindWallpaperDebug?.()
    unbindWallpaperDebug = undefined
    await ctx.home.saveState()
    await ctx.fiber.dispose()
    await bridge.dispose()
    fs.rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } catch (error) {
    if (previewObserver !== undefined) clearInterval(previewObserver)
    unbindWallpaperDebug?.()
    try {
      await ctx.fiber.dispose()
      await bridge.dispose()
    } catch {}
    fs.rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    throw error
  }
}

runPersonalizationVisualTest().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
