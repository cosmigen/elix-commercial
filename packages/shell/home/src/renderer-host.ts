/**
 * Tokenized loopback transport between Home's authoritative model and WebView renderers.
 *
 * @module @deepseek-ai/dsh-home/renderer-host
 */

import { randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { decorateHomeDocument } from './app-folder-presentation.ts'
import {
  MAX_RENDERER_INTENT_BYTES,
  parseHomeRendererIntent,
  type HomeRendererIntent,
  type HomeRendererSnapshot,
  type WallpaperRuntimeState,
} from './renderer-protocol.ts'
import { renderHomeDocument, renderHomeRoot } from './renderer.tsx'

const ROUTE_PREFIX = '/__elix/home'
const MAX_RENDERERS_PER_MONITOR = 4

/** Asset class exposed through a tokenized renderer URL. */
export type HomeRendererAsset =
  | { readonly kind: 'wallpaper' }
  | { readonly kind: 'icon'; readonly itemId: string }

/** Resolved local asset whose path never originates in the HTTP request. */
export interface ResolvedHomeRendererAsset {
  readonly path: string
  readonly contentType: string
}

/** Dependencies supplied by Home's domain owner. */
export interface HomeRendererHostOptions {
  readonly snapshot: (
    monitorId: string,
    assetBasePath: string,
    runtimeState: WallpaperRuntimeState,
  ) => HomeRendererSnapshot
  readonly dispatchIntent: (monitorId: string, intent: HomeRendererIntent) => void | Promise<void>
  readonly resolveAsset: (monitorId: string, asset: HomeRendererAsset) => ResolvedHomeRendererAsset | undefined
  readonly onWarning?: ((error: Error) => void) | undefined
}

interface RendererSession {
  readonly monitorId: string
  readonly token: string
  readonly clients: Set<ServerResponse>
  runtimeState: WallpaperRuntimeState
}

/**
 * Registers one bounded HTTP route family and creates an unguessable renderer session per monitor.
 */
export class HomeRendererHost {
  private readonly sessionsByMonitor = new Map<string, RendererSession>()
  private readonly sessionsByToken = new Map<string, RendererSession>()
  private readonly unregisterRoute: () => void
  private isDisposed = false

  constructor(
    private readonly webServer: WebServer,
    private readonly options: HomeRendererHostOptions,
  ) {
    this.unregisterRoute = webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: this.handleRequest.bind(this),
    })
  }

  /**
   * Return the loopback URL Surface Core loads for one monitor.
   * @param monitorId - Monitor identifier.
   * @returns Complete loopback URL for the monitor's Home renderer.
   */
  getSurfaceUrl(monitorId: string): string {
    const session = this.getOrCreateSession(monitorId)
    return this.origin + this.sessionPath(session)
  }

  /**
   * Push the latest Home projection to active renderers for one monitor.
   * @param monitorId - Monitor identifier.
   */
  publish(monitorId: string): void {
    const session = this.sessionsByMonitor.get(monitorId)
    if (session === undefined || session.clients.size === 0) return
    let markup: string
    try {
      markup = renderHomeRoot(this.options.snapshot(monitorId, this.sessionPath(session), session.runtimeState))
    } catch (error) {
      this.warn(error)
      return
    }
    this.writeEvent(session, 'snapshot', { markup })
  }

  /** Push fresh projections to every active monitor renderer. */
  publishAll(): void {
    for (const monitorId of this.sessionsByMonitor.keys()) this.publish(monitorId)
  }

  /**
   * Publish a wallpaper execution hint without changing durable Home state.
   * @param monitorId - Monitor identifier.
   * @param state - Current wallpaper runtime execution state.
   */
  setRuntimeState(monitorId: string, state: WallpaperRuntimeState): void {
    const session = this.sessionsByMonitor.get(monitorId)
    if (session === undefined || session.runtimeState === state) return
    session.runtimeState = state
    this.writeEvent(session, 'runtime', { state })
  }

  /**
   * End one disconnected monitor's renderer streams and forget its capability token.
   * @param monitorId - Monitor identifier.
   */
  removeMonitor(monitorId: string): void {
    const session = this.sessionsByMonitor.get(monitorId)
    if (session === undefined) return
    for (const client of session.clients) client.end()
    session.clients.clear()
    this.sessionsByMonitor.delete(monitorId)
    this.sessionsByToken.delete(session.token)
  }

  /** Remove the route and close every response owned by this host. */
  dispose(): void {
    if (this.isDisposed) return
    this.isDisposed = true
    this.unregisterRoute()
    for (const session of this.sessionsByMonitor.values()) {
      session.runtimeState = 'disposed'
      this.writeEvent(session, 'runtime', { state: 'disposed' })
      for (const client of session.clients) client.end()
      session.clients.clear()
    }
    this.sessionsByMonitor.clear()
    this.sessionsByToken.clear()
  }

  private get origin(): string {
    const host = this.webServer.host === '0.0.0.0' ? '127.0.0.1' : this.webServer.host
    if (!Number.isSafeInteger(this.webServer.port) || this.webServer.port <= 0) {
      throw new Error('Home renderer requires ctx.webServer to finish listening before Home initializes.')
    }
    return ['http://', host, ':', String(this.webServer.port)].join('')
  }

  private getOrCreateSession(monitorId: string): RendererSession {
    if (this.isDisposed) throw new Error('Home renderer host is disposed.')
    const existing = this.sessionsByMonitor.get(monitorId)
    if (existing !== undefined) return existing
    const session: RendererSession = {
      monitorId,
      token: randomBytes(24).toString('base64url'),
      clients: new Set(),
      runtimeState: 'suspended',
    }
    this.sessionsByMonitor.set(monitorId, session)
    this.sessionsByToken.set(session.token, session)
    return session
  }

  private sessionPath(session: RendererSession): string {
    return ROUTE_PREFIX + '/' + session.token
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.applyBaseHeaders(res)
    if (this.isDisposed) {
      this.sendText(res, 503, 'Home renderer is shutting down.')
      return
    }
    const pathname = new URL(req.url ?? '/', this.origin).pathname
    const suffix = pathname.slice(ROUTE_PREFIX.length).split('/').filter(Boolean)
    const token = suffix[0]
    const session = token === undefined ? undefined : this.sessionsByToken.get(token)
    if (session === undefined) {
      this.sendText(res, 404, 'Not found.')
      return
    }

    if (suffix.length === 1 && (req.method === 'GET' || req.method === 'HEAD')) {
      this.serveDocument(req, res, session)
      return
    }
    if (suffix.length === 2 && suffix[1] === 'events' && req.method === 'GET') {
      this.serveEvents(req, res, session)
      return
    }
    if (suffix.length === 2 && suffix[1] === 'intent' && req.method === 'POST') {
      await this.receiveIntent(req, res, session)
      return
    }
    if (suffix.length === 2 && suffix[1] === 'wallpaper' && (req.method === 'GET' || req.method === 'HEAD')) {
      await this.serveAsset(req, res, session, { kind: 'wallpaper' })
      return
    }
    if (suffix.length === 3 && suffix[1] === 'icon' && (req.method === 'GET' || req.method === 'HEAD')) {
      await this.serveAsset(req, res, session, { kind: 'icon', itemId: decodeURIComponent(suffix[2] ?? '') })
      return
    }
    this.sendText(res, 404, 'Not found.')
  }

  private serveDocument(req: IncomingMessage, res: ServerResponse, session: RendererSession): void {
    const nonce = randomBytes(18).toString('base64url')
    const document = decorateHomeDocument(
      renderHomeDocument(
        this.options.snapshot(session.monitorId, this.sessionPath(session), session.runtimeState),
        nonce,
      ),
      nonce,
    )
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.setHeader(
      'content-security-policy',
      "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; img-src 'self' data:; media-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'nonce-" + nonce + "'",
    )
    res.setHeader('content-length', Buffer.byteLength(document))
    res.statusCode = 200
    if (req.method === 'HEAD') res.end()
    else res.end(document)
  }

  private serveEvents(req: IncomingMessage, res: ServerResponse, session: RendererSession): void {
    if (session.clients.size >= MAX_RENDERERS_PER_MONITOR) {
      this.sendText(res, 429, 'Renderer connection limit reached.')
      return
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    session.clients.add(res)
    res.write('event: runtime\ndata:' + JSON.stringify({ state: session.runtimeState }) + '\n\n')
    const release = (): void => {
      session.clients.delete(res)
    }
    req.once('close', release)
    res.once('close', release)
  }

  private async receiveIntent(req: IncomingMessage, res: ServerResponse, session: RendererSession): Promise<void> {
    const origin = req.headers.origin
    if (origin !== undefined && origin !== this.origin) {
      this.sendText(res, 403, 'Origin rejected.')
      return
    }
    const mediaType = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
    if (mediaType !== 'application/json') {
      this.sendText(res, 415, 'Expected application/json.')
      return
    }
    try {
      const body = await readBoundedBody(req, MAX_RENDERER_INTENT_BYTES)
      const parsed: unknown = JSON.parse(body)
      const intent = parseHomeRendererIntent(parsed)
      await this.options.dispatchIntent(session.monitorId, intent)
      res.statusCode = 204
      res.end()
    } catch (error) {
      this.warn(error)
      this.sendText(res, 400, 'Invalid Home renderer intent.')
    }
  }

  private async serveAsset(
    req: IncomingMessage,
    res: ServerResponse,
    session: RendererSession,
    request: HomeRendererAsset,
  ): Promise<void> {
    const asset = this.options.resolveAsset(session.monitorId, request)
    if (asset === undefined) {
      this.sendText(res, 404, 'Asset not found.')
      return
    }
    try {
      const file = await stat(asset.path)
      if (!file.isFile()) {
        this.sendText(res, 404, 'Asset not found.')
        return
      }
      const range = parseRange(req.headers.range, file.size)
      if (range === null) {
        res.statusCode = 416
        res.setHeader('content-range', 'bytes */' + String(file.size))
        res.end()
        return
      }
      const start = range?.start ?? 0
      const end = range?.end ?? Math.max(0, file.size - 1)
      const length = file.size === 0 ? 0 : end - start + 1
      res.statusCode = range === undefined ? 200 : 206
      res.setHeader('content-type', asset.contentType)
      res.setHeader('accept-ranges', 'bytes')
      res.setHeader('content-length', length)
      if (range !== undefined) {
        res.setHeader('content-range', ['bytes ', start, '-', end, '/', file.size].map(String).join(''))
      }
      if (req.method === 'HEAD' || file.size === 0) {
        res.end()
        return
      }
      const stream = createReadStream(asset.path, { start, end })
      stream.once('error', (error) => {
        this.warn(error)
        res.destroy(error)
      })
      res.once('close', () => stream.destroy())
      stream.pipe(res)
    } catch (error) {
      this.warn(error)
      if (!res.headersSent) this.sendText(res, 404, 'Asset not found.')
      else res.destroy()
    }
  }

  private writeEvent(session: RendererSession, event: string, value: unknown): void {
    if (session.clients.size === 0) return
    const payload = 'event: ' + event + '\ndata:' + JSON.stringify(value) + '\n\n'
    for (const client of [...session.clients]) {
      if (client.destroyed || client.writableEnded) {
        session.clients.delete(client)
        continue
      }
      client.write(payload)
    }
  }

  private applyBaseHeaders(res: ServerResponse): void {
    res.setHeader('cache-control', 'no-store')
    res.setHeader('referrer-policy', 'no-referrer')
    res.setHeader('x-content-type-options', 'nosniff')
  }

  private sendText(res: ServerResponse, status: number, body: string): void {
    if (res.writableEnded) return
    res.statusCode = status
    res.setHeader('content-type', 'text/plain; charset=utf-8')
    res.setHeader('content-length', Buffer.byteLength(body))
    res.end(body)
  }

  private warn(error: unknown): void {
    this.options.onWarning?.(error instanceof Error ? error : new Error(String(error)))
  }
}

async function readBoundedBody(req: IncomingMessage, maximumBytes: number): Promise<string> {
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > maximumBytes) throw new Error('Home renderer intent body exceeds the byte limit.')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

interface ByteRange {
  readonly start: number
  readonly end: number
}

function parseRange(value: string | undefined, size: number): ByteRange | undefined | null {
  if (value === undefined) return undefined
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value.trim())
  if (match === null || size === 0) return null
  const rawStart = match[1] ?? ''
  const rawEnd = match[2] ?? ''
  if (rawStart === '' && rawEnd === '') return null
  let start: number
  let end: number
  if (rawStart === '') {
    const suffixLength = Number.parseInt(rawEnd, 10)
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null
    start = Math.max(0, size - suffixLength)
    end = size - 1
  } else {
    start = Number.parseInt(rawStart, 10)
    end = rawEnd === '' ? size - 1 : Number.parseInt(rawEnd, 10)
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
    return null
  }
  return { start, end: Math.min(end, size - 1) }
}
