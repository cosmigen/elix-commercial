/**
 * Interactive Windows acceptance console for ELIX Phase 17A Window Preview and Phase 17B Window Placement.
 *
 * This is a developer-only executable. It boots the real Cordis services and Rust native host,
 * hosts its controls inside a Surface Core WebView2 window, and drives production service APIs.
 */

import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createNativeBridge, type NativeBridgeClient } from '@deepseek-ai/dsh-native-core'
import SurfaceService, { type SurfaceInstance } from '@deepseek-ai/dsh-surface'
import WindowRegistryService, {
  type WindowId,
  type WindowSnapshot,
} from '@deepseek-ai/dsh-window-registry'
import WindowControlService from '@deepseek-ai/dsh-window-control'
import WindowPreviewService, { type PreviewLeaseSnapshot } from '@deepseek-ai/dsh-window-preview'
import WindowsContextService, { type MonitorId } from '@deepseek-ai/dsh-windows-context'
import ShellLayoutService from '@deepseek-ai/dsh-shell-layout'
import WindowPlacementService, {
  type PlacementResult,
  type PlacementZone,
} from '@deepseek-ai/dsh-window-placement'

const sleep = (ms: number) => new Promise(resolvePromise => setTimeout(resolvePromise, ms))
const WAIT_MS = 12_000
const LOG_LIMIT = 180
const CONSOLE_SURFACE_ID = 'phase17:test-console'

const ZONES: readonly PlacementZone[] = [
  'left-half',
  'right-half',
  'top-half',
  'bottom-half',
  'top-left-quarter',
  'top-right-quarter',
  'bottom-left-quarter',
  'bottom-right-quarter',
  'center',
  'fill',
]

type CheckState = 'idle' | 'pass' | 'fail' | 'manual'

interface CheckEntry {
  readonly label: string
  state: CheckState
  detail: string
}

interface LogEntry {
  readonly at: number
  readonly level: 'info' | 'pass' | 'fail' | 'warn'
  readonly message: string
}

interface JsonBody {
  readonly action?: string
  readonly windowId?: string
  readonly secondaryWindowId?: string
  readonly monitorId?: string
  readonly zone?: string
  readonly opacity?: number
}

interface ConsoleGeometry {
  readonly width: number
  readonly height: number
  readonly stageTop: number
  readonly stageHeight: number
  readonly stageWidth: number
  readonly stageA: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  readonly stageB: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
}

const checks: Record<string, CheckEntry> = {
  toolingLockfile: { label: 'Gate: frozen lockfile is internally consistent', state: 'idle', detail: '' },
  toolingFocused: { label: 'Gate: focused Phase 17 Vitest regression passes', state: 'idle', detail: '' },
  toolingTypecheck: { label: 'Gate: host TypeScript project graph passes', state: 'idle', detail: '' },
  toolingBuild: { label: 'Gate: repository build passes', state: 'idle', detail: '' },
  target: { label: 'Target window resolved with stable WindowId', state: 'idle', detail: '' },
  previewA: { label: '17A Preview A becomes LIVE', state: 'idle', detail: '' },
  previewB: { label: '17A simultaneous Preview B becomes LIVE', state: 'idle', detail: '' },
  previewVisibility: { label: '17A hide/show releases and reclaims native preview', state: 'idle', detail: '' },
  previewMinimize: { label: '17A minimize fallback and restore recovery', state: 'idle', detail: '' },
  previewSession: { label: '17A session lock/unlock releases and recovers previews', state: 'idle', detail: '' },
  previewResize: { label: '17A source resize keeps preview live and updates source geometry', state: 'idle', detail: '' },
  previewBudget: { label: '17A live-preview budget preserves higher-priority consumers', state: 'idle', detail: '' },
  previewDestroy: { label: '17A source destruction tears down native preview bindings', state: 'idle', detail: '' },
  previewVisual: { label: '17A visual content matches the selected source', state: 'manual', detail: 'Confirm this yourself after preview is live.' },
  previewLive: { label: '17A visible source changes update live', state: 'manual', detail: 'Edit/type in the selected app and confirm the preview updates.' },
  placementZones: { label: '17B placement zones apply', state: 'idle', detail: '' },
  placementRestore: { label: '17B restore returns to original placement', state: 'idle', detail: '' },
  constraints: { label: '17B native min/max/resizability constraints query', state: 'idle', detail: '' },
  maximized: { label: '17B maximized → placement → restore path', state: 'idle', detail: '' },
  conflict: { label: '17B concurrent operation conflict fencing', state: 'idle', detail: '' },
  cancellation: { label: '17B cancellation path', state: 'idle', detail: '' },
  staleId: { label: '17B destroyed WindowId is rejected as stale', state: 'idle', detail: '' },
  monitorMove: { label: '17B move-to-monitor and work-area policy', state: 'idle', detail: '' },
  namedLayout: { label: '17B named two-window layout', state: 'idle', detail: '' },
  topologyManual: { label: '17B monitor/DPI/orientation topology change remains stable', state: 'manual', detail: 'Change display topology/DPI/orientation, refresh, then confirm placement remains correct.' },
}

const logs: LogEntry[] = []

function log(level: LogEntry['level'], message: string): void {
  logs.push({ at: Date.now(), level, message })
  if (logs.length > LOG_LIMIT) logs.splice(0, logs.length - LOG_LIMIT)
  const prefix = level.toUpperCase().padEnd(4)
  console.log(`[${prefix}] ${message}`)
}

function setCheck(key: keyof typeof checks, state: CheckState, detail: string): void {
  const entry = checks[key]
  entry.state = state
  entry.detail = detail
  log(state === 'pass' ? 'pass' : state === 'fail' ? 'fail' : 'info', `${entry.label}: ${detail}`)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isTargetCandidate(window: WindowSnapshot): boolean {
  return (
    window.isVisible
    && !window.isShellWindow
    && (window.classification === 'APPLICATION' || window.classification === 'TOOL' || window.classification === 'TRANSIENT')
  )
}

function isPlacementCandidate(window: WindowSnapshot): boolean {
  return window.isVisible && !window.isShellWindow && window.classification === 'APPLICATION'
}

function assertPlacementApplied(label: string, result: PlacementResult): void {
  if (result.status !== 'applied' && result.status !== 'adjusted') {
    throw new Error(`${label} returned ${result.status}: ${result.reason ?? result.detail ?? 'unknown reason'}`)
  }
}

function safeKill(child: ChildProcess | undefined): void {
  if (!child || child.exitCode !== null || child.pid === undefined) return
  try {
    execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {
    // taskkill can race normal application exit; there is nothing left to clean in that case.
  }
}

async function readBody(request: IncomingMessage): Promise<JsonBody> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 64 * 1024) throw new Error('Request body exceeds 64 KiB')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as JsonBody
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

function sendHtml(response: ServerResponse, html: string): void {
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(html),
  })
  response.end(html)
}

function previewSurfaceHtml(label: string): string {
  return `<!doctype html><html><head><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}body{box-sizing:border-box;border:1px solid rgba(121,169,255,.75);border-radius:10px;box-shadow:inset 0 0 0 1px rgba(255,255,255,.05)}.tag{position:absolute;left:8px;top:7px;padding:3px 6px;border-radius:999px;background:rgba(9,14,22,.72);color:rgba(235,242,255,.75);font:10px Segoe UI,sans-serif;pointer-events:none}</style></head><body><div class="tag">${label}</div></body></html>`
}

function dashboardHtml(geometry: ConsoleGeometry): string {
  const stageCss = `--stage-top:${geometry.stageTop}px;--stage-height:${geometry.stageHeight}px;--stage-width:${geometry.stageWidth}px;`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">
<title>ELIX Phase 17 Test Console</title>
<style>
  :root{color-scheme:dark;font-family:"Segoe UI Variable Text","Segoe UI",sans-serif;${stageCss}}
  *{box-sizing:border-box}
  html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;color:#f4f7fb}
  body{background:rgba(7,10,16,.94)}
  button,select,input{font:inherit}
  button{border:1px solid rgba(255,255,255,.12);background:#182130;color:#f5f7fb;border-radius:9px;padding:8px 11px;cursor:pointer;transition:transform 110ms ease,background 110ms ease,border-color 110ms ease}
  button:hover{background:#223047;border-color:rgba(255,255,255,.24)}
  button:active{transform:translateY(1px)}
  button.primary{background:#2f6feb;border-color:#4f83ef}
  button.danger{background:#61252a;border-color:#8f343c}
  button.good{background:#184e35;border-color:#23764e}
  button.small{padding:5px 8px;font-size:12px}
  select,input[type=range]{background:#111925;color:#f5f7fb;border:1px solid rgba(255,255,255,.13);border-radius:8px;padding:7px}
  .topbar{height:84px;padding:16px 20px;display:flex;align-items:center;gap:14px;border-bottom:1px solid rgba(255,255,255,.08);background:rgba(10,14,22,.88)}
  .title{min-width:250px}.title h1{margin:0;font-size:20px;letter-spacing:.2px}.title p{margin:4px 0 0;color:#9eacc1;font-size:12px}
  .target-box{flex:1;display:grid;grid-template-columns:1fr 1fr auto auto;gap:8px;align-items:center}
  .target-box label{font-size:11px;color:#97a5ba}
  .target-box select{width:100%}
  .summary{min-width:140px;text-align:right}.summary strong{font-size:18px}.summary span{display:block;color:#9eacc1;font-size:11px;margin-top:3px}
  .preview-zone{position:absolute;left:0;right:0;top:84px;height:318px;padding:12px 20px 14px;display:grid;grid-template-columns:1fr 1fr;gap:16px;background:linear-gradient(180deg,rgba(12,17,26,.94),rgba(9,13,20,.74))}
  .preview-card{position:relative;border:1px solid rgba(255,255,255,.10);border-radius:13px;background:rgba(16,23,34,.72);overflow:hidden}
  .preview-label{height:38px;display:flex;align-items:center;justify-content:space-between;padding:0 12px;color:#c8d3e3;font-size:12px;border-bottom:1px solid rgba(255,255,255,.08);background:rgba(18,26,39,.82)}
  .preview-stage{position:absolute;left:12px;right:12px;top:50px;height:220px;border:1px dashed rgba(121,169,255,.65);border-radius:10px;background:transparent;pointer-events:none}
  .preview-stage::after{content:"DWM preview appears here";position:absolute;right:8px;bottom:6px;color:rgba(220,230,245,.42);font-size:10px}
  .workspace{position:absolute;left:0;right:0;top:402px;bottom:0;display:grid;grid-template-columns:1.35fr 1fr .9fr;gap:10px;padding:10px;background:#090d14}
  .column{min-width:0;overflow:auto;border:1px solid rgba(255,255,255,.08);border-radius:12px;background:#0e141e;padding:11px}
  h2{font-size:14px;margin:0 0 9px} h3{font-size:12px;margin:12px 0 7px;color:#a9b6ca}
  .row{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}.row select{flex:1;min-width:170px}
  .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}
  .grid3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}
  .status-line{font-size:11px;color:#9caabd;margin:7px 0;white-space:pre-wrap;word-break:break-word}
  .check{display:grid;grid-template-columns:18px 1fr;gap:7px;padding:7px 2px;border-bottom:1px solid rgba(255,255,255,.05)}
  .dot{width:10px;height:10px;border-radius:50%;margin-top:3px;background:#566276}.dot.pass{background:#48c78e}.dot.fail{background:#ff6675}.dot.manual{background:#e7b85b}
  .check b{display:block;font-size:11px;font-weight:600}.check span{display:block;font-size:10px;color:#8f9db1;margin-top:2px;line-height:1.3}
  .log{font-family:"Cascadia Mono",Consolas,monospace;font-size:10px;line-height:1.45;white-space:pre-wrap;word-break:break-word;color:#b9c4d4}
  .log .pass{color:#65d59f}.log .fail{color:#ff7b86}.log .warn{color:#e8bd67}.log .info{color:#b9c4d4}
  .badge{display:inline-flex;align-items:center;border:1px solid rgba(255,255,255,.12);border-radius:999px;padding:2px 7px;font-size:10px;color:#aebbd0}
  .footer-actions{position:sticky;bottom:-11px;margin:10px -11px -11px;padding:8px 11px;background:#0e141e;border-top:1px solid rgba(255,255,255,.08)}
</style>
</head>
<body>
  <header class="topbar">
    <div class="title"><h1>ELIX Phase 17 Test Console</h1><p>17A Window Preview + 17B Window Placement · real services, real native host</p></div>
    <div class="target-box">
      <div><label>Primary target</label><select id="target"></select></div>
      <div><label>Secondary target (named layout)</label><select id="secondary"></select></div>
      <button class="primary" data-action="spawn-notepad">Open test Notepad</button>
      <button data-action="refresh">Refresh</button>
    </div>
    <div class="summary"><strong id="score">0 / 0</strong><span id="summaryText">checks completed</span></div>
  </header>

  <section class="preview-zone">
    <div class="preview-card"><div class="preview-label"><span>Preview A · Dock-like consumer</span><span id="previewAState" class="badge">idle</span></div><div class="preview-stage"></div></div>
    <div class="preview-card"><div class="preview-label"><span>Preview B · Overview-like consumer</span><span id="previewBState" class="badge">idle</span></div><div class="preview-stage"></div></div>
  </section>

  <main class="workspace">
    <section class="column">
      <h2>Automated freeze gate</h2>
      <div class="row"><button class="primary" data-action="gate-all">Run complete automated gate</button><button data-action="gate-focused">Focused tests</button><button data-action="gate-typecheck">Typecheck</button></div>
      <div class="row"><button data-action="gate-lockfile">Verify lockfile</button><button data-action="gate-build">Build</button><button data-action="gate-full-tests">Full repo tests (optional)</button></div>
      <div id="commandState" class="status-line"></div>

      <h2>Phase 17A · Window Preview</h2>
      <div class="row"><button class="primary" data-action="preview-acquire-a">Acquire A</button><button class="primary" data-action="preview-acquire-b">Acquire B</button><button data-action="preview-release-all">Release all</button></div>
      <div class="row"><button data-action="preview-hide-a">Hide A</button><button data-action="preview-show-a">Show A</button><button data-action="preview-refresh">Reconcile</button></div>
      <div class="row"><button data-action="minimize-restore-preview">Test minimize → restore</button><button data-action="preview-session-cycle">Simulate lock → unlock</button><button data-action="preview-source-resize">Resize source</button><button data-action="preview-budget">Budget / priority test</button></div>
      <div class="row"><button class="good" data-action="manual-preview-pass">Preview looks correct</button><button class="good" data-action="manual-live-pass">Live changes update</button></div>
      <div class="row"><label class="badge">Opacity <input id="opacity" type="range" min="40" max="255" value="255"></label><button data-action="preview-opacity">Apply opacity</button></div>
      <div id="previewStats" class="status-line"></div>

      <h2>Phase 17B · Placement</h2>
      <div class="grid3" id="zones"></div>
      <div class="row" style="margin-top:7px"><button class="primary" data-action="placement-restore">Restore original</button><button data-action="placement-free">Release placement record</button><button data-action="constraints">Query constraints</button></div>
      <div class="row"><button data-action="maximized-placement">Maximized placement path</button><button data-action="operation-conflict">Concurrent conflict test</button><button data-action="cancellation">Cancellation test</button></div>
      <div class="row"><select id="monitor"></select><button data-action="move-monitor">Move target to monitor</button></div>
      <div class="row"><button data-action="named-layout">Named layout: primary left + secondary right</button><button class="good" data-action="manual-topology-pass">Monitor / DPI change looks correct</button></div>
      <div class="row"><button class="danger" data-action="stale-id">Close target + verify stale WindowId</button></div>
      <div id="placementState" class="status-line"></div>
    </section>

    <section class="column">
      <h2>Acceptance checklist</h2>
      <div id="checks"></div>
      <div class="footer-actions"><div class="row"><button class="primary" data-action="automated-core">Run core automated sequence</button><button data-action="reset-checks">Reset results</button></div></div>
    </section>

    <section class="column">
      <h2>Live diagnostics</h2>
      <div id="targetState" class="status-line"></div>
      <h3>Constraints / placement record</h3><div id="detailState" class="status-line"></div>
      <h3>Event log</h3><div id="log" class="log"></div>
      <div class="footer-actions"><div class="row"><button data-action="download-report">Download JSON report</button><button class="danger" data-action="shutdown">Exit console</button></div></div>
    </section>
  </main>
<script>
const zoneNames=${JSON.stringify(ZONES)};
const target=document.getElementById('target');
const secondary=document.getElementById('secondary');
const monitor=document.getElementById('monitor');
const escapeHtml=(value)=>String(value??'').replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;","\\\"":"&quot;","'":"&#39;"}[ch]||ch));
function optionLabel(w){return (w.title||'(untitled)')+' · '+w.className+' · PID '+w.processId}
async function post(action,extra={}){
  disable(true);
  try{
    const response=await fetch('/api/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,...extra})});
    const result=await response.json();
    if(!response.ok) throw new Error(result.error||'Action failed');
    if(result.download){const blob=new Blob([JSON.stringify(result.download,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='elix-phase17-test-report.json';a.click();URL.revokeObjectURL(a.href)}
  }catch(error){console.error(error)}finally{disable(false);await refresh()}
}
function disable(value){document.querySelectorAll('button').forEach(b=>b.disabled=value)}
function fillSelect(element,items,current,placeholder){
  const previous=current||element.value;
  element.innerHTML='<option value="">'+placeholder+'</option>'+items.map(item=>'<option value="'+escapeHtml(item.id)+'">'+escapeHtml(item.label)+'</option>').join('');
  if([...element.options].some(option=>option.value===previous)) element.value=previous;
}
function renderChecks(items){
  document.getElementById('checks').innerHTML=Object.values(items).map(item=>'<div class="check"><span class="dot '+item.state+'"></span><div><b>'+escapeHtml(item.label)+'</b><span>'+escapeHtml(item.detail||item.state)+'</span></div></div>').join('');
  const values=Object.values(items);const passed=values.filter(item=>item.state==='pass').length;const failed=values.filter(item=>item.state==='fail').length;
  document.getElementById('score').textContent=passed+' / '+values.length;document.getElementById('summaryText').textContent=failed?failed+' failed':'checks passed';
}
function renderLogs(entries){document.getElementById('log').innerHTML=entries.slice(-80).map(entry=>'<span class="'+entry.level+'">['+new Date(entry.at).toLocaleTimeString()+'] '+escapeHtml(entry.message)+'</span>').join('\\n');document.getElementById('log').scrollTop=999999}
async function refresh(){
  try{
    const response=await fetch('/api/state',{cache:'no-store'});const s=await response.json();
    const windows=s.windows.map(w=>({id:w.id,label:optionLabel(w)}));
    fillSelect(target,windows,s.selectedWindowId,'Select visible app window');
    fillSelect(secondary,windows,s.secondaryWindowId,'Select second app');
    fillSelect(monitor,s.monitors.map(m=>({id:m.id,label:(m.isPrimary?'Primary · ':'')+(m.friendlyName||m.deviceName)+' · '+m.workArea.width+'×'+m.workArea.height+' @ '+Math.round(m.scaleFactor*100)+'%'})),s.selectedMonitorId,'Select monitor');
    document.getElementById('previewAState').textContent=s.previewA?.state||'idle';document.getElementById('previewBState').textContent=s.previewB?.state||'idle';
    document.getElementById('previewStats').textContent='leases='+s.previewStats.totalLeases+' · live='+s.previewStats.live+' · native='+s.previewStats.nativeBindings+' · unavailable='+s.previewStats.unavailable+' · sessionLocked='+s.previewStats.sessionLocked;
    document.getElementById('commandState').textContent=s.commandState?JSON.stringify(s.commandState,null,2):'No repository command running.';
    document.getElementById('targetState').textContent=s.target?JSON.stringify({id:s.target.id,title:s.target.title,state:s.target.state,bounds:s.target.bounds,monitorId:s.target.monitorId},null,2):'No target selected.';
    document.getElementById('placementState').textContent=s.lastPlacement?JSON.stringify(s.lastPlacement,null,2):'No placement result yet.';
    document.getElementById('detailState').textContent=JSON.stringify({constraints:s.lastConstraints,placementRecord:s.placementRecord},null,2);
    renderChecks(s.checks);renderLogs(s.logs);
  }catch(error){console.error(error)}
}
document.getElementById('zones').innerHTML=zoneNames.map(zone=>'<button data-action="place-zone" data-zone="'+zone+'">'+zone.replaceAll('-',' ')+'</button>').join('');
document.addEventListener('click',event=>{const button=event.target.closest('button[data-action]');if(!button)return;const action=button.dataset.action;if(action==='download-report'){post(action);return}post(action,{windowId:target.value||undefined,secondaryWindowId:secondary.value||undefined,monitorId:monitor.value||undefined,zone:button.dataset.zone,opacity:Number(document.getElementById('opacity').value)})});
target.addEventListener('change',()=>post('select-target',{windowId:target.value}));secondary.addEventListener('change',()=>post('select-secondary',{secondaryWindowId:secondary.value}));monitor.addEventListener('change',()=>post('select-monitor',{monitorId:monitor.value}));
refresh();setInterval(refresh,700);
</script>
</body></html>`
}

async function main(): Promise<void> {
  if (process.platform !== 'win32') throw new Error('Phase 17 Test Console requires Windows.')

  const tempDir = mkdtempSync(join(tmpdir(), 'elix-phase17-console-'))
  const nativeHostPath = resolve(process.cwd(), 'native', 'target', 'debug', 'elix-native-host.exe')
  const bridge: NativeBridgeClient = createNativeBridge({
    binaryPath: nativeHostPath,
    supervisor: { autoRestart: true, initialBackoffMs: 30, maxBackoffMs: 200 },
  })
  const ctx = new Context()
  let surface: SurfaceInstance | undefined
  let previewSurfaceA: SurfaceInstance | undefined
  let previewSurfaceB: SurfaceInstance | undefined
  let selectedWindowId: WindowId | undefined
  let secondaryWindowId: WindowId | undefined
  let selectedMonitorId: MonitorId | undefined
  let previewAId: string | undefined
  let previewBId: string | undefined
  let lastPlacement: PlacementResult | undefined
  let lastConstraints: Awaited<ReturnType<typeof ctx.windowControl.getPlacementConstraints>> | undefined
  let spawnedNotepad: ChildProcess | undefined
  let activeCommand: ChildProcess | undefined
  let commandState: { label: string; running: boolean; exitCode?: number | null; startedAt: number; finishedAt?: number } | undefined
  let serverForCleanup: ReturnType<typeof createServer> | undefined
  let shuttingDown = false

  async function cleanupResources(): Promise<void> {
    const ids = [previewAId, previewBId].filter((id): id is string => Boolean(id))
    previewAId = undefined
    previewBId = undefined
    const previewService = ctx.get('windowPreview') as WindowPreviewService | undefined
    if (previewService) {
      await Promise.all(ids.map(id => previewService.releasePreview(id).catch(() => false))).catch(() => {})
    }
    if (previewSurfaceA) await previewSurfaceA.destroy().catch(() => false)
    if (previewSurfaceB) await previewSurfaceB.destroy().catch(() => false)
    if (surface) await surface.destroy().catch(() => false)
    await ctx.fiber.dispose().catch(() => {})
    await bridge.dispose().catch(() => {})
    safeKill(activeCommand)
    safeKill(spawnedNotepad)
    if (serverForCleanup?.listening) {
      await new Promise<void>(resolveClose => serverForCleanup?.close(() => resolveClose()))
    }
    try {
      rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch {
      // A late WebView2 process can briefly retain its profile; the OS temp directory is non-durable.
    }
  }

  try {
    await bridge.connect()
    if (bridge.getCapabilities()?.windowPreview !== true) {
      throw new Error('Native host does not advertise windowPreview. Rebuild the current native host.')
    }

    await ctx.plugin(WindowsContextService, { enabled: true, bridge })
    await ctx.plugin(SurfaceService, { enabled: true, bridge, defaultUserDataFolder: join(tempDir, 'webview2-default') })
    await ctx.plugin(WindowRegistryService, { enabled: true, bridge })
    await ctx.plugin(WindowControlService, { enabled: true, bridge })
    await ctx.plugin(WindowPreviewService, { enabled: true, maxLivePreviews: 2, bridge })
    await ctx.plugin(ShellLayoutService, { enabled: true })
    await ctx.plugin(WindowPlacementService, { enabled: true, maxDisplayReplans: 2 })
    await sleep(250)
  } catch (error) {
    await cleanupResources()
    throw error
  }

  const primary = ctx.windowsContext.getPrimaryMonitor()
  const width = Math.min(1180, Math.max(940, primary.workArea.width - 60))
  const height = Math.min(880, Math.max(720, primary.workArea.height - 60))
  const stageWidth = Math.floor((width - 56) / 2)
  const geometry: ConsoleGeometry = {
    width,
    height,
    stageTop: 146,
    stageHeight: 220,
    stageWidth,
    stageA: { x: 32, y: 146, width: stageWidth - 24, height: 220 },
    stageB: { x: 48 + stageWidth, y: 146, width: stageWidth - 24, height: 220 },
  }

  async function runRepoCommand(label: string, args: readonly string[], checkKey?: keyof typeof checks): Promise<void> {
    if (activeCommand && activeCommand.exitCode === null) throw new Error(`Repository command '${commandState?.label ?? 'unknown'}' is already running.`)
    log('info', `${label}: pnpm ${args.join(' ')}`)
    commandState = { label, running: true, startedAt: Date.now() }
    await new Promise<void>((resolveRun, rejectRun) => {
      const child = spawn('pnpm.cmd', [...args], { cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      activeCommand = child
      let settled = false
      const startedAt = commandState.startedAt
      const relay = (level: LogEntry['level']) => (chunk: Buffer | string) => {
        for (const line of String(chunk).split(/\r?\n/)) {
          const trimmed = line.trim()
          if (trimmed) log(level, trimmed.slice(0, 1200))
        }
      }
      child.stdout?.on('data', relay('info'))
      child.stderr?.on('data', relay('warn'))
      child.once('error', error => {
        if (settled) return
        settled = true
        activeCommand = undefined
        commandState = { label, running: false, startedAt, finishedAt: Date.now() }
        if (checkKey) setCheck(checkKey, 'fail', `${label} could not start: ${errorMessage(error)}`)
        rejectRun(error)
      })
      child.once('exit', code => {
        if (settled) return
        settled = true
        activeCommand = undefined
        commandState = { label, running: false, exitCode: code, startedAt, finishedAt: Date.now() }
        if (code === 0) {
          if (checkKey) setCheck(checkKey, 'pass', `${label} exited 0.`)
          resolveRun()
        } else {
          if (checkKey) setCheck(checkKey, 'fail', `${label} exited ${code ?? 'without an exit code'}.`)
          rejectRun(new Error(`${label} failed with exit code ${code ?? 'unknown'}.`))
        }
      })
    })
  }

  async function runFocusedGate(): Promise<void> {
    await runRepoCommand('Focused Phase 17 tests', [
      'exec', 'vitest', 'run',
      'packages/core/window-preview/tests',
      'packages/shell/window-placement/tests',
      'packages/shell/layout/tests',
      'packages/bundle/windows-runtime/tests/composition.spec.ts',
    ], 'toolingFocused')
  }

  async function runAutomatedGate(): Promise<void> {
    await runRepoCommand('Frozen lockfile verification', ['install', '--frozen-lockfile', '--lockfile-only', '--ignore-scripts'], 'toolingLockfile')
    await runFocusedGate()
    await runRepoCommand('Host TypeScript typecheck', ['exec', 'tsc', '-b', 'tsconfig.host.json', '--pretty', 'false'], 'toolingTypecheck')
    await runRepoCommand('Repository build', ['run', 'build'], 'toolingBuild')
    log('pass', 'Complete automated Phase 17 freeze gate passed.')
  }

  function candidates(): WindowSnapshot[] {
    const ownedHwnds = new Set(
      [surface?.hwnd, previewSurfaceA?.hwnd, previewSurfaceB?.hwnd]
        .filter((hwnd): hwnd is number => typeof hwnd === 'number' && hwnd !== 0),
    )
    return ctx.windowRegistry.getWindows()
      .filter(window => isTargetCandidate(window) && !ownedHwnds.has(window.hwnd))
      .sort((left, right) => left.title.localeCompare(right.title))
  }

  function target(): WindowSnapshot | undefined {
    return selectedWindowId ? ctx.windowRegistry.getWindow(selectedWindowId) : undefined
  }

  function requireTarget(): WindowSnapshot {
    const current = target()
    if (!current) throw new Error('Select or open a target application first.')
    return current
  }

  async function refreshAuthorities(): Promise<void> {
    await ctx.windowsContext.refresh().catch(error => log('warn', `Windows Context refresh: ${errorMessage(error)}`))
    await ctx.windowRegistry.refresh()
    await ctx.windowPreview.refresh()
  }

  async function waitForWindow(
    existing: ReadonlySet<WindowId>,
    pid: number | undefined,
    titleFragment: string,
  ): Promise<WindowSnapshot> {
    const deadline = Date.now() + WAIT_MS
    while (Date.now() < deadline) {
      await ctx.windowRegistry.refresh()
      const match = ctx.windowRegistry.getWindows().find(window => (
        isPlacementCandidate(window)
        && (
          window.title.toLowerCase().includes(titleFragment.toLowerCase())
          || (!existing.has(window.id) && (pid === undefined || window.processId === pid))
        )
      ))
      if (match) return match
      await sleep(70)
    }
    throw new Error(`Timed out waiting for target window '${titleFragment}'.`)
  }

  async function spawnNotepadTarget(): Promise<WindowSnapshot> {
    await releasePreviews()
    if (spawnedNotepad && spawnedNotepad.exitCode === null) safeKill(spawnedNotepad)
    const file = join(tempDir, `ELIX_PHASE17_${Date.now()}.txt`)
    writeFileSync(file, 'ELIX Phase 17 interactive acceptance target\r\nType here to verify live preview updates.\r\n', 'utf8')
    await ctx.windowRegistry.refresh()
    const existing = new Set(ctx.windowRegistry.getWindows().map(window => window.id))
    spawnedNotepad = spawn('notepad.exe', [file], { stdio: 'ignore', windowsHide: false })
    const resolved = await waitForWindow(existing, spawnedNotepad.pid, 'ELIX_PHASE17_')
    selectedWindowId = resolved.id
    setCheck('target', 'pass', `Resolved ${resolved.title || 'Notepad'} as ${resolved.id}`)
    return resolved
  }

  async function acquire(which: 'A' | 'B'): Promise<PreviewLeaseSnapshot> {
    const current = requireTarget()
    if (which === 'A' && previewAId) await ctx.windowPreview.releasePreview(previewAId)
    if (which === 'B' && previewBId) await ctx.windowPreview.releasePreview(previewBId)
    const rect = which === 'A' ? geometry.stageA : geometry.stageB
    const destinationSurfaceId = which === 'A' ? 'phase17:test-preview-a' : 'phase17:test-preview-b'
    const lease = await ctx.windowPreview.acquirePreview({
      sourceWindowId: current.id,
      destinationSurfaceId,
      destinationRect: { x: 0, y: 0, width: rect.width, height: rect.height },
      consumerId: `phase17-console-${which.toLowerCase()}`,
      importance: which === 'A' ? 'high' : 'normal',
      fit: 'contain',
      visible: true,
    })
    if (which === 'A') previewAId = lease.id
    else previewBId = lease.id
    const latest = ctx.windowPreview.getLease(lease.id) ?? lease
    setCheck(which === 'A' ? 'previewA' : 'previewB', latest.state === 'live' ? 'pass' : 'fail', `state=${latest.state}, backend=${latest.backend}`)
    return latest
  }

  async function releasePreviews(): Promise<void> {
    const ids = [previewAId, previewBId].filter((id): id is string => Boolean(id))
    previewAId = undefined
    previewBId = undefined
    await Promise.all(ids.map(id => ctx.windowPreview.releasePreview(id)))
    log('info', `Released ${ids.length} preview lease(s).`)
  }

  async function testPreviewVisibility(): Promise<void> {
    if (!previewAId) await acquire('A')
    const id = previewAId as string
    const beforeNative = ctx.windowPreview.getStats().nativeBindings
    await ctx.windowPreview.updateLease(id, { visible: false })
    const hidden = ctx.windowPreview.getLease(id)
    const hiddenNative = ctx.windowPreview.getStats().nativeBindings
    if (hidden?.state !== 'paused') {
      setCheck('previewVisibility', 'fail', `hide state=${hidden?.state ?? 'missing'}; native=${hiddenNative}`)
      return
    }
    await ctx.windowPreview.updateLease(id, { visible: true })
    const shown = ctx.windowPreview.getLease(id)
    const shownNative = ctx.windowPreview.getStats().nativeBindings
    const expectedHidden = Math.max(0, beforeNative - 1)
    const ok = hiddenNative === expectedHidden && shown?.state === 'live' && shownNative === beforeNative
    setCheck('previewVisibility', ok ? 'pass' : 'fail', `native ${beforeNative} → ${hiddenNative} → ${shownNative}; states ${hidden.state} → ${shown?.state ?? 'missing'}`)
  }

  async function testPreviewMinimizeRestore(): Promise<void> {
    const current = requireTarget()
    if (!previewAId) await acquire('A')
    if (!previewBId) await acquire('B')
    const minimized = await ctx.windowControl.minimize(current.id)
    if (!minimized.accepted) throw new Error('Window Control rejected minimize.')
    await sleep(180)
    await ctx.windowRegistry.refresh()
    await ctx.windowPreview.refresh()
    const during = [previewAId, previewBId].map(id => id ? ctx.windowPreview.getLease(id)?.state : undefined)
    const minimizedNative = ctx.windowPreview.getStats().nativeBindings
    const restored = await ctx.windowControl.restore(current.id)
    if (!restored.accepted) throw new Error('Window Control rejected restore.')
    await sleep(180)
    await ctx.windowRegistry.refresh()
    await ctx.windowPreview.refresh()
    const after = [previewAId, previewBId].map(id => id ? ctx.windowPreview.getLease(id)?.state : undefined)
    const unavailable = during.every(state => state === 'unavailable' || state === 'paused')
    const live = after.every(state => state === 'live')
    const restoredNative = ctx.windowPreview.getStats().nativeBindings
    const ok = unavailable && minimizedNative === 0 && live && restoredNative === 2
    setCheck('previewMinimize', ok ? 'pass' : 'fail', `minimized=${during.join(',')} native=${minimizedNative}; restored=${after.join(',')} native=${restoredNative}`)
  }

  async function testSessionCycle(): Promise<void> {
    if (!previewAId) await acquire('A')
    await ctx.windowPreview.setSessionLocked(true)
    const lockedStats = ctx.windowPreview.getStats()
    await ctx.windowPreview.setSessionLocked(false)
    const unlockedStats = ctx.windowPreview.getStats()
    const ok = lockedStats.nativeBindings === 0 && unlockedStats.live >= 1
    setCheck('previewSession', ok ? 'pass' : 'fail', `locked native=${lockedStats.nativeBindings}; unlocked live=${unlockedStats.live}`)
  }

  async function testPreviewSourceResize(): Promise<void> {
    const current = requireTarget()
    if (!previewAId) await acquire('A')
    const before = ctx.windowPreview.getLease(previewAId as string)
    const targetWidth = Math.max(320, current.bounds.width + 140)
    const targetHeight = Math.max(240, current.bounds.height + 90)
    const resized = await ctx.windowControl.resize(current.id, targetWidth, targetHeight)
    if (!resized.accepted) throw new Error('Window Control rejected source resize.')
    await sleep(160)
    await ctx.windowRegistry.refresh()
    await ctx.windowPreview.refresh()
    const after = ctx.windowPreview.getLease(previewAId as string)
    const geometryChanged = before?.contentWidth !== after?.contentWidth || before?.contentHeight !== after?.contentHeight
    const ok = after?.state === 'live' && (geometryChanged || resized.completed)
    setCheck('previewResize', ok ? 'pass' : 'fail', `before=${before?.contentWidth ?? '-'}×${before?.contentHeight ?? '-'}; after=${after?.contentWidth ?? '-'}×${after?.contentHeight ?? '-'}; completed=${resized.completed}`)
  }

  async function testPreviewBudget(): Promise<void> {
    if (!previewAId) await acquire('A')
    if (!previewBId) await acquire('B')
    const current = requireTarget()
    const extra = await ctx.windowPreview.acquirePreview({
      sourceWindowId: current.id,
      destinationSurfaceId: 'phase17:test-preview-a',
      destinationRect: { x: 6, y: 6, width: 120, height: 72 },
      consumerId: 'phase17-console-budget-low',
      importance: 'low',
      fit: 'contain',
      visible: true,
    })
    const stats = ctx.windowPreview.getStats()
    const a = previewAId ? ctx.windowPreview.getLease(previewAId) : undefined
    const b = previewBId ? ctx.windowPreview.getLease(previewBId) : undefined
    const low = ctx.windowPreview.getLease(extra.id)
    const ok = stats.live === 2 && a?.state === 'live' && b?.state === 'live' && low?.state !== 'live'
    setCheck('previewBudget', ok ? 'pass' : 'fail', `live=${stats.live}/${stats.maxLivePreviews}; A=${a?.state}; B=${b?.state}; low=${low?.state}`)
    await ctx.windowPreview.releasePreview(extra.id)
  }

  async function placeZone(zone: PlacementZone): Promise<PlacementResult> {
    const current = requireTarget()
    lastPlacement = await ctx.windowPlacement.place(current.id, { kind: zone })
    assertPlacementApplied(zone, lastPlacement)
    setCheck('placementZones', 'pass', `${zone}: ${lastPlacement.status}${lastPlacement.adjustments.length ? ` (${lastPlacement.adjustments.join(', ')})` : ''}`)
    return lastPlacement
  }

  async function restorePlacement(): Promise<PlacementResult> {
    const current = requireTarget()
    lastPlacement = await ctx.windowPlacement.restorePlacement(current.id)
    assertPlacementApplied('restore', lastPlacement)
    setCheck('placementRestore', 'pass', `${lastPlacement.status}; placement record released=${ctx.windowPlacement.getPlacementRecord(current.id) === undefined}`)
    return lastPlacement
  }

  async function queryConstraints(): Promise<void> {
    const current = requireTarget()
    lastConstraints = await ctx.windowControl.getPlacementConstraints(current.id)
    setCheck('constraints', 'pass', `resizable=${lastConstraints.resizable}; appConstraintsObserved=${lastConstraints.appConstraintsObserved}; min=${lastConstraints.minTrackWidth ?? '-'}×${lastConstraints.minTrackHeight ?? '-'}`)
  }

  async function testMaximizedPlacement(): Promise<void> {
    const current = requireTarget()
    const maximized = await ctx.windowControl.maximize(current.id)
    if (!maximized.accepted) throw new Error('Maximize was rejected.')
    await sleep(120)
    await ctx.windowRegistry.refresh()
    const placed = await ctx.windowPlacement.place(current.id, { kind: 'left-half' })
    assertPlacementApplied('maximized → left-half', placed)
    const restored = await ctx.windowPlacement.restorePlacement(current.id)
    assertPlacementApplied('maximized restore', restored)
    await ctx.windowRegistry.refresh()
    const state = ctx.windowRegistry.getWindow(current.id)?.state
    setCheck('maximized', state === 'maximized' ? 'pass' : 'fail', `final registry state=${state ?? 'missing'}`)
  }

  async function testConflict(): Promise<void> {
    const current = requireTarget()
    const [first, second] = await Promise.all([
      ctx.windowPlacement.place(current.id, { kind: 'left-half' }),
      ctx.windowPlacement.place(current.id, { kind: 'right-half' }),
    ])
    const conflict = [first, second].find(result => result.reason === 'operation-conflict')
    setCheck('conflict', conflict ? 'pass' : 'fail', `results=${first.status}/${first.reason ?? '-'}, ${second.status}/${second.reason ?? '-'}`)
    if (ctx.windowPlacement.getPlacementRecord(current.id)) await ctx.windowPlacement.restorePlacement(current.id).catch(() => undefined)
  }

  async function testCancellation(): Promise<void> {
    const current = requireTarget()
    const controller = new AbortController()
    controller.abort()
    const result = await ctx.windowPlacement.place(current.id, { kind: 'center' }, { signal: controller.signal })
    setCheck('cancellation', result.status === 'cancelled' ? 'pass' : 'fail', `status=${result.status}; reason=${result.reason ?? '-'}`)
  }

  async function testStaleId(): Promise<void> {
    const current = requireTarget()
    const oldId = current.id
    if (!previewAId) await acquire('A')
    if (!previewBId) await acquire('B')
    const trackedLeaseIds = [previewAId, previewBId].filter((id): id is string => Boolean(id))
    const closed = await ctx.windowControl.close(oldId)
    if (!closed.accepted) throw new Error('Close was rejected; stale lifetime test cannot proceed.')
    const deadline = Date.now() + WAIT_MS
    while (Date.now() < deadline) {
      await ctx.windowRegistry.refresh()
      if (!ctx.windowRegistry.getWindow(oldId)) break
      await sleep(70)
    }
    await ctx.windowPreview.refresh()
    const destroyedStates = trackedLeaseIds.map(id => ctx.windowPreview.getLease(id)?.state)
    const previewCleanupOk = destroyedStates.every(state => state === 'destroyed') && ctx.windowPreview.getStats().nativeBindings === 0
    setCheck('previewDestroy', previewCleanupOk ? 'pass' : 'fail', `lease states=${destroyedStates.join(',')}; native=${ctx.windowPreview.getStats().nativeBindings}`)
    const result = await ctx.windowPlacement.place(oldId, { kind: 'center' })
    const ok = result.status === 'rejected' && result.reason === 'stale-window-id'
    setCheck('staleId', ok ? 'pass' : 'fail', `status=${result.status}; reason=${result.reason ?? '-'}`)
    await releasePreviews()
    selectedWindowId = undefined
  }

  async function moveToMonitor(id: string): Promise<void> {
    const current = requireTarget()
    const monitorId = id as MonitorId
    lastPlacement = await ctx.windowPlacement.place(current.id, { kind: 'move-to-monitor', monitorId, placement: 'center' })
    assertPlacementApplied('move-to-monitor', lastPlacement)
    setCheck('monitorMove', 'pass', `monitor=${monitorId}; status=${lastPlacement.status}`)
  }

  async function applyNamedLayout(primaryId: string, secondaryId: string): Promise<void> {
    if (!primaryId || !secondaryId) throw new Error('Select both primary and secondary application windows.')
    if (primaryId === secondaryId) throw new Error('Primary and secondary targets must be different windows.')
    const first = ctx.windowRegistry.getWindow(primaryId as WindowId)
    const second = ctx.windowRegistry.getWindow(secondaryId as WindowId)
    if (!first || !second || !isPlacementCandidate(first) || !isPlacementCandidate(second)) {
      throw new Error('Both named-layout targets must be live application windows.')
    }
    const result = await ctx.windowPlacement.applyNamedLayout({
      name: 'phase17-console-two-up',
      entries: [
        { windowId: first.id, target: { kind: 'left-half' } },
        { windowId: second.id, target: { kind: 'right-half' } },
      ],
    })
    const ok = result.rejected === 0 && result.cancelled === 0 && result.applied + result.adjusted === 2
    setCheck('namedLayout', ok ? 'pass' : 'fail', `applied=${result.applied}; adjusted=${result.adjusted}; rejected=${result.rejected}; cancelled=${result.cancelled}`)
  }

  async function automatedCore(): Promise<void> {
    log('info', 'Starting guided core sequence. Visual confirmation remains manual.')
    if (!target()) await spawnNotepadTarget()
    await acquire('A')
    await acquire('B')
    await testPreviewVisibility()
    await testPreviewMinimizeRestore()
    await testSessionCycle()
    await testPreviewSourceResize()
    await testPreviewBudget()
    await queryConstraints()
    await placeZone('left-half')
    await placeZone('right-half')
    await restorePlacement()
    await testConflict()
    await testCancellation()
    log('pass', 'Core automated sequence completed. Finish manual preview and monitor/named-layout checks as applicable.')
  }

  function snapshotState(): unknown {
    const windows = candidates().map(window => ({
      id: window.id,
      title: window.title,
      className: window.className,
      processId: window.processId,
      state: window.state,
      bounds: window.bounds,
      monitorId: window.monitorId,
      classification: window.classification,
    }))
    const current = target()
    const monitors = ctx.windowsContext.getMonitors().map(monitor => ({
      id: monitor.id,
      deviceName: monitor.deviceName,
      friendlyName: monitor.friendlyName,
      bounds: monitor.bounds,
      workArea: monitor.workArea,
      dpiX: monitor.dpiX,
      dpiY: monitor.dpiY,
      scaleFactor: monitor.scaleFactor,
      isPrimary: monitor.isPrimary,
    }))
    const selectedMonitor = selectedMonitorId ?? ctx.windowsContext.getPrimaryMonitor().id
    return {
      commandState: commandState ?? null,
      selectedWindowId,
      secondaryWindowId,
      selectedMonitorId: selectedMonitor,
      target: current ? {
        id: current.id,
        title: current.title,
        className: current.className,
        processId: current.processId,
        state: current.state,
        bounds: current.bounds,
        monitorId: current.monitorId,
      } : null,
      windows,
      monitors,
      previewA: previewAId ? ctx.windowPreview.getLease(previewAId) ?? null : null,
      previewB: previewBId ? ctx.windowPreview.getLease(previewBId) ?? null : null,
      previewStats: ctx.windowPreview.getStats(),
      placementRecord: selectedWindowId ? ctx.windowPlacement.getPlacementRecord(selectedWindowId) ?? null : null,
      lastPlacement: lastPlacement ?? null,
      lastConstraints: lastConstraints ?? null,
      checks,
      logs,
      generatedAt: Date.now(),
    }
  }

  function report(): unknown {
    return {
      product: 'ELIX',
      scope: 'Phase 17A + 17B interactive acceptance',
      generatedAt: new Date().toISOString(),
      state: snapshotState(),
    }
  }

  async function shutdown(): Promise<void> {
    if (shuttingDown) return
    shuttingDown = true
    log('info', 'Shutting down Phase 17 Test Console.')
    await cleanupResources()
  }

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (request.method === 'GET' && url.pathname === '/') {
        sendHtml(response, dashboardHtml(geometry))
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/state') {
        sendJson(response, 200, snapshotState())
        return
      }
      if (request.method !== 'POST' || url.pathname !== '/api/action') {
        sendJson(response, 404, { error: 'Not found' })
        return
      }

      const body = await readBody(request)
      const action = body.action ?? ''
      switch (action) {
        case 'gate-all':
          await runAutomatedGate()
          break
        case 'gate-lockfile':
          await runRepoCommand('Frozen lockfile verification', ['install', '--frozen-lockfile', '--lockfile-only', '--ignore-scripts'], 'toolingLockfile')
          break
        case 'gate-focused':
          await runFocusedGate()
          break
        case 'gate-typecheck':
          await runRepoCommand('Host TypeScript typecheck', ['exec', 'tsc', '-b', 'tsconfig.host.json', '--pretty', 'false'], 'toolingTypecheck')
          break
        case 'gate-build':
          await runRepoCommand('Repository build', ['run', 'build'], 'toolingBuild')
          break
        case 'gate-full-tests':
          await runRepoCommand('Full repository tests', ['run', 'test'])
          break
        case 'refresh':
          await refreshAuthorities()
          break
        case 'spawn-notepad':
          await spawnNotepadTarget()
          break
        case 'select-target': {
          if (!body.windowId) {
            selectedWindowId = undefined
            break
          }
          const selected = ctx.windowRegistry.getWindow(body.windowId as WindowId)
          if (!selected || !isTargetCandidate(selected)) throw new Error('Selected target is no longer a visible supported window.')
          if (selectedWindowId !== selected.id) await releasePreviews()
          selectedWindowId = selected.id
          setCheck('target', 'pass', `Selected ${selected.title || selected.className} as ${selected.id}`)
          break
        }
        case 'select-secondary':
          secondaryWindowId = body.secondaryWindowId ? body.secondaryWindowId as WindowId : undefined
          break
        case 'select-monitor':
          selectedMonitorId = body.monitorId ? body.monitorId as MonitorId : undefined
          break
        case 'preview-acquire-a':
          await acquire('A')
          break
        case 'preview-acquire-b':
          await acquire('B')
          break
        case 'preview-release-all':
          await releasePreviews()
          break
        case 'preview-hide-a':
          await testPreviewVisibility()
          break
        case 'preview-show-a':
          if (!previewAId) await acquire('A')
          else await ctx.windowPreview.updateLease(previewAId, { visible: true })
          break
        case 'preview-refresh':
          await ctx.windowRegistry.refresh()
          await ctx.windowPreview.refresh()
          break
        case 'minimize-restore-preview':
          await testPreviewMinimizeRestore()
          break
        case 'preview-session-cycle':
          await testSessionCycle()
          break
        case 'preview-source-resize':
          await testPreviewSourceResize()
          break
        case 'preview-budget':
          await testPreviewBudget()
          break
        case 'manual-preview-pass':
          setCheck('previewVisual', 'pass', 'User confirmed preview pixels match the selected source window.')
          break
        case 'manual-live-pass':
          setCheck('previewLive', 'pass', 'User confirmed visible source content changes update in the preview.')
          break
        case 'preview-opacity': {
          if (!previewAId) await acquire('A')
          const opacity = Number.isFinite(body.opacity) ? Math.max(40, Math.min(255, Math.round(body.opacity as number))) : 255
          await ctx.windowPreview.updateLease(previewAId as string, { opacity })
          log('info', `Preview A opacity set to ${opacity}.`)
          break
        }
        case 'place-zone': {
          const zone = body.zone as PlacementZone | undefined
          if (!zone || !ZONES.includes(zone)) throw new Error(`Unknown placement zone '${body.zone ?? ''}'.`)
          await placeZone(zone)
          break
        }
        case 'placement-restore':
          await restorePlacement()
          break
        case 'placement-free': {
          const current = requireTarget()
          const released = ctx.windowPlacement.establishFreePlacement(current.id)
          log('info', `establishFreePlacement(${current.id}) => ${released}`)
          break
        }
        case 'constraints':
          await queryConstraints()
          break
        case 'maximized-placement':
          await testMaximizedPlacement()
          break
        case 'operation-conflict':
          await testConflict()
          break
        case 'cancellation':
          await testCancellation()
          break
        case 'move-monitor':
          if (!body.monitorId) throw new Error('Choose a monitor first.')
          await moveToMonitor(body.monitorId)
          break
        case 'named-layout':
          await applyNamedLayout(body.windowId ?? String(selectedWindowId ?? ''), body.secondaryWindowId ?? String(secondaryWindowId ?? ''))
          break
        case 'manual-topology-pass':
          setCheck('topologyManual', 'pass', 'User confirmed placement remains correct after monitor/DPI/orientation change and refresh.')
          break
        case 'stale-id':
          await testStaleId()
          break
        case 'automated-core':
          await automatedCore()
          break
        case 'reset-checks':
          for (const [key, entry] of Object.entries(checks)) {
            entry.state = key === 'previewVisual' || key === 'previewLive' || key === 'topologyManual' ? 'manual' : 'idle'
            entry.detail = key === 'previewVisual'
              ? 'Confirm this yourself after preview is live.'
              : key === 'previewLive'
                ? 'Edit/type in the selected app and confirm the preview updates.'
                : key === 'topologyManual'
                  ? 'Change display topology/DPI/orientation, refresh, then confirm placement remains correct.'
                  : ''
          }
          lastPlacement = undefined
          lastConstraints = undefined
          log('info', 'Checklist reset.')
          break
        case 'download-report':
          sendJson(response, 200, { ok: true, download: report() })
          return
        case 'shutdown':
          sendJson(response, 200, { ok: true })
          setTimeout(() => {
            void (async () => {
              await shutdown()
              process.exit(0)
            })()
          }, 80)
          return
        default:
          throw new Error(`Unknown action '${action}'.`)
      }
      sendJson(response, 200, { ok: true })
    } catch (error) {
      const message = errorMessage(error)
      log('fail', message)
      sendJson(response, 400, { error: message })
    }
  })
  serverForCleanup = server

  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      server.listen(0, '127.0.0.1', () => resolveListen())
    })
    const address = server.address() as AddressInfo
    const url = `http://127.0.0.1:${address.port}/`

    surface = await ctx.surface.create({
      id: CONSOLE_SURFACE_ID,
      bounds: {
        x: primary.workArea.x + Math.max(0, Math.floor((primary.workArea.width - width) / 2)),
        y: primary.workArea.y + Math.max(0, Math.floor((primary.workArea.height - height) / 2)),
        width,
        height,
      },
      monitorId: primary.id,
      renderer: { type: 'url', target: url },
      focusPolicy: 'normal',
      zOrderPolicy: 'topmost',
      skipTaskbar: false,
      transparent: true,
      visible: false,
      userDataFolder: join(tempDir, 'webview2-console'),
    })
    await surface.whenReady()
    await surface.show()

    const consoleBounds = surface.bounds
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
    await Promise.all([previewSurfaceA.show(), previewSurfaceB.show()])
    selectedMonitorId = primary.id
    log('pass', `Phase 17 Test Console ready at ${url}`)
    log('info', 'Open a test Notepad or select another visible application, then work top-to-bottom through the checklist.')

    const terminate = () => {
      void (async () => {
        await shutdown()
        process.exit(0)
      })()
    }
    process.once('SIGINT', terminate)
    process.once('SIGTERM', terminate)
  } catch (error) {
    await cleanupResources()
    throw error
  }
}

main().catch(error => {
  console.error('ELIX PHASE 17 TEST CONSOLE FAILED')
  console.error(error)
  process.exitCode = 1
})
