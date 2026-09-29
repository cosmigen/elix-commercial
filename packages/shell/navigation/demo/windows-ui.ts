import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import GlobalInputService from '@deepseek-ai/dsh-global-input'
import { createNativeBridge } from '@deepseek-ai/dsh-native-core'
import SpacesService, { type SpaceId } from '@deepseek-ai/dsh-spaces'
import WindowControlService from '@deepseek-ai/dsh-window-control'
import WindowRegistryService, { type WindowId } from '@deepseek-ai/dsh-window-registry'
import ShellNavigationService, { type ShellNavigationCommand } from '../src/index.ts'

const HOST = '127.0.0.1'
const DEFAULT_PORT = 4319
const MAX_BODY_BYTES = 32 * 1024
const MAX_EVENTS = 80

interface UiEvent {
  readonly kind: 'input' | 'navigation' | 'fault'
  readonly text: string
  readonly capturedAt: number
}

const COMMANDS = new Set<ShellNavigationCommand>([
  'space.next',
  'space.previous',
  'overview.toggle',
  'task-switcher.next',
  'task-switcher.previous',
  'navigation.commit',
  'navigation.cancel',
])

function html(token: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ELIX Phase 18B — Live Acceptance</title>
<style>
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#090b0f;color:#eef2f7}.shell{width:min(1240px,calc(100% - 32px));margin:0 auto;padding:28px 0 54px}
header{display:flex;justify-content:space-between;align-items:flex-start;gap:18px;margin-bottom:20px}.eyebrow{font:600 12px/1.2 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.14em;text-transform:uppercase;color:#8994a4}h1{margin:7px 0 8px;font-size:clamp(28px,4vw,46px);letter-spacing:-.04em}.sub{margin:0;max-width:820px;color:#9ba5b4;line-height:1.55}.status{min-width:250px;border:1px solid #242a34;border-radius:16px;padding:13px 14px;background:#11151b}.status-line{display:flex;align-items:center;justify-content:space-between;gap:14px;font-size:13px}.dot{width:9px;height:9px;border-radius:50%;background:#5fe38a;box-shadow:0 0 16px rgba(95,227,138,.5)}
.notice{display:none;margin-bottom:14px;border:1px solid #3a424f;background:#11151b;border-radius:12px;padding:11px 13px;color:#cbd3dd;font-size:13px}.notice.show{display:block}.notice.error{border-color:#65333a;color:#ffb9c0}.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:14px}.card{border:1px solid #242a34;background:#10141a;border-radius:18px;padding:18px}.space-card,.task-card{grid-column:span 7}.mode-card,.log-card{grid-column:span 5}.bindings-card,.overview-card{grid-column:1/-1}.card h2{margin:0 0 6px;font-size:18px}.card p{margin:0;color:#8994a4;line-height:1.5;font-size:13px}.big{margin:17px 0 4px;font-size:25px;font-weight:760;letter-spacing:-.03em}.meta{margin-top:6px;color:#7e8999;font:12px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace;word-break:break-all}.actions{display:flex;flex-wrap:wrap;gap:9px;margin-top:15px}button{border:1px solid #303744;background:#171c24;color:#f2f5f8;padding:10px 13px;border-radius:10px;cursor:pointer;font:inherit;transition:.15s ease}button:hover{background:#202733;border-color:#465064;transform:translateY(-1px)}button.primary{background:#eef2f7;color:#0c0e12;border-color:#eef2f7;font-weight:700}button:disabled{opacity:.45;cursor:default;transform:none}.mode{margin-top:16px;font-size:31px;font-weight:760;letter-spacing:-.04em}.selected{margin-top:14px;border:1px solid #334052;border-radius:13px;padding:13px;background:#121923}.selected strong{display:block;font-size:16px;margin-bottom:4px}.candidate-list{margin-top:12px;border-top:1px solid #202630}.candidate{display:flex;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:1px solid #1c222c;font-size:12px;color:#b9c2cf}.candidate.active{color:#fff;font-weight:700}.badge{font:700 10px/1 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.06em;padding:6px 8px;border-radius:999px;background:#223128;color:#9be6b3}.badge.conflict,.badge.failed{background:#3a2328;color:#ffb8c0}.binding{display:grid;grid-template-columns:minmax(170px,1fr) minmax(220px,1.4fr) auto;gap:12px;align-items:center;padding:10px 0;border-bottom:1px solid #202630;font-size:12px}.binding:last-child{border-bottom:0}.command{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;color:#d8dee8}kbd{border:1px solid #3a4351;background:#171c24;border-bottom-width:2px;border-radius:6px;padding:4px 7px;font:600 11px/1 ui-monospace,SFMono-Regular,Consolas,monospace;color:#eef2f7;white-space:nowrap}.log{margin-top:12px;max-height:410px;overflow:auto;border-top:1px solid #202630}.log-row{padding:8px 0;border-bottom:1px solid #181e27;font:12px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace;color:#b9c2cf}.log-row.input{color:#9bc5ff}.log-row.navigation{color:#a8e0ba}.log-row.fault{color:#ffb3bc}
.overview-card{display:none;outline:1px solid #334052;box-shadow:0 20px 80px rgba(0,0,0,.25)}.overview-card.show{display:block}.overview-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px}.overview-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:12px;margin-top:16px}.overview-space{border:1px solid #252d38;background:#0d1117;border-radius:14px;padding:14px}.overview-space.current{border-color:#66758a}.overview-space-title{display:flex;justify-content:space-between;align-items:center;gap:10px;font-weight:750}.overview-window{margin-top:8px;border:1px solid #202834;background:#131922;border-radius:10px;padding:10px}.overview-window.foreground{border-color:#49725a}.overview-window-title{font-size:12px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.overview-window .actions{margin-top:8px}.overview-window button,.overview-space button{padding:7px 9px;font-size:11px}.foreground{color:#9be6b3}
footer{margin-top:20px;color:#6f7a8a;font-size:12px;line-height:1.55}code{color:#bbc5d2}@media(max-width:860px){header{flex-direction:column}.status{width:100%}.space-card,.task-card,.mode-card,.log-card{grid-column:1/-1}.binding{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="shell">
<header><div><div class="eyebrow">ELIX / Phase 18B / Live Windows Acceptance</div><h1>Global Input & Shell Navigation</h1><p class="sub">This test surface consumes the reusable authorities. It is not the final ELIX UI: the actual navigation, Space and WindowId state remains service-owned and reusable anywhere.</p></div><div class="status"><div class="status-line"><span>Global input provider</span><span class="dot"></span></div><div class="meta" id="provider">connecting…</div><div class="meta" id="foreground">foreground: loading…</div></div></header>
<div id="notice" class="notice"></div>
<main class="grid">
<section class="card space-card"><h2>Space navigation</h2><p>The visual preview uses the real Spaces authority and returns to the exact origin after three seconds. Global arrows exercise ShellNavigationService.</p><div id="space" class="big">Loading…</div><div id="spaceId" class="meta"></div><div class="actions"><button class="primary" data-preview="previous">← Preview previous 3s</button><button class="primary" data-preview="next">Preview next 3s →</button><button data-command="space.previous">← Switch previous</button><button data-command="space.next">Switch next →</button></div><div class="meta" style="margin-top:14px">Global: <b>Ctrl + Alt + Shift + ← / →</b></div></section>
<section class="card mode-card"><h2>Shell mode</h2><p>Overview toggle changes reusable shell state. This harness now renders that state below so you can see the behavior.</p><div id="mode" class="mode">idle</div><div id="offset" class="meta">task offset: 0</div><div class="actions"><button id="overviewToggle" data-command="overview.toggle">Open Overview</button><button data-local="Enter">Commit</button><button data-local="Escape">Cancel</button></div></section>
<section id="overviewPanel" class="card overview-card"><div class="overview-head"><div><h2>Overview — live Spaces + application windows</h2><p>This is only an acceptance renderer. A future ELIX Overview can use the same service state and authorities with any design.</p></div><button data-command="overview.toggle">Close Overview</button></div><div id="overviewGrid" class="overview-grid"></div></section>
<section class="card task-card"><h2>Real task switch session</h2><p>Task ◀/▶ selects stable WindowIds without stealing focus. Commit activates the selected app. For the strongest Windows foreground test, use the global commit chord after selecting.</p><div id="selected" class="selected"><strong>No task selection</strong><span class="meta">Press Task ▶ or Task ◀.</span></div><div class="actions"><button data-command="task-switcher.previous">Task ◀</button><button data-command="task-switcher.next">Task ▶</button><button class="primary" data-local="Enter">Activate selected</button><button data-local="Escape">Cancel task session</button><button data-quick-task="next">Quick switch next app</button><button data-quick-task="previous">Quick switch previous app</button></div><div id="candidates" class="candidate-list"></div><div class="meta" style="margin-top:12px">Global: <b>Ctrl + Alt + Shift + J / K</b> selects · <b>Ctrl + Alt + Shift + Enter</b> commits · <b>Ctrl + Alt + Shift + Escape</b> cancels.</div></section>
<section class="card log-card"><h2>Live event log</h2><p>Input, selection, activation, Overview and Space events appear here.</p><div id="log" class="log"></div></section>
<section class="card bindings-card"><h2>Registered global bindings</h2><p>These are live registrations owned by GlobalInputService.</p><div id="bindings" style="margin-top:12px"></div></section>
</main>
<footer>Bound only to <code>127.0.0.1</code>. Every state-changing request requires a random per-run token. Press <code>Ctrl+C</code> in PowerShell to stop the test UI.</footer>
</div>
<script>
const TOKEN=${JSON.stringify(token)};const notice=document.getElementById('notice');let busy=false;
function esc(v){return String(v??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));}
function show(message,error=false){notice.textContent=message;notice.className='notice show'+(error?' error':'');clearTimeout(show.timer);show.timer=setTimeout(()=>notice.className='notice',5000);}
async function api(path,body){const response=await fetch(path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'content-type':'application/json','x-elix-token':TOKEN},body:body===undefined?undefined:JSON.stringify(body)});const payload=await response.json();if(!response.ok||payload.ok===false)throw new Error(payload.error||('HTTP '+response.status));return payload;}
function hotkey(binding){if(!binding)return'unavailable';const parts=[];if(binding.modifiers.control)parts.push('Ctrl');if(binding.modifiers.alt)parts.push('Alt');if(binding.modifiers.shift)parts.push('Shift');if(binding.modifiers.win)parts.push('Win');parts.push(binding.key);return parts.join(' + ');}
function render(data){
 document.getElementById('provider').textContent=data.provider;document.getElementById('space').textContent=data.currentSpace?.name||'(unknown Space)';document.getElementById('spaceId').textContent=data.currentSpace?.id||'';document.getElementById('mode').textContent=data.navigation.mode;document.getElementById('offset').textContent='task offset: '+data.navigation.taskSwitchOffset+(data.navigation.lastCommand?' · last: '+data.navigation.lastCommand:'');document.getElementById('foreground').textContent='foreground: '+(data.foreground?.title||data.foreground?.executableName||'(unknown)');
 const selected=data.selectedTask;if(selected){document.getElementById('selected').innerHTML='<strong>'+esc(selected.title||selected.executableName||selected.id)+'</strong><span class="meta">selected WindowId: '+esc(selected.id)+(selected.isForeground?' · FOREGROUND':'')+'</span>';}else{document.getElementById('selected').innerHTML='<strong>No task selection</strong><span class="meta">Press Task ▶ or Task ◀.</span>';}
 document.getElementById('candidates').innerHTML=data.taskCandidates.length?data.taskCandidates.map((item,index)=>'<div class="candidate '+(item.selected?'active':'')+'"><span>'+(item.selected?'▶ ':'')+esc(item.title||item.executableName||item.id)+'</span><span>'+(index+1)+'/'+data.taskCandidates.length+'</span></div>').join(''):'<div class="candidate"><span>No active task-switch session.</span></div>';
 document.getElementById('bindings').innerHTML=data.bindings.map(item=>'<div class="binding"><span class="command">'+esc(item.command)+'</span><kbd>'+esc(hotkey(item.binding))+'</kbd><span class="badge '+esc(item.state)+'">'+esc(item.state)+'</span></div>').join('');
 document.getElementById('log').innerHTML=data.events.length?[...data.events].reverse().map(event=>'<div class="log-row '+esc(event.kind)+'">'+esc(event.text)+'</div>').join(''):'<div class="log-row">No events yet.</div>';
 const overviewOpen=data.navigation.mode==='overview';document.getElementById('overviewPanel').classList.toggle('show',overviewOpen);document.getElementById('overviewToggle').textContent=overviewOpen?'Close Overview':'Open Overview';
 document.getElementById('overviewGrid').innerHTML=data.overviewSpaces.map(space=>'<section class="overview-space '+(space.isCurrent?'current':'')+'"><div class="overview-space-title"><span>'+esc(space.name)+'</span><span class="badge">'+(space.isCurrent?'CURRENT':'SPACE '+(space.index+1))+'</span></div><div class="meta">'+esc(space.id)+'</div><div class="actions"><button data-overview-space="'+esc(space.id)+'" '+(space.isCurrent?'disabled':'')+'>Switch here</button></div>'+(space.windows.length?space.windows.map(win=>'<div class="overview-window '+(win.isForeground?'foreground':'')+'"><div class="overview-window-title">'+esc(win.title||win.executableName||win.id)+'</div><div class="meta">'+esc(win.executableName||'application')+(win.isForeground?' · FOREGROUND':'')+'</div><div class="actions"><button data-overview-window="'+esc(win.id)+'" data-space-id="'+esc(space.id)+'">Activate</button></div></div>').join(''):'<div class="meta" style="margin-top:12px">No application windows</div>')+'</section>').join('');
}
async function refresh(){try{render((await api('/api/state')).state)}catch(error){show(error.message,true)}}
async function post(path,body,success){if(busy)return;busy=true;try{const result=await api(path,body);if(result.state)render(result.state);if(success)show(success)}catch(error){show(error.message,true)}finally{busy=false;await refresh()}}
document.body.addEventListener('click',event=>{const command=event.target.closest('button[data-command]');if(command)return void post('/api/command',{command:command.dataset.command},'Command executed.');const preview=event.target.closest('button[data-preview]');if(preview)return void post('/api/preview',{direction:preview.dataset.preview},'3-second Space preview started.');const local=event.target.closest('button[data-local]');if(local)return void post('/api/local-key',{key:local.dataset.local},local.dataset.local==='Enter'?'Selected task committed.':'Navigation cancelled.');const quick=event.target.closest('button[data-quick-task]');if(quick)return void post('/api/quick-task',{direction:quick.dataset.quickTask},'Quick task switch committed.');const space=event.target.closest('button[data-overview-space]');if(space)return void post('/api/overview-space',{spaceId:space.dataset.overviewSpace},'Overview Space selected.');const win=event.target.closest('button[data-overview-window]');if(win)return void post('/api/overview-window',{windowId:win.dataset.overviewWindow,spaceId:win.dataset.spaceId},'Overview window activation requested.');});
document.addEventListener('keydown',event=>{if(event.target instanceof HTMLInputElement||event.target instanceof HTMLTextAreaElement)return;if(event.key==='Escape'||event.key==='Enter'){event.preventDefault();void post('/api/local-key',{key:event.key},event.key+' handled by ShellNavigationService.')}});refresh();setInterval(()=>{if(!busy)refresh()},350);
</script>
</body></html>`
}

function json(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(JSON.stringify(payload))
}

async function bodyJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error('Request body is too large.')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON object required.')
  return value as Record<string, unknown>
}

function requireString(input: Record<string, unknown>, key: string): string {
  const value = input[key]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} must be a non-empty string.`)
  return value.trim()
}

function requireDirection(input: Record<string, unknown>): 'next' | 'previous' {
  const direction = requireString(input, 'direction')
  if (direction !== 'next' && direction !== 'previous') throw new Error('direction must be next or previous.')
  return direction
}

function modulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function main(): Promise<void> {
  if (process.platform !== 'win32') throw new Error('Phase 18B test UI requires Windows.')

  const nativeHostPath = join(process.cwd(), 'native', 'target', 'debug', 'elix-native-host.exe')
  const bridge = createNativeBridge({ binaryPath: nativeHostPath, debug: false })
  const ctx = new Context()
  const token = randomBytes(24).toString('hex')
  const events: UiEvent[] = []
  let previewGeneration = 0

  function pushEvent(kind: UiEvent['kind'], text: string): void {
    events.push({ kind, text, capturedAt: Date.now() })
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS)
  }

  await bridge.connect()
  if (bridge.getCapabilities()?.globalInput !== true) {
    throw new Error('Native host does not advertise globalInput. Rebuild elix-native-bridge.')
  }

  await ctx.plugin(WindowRegistryService, { enabled: true, bridge })
  await ctx.plugin(SpacesService, { enabled: true, bridge })
  await ctx.plugin(GlobalInputService, { enabled: true, bridge, pollIntervalMs: 40 })
  await ctx.plugin(WindowControlService, { enabled: true, bridge })
  await ctx.plugin(ShellNavigationService, {
    enabled: true,
    registerDefaultBindings: true,
    globalInput: ctx.globalInput,
    spaces: ctx.spaces,
    windowRegistry: ctx.windowRegistry,
    windowControl: ctx.windowControl,
  })

  await ctx.windowRegistry.refresh()
  await ctx.spaces.refresh()
  await ctx.shellNavigation.initializeBindings()

  const stopInput = ctx.globalInput.subscribe(event => {
    pushEvent('input', `INPUT ${event.bindingId} · ${event.key} · seq=${event.sequence}`)
  })
  const stopNavigation = ctx.shellNavigation.subscribe(event => {
    const selected = event.current.selectedWindowId
      ? ctx.windowRegistry.getWindow(event.current.selectedWindowId)
      : undefined
    const suffix = selected ? ` · selected=${selected.title || selected.executableName || selected.id}` : ''
    pushEvent('navigation', `NAV ${event.origin} · ${event.command} · mode=${event.current.mode} · offset=${event.current.taskSwitchOffset}${suffix}`)
  })
  const stopFault = ctx.on('shell-navigation/fault', error => {
    pushEvent('fault', `FAULT ${error.message}`)
  })

  function state() {
    const spaces = ctx.spaces.getSnapshot()
    const currentSpace = spaces.spaces.find(space => space.id === spaces.currentSpaceId)
    const navigation = ctx.shellNavigation.getSnapshot()
    const registryWindows = new Map(ctx.windowRegistry.getWindows().map(window => [window.id, window]))
    const taskCandidates = navigation.taskCandidateIds.map(id => {
      const window = registryWindows.get(id)
      return {
        id,
        title: window?.title ?? '',
        executableName: window?.executableName ?? '',
        isForeground: window?.isForeground ?? false,
        selected: id === navigation.selectedWindowId,
      }
    })
    const selectedTask = navigation.selectedWindowId
      ? taskCandidates.find(candidate => candidate.id === navigation.selectedWindowId)
      : undefined
    const foreground = ctx.windowRegistry.getForegroundWindow()
    const overviewSpaces = spaces.spaces.map(space => ({
      id: space.id,
      index: space.index ?? 0,
      name: space.name || `Desktop ${(space.index ?? 0) + 1}`,
      isCurrent: space.id === spaces.currentSpaceId,
      windows: space.windowIds.flatMap(id => {
        const window = registryWindows.get(id)
        if (!window || window.classification !== 'APPLICATION' || !window.isVisible) return []
        return [{
          id: window.id,
          title: window.title,
          executableName: window.executableName ?? '',
          isForeground: window.isForeground,
          isMinimized: window.isMinimized,
        }]
      }),
    }))
    return {
      provider: ctx.globalInput.getCapabilities().provider,
      currentSpace: currentSpace
        ? { id: currentSpace.id, name: currentSpace.name || `Desktop ${(currentSpace.index ?? 0) + 1}` }
        : undefined,
      foreground: foreground
        ? { id: foreground.id, title: foreground.title, executableName: foreground.executableName ?? '' }
        : undefined,
      navigation,
      selectedTask,
      taskCandidates,
      overviewSpaces,
      bindings: ctx.shellNavigation.getBindingStatuses(),
      events: [...events],
    }
  }

  async function activateWindow(windowId: WindowId): Promise<void> {
    let last = 'not confirmed'
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await ctx.windowControl.activate(windowId)
        last = `accepted=${result.accepted}, completed=${result.completed}, foreground=${result.observation.foreground}`
        await ctx.windowRegistry.refresh()
        if (result.observation.foreground || ctx.windowRegistry.getForegroundWindow()?.id === windowId) return
      } catch (error) {
        last = error instanceof Error ? error.message : String(error)
      }
      if (attempt === 0) await delay(100)
    }
    throw new Error(`Windows did not foreground ${windowId}: ${last}`)
  }

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', `http://${HOST}`)
      if (request.method === 'GET' && url.pathname === '/') {
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
          'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
        })
        response.end(html(token))
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/state') {
        json(response, 200, { ok: true, state: state() })
        return
      }
      if (request.method !== 'POST' || request.headers['x-elix-token'] !== token) {
        json(response, 403, { ok: false, error: 'Forbidden.' })
        return
      }

      const input = await bodyJson(request)
      if (url.pathname === '/api/command') {
        const raw = requireString(input, 'command') as ShellNavigationCommand
        if (!COMMANDS.has(raw)) throw new Error(`Unsupported command '${raw}'.`)
        if (raw === 'space.next' || raw === 'space.previous') previewGeneration++
        await ctx.shellNavigation.execute(raw, 'local-ui')
        json(response, 200, { ok: true, state: state() })
        return
      }

      if (url.pathname === '/api/local-key') {
        const key = requireString(input, 'key')
        if (key !== 'Enter' && key !== 'Escape') throw new Error('Local key must be Enter or Escape.')
        await ctx.shellNavigation.executeLocalKey(key)
        json(response, 200, { ok: true, state: state() })
        return
      }

      if (url.pathname === '/api/quick-task') {
        const direction = requireDirection(input)
        await ctx.shellNavigation.execute(direction === 'next' ? 'task-switcher.next' : 'task-switcher.previous', 'local-ui')
        await ctx.shellNavigation.execute('navigation.commit', 'local-ui')
        json(response, 200, { ok: true, state: state() })
        return
      }

      if (url.pathname === '/api/preview') {
        const direction = requireDirection(input)
        const fresh = await ctx.spaces.refresh()
        const origin = fresh.currentSpaceId
        if (!origin) throw new Error('Current Space is unknown.')
        const ordered = [...fresh.spaces].sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
        if (ordered.length < 2) throw new Error('At least two Spaces are required for preview.')
        const currentIndex = ordered.findIndex(space => space.id === origin)
        if (currentIndex < 0) throw new Error('Current Space is absent from enumeration.')
        const delta = direction === 'next' ? 1 : -1
        const target = ordered[modulo(currentIndex + delta, ordered.length)]!
        const generation = ++previewGeneration

        await ctx.spaces.switchSpace(target.id)
        const observed = await ctx.spaces.refresh()
        if (observed.currentSpaceId !== target.id) {
          throw new Error(`Space preview expected ${target.id} but Windows reports ${observed.currentSpaceId ?? 'unknown'}.`)
        }
        pushEvent('navigation', `PREVIEW ${origin} -> ${target.id} · return scheduled in 3s`)

        setTimeout(() => {
          if (generation !== previewGeneration) return
          void (async () => {
            try {
              await ctx.spaces.switchSpace(origin as SpaceId)
              const returned = await ctx.spaces.refresh()
              if (returned.currentSpaceId !== origin) throw new Error(`Windows reports ${returned.currentSpaceId ?? 'unknown'}`)
              pushEvent('navigation', `PREVIEW RETURN -> ${origin}`)
            } catch (error) {
              pushEvent('fault', `PREVIEW RETURN FAILED · ${error instanceof Error ? error.message : String(error)}`)
            }
          })()
        }, 3000)

        json(response, 200, { ok: true, state: state() })
        return
      }

      if (url.pathname === '/api/overview-space') {
        const spaceId = requireString(input, 'spaceId') as SpaceId
        previewGeneration++
        await ctx.spaces.switchSpace(spaceId)
        await ctx.spaces.refresh()
        if (ctx.shellNavigation.getSnapshot().mode === 'overview') {
          await ctx.shellNavigation.execute('overview.toggle', 'local-ui')
        }
        json(response, 200, { ok: true, state: state() })
        return
      }

      if (url.pathname === '/api/overview-window') {
        const spaceId = requireString(input, 'spaceId') as SpaceId
        const windowId = requireString(input, 'windowId') as WindowId
        previewGeneration++
        if (ctx.spaces.getCurrentSpaceId() !== spaceId) {
          await ctx.spaces.switchSpace(spaceId)
          await ctx.spaces.refresh()
          await delay(120)
        }
        await ctx.windowRegistry.refresh()
        const window = ctx.windowRegistry.getWindow(windowId)
        if (!window || window.classification !== 'APPLICATION') throw new Error('Overview target window is stale or not an application.')
        await activateWindow(windowId)
        if (ctx.shellNavigation.getSnapshot().mode === 'overview') {
          await ctx.shellNavigation.execute('overview.toggle', 'local-ui')
        }
        json(response, 200, { ok: true, state: state() })
        return
      }

      json(response, 404, { ok: false, error: 'Not found.' })
    } catch (error) {
      json(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })

  server.listen(DEFAULT_PORT, HOST, () => {
    const url = `http://${HOST}:${DEFAULT_PORT}/`
    console.log('='.repeat(78))
    console.log(' ELIX Phase 18B — INPUT & NAVIGATION TEST UI')
    console.log('='.repeat(78))
    console.log(`\nOpen: ${url}`)
    console.log('Test Space preview, visual Overview, task selection and global commit/cancel.')
    console.log('Press Ctrl+C here to stop the test UI.\n')
    spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref()
  })

  const shutdown = async () => {
    stopInput()
    stopNavigation()
    stopFault()
    server.close()
    await ctx.fiber.dispose().catch(() => undefined)
    await bridge.dispose().catch(() => undefined)
    process.exit(0)
  }
  process.once('SIGINT', () => void shutdown())
  process.once('SIGTERM', () => void shutdown())
}

main().catch(error => {
  console.error(`[FAIL] ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exitCode = 1
})
