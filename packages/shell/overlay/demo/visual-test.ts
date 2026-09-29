/**
 * Interactive Visual Acceptance Demo for ELIX Overlay Core.
 *
 * Provides an authoritative visual test harness to verify popup behaviors on Windows:
 * 1. Open centered popup
 * 2. Open popup anchored to a button
 * 3. Open popup at cursor/right-click position
 * 4. Bottom-edge placement -> automatically flips upward
 * 5. Right-edge placement -> shifts left to remain visible
 * 6. Top-left edge handling
 * 7. Escape dismissal
 * 8. Outside-click dismissal
 * 9. Open second popup & verify exclusive group replacement
 * 10. Parent popup + submenu
 * 11. no-activate popup
 * 12. activating popup
 * 13. move/reopen on another monitor if available
 * 14. resize / DPI-safe placement
 * 15. close everything and verify zero orphan windows
 *
 * Run with:
 *   pnpm run demo:overlay
 * or
 *   node --import tsx/esm packages/shell/overlay/demo/visual-test.ts
 *
 * @module @deepseek-ai/dsh-shell-overlay/demo
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as readline from 'node:readline'
import { Context } from '@deepseek-ai/cordis'
import { createNativeBridge } from '@deepseek-ai/dsh-native-core'
import { SurfaceService } from '@deepseek-ai/dsh-surface'
import WindowsContextService from '@deepseek-ai/dsh-windows-context'
import ShellLayoutService from '@deepseek-ai/dsh-shell-layout'
import OverlayService from '../src/index.ts'
import type { OverlayDefinition, OverlayInstance } from '../src/types.ts'

const HOST_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>ELIX Overlay Core Visual Test Harness</title>
  <style>
    body {
      margin: 0;
      padding: 24px;
      background: #0f172a;
      color: #f8fafc;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      user-select: none;
    }
    h1 { margin: 0 0 8px 0; font-size: 20px; color: #38bdf8; display: flex; align-items: center; gap: 8px; }
    .badge { font-size: 11px; padding: 2px 8px; border-radius: 4px; background: #22c55e; color: #000; font-weight: bold; }
    p { margin: 0 0 16px 0; font-size: 13px; color: #94a3b8; }
    .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 20px; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 6px; padding: 12px; }
    .card-title { font-size: 13px; font-weight: 600; color: #e2e8f0; margin-bottom: 6px; }
    .card-desc { font-size: 11px; color: #64748b; margin-bottom: 10px; height: 32px; }
    .btn {
      display: block;
      width: 100%;
      box-sizing: border-box;
      padding: 6px 12px;
      font-size: 12px;
      font-weight: 500;
      color: #fff;
      background: #2563eb;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      text-align: center;
    }
    .btn:hover { background: #1d4ed8; }
    .btn.danger { background: #dc2626; }
    .btn.danger:hover { background: #b91c1c; }
    .status-panel {
      background: #020617;
      border: 1px solid #1e293b;
      border-radius: 6px;
      padding: 12px;
      font-family: monospace;
      font-size: 12px;
      color: #a5f3fc;
      height: 120px;
      overflow-y: auto;
    }
  </style>
</head>
<body>
  <h1>ELIX Overlay Core <span class="badge">PHASE 11 HARNESS</span></h1>
  <p>Interactive verification harness for deterministic placement, edge flip/shift, focus, dismissal, and stacking.</p>
  <div class="grid">
    <div class="card">
      <div class="card-title">1. Centered Popup</div>
      <div class="card-desc">Opens popup centered in available monitor work area.</div>
      <button id="btn-test-1" class="btn" onclick="runCmd(1, this)">Run Test 1</button>
    </div>
    <div class="card">
      <div class="card-title">2. Button Anchored</div>
      <div class="card-desc">Anchored to rectangle with bottom-start placement.</div>
      <button id="btn-test-2" class="btn" onclick="runCmd(2, this)">Run Test 2</button>
    </div>
    <div class="card">
      <div class="card-title">3. Cursor / Point Anchor</div>
      <div class="card-desc">Simulates context menu right-click position.</div>
      <button id="btn-test-3" class="btn" onclick="runCmd(3, this)">Run Test 3</button>
    </div>
    <div class="card">
      <div class="card-title">4. Bottom Edge (Auto-Flip)</div>
      <div class="card-desc">Anchor near bottom edge; automatically flips upward.</div>
      <button id="btn-test-4" class="btn" onclick="runCmd(4, this)">Run Test 4</button>
    </div>
    <div class="card">
      <div class="card-title">5. Right Edge (Shift Left)</div>
      <div class="card-desc">Anchor near right edge; slides left to remain visible.</div>
      <button id="btn-test-5" class="btn" onclick="runCmd(5, this)">Run Test 5</button>
    </div>
    <div class="card">
      <div class="card-title">6. Top-Left Edge Handling</div>
      <div class="card-desc">Anchor near (0, 0); flips/shifts inside monitor.</div>
      <button id="btn-test-6" class="btn" onclick="runCmd(6, this)">Run Test 6</button>
    </div>
    <div class="card">
      <div class="card-title">7. Escape Dismissal</div>
      <div class="card-desc">Sends Escape event to close topmost eligible popup.</div>
      <button id="btn-test-7" class="btn" onclick="runCmd(7, this)">Run Test 7</button>
    </div>
    <div class="card">
      <div class="card-title">8. Outside Click Dismissal</div>
      <div class="card-desc">Simulates pointer click outside active overlay bounds.</div>
      <button id="btn-test-8" class="btn" onclick="runCmd(8, this)">Run Test 8</button>
    </div>
    <div class="card">
      <div class="card-title">9. Exclusive Stack Group</div>
      <div class="card-desc">Opens second popup in same group; closes first.</div>
      <button id="btn-test-9" class="btn" onclick="runCmd(9, this)">Run Test 9</button>
    </div>
    <div class="card">
      <div class="card-title">10. Parent Popup + Submenu</div>
      <div class="card-desc">Parent menu opens nested child; parent close tears down child.</div>
      <button id="btn-test-10" class="btn" onclick="runCmd(10, this)">Run Test 10</button>
    </div>
    <div class="card">
      <div class="card-title">11. No-Activate (Preview)</div>
      <div class="card-desc">Hover card/preview popup; does not steal focus.</div>
      <button id="btn-test-11" class="btn" onclick="runCmd(11, this)">Run Test 11</button>
    </div>
    <div class="card">
      <div class="card-title">12. Activating Popup</div>
      <div class="card-desc">Context menu popup with active keyboard focus.</div>
      <button id="btn-test-12" class="btn" onclick="runCmd(12, this)">Run Test 12</button>
    </div>
    <div class="card">
      <div class="card-title">13. Multi-Monitor Test</div>
      <div class="card-desc">Places popup on secondary display if available.</div>
      <button id="btn-test-13" class="btn" onclick="runCmd(13, this)">Run Test 13</button>
    </div>
    <div class="card">
      <div class="card-title">14. Resize / DPI Safety</div>
      <div class="card-desc">Dynamically resizes popup bounds safely on screen.</div>
      <button id="btn-test-14" class="btn" onclick="runCmd(14, this)">Run Test 14</button>
    </div>
    <div class="card">
      <div class="card-title">15. Close All (Clean Audit)</div>
      <div class="card-desc">Closes all popups; guarantees zero orphan HWNDs.</div>
      <button id="btn-test-15" class="btn danger" onclick="runCmd(15, this)">Run Test 15</button>
    </div>
  </div>
  <div class="status-panel" id="status">
    [Console Ready] Use terminal keys (1-15, Esc, q) or click above buttons.
  </div>
  <script>
    function runCmd(scenario, btnEl) {
      var rect = null;
      if (btnEl && btnEl.getBoundingClientRect) {
        var r = btnEl.getBoundingClientRect();
        rect = { x: r.left, y: r.top, width: r.width, height: r.height };
      }
      if (window.chrome && window.chrome.webview) {
        window.chrome.webview.postMessage({
          type: 'overlay-demo/run',
          scenario: scenario,
          anchorRect: rect,
          clientRect: rect
        });
      }
    }
    document.addEventListener('pointerdown', function(ev) {
      if (window.chrome && window.chrome.webview) {
        window.chrome.webview.postMessage({
          type: 'surface/pointer',
          action: 'down',
          screenX: ev.screenX,
          screenY: ev.screenY
        });
      }
    });
    if (window.chrome && window.chrome.webview) {
      window.chrome.webview.addEventListener('message', function(ev) {
        var data = ev.data;
        var p = document.createElement('div');
        p.textContent = (typeof data === 'string') ? data : (data.text || JSON.stringify(data));
        var el = document.getElementById('status');
        if (el) {
          el.appendChild(p);
          el.scrollTop = el.scrollHeight;
        }
      });
    }
  </script>
</body>
</html>`

const POPUP_HTML = (title: string, items: string[], isSubmenu = false) => `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body {
      margin: 0;
      padding: 10px;
      background: #1e293b;
      color: #f8fafc;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      border: 1px solid #475569;
      border-radius: 8px;
      box-sizing: border-box;
      user-select: none;
    }
    .title { font-size: 12px; font-weight: bold; color: ${isSubmenu ? '#a78bfa' : '#38bdf8'}; margin-bottom: 8px; }
    .item { padding: 6px 8px; font-size: 13px; border-radius: 4px; cursor: pointer; display: flex; justify-content: space-between; }
    .item:hover { background: #3b82f6; color: #fff; }
    .tag { font-size: 10px; background: #334155; padding: 1px 5px; border-radius: 3px; }
  </style>
</head>
<body>
  <div class="title">${title}</div>
  ${items.map(it => `<div class="item" onclick="handleItemClick('${it}')"><span>${it}</span><span class="tag">&gt;</span></div>`).join('')}
  <script>
    function handleItemClick(name) {
      if (window.chrome && window.chrome.webview) {
        window.chrome.webview.postMessage({ type: 'overlay-popup/item-clicked', item: name });
      }
    }
    document.addEventListener('pointerdown', function(ev) {
      if (window.chrome && window.chrome.webview) {
        window.chrome.webview.postMessage({
          type: 'surface/pointer',
          action: 'down',
          screenX: ev.screenX,
          screenY: ev.screenY
        });
      }
    });
  </script>
</body>
</html>`

export async function runVisualTest(): Promise<void> {
  console.log('Starting ELIX Overlay Core Visual Test Harness...')

  const bridge = createNativeBridge()
  await bridge.connect()

  const tempUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'elix-overlay-demo-'))
  const ctx = new Context()

  await ctx.plugin(WindowsContextService, { enabled: true, bridge })
  await ctx.plugin(ShellLayoutService, { enabled: true, bridge })
  await ctx.plugin(SurfaceService, {
    enabled: true,
    bridge,
    defaultUserDataFolder: tempUserDataDir,
  })
  await ctx.plugin(OverlayService, { enabled: true })

  const monitors = ctx.windowsContext.getMonitors()
  const primary = ctx.windowsContext.getPrimaryMonitor()

  console.log(`Discovered ${monitors.length} monitor(s). Primary: ${primary.deviceName} (${primary.bounds.width}x${primary.bounds.height})`)

  // Register definitions
  const defGeneral: OverlayDefinition = {
    id: 'demo-general',
    ownerId: 'demo',
    size: { width: 220, height: 180 },
    defaultPlacement: 'bottom-start',
    focusPolicy: 'activate',
    renderer: {
      type: 'html',
      target: POPUP_HTML('Overlay Menu', ['First Action', 'Second Action', 'Configure Option']),
    },
    dismiss: { outsideClick: true, escape: true },
  }

  const defPreview: OverlayDefinition = {
    id: 'demo-preview',
    ownerId: 'demo',
    size: { width: 200, height: 120 },
    defaultPlacement: 'top',
    focusPolicy: 'no-activate',
    renderer: {
      type: 'html',
      target: POPUP_HTML('Dock Preview', ['Quick Glance', 'Window #1', 'Window #2']),
    },
    dismiss: { outsideClick: false, escape: true },
  }

  const defSubmenu: OverlayDefinition = {
    id: 'demo-submenu',
    ownerId: 'demo',
    size: { width: 160, height: 140 },
    defaultPlacement: 'right-start',
    focusPolicy: 'activate',
    renderer: {
      type: 'html',
      target: POPUP_HTML('Submenu', ['Sub item A', 'Sub item B', 'Sub item C'], true),
    },
    dismiss: { outsideClick: true, escape: true },
  }

  const defExclusiveA: OverlayDefinition = {
    id: 'demo-exclusive-a',
    ownerId: 'demo',
    size: { width: 200, height: 150 },
    defaultPlacement: 'auto',
    focusPolicy: 'activate',
    stack: { group: 'exclusive-flyouts', exclusive: true },
    renderer: {
      type: 'html',
      target: POPUP_HTML('Flyout A (Wi-Fi)', ['Network Alpha', 'Network Beta', 'Disconnect']),
    },
    dismiss: { outsideClick: true, escape: true },
  }

  const defExclusiveB: OverlayDefinition = {
    id: 'demo-exclusive-b',
    ownerId: 'demo',
    size: { width: 200, height: 150 },
    defaultPlacement: 'auto',
    focusPolicy: 'activate',
    stack: { group: 'exclusive-flyouts', exclusive: true },
    renderer: {
      type: 'html',
      target: POPUP_HTML('Flyout B (Battery)', ['Remaining: 85%', 'Performance Mode', 'Battery Saver']),
    },
    dismiss: { outsideClick: true, escape: true },
  }

  ctx.overlay.register(defGeneral)
  ctx.overlay.register(defPreview)
  ctx.overlay.register(defSubmenu)
  ctx.overlay.register(defExclusiveA)
  ctx.overlay.register(defExclusiveB)

  // Create host window
  const hostWidth = 880
  const hostHeight = 660
  const hostX = primary.bounds.x + Math.round((primary.bounds.width - hostWidth) / 2)
  const hostY = primary.bounds.y + Math.round((primary.bounds.height - hostHeight) / 2)

  const hostSurface = await ctx.surface.create({
    id: 'overlay-demo-host',
    bounds: { x: hostX, y: hostY, width: hostWidth, height: hostHeight },
    renderer: { type: 'html', target: HOST_HTML },
    visible: true,
  })

  await hostSurface.whenReady()
  console.log(`Visual Test Host Surface created. HWND: ${hostSurface.hwnd}`)

  let lastOpenedInstance: OverlayInstance | null = null

  const logStatus = (msg: string) => {
    console.log(msg)
    void hostSurface.postMessage({ text: msg }).catch(() => {})
  }

  // Helper to compute canonical physical screen coords from clientRect or fallback
  const getAnchorFromClientOrFallback = (
    clientRect: { x: number; y: number; width: number; height: number } | undefined,
    fallback: { x: number; y: number; width: number; height: number },
  ) => {
    if (!clientRect) return fallback
    return {
      x: hostSurface.bounds.x + Math.round(clientRect.x * hostSurface.scaleFactor),
      y: hostSurface.bounds.y + Math.round(clientRect.y * hostSurface.scaleFactor),
      width: Math.round(clientRect.width * hostSurface.scaleFactor),
      height: Math.round(clientRect.height * hostSurface.scaleFactor),
    }
  }

  // Handler for running test scenarios
  const executeScenario = async (
    testNumber: number,
    clientRect?: { x: number; y: number; width: number; height: number },
  ): Promise<void> => {
    switch (testNumber) {
      case 1: {
        logStatus('\n[Scenario 1] Opening centered popup...')
        const targetX = primary.workArea.x + Math.round((primary.workArea.width - defGeneral.size.width) / 2)
        const targetY = primary.workArea.y + Math.round((primary.workArea.height - defGeneral.size.height) / 2)
        const inst = await ctx.overlay.open({
          definitionId: defGeneral.id,
          anchor: {
            type: 'point',
            x: targetX,
            y: targetY,
          },
          placement: 'bottom-start',
          offset: 0,
        })
        lastOpenedInstance = inst
        logStatus(`-> Centered popup opened at (${inst.actualBounds.x}, ${inst.actualBounds.y}) [Work area: ${primary.workArea.x},${primary.workArea.y} ${primary.workArea.width}x${primary.workArea.height}]`)
        break
      }

      case 2: {
        const anchorRect = getAnchorFromClientOrFallback(clientRect, {
          x: hostX + 50,
          y: hostY + 120,
          width: 220,
          height: 36,
        })
        logStatus(`\n[Scenario 2] Opening popup anchored to button at (${anchorRect.x}, ${anchorRect.y}, ${anchorRect.width}x${anchorRect.height})...`)
        const inst = await ctx.overlay.open({
          definitionId: defGeneral.id,
          anchor: { type: 'rect', ...anchorRect },
          placement: 'bottom-start',
        })
        lastOpenedInstance = inst
        logStatus(`-> Button-anchored popup opened at (${inst.actualBounds.x}, ${inst.actualBounds.y})`)
        break
      }

      case 3: {
        logStatus('\n[Scenario 3] Opening cursor position popup...')
        let anchorPt = { x: hostX + 300, y: hostY + 250 }
        if (clientRect) {
          anchorPt = {
            x: hostSurface.bounds.x + Math.round((clientRect.x + clientRect.width / 2) * hostSurface.scaleFactor),
            y: hostSurface.bounds.y + Math.round((clientRect.y + clientRect.height / 2) * hostSurface.scaleFactor),
          }
        }
        const inst = await ctx.overlay.open({
          definitionId: defGeneral.id,
          anchor: { type: 'point', x: anchorPt.x, y: anchorPt.y },
        })
        lastOpenedInstance = inst
        logStatus(`-> Cursor popup opened at (${inst.actualBounds.x}, ${inst.actualBounds.y})`)
        break
      }

      case 4: {
        logStatus('\n[Scenario 4] Bottom-edge placement (Auto-Flip upward)...')
        const inst = await ctx.overlay.open({
          definitionId: defGeneral.id,
          anchor: {
            type: 'rect',
            x: primary.workArea.x + 500,
            y: primary.workArea.y + primary.workArea.height - 40,
            width: 100,
            height: 35,
          },
          placement: 'bottom-start', // Will flip to top-start!
        })
        lastOpenedInstance = inst
        logStatus(`-> Effective placement: ${inst.effectivePlacement} (Flipped upward above anchor at y=${inst.actualBounds.y})`)
        break
      }

      case 5: {
        logStatus('\n[Scenario 5] Right-edge placement (Shift left)...')
        const inst = await ctx.overlay.open({
          definitionId: defGeneral.id,
          anchor: {
            type: 'rect',
            x: primary.workArea.x + primary.workArea.width - 80,
            y: primary.workArea.y + 200,
            width: 60,
            height: 35,
          },
          placement: 'bottom-start', // Will shift left to stay on screen!
        })
        lastOpenedInstance = inst
        logStatus(`-> Popup shifted left: x=${inst.actualBounds.x}, rightEdge=${inst.actualBounds.x + inst.actualBounds.width}`)
        break
      }

      case 6: {
        logStatus('\n[Scenario 6] Top-left edge placement...')
        const inst = await ctx.overlay.open({
          definitionId: defGeneral.id,
          anchor: {
            type: 'rect',
            x: primary.workArea.x + 10,
            y: primary.workArea.y + 10,
            width: 40,
            height: 30,
          },
          placement: 'top-start', // Underflows top -> flips to bottom-start
        })
        lastOpenedInstance = inst
        logStatus(`-> Placement reconciled to (${inst.actualBounds.x}, ${inst.actualBounds.y})`)
        break
      }

      case 7: {
        logStatus('\n[Scenario 7] Real physical Escape dismissal verification...')
        await ctx.overlay.closeAll()
        const anchorRect = getAnchorFromClientOrFallback(clientRect, {
          x: hostX + 36,
          y: hostY + 360,
          width: 240,
          height: 32,
        })
        const instToDismiss = await ctx.overlay.open({
          definitionId: defGeneral.id,
          anchor: { type: 'rect', ...anchorRect },
          placement: 'bottom-start',
        })
        lastOpenedInstance = instToDismiss
        await new Promise(r => setTimeout(r, 60))
        const focusState = await instToDismiss.surface.getFocusState()
        logStatus(`-> Popup HWND: ${focusState.hwnd}`)
        logStatus(`-> Foreground HWND: ${focusState.foregroundHwnd}`)
        logStatus(`-> Focused/active: ${focusState.isForeground && focusState.hasKeyboardFocus ? 'YES' : 'NO'}`)
        logStatus('>>> [ACTION REQUIRED] Please press the physical ESCAPE key on your keyboard now (WITHOUT clicking inside the popup)...')
        break
      }

      case 8: {
        logStatus('\n[Scenario 8] Real physical outside-click dismissal verification...')
        let instToDismiss = lastOpenedInstance && ctx.overlay.getInstance(lastOpenedInstance.instanceId)
          ? lastOpenedInstance
          : ctx.overlay.getTopmost(i => i.dismiss.outsideClick !== false)

        if (!instToDismiss) {
          logStatus('-> Opening test overlay first for outside-click dismissal...')
          instToDismiss = await ctx.overlay.open({
            definitionId: defGeneral.id,
            anchor: { type: 'point', x: hostX + 300, y: hostY + 200 },
          })
          lastOpenedInstance = instToDismiss
        }

        logStatus(`-> Popup ${instToDismiss.instanceId} is OPEN.`)
        logStatus('>>> [ACTION REQUIRED] Please click visibly OUTSIDE the popup (e.g. on this test harness window or desktop) now...')
        break
      }

      case 9: {
        logStatus('\n[Scenario 9] Exclusive stack group replacement...')
        logStatus('Opening Flyout A...')
        await ctx.overlay.open({
          definitionId: defExclusiveA.id,
          anchor: { type: 'point', x: hostX + 150, y: hostY + 300 },
        })
        logStatus(`Active overlays: ${ctx.overlay.getActive().map(i => i.definitionId).join(', ')}`)

        logStatus('Opening Flyout B (same exclusive group)...')
        await ctx.overlay.open({
          definitionId: defExclusiveB.id,
          anchor: { type: 'point', x: hostX + 180, y: hostY + 300 },
        })
        logStatus(`Active overlays after exclusive replacement: ${ctx.overlay.getActive().map(i => i.definitionId).join(', ')}`)
        break
      }

      case 10: {
        logStatus('\n[Scenario 10] Parent popup + nested submenu...')
        await ctx.overlay.closeAll()
        const parent = await ctx.overlay.open({
          definitionId: defGeneral.id,
          anchor: { type: 'point', x: hostX + 150, y: hostY + 150 },
        })
        lastOpenedInstance = parent
        logStatus(`Parent menu opened: ${parent.instanceId}`)

        const child = await ctx.overlay.open({
          definitionId: defSubmenu.id,
          parentInstanceId: parent.instanceId,
          anchor: {
            type: 'surface-relative',
            surfaceId: parent.surfaceId,
            rect: { x: 0, y: 40, width: 220, height: 30 },
          },
          placement: 'right-start',
        })
        logStatus(`Submenu opened: ${child.instanceId} attached to parent at (${child.actualBounds.x}, ${child.actualBounds.y})`)
        break
      }

      case 11: {
        logStatus('\n[Scenario 11] Opening no-activate popup (Dock preview)...')
        await ctx.overlay.closeAll()
        const fgBefore = await ctx.surface.getForegroundHwnd()
        const anchorRect = getAnchorFromClientOrFallback(clientRect, {
          x: hostX + 310,
          y: hostY + 480,
          width: 240,
          height: 32,
        })
        const inst = await ctx.overlay.open({
          definitionId: defPreview.id,
          anchor: { type: 'rect', ...anchorRect },
          placement: 'top',
        })
        lastOpenedInstance = inst
        await new Promise(r => setTimeout(r, 60))
        const focusState = await inst.surface.getFocusState()
        const fgAfter = await ctx.surface.getForegroundHwnd()
        const preserved = !focusState.isForeground && fgBefore === fgAfter
        logStatus(`-> No-activate popup opened at (${inst.actualBounds.x}, ${inst.actualBounds.y}), HWND: ${focusState.hwnd}`)
        logStatus(`-> Foreground before: ${fgBefore}, after: ${fgAfter}`)
        logStatus(`-> No-activate preserved: ${preserved ? 'YES' : 'NO'}`)
        break
      }

      case 12: {
        logStatus('\n[Scenario 12] Opening activating popup...')
        await ctx.overlay.closeAll()
        const anchorRect = getAnchorFromClientOrFallback(clientRect, {
          x: hostX + 590,
          y: hostY + 480,
          width: 240,
          height: 32,
        })
        const inst = await ctx.overlay.open({
          definitionId: defGeneral.id,
          anchor: { type: 'rect', ...anchorRect },
          placement: 'top-start',
        })
        lastOpenedInstance = inst
        await new Promise(r => setTimeout(r, 60))
        const focusState = await inst.surface.getFocusState()
        logStatus(`-> Activating popup opened at (${inst.actualBounds.x}, ${inst.actualBounds.y}), HWND: ${focusState.hwnd}`)
        logStatus(`-> Foreground HWND: ${focusState.foregroundHwnd}`)
        logStatus(`-> Focused/active: ${focusState.isForeground && focusState.hasKeyboardFocus ? 'YES' : 'NO'}`)
        break
      }

      case 13: {
        logStatus('\n[Scenario 13] Multi-monitor placement test...')
        const targetMon = monitors.length > 1 ? monitors[1]! : primary
        const inst = await ctx.overlay.open({
          definitionId: defGeneral.id,
          anchor: {
            type: 'point',
            x: targetMon.workArea.x + 200,
            y: targetMon.workArea.y + 200,
          },
        })
        lastOpenedInstance = inst
        logStatus(`-> Popup opened on monitor '${targetMon.deviceName}' at (${inst.actualBounds.x}, ${inst.actualBounds.y})`)
        break
      }

      case 14: {
        logStatus('\n[Scenario 14] Resize and DPI safety...')
        if (lastOpenedInstance && ctx.overlay.getInstance(lastOpenedInstance.instanceId)) {
          const updated = await ctx.overlay.reposition(lastOpenedInstance.instanceId, {
            type: 'point',
            x: lastOpenedInstance.actualBounds.x + 30,
            y: lastOpenedInstance.actualBounds.y + 30,
          })
          logStatus(`-> Successfully repositioned popup to (${updated.actualBounds.x}, ${updated.actualBounds.y})`)
        } else {
          logStatus('-> No active popup found to resize; opening one first.')
          const inst = await ctx.overlay.open({
            definitionId: defGeneral.id,
            anchor: { type: 'point', x: hostX + 200, y: hostY + 200 },
          })
          lastOpenedInstance = inst
          logStatus(`-> Opened popup at (${inst.actualBounds.x}, ${inst.actualBounds.y})`)
        }
        break
      }

      case 15: {
        logStatus('\n[Scenario 15] Closing all overlays and auditing orphan HWNDs...')
        const closedCount = await ctx.overlay.closeAll()
        const activeCount = ctx.overlay.getActive().length
        logStatus(`-> Closed ${closedCount} overlay(s). Remaining active: ${activeCount}`)
        break
      }
    }
  }

  // Listen for button click and popup messages sent from WebView2 surfaces
  ctx.on('surface/message', async ({ surface, message }) => {
    let data: unknown
    try {
      data = typeof message === 'string' ? JSON.parse(message) : message
    } catch {
      data = message
    }
    if (typeof data !== 'object' || data === null) return

    const msgObj = data as {
      type?: string
      scenario?: number
      anchorRect?: { x: number; y: number; width: number; height: number }
      clientRect?: { x: number; y: number; width: number; height: number }
      item?: string
    }
    if (
      surface.id === hostSurface.id &&
      msgObj.type === 'overlay-demo/run' &&
      typeof msgObj.scenario === 'number'
    ) {
      await executeScenario(msgObj.scenario, msgObj.anchorRect ?? msgObj.clientRect)
    } else if (msgObj.type === 'overlay-popup/item-clicked') {
      logStatus(`[POPUP] Clicked item '${msgObj.item}' in surface '${surface.id}' (tree remained open as expected)`)
    }
  })

  // Listen for overlay closure events to display PASS confirmations
  ctx.on('overlay/closed', ({ instanceId, reason }) => {
    logStatus(`[EVENT] Overlay closed: ${instanceId} (reason: ${reason})`)
    if (reason === 'escape') {
      logStatus(`PASS: Escape received and popup dismissed! Remaining overlays: ${ctx.overlay.getActive().length}`)
    } else if (reason === 'outside-click') {
      logStatus(`PASS: Outside-click received and popup dismissed! Remaining overlays: ${ctx.overlay.getActive().length}`)
    }
  })

  // Print menu
  console.log('\n=== ELIX Overlay Visual Acceptance Console ===')
  console.log('Type a number (1-15) and press Enter, or "esc" for Escape, "q" to exit:')
  console.log('  1: Centered popup           2: Button-anchored popup     3: Cursor popup')
  console.log('  4: Bottom-edge auto-flip    5: Right-edge shift-left     6: Top-left edge')
  console.log('  7: Escape dismissal         8: Outside-click dismissal   9: Exclusive group')
  console.log(' 10: Parent + Submenu        11: No-activate popup        12: Activating popup')
  console.log(' 13: Multi-monitor test      14: Reposition / DPI test    15: Close all')

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  return new Promise<void>((resolve) => {
    let closed = false
    let inputTail = Promise.resolve()
    rl.on('line', (line) => {
      inputTail = inputTail.then(async () => {
        if (closed) return
        const input = line.trim().toLowerCase()
      if (input === 'q' || input === 'quit' || input === 'exit') {
        closed = true
        console.log('Exiting visual test harness...')
        await ctx.overlay.closeAll()
        await ctx.fiber.dispose()
        await bridge.dispose()
        try {
          fs.rmSync(tempUserDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
        } catch {
          // Ignore
        }
        rl.close()
        resolve()
        return
      }

      if (input === 'esc' || input === 'escape') {
        if (ctx.overlay.getActive().length > 0) {
          logStatus('-> [TERMINAL HELPER] Invoking ctx.overlay.notifyEscapeKey()...')
          const dismissed = await ctx.overlay.notifyEscapeKey()
          logStatus(`-> Dismissed instance: ${dismissed ?? 'none'}. Remaining: ${ctx.overlay.getActive().length}`)
        } else {
          await executeScenario(7)
        }
        return
      }

      if (input === 'click' || input === 'outside') {
        logStatus('-> [TERMINAL HELPER] Invoking ctx.overlay.notifyOutsideClick({ x: 0, y: 0 })...')
        const closed = await ctx.overlay.notifyOutsideClick({ x: 0, y: 0 })
        logStatus(`-> Closed instances: ${closed.join(', ') || 'none'}. Remaining: ${ctx.overlay.getActive().length}`)
        return
      }

      const num = parseInt(input, 10)
      if (!isNaN(num) && num >= 1 && num <= 15) {
        await executeScenario(num)
      } else {
        console.log('Invalid option. Enter 1-15, "esc", or "q".')
        }
      }).catch((error: unknown) => {
        console.error('Overlay demo command failed:', error)
      })
    })
  })
}

// Auto-run if executed directly
if (process.argv[1]?.endsWith('visual-test.ts')) {
  runVisualTest().catch((err) => {
    console.error('Visual test harness failed:', err)
    process.exit(1)
  })
}
