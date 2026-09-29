import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createNativeBridge } from '@deepseek-ai/dsh-native-core'
import WindowRegistryService from '@deepseek-ai/dsh-window-registry'
import SpacesService, { type SpaceId } from '../src/index.ts'

const HOST = '127.0.0.1'
const DEFAULT_PORT = 4318
const MAX_BODY_BYTES = 32 * 1024

function html(token: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ELIX Phase 18A — Spaces Test UI</title>
<style>
:root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; background: #090b0f; color: #eef2f7; }
.shell { width: min(1180px, calc(100% - 32px)); margin: 0 auto; padding: 28px 0 56px; }
header { display: flex; gap: 20px; align-items: flex-start; justify-content: space-between; margin-bottom: 24px; }
.eyebrow { font: 600 12px/1.2 ui-monospace, SFMono-Regular, Consolas, monospace; letter-spacing: .14em; text-transform: uppercase; color: #8d98a8; }
h1 { margin: 7px 0 8px; font-size: clamp(28px, 4vw, 46px); letter-spacing: -.04em; }
.sub { margin: 0; max-width: 760px; color: #9ba5b4; line-height: 1.55; }
.status { min-width: 210px; border: 1px solid #242a34; border-radius: 16px; padding: 13px 14px; background: #11151b; }
.status-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; font-size: 13px; }
.dot { width: 9px; height: 9px; border-radius: 50%; background: #5fe38a; box-shadow: 0 0 16px rgba(95,227,138,.5); }
.toolbar { display: flex; flex-wrap: wrap; gap: 10px; margin: 0 0 18px; }
button, input { font: inherit; }
button { border: 1px solid #303744; background: #171c24; color: #f2f5f8; padding: 9px 13px; border-radius: 10px; cursor: pointer; transition: .15s ease; }
button:hover { background: #202733; border-color: #465064; transform: translateY(-1px); }
button:disabled { opacity: .45; cursor: default; transform: none; }
button.primary { background: #eef2f7; color: #0c0e12; border-color: #eef2f7; font-weight: 700; }
button.danger { color: #ffb8b8; border-color: #5a3338; }
input { min-width: 220px; border: 1px solid #303744; background: #11151b; color: #eef2f7; padding: 9px 12px; border-radius: 10px; outline: none; }
input:focus { border-color: #69778e; }
.notice { display: none; margin-bottom: 18px; border: 1px solid #3a424f; background: #11151b; border-radius: 12px; padding: 11px 13px; color: #cbd3dd; font-size: 13px; }
.notice.show { display: block; }
.notice.error { border-color: #65333a; color: #ffb9c0; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(310px, 1fr)); gap: 14px; }
.card { position: relative; border: 1px solid #242a34; background: #10141a; border-radius: 18px; overflow: hidden; min-height: 250px; }
.card.current { border-color: #67748a; box-shadow: inset 0 0 0 1px #67748a; }
.card-head { padding: 18px 18px 14px; border-bottom: 1px solid #202630; }
.title-line { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.desktop-name { font-size: 18px; font-weight: 750; letter-spacing: -.02em; }
.badge { font: 700 10px/1 ui-monospace, SFMono-Regular, Consolas, monospace; letter-spacing: .08em; padding: 6px 8px; border-radius: 999px; background: #26313e; color: #dce6f2; }
.meta { margin-top: 7px; color: #7e8999; font: 12px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace; word-break: break-all; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
.windows { padding: 10px 12px 14px; }
.window { display: flex; gap: 10px; align-items: center; min-height: 34px; border-radius: 9px; padding: 6px 8px; color: #c5ccd6; font-size: 12px; }
.window:hover { background: #161c24; }
.window-icon { width: 7px; height: 7px; border-radius: 2px; background: #596678; flex: 0 0 auto; }
.empty { padding: 18px 8px; color: #687384; font-size: 12px; text-align: center; }
footer { margin-top: 22px; color: #6f7a8a; font-size: 12px; line-height: 1.55; }
code { color: #bbc5d2; }
@media (max-width: 720px) { header { flex-direction: column; } .status { width: 100%; } }
</style>
</head>
<body>
<div class="shell">
  <header>
    <div>
      <div class="eyebrow">ELIX / Phase 18A / Live Windows Control</div>
      <h1>Spaces Test UI</h1>
      <p class="sub">Click <b>Preview 3s</b> on another desktop. Windows should visibly switch there, wait three seconds, then ELIX should bring you back to this desktop automatically.</p>
    </div>
    <div class="status">
      <div class="status-row"><span>Shell provider</span><span class="dot"></span></div>
      <div class="meta" id="provider">connecting…</div>
    </div>
  </header>

  <div class="toolbar">
    <input id="newName" placeholder="New Space name (optional)" />
    <button id="create" class="primary">+ Create Space</button>
    <button id="refresh">Refresh</button>
  </div>
  <div id="notice" class="notice"></div>
  <main id="grid" class="grid"></main>
  <footer>
    The server binds only to <code>127.0.0.1</code>. A random per-run token is required for every state-changing request. Closing the terminal stops this test UI.
  </footer>
</div>
<script>
const TOKEN = ${JSON.stringify(token)};
const grid = document.getElementById('grid');
const notice = document.getElementById('notice');
const provider = document.getElementById('provider');
const newName = document.getElementById('newName');
const createButton = document.getElementById('create');
let state = null;
let busy = false;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}
function showNotice(message, error = false) {
  notice.textContent = message;
  notice.className = 'notice show' + (error ? ' error' : '');
  clearTimeout(showNotice.timer);
  showNotice.timer = setTimeout(() => notice.className = 'notice', 5000);
}
async function api(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : {'content-type':'application/json','x-elix-token':TOKEN},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok || payload.ok === false) throw new Error(payload.error || ('HTTP ' + response.status));
  return payload;
}
function render(next) {
  state = next;
  provider.textContent = next.capabilities.provider + ' · revision ' + next.revision;
  createButton.disabled = busy || !next.capabilities.createSpace;
  grid.innerHTML = next.spaces.map(space => {
    const name = space.name || ('Desktop ' + (space.index + 1));
    const windowRows = space.windows.length
      ? space.windows.map(w => '<div class="window"><span class="window-icon"></span><span>' + escapeHtml(w.title || w.executableName || '(untitled)') + '</span></div>').join('')
      : '<div class="empty">No tracked application windows</div>';
    return '<section class="card ' + (space.isCurrent ? 'current' : '') + '">' +
      '<div class="card-head"><div class="title-line"><div class="desktop-name">' + escapeHtml(name) + '</div>' +
      (space.isCurrent ? '<span class="badge">CURRENT</span>' : '<span class="badge">SPACE ' + (space.index + 1) + '</span>') +
      '</div><div class="meta">' + escapeHtml(space.id) + '</div>' +
      '<div class="actions">' +
      '<button data-action="preview" data-id="' + escapeHtml(space.id) + '" ' + (space.isCurrent || busy || !next.capabilities.switchSpace ? 'disabled' : '') + '>Preview 3s</button>' +
      '<button data-action="switch" data-id="' + escapeHtml(space.id) + '" ' + (space.isCurrent || busy || !next.capabilities.switchSpace ? 'disabled' : '') + '>Switch</button>' +
      '<button data-action="rename" data-id="' + escapeHtml(space.id) + '" ' + (busy || !next.capabilities.renameSpace ? 'disabled' : '') + '>Rename</button>' +
      '<button class="danger" data-action="remove" data-id="' + escapeHtml(space.id) + '" ' + (busy || next.spaces.length <= 1 || !next.capabilities.removeSpace ? 'disabled' : '') + '>Remove</button>' +
      '</div></div><div class="windows">' + windowRows + '</div></section>';
  }).join('');
}
async function refresh() {
  try { render((await api('/api/state')).state); }
  catch (error) { showNotice(error.message, true); }
}
async function mutate(path, body, success) {
  busy = true;
  if (state) render(state);
  try {
    const result = await api(path, body);
    if (result.state) render(result.state);
    if (success) showNotice(success);
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    busy = false;
    await refresh();
  }
}

document.getElementById('refresh').onclick = refresh;
createButton.onclick = () => mutate('/api/create', {name:newName.value.trim() || undefined}, 'Space created.');
grid.onclick = async event => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const id = button.dataset.id;
  const action = button.dataset.action;
  if (action === 'preview') return mutate('/api/switch', {spaceId:id, returnAfterMs:3000}, 'Preview completed.');
  if (action === 'switch') return mutate('/api/switch', {spaceId:id}, 'Space switched. Use Win+Ctrl+Left/Right to return if this browser stayed behind.');
  if (action === 'rename') {
    const name = prompt('New Space name:');
    if (name !== null && name.trim()) return mutate('/api/rename', {spaceId:id,name:name.trim()}, 'Space renamed.');
  }
  if (action === 'remove') {
    if (!confirm('Remove this Space? Windows will move its windows to a fallback Space.')) return;
    return mutate('/api/remove', {spaceId:id}, 'Space removed.');
  }
};

refresh();
setInterval(() => { if (!busy) refresh(); }, 800);
</script>
</body>
</html>`
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

async function main(): Promise<void> {
  if (process.platform !== 'win32') throw new Error('Phase 18A Spaces UI requires Windows.')

  const nativeHostPath = join(process.cwd(), 'native', 'target', 'debug', 'elix-native-host.exe')
  const bridge = createNativeBridge({ binaryPath: nativeHostPath, debug: false })
  const ctx = new Context()
  const token = randomBytes(24).toString('hex')

  await bridge.connect()
  await ctx.plugin(WindowRegistryService, { enabled: true, bridge })
  await ctx.plugin(SpacesService, { enabled: true, bridge })
  await ctx.windowRegistry.refresh()
  await ctx.spaces.refresh()

  if (ctx.spaces.getCapabilities().provider !== 'windows-shell-virtual-desktop') {
    throw new Error(`Full Shell Spaces provider is unavailable: ${JSON.stringify(ctx.spaces.getCapabilities())}`)
  }

  function state() {
    const snapshot = ctx.spaces.getSnapshot()
    const windows = new Map(ctx.windowRegistry.getWindows().map(window => [window.id, window]))
    return {
      revision: snapshot.revision,
      currentSpaceId: snapshot.currentSpaceId,
      capabilities: snapshot.capabilities,
      completeness: snapshot.completeness,
      spaces: snapshot.spaces.map(space => ({
        id: space.id,
        index: space.index ?? 0,
        name: space.name,
        isCurrent: space.isCurrent,
        windows: space.windowIds.map(id => {
          const window = windows.get(id)
          return {
            id,
            title: window?.title ?? '',
            executableName: window?.executableName ?? '',
          }
        }),
      })),
    }
  }

  let previewGeneration = 0
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
      if (url.pathname === '/api/switch') {
        const destination = requireString(input, 'spaceId') as SpaceId
        const returnAfterMs = typeof input.returnAfterMs === 'number' ? input.returnAfterMs : undefined
        const origin = ctx.spaces.getCurrentSpaceId()
        if (!origin) throw new Error('Current Space is unknown.')
        const generation = ++previewGeneration
        await ctx.spaces.switchSpace(destination)
        if (returnAfterMs !== undefined) {
          if (!Number.isFinite(returnAfterMs) || returnAfterMs < 500 || returnAfterMs > 15_000) {
            throw new Error('returnAfterMs must be between 500 and 15000.')
          }
          setTimeout(() => {
            if (generation !== previewGeneration) return
            void ctx.spaces.switchSpace(origin).catch(error => console.error('[UI] preview return failed:', error))
          }, returnAfterMs)
        }
        json(response, 200, { ok: true, state: state() })
        return
      }
      if (url.pathname === '/api/create') {
        const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : undefined
        await ctx.spaces.createSpace(name)
        json(response, 200, { ok: true, state: state() })
        return
      }
      if (url.pathname === '/api/rename') {
        await ctx.spaces.renameSpace(requireString(input, 'spaceId') as SpaceId, requireString(input, 'name'))
        json(response, 200, { ok: true, state: state() })
        return
      }
      if (url.pathname === '/api/remove') {
        const target = requireString(input, 'spaceId') as SpaceId
        const current = ctx.spaces.getCurrentSpaceId()
        const fallback = ctx.spaces.getSnapshot().spaces.find(space => space.id !== target && space.id === current)?.id
          ?? ctx.spaces.getSnapshot().spaces.find(space => space.id !== target)?.id
        if (!fallback) throw new Error('No fallback Space is available.')
        await ctx.spaces.removeSpace(target, fallback)
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
    console.log(' ELIX Phase 18A — SPACES TEST UI')
    console.log('='.repeat(78))
    console.log(`\nOpen: ${url}`)
    console.log('Use “Preview 3s” on another Space to visibly switch and auto-return.')
    console.log('Press Ctrl+C here to stop the test UI.\n')
    spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref()
  })

  const shutdown = async () => {
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
