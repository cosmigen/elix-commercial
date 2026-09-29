import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import { createNativeBridge } from '@deepseek-ai/dsh-native-core'
import { SurfaceService } from '@deepseek-ai/dsh-surface'
import WindowsContextService from '@deepseek-ai/dsh-windows-context'
import OverlayService from '@deepseek-ai/dsh-shell-overlay'
import {
  generateThemeTokensCss,
  generateUiFoundationCss,
  UI_FOUNDATION_RENDERER_BRIDGE_SCRIPT,
  UiFoundationService,
} from '@deepseek-ai/dsh-ui-foundation'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function captureWindow(hwnd: number, name: string): void {
  const pngPath = path.resolve(process.cwd(), '.agents', 'reports', 'visual-audit', 'evidence', `${name}.png`)
  const script = path.resolve(process.cwd(), '.audit', 'phase1-through-16d', 'capture_window.ps1')
  execFileSync('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-File', script, String(hwnd), pngPath], { stdio: 'inherit' })
  console.log(`[CAPTURED] ${path.basename(pngPath)}`)
}

const HOST_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ELIX Phase 16B Gallery</title><style>:root{${generateThemeTokensCss()}${generateUiFoundationCss()}}body{margin:0;padding:24px;background:var(--elix-surface-background);color:var(--elix-text-primary);font-family:var(--elix-font-ui)}h1{font-size:var(--elix-text-xl);margin:0 0 8px}.muted{color:var(--elix-text-muted)}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:18px}.card{min-width:0;padding:16px;background:var(--elix-surface-glass);border:1px solid var(--elix-surface-border);border-radius:var(--elix-radius-xl)}button,input{min-height:var(--elix-hit-target);font:inherit}.row{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}.elix-control,.elix-search{padding:8px 12px;border-radius:var(--elix-radius-md);border:1px solid var(--elix-control-border);background:var(--elix-control-background);color:var(--elix-text-primary)}.motion{height:40px;border:1px solid var(--elix-surface-border);border-radius:var(--elix-radius-md);overflow:hidden}.dot{width:24px;height:24px;margin:8px;background:var(--elix-accent);border-radius:50%;animation:slide 1s ease-in-out infinite alternate}@keyframes slide{to{transform:translateX(220px)}}[data-elix-reduce-motion="true"] .dot{animation:none!important}.probe{font-size:var(--elix-text-lg);line-height:1.4}@media(max-width:760px){.grid{grid-template-columns:1fr}}</style></head><body><h1>ELIX UI Foundation <span class="muted">PHASE 16B</span></h1><p class="muted">Visual acceptance: theme, high contrast, text scale, reduced motion, opaque fallback, and themed overlay.</p><div class="grid"><section class="card"><h2>Controls</h2><div class="row"><button class="elix-control">Primary action</button><button class="elix-control" disabled>Disabled</button><label class="elix-control"><input type="checkbox" checked> Enabled</label></div></section><section class="card"><h2>Search and status</h2><input class="elix-search" placeholder="Search settings" aria-label="Search settings"><p role="status">Ready for visual audit</p></section><section class="card"><h2>200% text probe</h2><p class="probe">This text and the controls must grow and reflow without overlap.</p></section><section class="card"><h2>Reduced motion probe</h2><div class="motion"><div class="dot"></div></div></section></div><script>${UI_FOUNDATION_RENDERER_BRIDGE_SCRIPT}</script></body></html>`
const OVERLAY_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>:root{${generateThemeTokensCss()}${generateUiFoundationCss()}}body{margin:0;padding:16px;background:transparent;color:var(--elix-text-primary);font-family:var(--elix-font-ui)}.elix-popover{padding:16px;background:var(--elix-surface-glass);border:1px solid var(--elix-surface-border);border-radius:var(--elix-radius-xl);box-shadow:var(--elix-surface-shadow-lg)}</style></head><body><div class="elix-popover" role="dialog" aria-label="Themed overlay"><h2>Live themed overlay</h2><p>Shares the 16B UI state.</p><button class="elix-control">Focusable action</button></div><script>${UI_FOUNDATION_RENDERER_BRIDGE_SCRIPT}</script></body></html>`

async function main(): Promise<void> {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'elix-phase16b-visual-audit-'))
  const bridge = createNativeBridge()
  const ctx = new Context()
  try {
    await bridge.connect()
    await ctx.plugin(WindowsContextService, { enabled: true, bridge })
    await ctx.plugin(SurfaceService, { enabled: true, bridge, defaultUserDataFolder: stateDir })
    await ctx.plugin(OverlayService, { enabled: true })
    await ctx.plugin(UiFoundationService, { enabled: true, persistencePath: path.join(stateDir, 'preferences.json') })
    const primary = ctx.windowsContext.getPrimaryMonitor()
    const host = await ctx.surface.create({
      id: 'phase16b-visual-audit-host',
      bounds: { x: primary.workArea.x + 40, y: primary.workArea.y + 40, width: 1040, height: 780 },
      renderer: { type: 'html', target: HOST_HTML },
      visible: true,
    })
    await host.whenReady()
    await sleep(700)
    captureWindow(host.hwnd, 'P16B_ui_runner_dark')

    await ctx.uiFoundation.setUserPreferences({ appearance: { colorScheme: 'light' } })
    await sleep(400)
    captureWindow(host.hwnd, 'P16B_ui_runner_light')

    await ctx.uiFoundation.setAccessibilityOverrides({ highContrast: true })
    await sleep(400)
    captureWindow(host.hwnd, 'P16B_ui_runner_high_contrast')

    await ctx.uiFoundation.setAccessibilityOverrides({ highContrast: false, textScale: 2 })
    await sleep(400)
    captureWindow(host.hwnd, 'P16B_ui_runner_200pct_text')

    await ctx.uiFoundation.setAccessibilityOverrides({ textScale: 1, reduceMotion: true })
    await sleep(400)
    captureWindow(host.hwnd, 'P16B_ui_runner_reduced_motion')

    await ctx.uiFoundation.setAccessibilityOverrides({ reduceMotion: false, reduceTransparency: true })
    await sleep(400)
    captureWindow(host.hwnd, 'P16B_ui_runner_opaque_fallback')

    await ctx.uiFoundation.setAccessibilityOverrides({ reduceTransparency: false })
    ctx.overlay.register({
      id: 'phase16b-visual-audit-overlay',
      ownerId: host.id,
      size: { width: 380, height: 220 },
      defaultPlacement: 'bottom-start',
      focusPolicy: 'activate',
      dismiss: { escape: true, outsideClick: true },
      renderer: { type: 'html', target: OVERLAY_HTML },
    })
    const handle = await ctx.overlay.open({
      definitionId: 'phase16b-visual-audit-overlay',
      anchor: { type: 'point', x: host.bounds.x + 120, y: host.bounds.y + 120 },
    })
    await sleep(500)
    const overlay = handle.surface ?? ctx.surface.get(handle.surfaceId)
    if (!overlay) throw new Error('Phase 16B themed overlay surface was not created')
    captureWindow(overlay.hwnd, 'P16B_ui_runner_themed_overlay')
    await ctx.overlay.close(handle.instanceId)
    console.log('PHASE 16B VISUAL RUNNER PASSED')
  } finally {
    await ctx.overlay?.closeAll().catch(() => undefined)
    await ctx.fiber.dispose().catch(() => undefined)
    await bridge.dispose().catch(() => undefined)
    try { fs.rmSync(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) } catch (error) {
      console.warn(`Phase 16B temporary cleanup was not complete: ${String(error)}`)
    }
  }
}

main().catch(error => {
  console.error('PHASE 16B VISUAL RUNNER FAILED')
  console.error(error)
  process.exitCode = 1
})
