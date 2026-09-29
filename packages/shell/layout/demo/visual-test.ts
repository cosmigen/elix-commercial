/**
 * Interactive Visual Acceptance Harness for ELIX Phase 16A Shell Boundary Authority.
 *
 * This is deliberately a real ELIX Surface/WebView2 window. The controls mutate
 * the live ShellLayoutService, which in turn drives the real native AppBar bridge.
 * The diagram compares physical monitor bounds, WindowsContext.workArea, and the
 * authoritative Shell Layout computed work area so native double-accounting and
 * cleanup failures are visible immediately.
 *
 * Run with:
 *   pnpm run demo:shell-layout
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as readline from 'node:readline'
import { Context } from '@deepseek-ai/cordis'
import { createNativeBridge } from '@deepseek-ai/dsh-native-core'
import { SurfaceService } from '@deepseek-ai/dsh-surface'
import WindowsContextService from '@deepseek-ai/dsh-windows-context'
import type { PhysicalPixelRect, WindowsMonitor } from '@deepseek-ai/dsh-windows-context'
import ShellLayoutService, {
  deriveMonitorEdgeRect,
  getReservationDepth,
  type ShellReservation,
  type ShellReservationHandle,
} from '../src/index.ts'

const DEMO_RESERVATION_ID = 'phase16a-visual-top-edge'
const DEMO_OWNER_ID = 'phase16a-visual-harness'

interface VisualState {
  readonly type: 'shell-layout-demo/state'
  readonly timestamp: number
  readonly lifecycle: string
  readonly monitor: {
    readonly id: string
    readonly deviceName: string
    readonly bounds: PhysicalPixelRect
    readonly windowsWorkArea: PhysicalPixelRect
    readonly elixWorkArea: PhysicalPixelRect
    readonly baselineWorkArea: PhysicalPixelRect
  }
  readonly reservation: {
    readonly exists: boolean
    readonly visible: boolean
    readonly edge?: string
    readonly desiredDepth: number
    readonly effectiveDepth: number
    readonly rect?: PhysicalPixelRect
  }
  readonly native: {
    readonly matchingCount: number
    readonly registeredIds: readonly string[]
  }
  readonly checks: {
    readonly lifecycleActive: boolean
    readonly windowsAndElixAgree: boolean
    readonly noDuplicateNativeBar: boolean
    readonly hiddenReservationUnregistered: boolean
    readonly removedReservationRestoresBaseline: boolean
  }
  readonly note: string
}

const HOST_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>ELIX Phase 16A — Shell Boundary Authority</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: #071018;
      color: #eef6ff;
      font-family: "Segoe UI Variable", "Segoe UI", sans-serif;
      min-width: 700px;
    }
    .shell { padding: 22px; display: grid; gap: 16px; }
    .top { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
    h1 { margin: 0; font-size: 22px; letter-spacing: -0.02em; }
    .sub { color: #8fa7bb; font-size: 12px; margin-top: 5px; max-width: 760px; }
    .phase { padding: 5px 9px; border: 1px solid #31516a; border-radius: 999px; color: #8bd5ff; font-size: 11px; white-space: nowrap; }
    .layout { display: grid; grid-template-columns: minmax(430px, 1.4fr) minmax(300px, .8fr); gap: 16px; }
    .panel { background: #0c1721; border: 1px solid #1d3142; border-radius: 12px; padding: 15px; }
    .panel-title { font-size: 12px; color: #9db7cb; margin-bottom: 11px; text-transform: uppercase; letter-spacing: .08em; }
    .monitor-wrap { background: #050b10; border-radius: 10px; padding: 18px; min-height: 330px; display: grid; place-items: center; }
    #monitor {
      width: min(100%, 680px);
      aspect-ratio: 16 / 9;
      position: relative;
      background: #14222d;
      border: 2px solid #567084;
      border-radius: 6px;
      overflow: hidden;
      box-shadow: inset 0 0 50px rgba(0,0,0,.35);
    }
    .layer { position: absolute; pointer-events: none; }
    #windowsArea { border: 2px dashed #38bdf8; background: rgba(56,189,248,.06); z-index: 2; }
    #elixArea { border: 2px solid #4ade80; background: rgba(74,222,128,.08); z-index: 3; }
    #reservation { background: rgba(251,146,60,.76); border: 1px solid #fdba74; z-index: 4; display: none; }
    .legend { margin-top: 10px; display: flex; flex-wrap: wrap; gap: 12px; font-size: 11px; color: #a9becf; }
    .legend span::before { content: ''; width: 9px; height: 9px; display: inline-block; margin-right: 5px; border-radius: 2px; vertical-align: -1px; }
    .legend .win::before { border: 2px dashed #38bdf8; }
    .legend .elix::before { border: 2px solid #4ade80; }
    .legend .res::before { background: #fb923c; }
    .metrics { display: grid; gap: 8px; font: 11px/1.45 Consolas, monospace; }
    .metric { padding: 9px 10px; background: #081119; border: 1px solid #172a39; border-radius: 8px; }
    .metric b { color: #cbe9ff; }
    .checks { display: grid; gap: 8px; margin-top: 12px; }
    .check { display: flex; justify-content: space-between; gap: 12px; padding: 8px 10px; border-radius: 8px; background: #081119; font-size: 12px; }
    .state { font-weight: 700; }
    .pass { color: #4ade80; }
    .fail { color: #fb7185; }
    .controls { display: grid; grid-template-columns: repeat(4, minmax(120px, 1fr)); gap: 8px; }
    button { border: 1px solid #284359; background: #102536; color: #e8f5ff; border-radius: 8px; padding: 10px 11px; cursor: pointer; font: inherit; }
    button:hover { background: #17354c; }
    button.primary { background: #0d4f77; border-color: #2176a7; }
    button.warn { background: #5b3614; border-color: #87511f; }
    button.danger { background: #531b24; border-color: #7d2936; }
    #status { min-height: 92px; max-height: 142px; overflow: auto; background: #050b10; border: 1px solid #152633; border-radius: 9px; padding: 10px; font: 11px/1.55 Consolas, monospace; color: #a7d9ef; }
    #overall { font-size: 12px; font-weight: 700; margin-left: 8px; }
    @media (max-width: 900px) { .layout { grid-template-columns: 1fr; } .controls { grid-template-columns: repeat(2, 1fr); } }
    /* Phase 16A compact acceptance viewport */
    @media (min-height: 600px) {
      body {
        overflow: hidden;
      }

      .shell {
        height: 100vh;
        padding: 10px 14px;
        gap: 7px;
        grid-template-rows:
          auto
          minmax(0, 1fr)
          auto
          auto;
      }

      .top {
        gap: 8px;
      }

      h1 {
        font-size: 18px;
      }

      .sub {
        margin-top: 2px;
        font-size: 10px;
        line-height: 1.3;
      }

      .phase {
        padding: 4px 7px;
        font-size: 9px;
      }

      .layout {
        min-height: 0;
        gap: 8px;
      }

      .panel {
        min-height: 0;
        padding: 8px;
      }

      .panel-title {
        margin-bottom: 5px;
        font-size: 9px;
      }

      .monitor-wrap {
        min-height: 0;
        height: 210px;
        padding: 7px;
      }

      #monitor {
        width: min(100%, 500px);
        max-height: 195px;
      }

      .legend {
        margin-top: 5px;
        gap: 7px;
        font-size: 9px;
      }

      .metrics {
        gap: 3px;
        font-size: 9px;
        line-height: 1.3;
      }

      .metric {
        padding: 4px 6px;
      }

      .checks {
        margin-top: 5px;
        gap: 3px;
      }

      .check {
        padding: 4px 6px;
        font-size: 9px;
      }

      .controls {
        grid-template-columns: repeat(4, minmax(100px, 1fr));
        gap: 5px;
      }

      button {
        padding: 6px 7px;
        font-size: 10px;
      }

      #status {
        min-height: 38px;
        max-height: 44px;
        padding: 5px 7px;
        font-size: 9px;
        line-height: 1.35;
      }
    }

  </style>
</head>
<body>
  <div class="shell">
    <div class="top">
      <div>
        <h1>Shell Boundary Authority <span id="overall">WAITING</span></h1>
        <div class="sub">Live Phase 16A acceptance surface. Blue = Windows work area. Green = ELIX authoritative work area. Orange = ELIX edge reservation. A healthy native reservation makes blue and green overlap exactly.</div>
      </div>
      <div class="phase">PHASE 16A VISUAL ACCEPTANCE</div>
    </div>

    <div class="layout">
      <div class="panel">
        <div class="panel-title">Live monitor geometry</div>
        <div class="monitor-wrap">
          <div id="monitor">
            <div id="windowsArea" class="layer"></div>
            <div id="elixArea" class="layer"></div>
            <div id="reservation" class="layer"></div>
          </div>
        </div>
        <div class="legend">
          <span class="win">Windows work area</span>
          <span class="elix">ELIX computed work area</span>
          <span class="res">ELIX reservation</span>
        </div>
      </div>

      <div class="panel">
        <div class="panel-title">Authority checks</div>
        <div class="metrics">
          <div class="metric" id="monitorMetric">Monitor: waiting...</div>
          <div class="metric" id="windowsMetric">Windows: waiting...</div>
          <div class="metric" id="elixMetric">ELIX: waiting...</div>
          <div class="metric" id="reservationMetric">Reservation: none</div>
          <div class="metric" id="nativeMetric">Native AppBars: waiting...</div>
        </div>
        <div class="checks" id="checks"></div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-title">Interactive acceptance sequence</div>
      <div class="controls">
        <button class="primary" onclick="act('run-all')">Run guided acceptance</button>
        <button onclick="act('reserve-40')">Top 40 px</button>
        <button onclick="act('reserve-52')">Top 52 px</button>
        <button onclick="act('bottom-40')">Bottom 40 px</button>
        <button onclick="act('bottom-52')">Bottom 52 px</button>
        <button onclick="act('left-40')">Left 40 px</button>
        <button onclick="act('left-52')">Left 52 px</button>
        <button onclick="act('right-40')">Right 40 px</button>
        <button onclick="act('right-52')">Right 52 px</button>
        <button onclick="act('hide')">Hide / suspend</button>
        <button onclick="act('show')">Show / restore</button>
        <button class="warn" onclick="act('remove')">Remove reservation</button>
        <button onclick="act('refresh')">Refresh snapshot</button>
        <button class="danger" onclick="act('quit')">Clean up & exit</button>
      </div>
    </div>

    <div id="status">[ready] Waiting for native state...</div>
  </div>

  <script>
    function act(action) {
      if (window.chrome && window.chrome.webview) {
        window.chrome.webview.postMessage({ type: 'shell-layout-demo/action', action: action });
      }
    }

    function rectText(r) {
      return r ? ('x=' + r.x + ', y=' + r.y + ', ' + r.width + '×' + r.height) : 'n/a';
    }

    function styleRect(el, rect, bounds) {
      if (!rect || !bounds || bounds.width <= 0 || bounds.height <= 0) return;
      var left = ((rect.x - bounds.x) / bounds.width) * 100;
      var top = ((rect.y - bounds.y) / bounds.height) * 100;
      var width = (rect.width / bounds.width) * 100;
      var height = (rect.height / bounds.height) * 100;
      el.style.left = left + '%';
      el.style.top = top + '%';
      el.style.width = width + '%';
      el.style.height = height + '%';
    }

    function checkRow(name, ok) {
      return '<div class="check"><span>' + name + '</span><span class="state ' + (ok ? 'pass' : 'fail') + '">' + (ok ? 'PASS' : 'FAIL') + '</span></div>';
    }

    function render(s) {
      var b = s.monitor.bounds;
      styleRect(document.getElementById('windowsArea'), s.monitor.windowsWorkArea, b);
      styleRect(document.getElementById('elixArea'), s.monitor.elixWorkArea, b);

      var r = document.getElementById('reservation');
      if (s.reservation.exists && s.reservation.visible && s.reservation.rect) {
        styleRect(r, s.reservation.rect, b);
        r.style.display = 'block';
      } else {
        r.style.display = 'none';
      }

      document.getElementById('monitorMetric').innerHTML = '<b>Monitor</b> ' + s.monitor.deviceName + '<br>' + rectText(b);
      document.getElementById('windowsMetric').innerHTML = '<b>Windows work area</b><br>' + rectText(s.monitor.windowsWorkArea);
      document.getElementById('elixMetric').innerHTML = '<b>ELIX computed work area</b><br>' + rectText(s.monitor.elixWorkArea);
      document.getElementById('reservationMetric').innerHTML = '<b>Reservation</b> ' + (s.reservation.exists ? (s.reservation.visible ? 'VISIBLE' : 'HIDDEN') : 'NONE') + '<br>desired=' + s.reservation.desiredDepth + ' px, effective=' + s.reservation.effectiveDepth + ' px';
      document.getElementById('nativeMetric').innerHTML = '<b>Matching native AppBars</b> ' + s.native.matchingCount + '<br>' + (s.native.registeredIds.join(', ') || 'none');

      var c = s.checks;
      document.getElementById('checks').innerHTML =
        checkRow('Shell Layout lifecycle active', c.lifecycleActive) +
        checkRow('Windows = ELIX work area', c.windowsAndElixAgree) +
        checkRow('No duplicate native AppBar', c.noDuplicateNativeBar) +
        checkRow('Hidden reservation is unregistered', c.hiddenReservationUnregistered) +
        checkRow('Removal restores baseline', c.removedReservationRestoresBaseline);

      var all = c.lifecycleActive && c.windowsAndElixAgree && c.noDuplicateNativeBar && c.hiddenReservationUnregistered && c.removedReservationRestoresBaseline;
      var overall = document.getElementById('overall');
      overall.textContent = all ? 'PASS' : 'CHECK';
      overall.className = all ? 'pass' : 'fail';
      log('[snapshot] ' + s.note);
    }

    function log(text) {
      var el = document.getElementById('status');
      var row = document.createElement('div');
      row.textContent = text;
      el.appendChild(row);
      while (el.childNodes.length > 80) el.removeChild(el.firstChild);
      el.scrollTop = el.scrollHeight;
    }

    if (window.chrome && window.chrome.webview) {
      window.chrome.webview.addEventListener('message', function(ev) {
        var data = ev.data;
        if (!data) return;
        if (data.type === 'shell-layout-demo/state') render(data);
        if (data.type === 'shell-layout-demo/log') log(data.text);
      });
    }
  </script>
</body>
</html>`

function sameRect(a: PhysicalPixelRect, b: PhysicalPixelRect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

function copyRect(rect: PhysicalPixelRect): PhysicalPixelRect {
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
}

function effectiveDepth(reservation: ShellReservation | undefined): number {
  if (!reservation) return 0
  return getReservationDepth(reservation)
}

function desiredDepth(reservation: ShellReservation | undefined): number {
  if (!reservation || reservation.kind !== 'edge' || !reservation.edge) return 0
  return reservation.edge === 'top' || reservation.edge === 'bottom'
    ? reservation.rect.height
    : reservation.rect.width
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return true
    await wait(80)
  }
  return false
}

export async function runVisualTest(): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error('Phase 16A visual acceptance requires Windows.')
  }

  console.log('Starting ELIX Phase 16A Shell Boundary visual acceptance harness...')

  const bridge = createNativeBridge()
  await bridge.connect()

  const tempUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'elix-shell-layout-demo-'))
  const ctx = new Context()

  await ctx.plugin(WindowsContextService, { enabled: true, bridge })
  await ctx.plugin(ShellLayoutService, {
    enabled: true,
    bridge,
    syncNativeWorkArea: true,
  })
  await ctx.plugin(SurfaceService, {
    enabled: true,
    bridge,
    defaultUserDataFolder: tempUserDataDir,
  })

  const primaryAtStart = ctx.windowsContext.getPrimaryMonitor()
  if (!primaryAtStart) throw new Error('No primary monitor was discovered.')

  const baselineWorkArea = copyRect(primaryAtStart.workArea)
  const hostWidth = Math.max(680, Math.min(1120, primaryAtStart.workArea.width - 80))
  const hostHeight = Math.max(560, Math.min(820, primaryAtStart.workArea.height - 80))
  const hostX = primaryAtStart.workArea.x + Math.round((primaryAtStart.workArea.width - hostWidth) / 2)
  const hostY = primaryAtStart.workArea.y + Math.round((primaryAtStart.workArea.height - hostHeight) / 2)

  const hostSurface = await ctx.surface.create({
    id: 'phase16a-shell-boundary-visual-host',
    bounds: { x: hostX, y: hostY, width: hostWidth, height: hostHeight },
    renderer: { type: 'html', target: HOST_HTML },
    visible: true,
  })
  await hostSurface.whenReady()

  let handle: ShellReservationHandle | undefined
  let activeEdge: 'top' | 'bottom' | 'left' | 'right' = 'top'
  let exiting = false
  let runSerial = Promise.resolve()

  const currentPrimary = (): WindowsMonitor => {
    const monitor = ctx.windowsContext.getPrimaryMonitor()
    if (!monitor) throw new Error('Primary monitor disappeared.')
    return monitor
  }

  const log = (text: string): void => {
    console.log(text)
    void hostSurface.postMessage({ type: 'shell-layout-demo/log', text }).catch(() => {})
  }

  const nativeMatches = async (): Promise<{ count: number; ids: readonly string[] }> => {
    const registered = await bridge.appBar.getRegistered()
    const matching = registered.filter(item => item.id === DEMO_RESERVATION_ID)
    return { count: matching.length, ids: matching.map(item => item.id) }
  }

  const publishState = async (note: string): Promise<VisualState> => {
    const monitor = currentPrimary()
    const layout = ctx.shellLayout.getMonitorLayout(monitor.id)
    if (!layout) throw new Error(`No Shell Layout state for monitor ${monitor.id}.`)

    const reservation = ctx.shellLayout.getReservation(DEMO_RESERVATION_ID)
    const native = await nativeMatches()
    const noReservation = reservation === undefined
    const hidden = reservation !== undefined && !reservation.visible

    const state: VisualState = {
      type: 'shell-layout-demo/state',
      timestamp: Date.now(),
      lifecycle: ctx.shellLayout.getLifecycleState(),
      monitor: {
        id: monitor.id,
        deviceName: monitor.deviceName,
        bounds: copyRect(monitor.bounds),
        windowsWorkArea: copyRect(monitor.workArea),
        elixWorkArea: copyRect(layout.computedWorkArea),
        baselineWorkArea: copyRect(baselineWorkArea),
      },
      reservation: {
        exists: reservation !== undefined,
        visible: reservation?.visible ?? false,
        ...(reservation?.edge ? { edge: reservation.edge } : {}),
        desiredDepth: desiredDepth(reservation),
        effectiveDepth: effectiveDepth(reservation),
        ...(reservation ? { rect: copyRect(reservation.effectiveRect ?? reservation.rect) } : {}),
      },
      native: {
        matchingCount: native.count,
        registeredIds: native.ids,
      },
      checks: {
        lifecycleActive: ctx.shellLayout.getLifecycleState() === 'ACTIVE',
        windowsAndElixAgree: sameRect(monitor.workArea, layout.computedWorkArea),
        noDuplicateNativeBar: native.count <= 1,
        hiddenReservationUnregistered: !hidden || native.count === 0,
        removedReservationRestoresBaseline:
          !noReservation || (sameRect(monitor.workArea, baselineWorkArea) && sameRect(layout.computedWorkArea, baselineWorkArea)),
      },
      note,
    }

    await hostSurface.postMessage(state)
    return state
  }

  const upsertReservation = async (
    depth: number,
    edge: 'top' | 'bottom' | 'left' | 'right' = activeEdge,
  ): Promise<void> => {
    const monitor = currentPrimary()
    activeEdge = edge
    const rect = deriveMonitorEdgeRect(edge, depth, monitor.bounds)
    const current = ctx.shellLayout.getReservation(DEMO_RESERVATION_ID)

    if (!current) {
      handle = ctx.shellLayout.registerReservation({
        id: DEMO_RESERVATION_ID,
        monitorId: monitor.id,
        ownerId: DEMO_OWNER_ID,
        kind: 'edge',
        edge,
        rect,
        affectsWorkArea: true,
        affectsHomeLayout: false,
        visible: true,
        priority: 1000,
      })
    } else if (handle?.get()) {
      handle.update({ rect, edge, visible: true })
    } else {
      ctx.shellLayout.updateReservation(
        DEMO_RESERVATION_ID,
        { rect, edge, visible: true },
      )
    }

    const converged = await waitUntil(async () => {
      const reservation = ctx.shellLayout.getReservation(DEMO_RESERVATION_ID)
      if (!reservation?.effectiveRect || effectiveDepth(reservation) !== depth) return false
      const native = await nativeMatches()
      const now = currentPrimary()
      const layout = ctx.shellLayout.getWorkArea(now.id)
      return native.count === 1 && layout !== undefined && sameRect(now.workArea, layout)
    })

    await publishState(`Reserve/update ${depth}px: ${converged ? 'converged' : 'timed out waiting for convergence'}`)
    log(`${converged ? 'PASS' : 'CHECK'}: ${depth}px native reservation ${converged ? 'is reflected exactly once' : 'did not fully converge within timeout'}.`)
  }

  const hideReservation = async (): Promise<void> => {
    const reservation = ctx.shellLayout.getReservation(DEMO_RESERVATION_ID)
    if (!reservation) {
      log('No reservation exists to hide.')
      await publishState('Hide skipped: no reservation')
      return
    }

    if (handle?.get()) handle.update({ visible: false })
    else ctx.shellLayout.updateReservation(DEMO_RESERVATION_ID, { visible: false })

    const converged = await waitUntil(async () => {
      const native = await nativeMatches()
      const monitor = currentPrimary()
      const layout = ctx.shellLayout.getWorkArea(monitor.id)
      return native.count === 0 && layout !== undefined && sameRect(layout, monitor.workArea)
    })

    await publishState(`Hide/suspend: ${converged ? 'native reservation removed' : 'convergence timeout'}`)
    log(`${converged ? 'PASS' : 'CHECK'}: hidden reservation ${converged ? 'released its native AppBar' : 'still needs inspection'}.`)
  }

  const showReservation = async (): Promise<void> => {
    const reservation = ctx.shellLayout.getReservation(DEMO_RESERVATION_ID)
    if (!reservation) {
      await upsertReservation(52)
      return
    }

    if (handle?.get()) handle.update({ visible: true })
    else ctx.shellLayout.updateReservation(DEMO_RESERVATION_ID, { visible: true })

    const converged = await waitUntil(async () => {
      const native = await nativeMatches()
      const monitor = currentPrimary()
      const layout = ctx.shellLayout.getWorkArea(monitor.id)
      return native.count === 1 && layout !== undefined && sameRect(layout, monitor.workArea)
    })

    await publishState(`Show/restore: ${converged ? 'reservation restored' : 'convergence timeout'}`)
    log(`${converged ? 'PASS' : 'CHECK'}: visible reservation ${converged ? 'reclaimed one native AppBar' : 'needs inspection'}.`)
  }

  const removeReservation = async (): Promise<void> => {
    if (handle?.get()) handle.dispose()
    else ctx.shellLayout.removeReservation(DEMO_RESERVATION_ID)
    handle = undefined

    const restored = await waitUntil(async () => {
      const native = await nativeMatches()
      const monitor = currentPrimary()
      const layout = ctx.shellLayout.getWorkArea(monitor.id)
      return (
        native.count === 0 &&
        layout !== undefined &&
        sameRect(monitor.workArea, baselineWorkArea) &&
        sameRect(layout, baselineWorkArea)
      )
    }, 6500)

    await publishState(`Remove/cleanup: ${restored ? 'baseline restored' : 'baseline restoration timeout'}`)
    log(`${restored ? 'PASS' : 'CHECK'}: removal ${restored ? 'restored the original Windows work area and left no native AppBar' : 'requires visual inspection'}.`)
  }

  const runGuidedAcceptance = async (): Promise<void> => {
    log('--- Guided acceptance started ---')
    if (ctx.shellLayout.getReservation(DEMO_RESERVATION_ID)) await removeReservation()
    await publishState('Baseline captured')
    await wait(700)

    await upsertReservation(40)
    await wait(1100)

    await upsertReservation(52)
    await wait(1100)

    await hideReservation()
    await wait(1100)

    await showReservation()
    await wait(1100)

    await removeReservation()
    log('--- Guided acceptance finished. Final screen should show PASS with no orange reservation band. ---')
  }

  const cleanup = async (): Promise<void> => {
    if (exiting) return
    exiting = true
    try {
      if (ctx.shellLayout.getReservation(DEMO_RESERVATION_ID)) {
        if (handle?.get()) handle.dispose()
        else ctx.shellLayout.removeReservation(DEMO_RESERVATION_ID)
        await waitUntil(async () => (await nativeMatches()).count === 0, 3000)
      }
    } finally {
      await ctx.fiber.dispose()
      await bridge.dispose()
      try {
        fs.rmSync(tempUserDataDir, { recursive: true, force: true })
      } catch {
        // Best-effort demo cleanup.
      }
    }
  }

  const dispatchAction = async (action: string): Promise<void> => {
    switch (action) {
      case 'run-all':
        await runGuidedAcceptance()
        break
      case 'reserve-40':
        await upsertReservation(40)
        break
      case 'reserve-52':
        await upsertReservation(52, 'top')
        break
      case 'bottom-40':
        await upsertReservation(40, 'bottom')
        break
      case 'bottom-52':
        await upsertReservation(52, 'bottom')
        break
      case 'left-40':
        await upsertReservation(40, 'left')
        break
      case 'left-52':
        await upsertReservation(52, 'left')
        break
      case 'right-40':
        await upsertReservation(40, 'right')
        break
      case 'right-52':
        await upsertReservation(52, 'right')
        break
      case 'hide':
        await hideReservation()
        break
      case 'show':
        await showReservation()
        break
      case 'remove':
        await removeReservation()
        break
      case 'refresh':
        await publishState('Manual refresh')
        break
      case 'quit':
        await cleanup()
        break
      default:
        log(`Unknown action: ${action}`)
    }
  }

  ctx.on('surface/message', ({ surface, message }) => {
    if (surface.id !== hostSurface.id) return
    let data: unknown = message
    try {
      data = typeof message === 'string' ? JSON.parse(message) : message
    } catch {
      // Preserve non-JSON payload.
    }
    if (typeof data !== 'object' || data === null) return
    const event = data as { type?: string; action?: string }
    if (event.type !== 'shell-layout-demo/action' || !event.action) return
    runSerial = runSerial
      .then(() => dispatchAction(event.action!))
      .catch(error => log(`ERROR: ${error instanceof Error ? error.message : String(error)}`))
  })

  const unbindLayoutChange = ctx.shellLayout.subscribe(() => {
    void publishState('Shell Layout state changed').catch(() => {})
  })
  const unbindWindowsChange = ctx.on('windows-context/change', () => {
    void publishState('Windows Context work area changed').catch(() => {})
  })

  ctx.effect(() => () => {
    unbindLayoutChange()
    unbindWindowsChange()
  }, 'phase16a.visual-demo.listeners')

  await publishState('Ready — baseline captured')
  log('Use Run guided acceptance, or exercise each state manually. Terminal: type "run", "40", "52", "hide", "show", "remove", "refresh", or "q".')

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

  return new Promise<void>((resolve) => {
    rl.on('line', (line) => {
      const input = line.trim().toLowerCase()
      const aliases: Record<string, string> = {
        run: 'run-all',
        '40': 'reserve-40',
        '52': 'reserve-52',
        bottom40: 'bottom-40',
        bottom52: 'bottom-52',
        left40: 'left-40',
        left52: 'left-52',
        right40: 'right-40',
        right52: 'right-52',
        hide: 'hide',
        show: 'show',
        remove: 'remove',
        refresh: 'refresh',
      }

      if (input === 'q' || input === 'quit' || input === 'exit') {
        runSerial = runSerial.finally(async () => {
          await cleanup()
          rl.close()
          resolve()
        })
        return
      }

      const action = aliases[input]
      if (!action) {
        console.log('Commands: run | 40 | 52 | hide | show | remove | refresh | q')
        return
      }

      runSerial = runSerial
        .then(() => dispatchAction(action))
        .catch(error => log(`ERROR: ${error instanceof Error ? error.message : String(error)}`))
    })
  })
}

if (process.argv[1]?.endsWith('visual-test.ts')) {
  runVisualTest().catch((error) => {
    console.error('Phase 16A visual acceptance harness failed:', error)
    process.exit(1)
  })
}
