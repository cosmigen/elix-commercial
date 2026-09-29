import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as readline from 'node:readline'
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
} from '../src/index.ts'

const TOKEN_CSS = generateThemeTokensCss()
const FOUNDATION_CSS = generateUiFoundationCss()

function documentHtml(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>
:root{${TOKEN_CSS}}
${FOUNDATION_CSS}
html,body{max-width:100%;overflow-x:hidden;}
body{margin:0;padding:24px;background:var(--elix-surface-background);color:var(--elix-text-primary);font-family:var(--elix-font-ui);min-height:100vh;}
h1{font-size:var(--elix-text-xl);margin:0 0 6px}.muted{color:var(--elix-text-muted)}
.toolbar{display:flex;flex-wrap:wrap;gap:8px;margin:18px 0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(280px,100%),1fr));gap:12px;align-items:start}
.card{min-width:0;background:var(--elix-surface-glass);border:1px solid var(--elix-surface-border);border-radius:var(--elix-radius-xl);padding:16px;box-shadow:var(--elix-surface-shadow-sm);overflow-wrap:anywhere}
.card h2{font-size:var(--elix-text-md);margin:0 0 12px}.row{display:flex;align-items:center;flex-wrap:wrap;gap:10px;min-height:var(--elix-hit-target)}
.long{line-height:1.45}.status{margin-top:16px;padding:12px;border:1px solid var(--elix-divider);border-radius:var(--elix-radius-md);font-family:var(--elix-font-mono);font-size:var(--elix-text-xs)}
.motion-track{height:48px;border:1px solid var(--elix-surface-border);border-radius:var(--elix-radius-md);display:flex;align-items:center;padding:6px;overflow:hidden;background:var(--elix-surface-background)}
.motion-probe{width:28px;height:28px;border-radius:50%;background:var(--elix-accent);box-shadow:0 0 0 4px var(--elix-accent-glow);animation:elix-motion-probe 1.2s ease-in-out infinite alternate}
@keyframes elix-motion-probe{from{transform:translateX(0)}to{transform:translateX(180px)}}
[data-elix-reduce-motion="true"] .motion-probe{animation:none!important;transform:translateX(0)!important}
.scale-probe{font-size:var(--elix-text-lg);line-height:1.4;padding:8px 0}
@media(max-width:820px){body{padding:16px}}
</style></head><body>${body}<script>${UI_FOUNDATION_RENDERER_BRIDGE_SCRIPT}</script><script>
function send(action){if(window.chrome&&window.chrome.webview)window.chrome.webview.postMessage({type:'ui-demo/action',action:action});}
if(window.chrome&&window.chrome.webview){window.chrome.webview.addEventListener('message',function(event){var data=event.data;if(data&&data.type==='ui-demo/status'){var status=document.getElementById('status');if(status)status.textContent=String(data.text||'');}});}
</script></body></html>`
}

const HOST_HTML = documentHtml('ELIX Phase 16B Gallery', `
<h1>ELIX UI Foundation <span class="muted">PHASE 16B</span></h1>
<div class="muted">Shared preferences, accessibility, focus, motion, and component contract acceptance.</div>
<div class="toolbar">
<button class="elix-control elix-button" onclick="send('dark')">Dark</button>
<button class="elix-control elix-button" onclick="send('light')">Light</button>
<button class="elix-control elix-button" onclick="send('system')">Follow Windows</button>
<button class="elix-control elix-button" onclick="send('contrast')">High contrast</button>
<button class="elix-control elix-button" onclick="send('text200')">200% text</button>
<button class="elix-control elix-button" onclick="send('motion')">Reduced motion</button>
<button class="elix-control elix-button" onclick="send('transparency')">Opaque fallback</button>
<button class="elix-control elix-button" onclick="send('preview')">15s Preview</button>
<button class="elix-control elix-button" onclick="send('overlay')">Open themed overlay</button>
</div>
<div class="grid">
<section class="card"><h2>Buttons & disabled</h2><div class="row"><button class="elix-control elix-button">Primary action</button><button class="elix-control elix-button" disabled>Disabled</button></div></section>
<section class="card"><h2>Toggle & slider</h2><label class="elix-control elix-toggle"><input type="checkbox" role="switch" checked> Enabled</label><input class="elix-slider" type="range" min="0" max="100" value="65" aria-label="Volume"></section>
<section class="card"><h2>Segmented & tabs</h2><div class="elix-segmented" role="radiogroup"><button class="elix-control elix-button" role="radio" aria-checked="true">A</button><button class="elix-control elix-button" role="radio">B</button></div><div class="elix-tabs" role="tablist"><button class="elix-control elix-button elix-tab" role="tab" aria-selected="true">General</button><button class="elix-control elix-button elix-tab" role="tab">Advanced</button></div></section>
<section class="card"><h2>Search & list</h2><input class="elix-search" role="searchbox" placeholder="Search settings" aria-label="Search settings"><ul class="elix-list" role="listbox"><li class="elix-listitem" role="option" tabindex="0">Appearance</li><li class="elix-listitem" role="option">Accessibility</li></ul></section>
<section class="card"><h2>Menu & popover</h2><div class="elix-menu" role="menu"><div class="elix-menuitem" role="menuitem" tabindex="0">Open</div><div class="elix-menuitem" role="menuitem">Rename</div></div><div class="elix-popover" role="dialog">Popover content</div></section>
<section class="card"><h2>Status states</h2><div role="status" class="elix-muted">Loading…</div><div role="alert" class="elix-error">Example error</div><div class="elix-success">Ready</div><progress class="elix-progress" value="70" max="100">70%</progress></section>
<section class="card"><h2>200% text probe</h2><div class="scale-probe">This sentence and the controls around it must visibly grow when 200% text is enabled. The cards should reflow instead of overlapping.</div></section>
<section class="card"><h2>Reduced-motion probe</h2><div class="motion-track" aria-label="Motion test"><div class="motion-probe"></div></div><p class="long">The dot moves while motion is enabled. It must stop immediately when Reduced motion is turned on.</p></section>
<section class="card"><h2>Dialog semantics</h2><div class="elix-dialog" role="dialog" aria-modal="true" aria-label="Example dialog"><p>Keyboard focus and Escape behavior are owned by the consumer using the shared contract.</p><button class="elix-control elix-button">Confirm</button></div></section>
<section class="card"><h2>Long translated-text stress</h2><p class="long">This deliberately long shell label demonstrates that shared controls remain readable when localization produces substantially longer text than English.</p></section>
<section class="card"><h2>Keyboard/Narrator</h2><p class="long">Tab through controls. Focus must remain visible. Native button, input, switch, listbox, tab, dialog, alert, status and progress roles remain available to accessibility APIs.</p></section>
</div>
<div id="status" class="status" aria-live="polite">Ready. Resize or move this window across mixed-DPI monitors while testing.</div>
`)

const OVERLAY_HTML = documentHtml('ELIX Themed Overlay', `
<div class="elix-popover" role="dialog" aria-label="Themed overlay"><h1>Live Overlay</h1><p>This WebView receives the same UI-state message as the gallery.</p><button class="elix-control elix-button">Focusable action</button></div>
`)

export async function runVisualTest(): Promise<void> {
  console.log('Starting ELIX Phase 16B visual acceptance gallery...')
  const bridge = createNativeBridge()
  await bridge.connect()
  const userDataFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'elix-ui-foundation-'))
  const preferencePath = path.join(userDataFolder, 'preferences.json')
  const ctx = new Context()

  await ctx.plugin(WindowsContextService, { enabled: true, bridge })
  await ctx.plugin(SurfaceService, { enabled: true, bridge, defaultUserDataFolder: userDataFolder })
  await ctx.plugin(OverlayService, { enabled: true })
  await ctx.plugin(UiFoundationService, { enabled: true, persistencePath: preferencePath })

  const primary = ctx.windowsContext.getPrimaryMonitor()
  const width = Math.min(1100, Math.max(760, primary.workArea.width - 100))
  const height = Math.min(820, Math.max(620, primary.workArea.height - 100))
  const host = await ctx.surface.create({
    id: 'phase16b-gallery',
    bounds: {
      x: primary.workArea.x + Math.round((primary.workArea.width - width) / 2),
      y: primary.workArea.y + Math.round((primary.workArea.height - height) / 2),
      width,
      height,
    },
    renderer: { type: 'html', target: HOST_HTML },
    visible: true,
  })
  await host.whenReady()

  ctx.overlay.register({
    id: 'phase16b-themed-overlay',
    ownerId: 'phase16b-gallery',
    size: { width: 360, height: 210 },
    defaultPlacement: 'bottom-start',
    focusPolicy: 'activate',
    dismiss: { escape: true, outsideClick: true },
    renderer: { type: 'html', target: OVERLAY_HTML },
  })

  let contrast = false
  let text200 = false
  let reducedMotion = false
  let opaque = false

  const status = async (text: string): Promise<void> => {
    console.log(text)
    await host.postMessage({ type: 'ui-demo/status', text }).catch(() => false)
  }

  ctx.on('surface/message', ({ surface, message }) => {
    if (surface.id !== host.id) return
    let data: unknown
    try { data = JSON.parse(message) } catch { return }
    if (!data || typeof data !== 'object') return
    const action = (data as { action?: string }).action
    if (!action) return
    void (async () => {
      switch (action) {
        case 'dark':
          await ctx.uiFoundation.setUserPreferences({ appearance: { colorScheme: 'dark' } })
          await status('Dark mode applied in place.')
          break
        case 'light':
          await ctx.uiFoundation.setUserPreferences({ appearance: { colorScheme: 'light' } })
          await status('Light mode applied in place.')
          break
        case 'system':
          await ctx.uiFoundation.setUserPreferences({ appearance: { colorScheme: 'system' } })
          await status('Following the current Windows color scheme.')
          break
        case 'contrast':
          contrast = !contrast
          await ctx.uiFoundation.setAccessibilityOverrides({ highContrast: contrast })
          await status(`High contrast ${contrast ? 'enabled' : 'disabled'}.`)
          break
        case 'text200':
          text200 = !text200
          await ctx.uiFoundation.setAccessibilityOverrides({ textScale: text200 ? 2 : 1 })
          await status(`Text scale ${text200 ? '200%' : '100%'}. Text and controls should visibly resize and the grid should reflow.`)
          break
        case 'motion':
          reducedMotion = !reducedMotion
          await ctx.uiFoundation.setAccessibilityOverrides({ reduceMotion: reducedMotion })
          await status(`Reduced motion ${reducedMotion ? 'enabled — the motion probe must be stopped' : 'disabled — the motion probe should move'}.`)
          break
        case 'transparency':
          opaque = !opaque
          await ctx.uiFoundation.setAccessibilityOverrides({ reduceTransparency: opaque })
          await status(`Opaque fallback ${opaque ? 'enabled' : 'disabled'}.`)
          break
        case 'preview': {
          ctx.uiFoundation.beginPreview({ appearance: { accentColor: '#a855f7', density: 'comfortable' } }, { ownerId: 'phase16b-gallery' })
          await status('Preview active for 15 seconds; it will revert automatically unless kept by API.')
          break
        }
        case 'overlay': {
          await ctx.overlay.open({
            definitionId: 'phase16b-themed-overlay',
            anchor: { type: 'point', x: host.bounds.x + 120, y: host.bounds.y + 120 },
          })
          await status('Real Overlay surface opened. Change themes; it must update in place without closing.')
          break
        }
      }
    })()
  })

  console.log('PASS criteria:')
  console.log('1. Light/dark/system change in place without recreating the gallery HWND.')
  console.log('2. High contrast remains readable; focus outlines are obvious.')
  console.log('3. 200% text visibly doubles body/control text and the gallery reflows without overlap.')
  console.log('4. Reduced motion stops the visible motion probe immediately; opaque fallback removes blur.')
  console.log('5. Open themed overlay, then change theme: overlay stays open and updates in place.')
  console.log('6. Keyboard Tab focus is visible; Narrator exposes native semantic roles.')
  console.log('7. Move gallery between mixed-DPI monitors; controls remain usable.')

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  console.log('Type q and Enter to exit.')
  await new Promise<void>((resolve) => {
    rl.on('line', (line) => {
      if (line.trim().toLowerCase() !== 'q') return
      void (async () => {
        ctx.uiFoundation.releasePreviewOwner('phase16b-gallery')
        await ctx.overlay.closeAll()
        await ctx.fiber.dispose()
        await bridge.dispose()
        fs.rmSync(userDataFolder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
        rl.close()
        resolve()
      })()
    })
  })
}

runVisualTest().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
