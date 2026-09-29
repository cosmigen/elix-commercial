/**
 * Launch-time adapter for the Phase 17 acceptance console.
 *
 * DWM thumbnails require a top-level destination HWND, but multiple thumbnails can
 * target different rectangles in the same top-level HWND. The console therefore uses
 * its own Surface HWND for both preview panes instead of creating helper Surface HWNDs.
 * This keeps Preview A/B genuinely embedded in the dashboard and avoids z-order drift.
 */

import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const sourcePath = join(here, 'index.ts')
const runtimePath = join(here, `.phase17-runtime-${process.pid}.ts`)

let source = readFileSync(sourcePath, 'utf8')

function replaceExactly(label: string, before: string, after: string): void {
  const first = source.indexOf(before)
  if (first < 0) throw new Error(`Phase 17 console launcher could not locate ${label}.`)
  if (source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`Phase 17 console launcher found more than one ${label}; refusing an ambiguous patch.`)
  }
  source = source.replace(before, after)
}

replaceExactly(
  'console width policy',
  '  const width = Math.min(1180, Math.max(940, primary.workArea.width - 60))',
  '  const width = Math.min(1060, Math.max(860, Math.floor(primary.workArea.width * 0.68)))',
)
replaceExactly(
  'console height policy',
  '  const height = Math.min(880, Math.max(720, primary.workArea.height - 60))',
  '  const height = Math.min(740, Math.max(640, Math.floor(primary.workArea.height * 0.68)))',
)

// Do not offer cloaked/hidden helper HWNDs as acceptance targets. Minimized windows stay
// selectable because Phase 17A explicitly supports their live DWM preview path.
replaceExactly(
  'target composability filter',
  `function isTargetCandidate(window: WindowSnapshot): boolean {
  return (
    window.isVisible
    && !window.isShellWindow
    && (window.classification === 'APPLICATION' || window.classification === 'TOOL' || window.classification === 'TRANSIENT')
  )
}`,
  `function isTargetCandidate(window: WindowSnapshot): boolean {
  return (
    window.isVisible
    && !window.isCloaked
    && window.state !== 'hidden'
    && !window.isShellWindow
    && (window.classification === 'APPLICATION' || window.classification === 'TOOL' || window.classification === 'TRANSIENT')
  )
}`,
)
replaceExactly(
  'target option diagnostics',
  "function optionLabel(w){return (w.title||'(untitled)')+' · '+w.className+' · PID '+w.processId}",
  "function optionLabel(w){return (w.title||'(untitled)')+' · '+w.className+' · '+w.state+' · PID '+w.processId}",
)

// The DWM pixels are composed into the main console HWND. Every DOM ancestor covering
// the two destination rectangles must therefore stay transparent.
replaceExactly(
  'dashboard body transparency',
  '  body{background:rgba(7,10,16,.94)}',
  '  body{background:transparent}',
)
replaceExactly(
  'preview zone transparency',
  '  .preview-zone{position:absolute;left:0;right:0;top:84px;height:318px;padding:12px 20px 14px;display:grid;grid-template-columns:1fr 1fr;gap:16px;background:linear-gradient(180deg,rgba(12,17,26,.94),rgba(9,13,20,.74))}',
  '  .preview-zone{position:absolute;left:0;right:0;top:84px;height:318px;padding:12px 20px 14px;display:grid;grid-template-columns:1fr 1fr;gap:16px;background:transparent}',
)
replaceExactly(
  'preview card transparency',
  '  .preview-card{position:relative;border:1px solid rgba(255,255,255,.10);border-radius:13px;background:rgba(16,23,34,.72);overflow:hidden}',
  '  .preview-card{position:relative;border:1px solid rgba(255,255,255,.10);border-radius:13px;background:transparent;overflow:hidden}',
)

replaceExactly(
  'preview acquisition destination',
  "    const destinationSurfaceId = which === 'A' ? 'phase17:test-preview-a' : 'phase17:test-preview-b'\n    const lease = await ctx.windowPreview.acquirePreview({",
  "    const destinationSurfaceId = CONSOLE_SURFACE_ID\n    const lease = await ctx.windowPreview.acquirePreview({",
)
replaceExactly(
  'preview acquisition rectangle',
  '      destinationRect: { x: 0, y: 0, width: rect.width, height: rect.height },',
  '      destinationRect: rect,',
)
replaceExactly(
  'preview failure diagnostics',
  "    setCheck(which === 'A' ? 'previewA' : 'previewB', latest.state === 'live' ? 'pass' : 'fail', `state=${latest.state}, backend=${latest.backend}`)",
  "    setCheck(which === 'A' ? 'previewA' : 'previewB', latest.state === 'live' ? 'pass' : 'fail', `state=${latest.state}, backend=${latest.backend}, reason=${latest.reason ?? '-'}`)",
)

replaceExactly(
  'budget preview destination',
  "      destinationSurfaceId: 'phase17:test-preview-a',\n      destinationRect: { x: 6, y: 6, width: 120, height: 72 },",
  "      destinationSurfaceId: CONSOLE_SURFACE_ID,\n      destinationRect: { x: geometry.stageA.x + 6, y: geometry.stageA.y + 6, width: 120, height: 72 },",
)

replaceExactly(
  'minimize acceptance label',
  "  previewMinimize: { label: '17A minimize fallback and restore recovery', state: 'idle', detail: '' },",
  "  previewMinimize: { label: '17A minimized source remains LIVE and restores cleanly', state: 'idle', detail: '' },",
)
replaceExactly(
  'minimize acceptance policy',
  "    const unavailable = during.every(state => state === 'unavailable' || state === 'paused')\n    const live = after.every(state => state === 'live')\n    const restoredNative = ctx.windowPreview.getStats().nativeBindings\n    const ok = unavailable && minimizedNative === 0 && live && restoredNative === 2",
  "    const minimizedLive = during.every(state => state === 'live')\n    const live = after.every(state => state === 'live')\n    const restoredNative = ctx.windowPreview.getStats().nativeBindings\n    const ok = minimizedLive && minimizedNative === 2 && live && restoredNative === 2",
)

// Remove the two helper top-level preview windows completely. Preview leases now resolve
// their destination directly to CONSOLE_SURFACE_ID and use stageA/stageB as destinationRects.
replaceExactly(
  'helper preview surfaces',
  `    const consoleBounds = surface.bounds
    previewSurfaceA = await ctx.surface.create({
      id: 'phase17:test-preview-a',
      bounds: {
        x: consoleBounds.x + geometry.stageA.x,
        y: consoleBounds.y + geometry.stageA.y,
        width: geometry.stageA.width,
        height: geometry.stageA.height,
      },
      monitorId: primary.id,
      renderer: { type: 'html', target: previewSurfaceHtml('Preview A') },
      focusPolicy: 'noActivate',
      zOrderPolicy: 'topmost',
      skipTaskbar: true,
      transparent: true,
      visible: false,
      userDataFolder: join(tempDir, 'webview2-preview-a'),
    })
    previewSurfaceB = await ctx.surface.create({
      id: 'phase17:test-preview-b',
      bounds: {
        x: consoleBounds.x + geometry.stageB.x,
        y: consoleBounds.y + geometry.stageB.y,
        width: geometry.stageB.width,
        height: geometry.stageB.height,
      },
      monitorId: primary.id,
      renderer: { type: 'html', target: previewSurfaceHtml('Preview B') },
      focusPolicy: 'noActivate',
      zOrderPolicy: 'topmost',
      skipTaskbar: true,
      transparent: true,
      visible: false,
      userDataFolder: join(tempDir, 'webview2-preview-b'),
    })
    await Promise.all([previewSurfaceA.whenReady(), previewSurfaceB.whenReady()])
    await Promise.all([previewSurfaceA.show(), previewSurfaceB.show()])`,
  `    // Preview A/B intentionally share the main console's top-level HWND.
    // DWM composes each lease into its own destination rectangle inside this Surface.`,
)

writeFileSync(runtimePath, source, 'utf8')
try {
  await import(`${pathToFileURL(runtimePath).href}?pid=${process.pid}`)
} finally {
  rmSync(runtimePath, { force: true })
}
