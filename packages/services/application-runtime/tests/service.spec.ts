import { Context } from '@deepseek-ai/cordis'
import type {
  AppId,
  AppLaunchOptions,
  AppLaunchResult,
  AppRecord,
  AppRegistryService,
} from '@deepseek-ai/dsh-app-registry'
import {
  WindowControlError,
  type WindowControlAction,
  type WindowControlResult,
  type WindowControlSource,
} from '@deepseek-ai/dsh-window-control'
import type {
  WindowId,
  WindowRegistrySnapshot,
  WindowRegistrySource,
  WindowSnapshot,
} from '@deepseek-ai/dsh-window-registry'
import { describe, expect, it, vi } from 'vitest'
import ApplicationRuntimeService from '../src/index.ts'

const APP_A = 'app:a' as AppId
const APP_B = 'app:b' as AppId
const WIN_A1 = 'win:a1' as WindowId
const WIN_A2 = 'win:a2' as WindowId
const WIN_B1 = 'win:b1' as WindowId

function app(
  id: AppId,
  launch: AppRecord['launch'],
  overrides: Partial<AppRecord> = {},
): AppRecord {
  return {
    id,
    kind: launch.kind === 'packaged' ? 'packaged' : launch.kind === 'shortcut' ? 'shortcut' : 'win32',
    displayName: String(id),
    icon: { kind: 'fallback', defaultIconId: 'generic-app' },
    launch,
    source: 'start-menu-user',
    aliases: [],
    firstSeenAt: 1,
    lastSeenAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function windowSnapshot(
  id: WindowId,
  overrides: Partial<WindowSnapshot> = {},
): WindowSnapshot {
  return {
    id,
    hwnd: id === WIN_A1 ? 0x1001 : id === WIN_A2 ? 0x1002 : 0x2001,
    processId: id === WIN_A2 ? 102 : 101,
    threadId: 201,
    processCreationTime: 123456,
    executablePath: String.raw`C:\Apps\Alpha\alpha.exe`,
    executableName: 'alpha.exe',
    title: String(id),
    className: 'TestWindow',
    bounds: { x: 100, y: 100, width: 800, height: 600 },
    classification: 'APPLICATION',
    state: 'normal',
    isVisible: true,
    isMinimized: false,
    isMaximized: false,
    isCloaked: false,
    isToolWindow: false,
    isShellWindow: false,
    isEnabled: true,
    isForeground: false,
    firstSeen: id === WIN_A2 ? 20 : 10,
    updatedRevision: 1,
    generation: 1,
    capturedAt: 1,
    ...overrides,
  }
}

function registrySnapshot(
  windows: readonly WindowSnapshot[],
  foregroundWindowId?: WindowId,
  revision = 1,
  generation = 1,
): WindowRegistrySnapshot {
  return {
    generation,
    revision,
    windows,
    ...(foregroundWindowId ? { foregroundWindowId } : {}),
    capturedAt: revision,
  }
}

class MutableWindowRegistry implements WindowRegistrySource {
  private listeners = new Set<(snapshot: WindowRegistrySnapshot) => void>()

  constructor(private snapshot: WindowRegistrySnapshot) {}

  setSnapshot(snapshot: WindowRegistrySnapshot): void {
    this.snapshot = snapshot
    for (const listener of [...this.listeners]) listener(snapshot)
  }

  getSnapshot(): WindowRegistrySnapshot {
    return this.snapshot
  }

  getWindows(): readonly WindowSnapshot[] {
    return this.snapshot.windows
  }

  getWindow(id: WindowId): WindowSnapshot | undefined {
    return this.snapshot.windows.find(window => window.id === id)
  }

  getByHwnd(hwnd: number): WindowSnapshot | undefined {
    return this.snapshot.windows.find(window => window.hwnd === hwnd)
  }

  getByProcessId(pid: number): readonly WindowSnapshot[] {
    return this.snapshot.windows.filter(window => window.processId === pid)
  }

  getForegroundWindow(): WindowSnapshot | undefined {
    return this.snapshot.foregroundWindowId
      ? this.getWindow(this.snapshot.foregroundWindowId)
      : undefined
  }

  getWindowsForMonitor(): readonly WindowSnapshot[] {
    return []
  }

  async refresh(): Promise<WindowRegistrySnapshot> {
    return this.snapshot
  }

  subscribe(listener: (snapshot: WindowRegistrySnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

class MutableAppRegistry {
  ready = true
  apps: AppRecord[]
  listCalls = 0
  readonly launch = vi.fn<(
    _appId: AppId,
    _options?: AppLaunchOptions,
  ) => Promise<AppLaunchResult>>()

  constructor(apps: readonly AppRecord[]) {
    this.apps = [...apps]
    this.launch.mockResolvedValue({ success: true, pid: 999 })
  }

  list(): readonly AppRecord[] {
    this.listCalls += 1
    return this.apps
  }

  get(appId: AppId): AppRecord | undefined {
    return this.apps.find(app => app.id === appId)
  }
}

function result(
  windowId: WindowId,
  action: WindowControlAction,
  completed = true,
): WindowControlResult {
  return {
    windowId,
    action,
    hwnd: 0x1001,
    accepted: true,
    completed,
    observation: {
      exists: true,
      visible: true,
      minimized: action === 'minimize',
      maximized: action === 'maximize',
      foreground: action === 'activate' && completed,
    },
  }
}

function control(): WindowControlSource & {
  activate: ReturnType<typeof vi.fn<(_windowId: WindowId) => Promise<WindowControlResult>>>
  restore: ReturnType<typeof vi.fn<(_windowId: WindowId) => Promise<WindowControlResult>>>
} {
  const activate = vi.fn<(_windowId: WindowId) => Promise<WindowControlResult>>(async (windowId: WindowId) => result(windowId, 'activate'))
  const restore = vi.fn<(_windowId: WindowId) => Promise<WindowControlResult>>(async (windowId: WindowId) => result(windowId, 'restore'))
  return {
    activate,
    restore,
    minimize: vi.fn<(_windowId: WindowId) => Promise<WindowControlResult>>(async (windowId: WindowId) => result(windowId, 'minimize')),
    maximize: vi.fn<(_windowId: WindowId) => Promise<WindowControlResult>>(async (windowId: WindowId) => result(windowId, 'maximize')),
    close: vi.fn<(_windowId: WindowId) => Promise<WindowControlResult>>(async (windowId: WindowId) => result(windowId, 'close')),
    setBounds: vi.fn<(_windowId: WindowId) => Promise<WindowControlResult>>(async (windowId: WindowId) => result(windowId, 'setBounds')),
    getPlacementConstraints: vi.fn(async () => ({
      resizable: true,
      visibleBounds: { x: 0, y: 0, width: 1280, height: 720 },
      appConstraintsObserved: false,
    })),
    move: vi.fn<(_windowId: WindowId) => Promise<WindowControlResult>>(async (windowId: WindowId) => result(windowId, 'setBounds')),
    resize: vi.fn<(_windowId: WindowId) => Promise<WindowControlResult>>(async (windowId: WindowId) => result(windowId, 'setBounds')),
    moveToMonitor: vi.fn<(_windowId: WindowId) => Promise<WindowControlResult>>(async (windowId: WindowId) => result(windowId, 'setBounds')),
  }
}

async function setup(
  apps: readonly AppRecord[],
  snapshot: WindowRegistrySnapshot,
  windowControl: WindowControlSource = control(),
) {
  const appRegistry = new MutableAppRegistry(apps)
  const windowRegistry = new MutableWindowRegistry(snapshot)
  const ctx = new Context()

  ctx.provide('appRegistry')
  ctx.appRegistry = appRegistry as unknown as AppRegistryService
  ctx.provide('windowRegistry')
  ctx.windowRegistry = windowRegistry as unknown as typeof ctx.windowRegistry
  ctx.provide('windowControl')
  ctx.windowControl = windowControl as unknown as typeof ctx.windowControl
  ctx.plugin(ApplicationRuntimeService, { enabled: true })
  await new Promise(resolve => setTimeout(resolve, 10))

  return { ctx, appRegistry, windowRegistry, windowControl }
}

async function setupWithoutWindowControl(
  apps: readonly AppRecord[],
  snapshot: WindowRegistrySnapshot,
) {
  const appRegistry = new MutableAppRegistry(apps)
  const windowRegistry = new MutableWindowRegistry(snapshot)
  const ctx = new Context()

  ctx.provide('appRegistry')
  ctx.appRegistry = appRegistry as unknown as AppRegistryService
  ctx.provide('windowRegistry')
  ctx.windowRegistry = windowRegistry as unknown as typeof ctx.windowRegistry
  ctx.plugin(ApplicationRuntimeService, { enabled: true })
  await new Promise(resolve => setTimeout(resolve, 10))

  return { ctx, appRegistry, windowRegistry }
}

describe('ApplicationRuntimeService', () => {
  it('groups multiple processes/windows under one AppId and keeps deterministic MRU', async () => {
    const alpha = app(APP_A, { kind: 'win32', executablePath: String.raw`C:\Apps\Alpha\alpha.exe` })
    const a1 = windowSnapshot(WIN_A1, { processId: 101, isForeground: true })
    const a2 = windowSnapshot(WIN_A2, { processId: 202 })
    const { ctx, windowRegistry } = await setup(
      [alpha],
      registrySnapshot([a1, a2], WIN_A1),
    )

    let runtime = ctx.applicationRuntime.getApplication(APP_A)!
    expect(runtime.windows.map(window => window.processId)).toEqual([101, 202])
    expect(runtime.mruWindowIds[0]).toBe(WIN_A1)
    expect(ctx.applicationRuntime.getSnapshot().mruAppIds).toEqual([APP_A])

    windowRegistry.setSnapshot(registrySnapshot([
      windowSnapshot(WIN_A1),
      windowSnapshot(WIN_A2, { processId: 202, isForeground: true }),
    ], WIN_A2, 2))

    runtime = ctx.applicationRuntime.getApplication(APP_A)!
    expect(runtime.mruWindowIds).toEqual([WIN_A2, WIN_A1])
    await ctx.fiber.dispose()
  })

  it('publishes runtime entries only for applications with confidently observed windows', async () => {
    const alpha = app(APP_A, { kind: 'win32', executablePath: String.raw`C:\Apps\Alpha\alpha.exe` })
    const beta = app(APP_B, { kind: 'win32', executablePath: String.raw`C:\Apps\Beta\beta.exe` })
    const { ctx } = await setup([alpha, beta], registrySnapshot([windowSnapshot(WIN_A1)]))

    expect(ctx.applicationRuntime.getApplications().map(entry => entry.appId)).toEqual([APP_A])
    expect(ctx.applicationRuntime.hasObservedWindows(APP_A)).toBe(true)
    expect(ctx.applicationRuntime.hasObservedWindows(APP_B)).toBe(false)
    expect(ctx.applicationRuntime.getApplication(APP_B)).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('prefers exact AUMID identity and never maps SHELL/ELIX/helper windows as apps', async () => {
    const packaged = app(APP_A, {
      kind: 'packaged',
      aumid: 'Contoso.App_123!Main',
      packageFamilyName: 'Contoso.App_123',
    })
    const unrelatedHost = app(APP_B, {
      kind: 'win32',
      executablePath: String.raw`C:\Windows\System32\ApplicationFrameHost.exe`,
    })
    const packagedWindow = windowSnapshot(WIN_A1, {
      aumid: 'contoso.app_123!main',
      executablePath: String.raw`C:\Windows\System32\ApplicationFrameHost.exe`,
    })
    const shellWindow = windowSnapshot(WIN_B1, { classification: 'SHELL' })
    const { ctx } = await setup([packaged, unrelatedHost], registrySnapshot([packagedWindow, shellWindow]))

    expect(ctx.applicationRuntime.getApplication(APP_A)!.windows.map(window => window.id)).toEqual([WIN_A1])
    expect(ctx.applicationRuntime.getApplication(APP_B)).toBeUndefined()
    expect(ctx.applicationRuntime.getSnapshot().unmatchedWindows).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('does not fall back to a shared host executable when a present AUMID has no catalog match', async () => {
    const host = app(APP_A, {
      kind: 'win32',
      executablePath: String.raw`C:\Windows\System32\ApplicationFrameHost.exe`,
    })
    const observed = windowSnapshot(WIN_A1, {
      aumid: 'Unknown.Package!Main',
      executablePath: String.raw`C:\Windows\System32\ApplicationFrameHost.exe`,
    })
    const { ctx } = await setup([host], registrySnapshot([observed]))

    expect(ctx.applicationRuntime.getApplication(APP_A)).toBeUndefined()
    expect(ctx.applicationRuntime.getSnapshot().unmatchedWindows).toEqual([
      expect.objectContaining({ windowId: WIN_A1, reason: 'no-catalog-match' }),
    ])
    await ctx.fiber.dispose()
  })

  it('uses Windows path semantics and lets direct executable identity outrank shortcut target', async () => {
    const direct = app(APP_A, {
      kind: 'win32',
      executablePath: String.raw`C:\Apps\Alpha\.\alpha.exe`,
    })
    const shortcut = app(APP_B, {
      kind: 'shortcut',
      shortcutPath: String.raw`C:\Users\Me\Desktop\Alpha.lnk`,
      targetPath: String.raw`c:\apps\alpha\alpha.exe`,
    })
    const observed = windowSnapshot(WIN_A1, {
      executablePath: 'c:/APPS/ALPHA/alpha.exe',
    })
    const { ctx } = await setup([shortcut, direct], registrySnapshot([observed]))

    expect(ctx.applicationRuntime.getApplication(APP_A)!.windows).toHaveLength(1)
    expect(ctx.applicationRuntime.getApplication(APP_B)).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('keeps ambiguous duplicate direct identities unmatched and refuses duplicate launch', async () => {
    const first = app(APP_A, { kind: 'win32', executablePath: String.raw`C:\Apps\Shared\same.exe` })
    const second = app(APP_B, { kind: 'win32', executablePath: String.raw`c:\apps\shared\same.exe` })
    const observed = windowSnapshot(WIN_A1, { executablePath: String.raw`C:\APPS\SHARED\same.exe` })
    const { ctx, appRegistry } = await setup([first, second], registrySnapshot([observed]))

    const unmatched = ctx.applicationRuntime.getSnapshot().unmatchedWindows[0]!
    expect(unmatched.reason).toBe('ambiguous-catalog-match')
    expect(unmatched.candidateAppIds).toEqual([APP_A, APP_B])

    const outcome = await ctx.applicationRuntime.launchOrActivate(APP_A)
    expect(outcome).toMatchObject({ action: 'failed', completed: false })
    expect(outcome.failure?.code).toBe('AMBIGUOUS_EXISTING_WINDOW')
    expect(appRegistry.launch).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('restores a minimized MRU window before activation instead of launching another instance', async () => {
    const alpha = app(APP_A, { kind: 'win32', executablePath: String.raw`C:\Apps\Alpha\alpha.exe` })
    const minimized = windowSnapshot(WIN_A1, {
      state: 'minimized',
      isMinimized: true,
      isVisible: true,
    })
    const windowControl = control()
    const { ctx, appRegistry } = await setup([alpha], registrySnapshot([minimized]), windowControl)

    const outcome = await ctx.applicationRuntime.launchOrActivate(APP_A)
    expect(outcome.action).toBe('restored-and-activated')
    expect(windowControl.restore).toHaveBeenCalledWith(WIN_A1)
    expect(windowControl.activate).toHaveBeenCalledWith(WIN_A1)
    expect(appRegistry.launch).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('treats launch options as explicit launch intent even when an activatable window exists', async () => {
    const alpha = app(APP_A, { kind: 'win32', executablePath: String.raw`C:\\Apps\\Alpha\\alpha.exe` })
    const windowControl = control()
    const { ctx, appRegistry } = await setup(
      [alpha],
      registrySnapshot([windowSnapshot(WIN_A1)]),
      windowControl,
    )
    const options: AppLaunchOptions = {
      additionalArgs: [String.raw`C:\\Cases\\evidence.elix`],
    }

    const outcome = await ctx.applicationRuntime.launchOrActivate(APP_A, options)

    expect(outcome).toMatchObject({ action: 'launch-requested', completed: true })
    expect(appRegistry.launch).toHaveBeenCalledWith(APP_A, options)
    expect(windowControl.activate).not.toHaveBeenCalled()
    expect(windowControl.restore).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('supports explicit New window launch without fabricating identity options', async () => {
    const alpha = app(APP_A, { kind: 'win32', executablePath: String.raw`C:\\Apps\\Alpha\\alpha.exe` })
    const windowControl = control()
    const { ctx, appRegistry } = await setup(
      [alpha],
      registrySnapshot([windowSnapshot(WIN_A1)]),
      windowControl,
    )

    const outcome = await ctx.applicationRuntime.launchApplication(APP_A)

    expect(outcome).toMatchObject({ action: 'launch-requested', completed: true })
    expect(appRegistry.launch).toHaveBeenCalledWith(APP_A, {})
    expect(windowControl.activate).not.toHaveBeenCalled()
    expect(windowControl.restore).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('does not launch a duplicate when observed windows exist but are cloaked/unactivatable', async () => {
    const alpha = app(APP_A, { kind: 'win32', executablePath: String.raw`C:\Apps\Alpha\alpha.exe` })
    const cloaked = windowSnapshot(WIN_A1, { isCloaked: true })
    const { ctx, appRegistry } = await setup([alpha], registrySnapshot([cloaked]))

    const outcome = await ctx.applicationRuntime.launchOrActivate(APP_A)
    expect(outcome.failure?.code).toBe('NO_ACTIVATABLE_WINDOW')
    expect(appRegistry.launch).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('reports foreground activation denial instead of pretending the request completed', async () => {
    const alpha = app(APP_A, { kind: 'win32', executablePath: String.raw`C:\Apps\Alpha\alpha.exe` })
    const windowControl = control()
    windowControl.activate.mockImplementation(async (windowId: WindowId) => result(windowId, 'activate', false))
    const { ctx } = await setup([alpha], registrySnapshot([windowSnapshot(WIN_A1)]), windowControl)

    const outcome = await ctx.applicationRuntime.activateApplication(APP_A)
    expect(outcome.action).toBe('failed')
    expect(outcome.completed).toBe(false)
    expect(outcome.failure?.code).toBe('ACTIVATION_NOT_CONFIRMED')
    expect(outcome.activateResult?.accepted).toBe(true)
    await ctx.fiber.dispose()
  })

  it('re-resolves once after a stale WindowId race and activates a surviving window', async () => {
    const alpha = app(APP_A, { kind: 'win32', executablePath: String.raw`C:\Apps\Alpha\alpha.exe` })
    const a1 = windowSnapshot(WIN_A1, { isForeground: true })
    const a2 = windowSnapshot(WIN_A2)
    const windowControl = control()
    const registry = new MutableWindowRegistry(registrySnapshot([a1, a2], WIN_A1))
    windowControl.activate.mockImplementation(async (windowId: WindowId) => {
      if (windowId === WIN_A1) {
        registry.setSnapshot(registrySnapshot([windowSnapshot(WIN_A2)], undefined, 2))
        throw new WindowControlError('STALE_WINDOW_ID', 'gone', true)
      }
      return result(windowId, 'activate')
    })

    const appRegistry = new MutableAppRegistry([alpha])
    const ctx = new Context()
    ctx.provide('appRegistry')
    ctx.appRegistry = appRegistry as unknown as AppRegistryService
    ctx.provide('windowRegistry')
    ctx.windowRegistry = registry as unknown as typeof ctx.windowRegistry
    ctx.provide('windowControl')
    ctx.windowControl = windowControl as unknown as typeof ctx.windowControl
    ctx.plugin(ApplicationRuntimeService, { enabled: true })
    await new Promise(resolve => setTimeout(resolve, 10))

    const outcome = await ctx.applicationRuntime.activateApplication(APP_A)
    expect(outcome.completed).toBe(true)
    expect(outcome.windowId).toBe(WIN_A2)
    expect(windowControl.activate).toHaveBeenCalledTimes(2)
    await ctx.fiber.dispose()
  })

  it('deduplicates identical concurrent launchOrActivate calls without inventing a window', async () => {
    const alpha = app(APP_A, { kind: 'win32', executablePath: String.raw`C:\Apps\Alpha\alpha.exe` })
    const { ctx, appRegistry } = await setup([alpha], registrySnapshot([]))
    let release!: (value: AppLaunchResult) => void
    appRegistry.launch.mockImplementation(() => new Promise((resolve) => { release = resolve }))

    const first = ctx.applicationRuntime.launchOrActivate(APP_A)
    const second = ctx.applicationRuntime.launchOrActivate(APP_A)
    expect(appRegistry.launch).toHaveBeenCalledTimes(1)

    release({ success: true, pid: 555 })
    const [a, b] = await Promise.all([first, second])
    expect(a).toEqual(b)
    expect(a).toMatchObject({ action: 'launch-requested', completed: true })
    expect(ctx.applicationRuntime.hasObservedWindows(APP_A)).toBe(false)
    expect(ctx.applicationRuntime.getApplication(APP_A)).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('rejects concurrent same-AppId requests with different launch options instead of silently dropping arguments', async () => {
    const alpha = app(APP_A, { kind: 'win32', executablePath: String.raw`C:\Apps\Alpha\alpha.exe` })
    const { ctx, appRegistry } = await setup([alpha], registrySnapshot([]))
    let release!: (value: AppLaunchResult) => void
    appRegistry.launch.mockImplementation(() => new Promise((resolve) => { release = resolve }))

    const first = ctx.applicationRuntime.launchOrActivate(APP_A, { additionalArgs: ['--one'] })
    const second = await ctx.applicationRuntime.launchOrActivate(APP_A, { additionalArgs: ['--two'] })

    expect(second.failure?.code).toBe('CONCURRENT_LAUNCH_CONFLICT')
    expect(appRegistry.launch).toHaveBeenCalledTimes(1)
    release({ success: true, pid: 555 })
    expect((await first).action).toBe('launch-requested')
    await ctx.fiber.dispose()
  })

  it('can launch an app with no observed window even when Window Control is unavailable', async () => {
    const alpha = app(APP_A, { kind: 'win32', executablePath: String.raw`C:\Apps\Alpha\alpha.exe` })
    const { ctx, appRegistry } = await setupWithoutWindowControl([alpha], registrySnapshot([]))

    const outcome = await ctx.applicationRuntime.launchOrActivate(APP_A)
    expect(outcome.action).toBe('launch-requested')
    expect(appRegistry.launch).toHaveBeenCalledTimes(1)
    await ctx.fiber.dispose()
  })

  it('reconciles catalog removal without deleting Window Registry truth or inventing an AppId', async () => {
    const alpha = app(APP_A, { kind: 'win32', executablePath: String.raw`C:\Apps\Alpha\alpha.exe` })
    const observed = windowSnapshot(WIN_A1)
    const { ctx, appRegistry } = await setup([alpha], registrySnapshot([observed]))
    expect(ctx.applicationRuntime.hasObservedWindows(APP_A)).toBe(true)

    appRegistry.apps = []
    ctx.emit('app-registry/app-removed', APP_A)

    expect(ctx.applicationRuntime.getApplications()).toHaveLength(0)
    expect(ctx.applicationRuntime.getSnapshot().unmatchedWindows).toEqual([
      expect.objectContaining({ windowId: WIN_A1, reason: 'no-catalog-match' }),
    ])
    await ctx.fiber.dispose()
  })

  it('reconciles a previously unmatched window when its App Registry record arrives later', async () => {
    const observed = windowSnapshot(WIN_A1)
    const { ctx, appRegistry } = await setup([], registrySnapshot([observed]))
    expect(ctx.applicationRuntime.getSnapshot().unmatchedWindows[0]?.reason).toBe('no-catalog-match')

    const alpha = app(APP_A, { kind: 'win32', executablePath: String.raw`C:\Apps\Alpha\alpha.exe` })
    appRegistry.apps = [alpha]
    ctx.emit('app-registry/app-added', alpha)

    expect(ctx.applicationRuntime.getSnapshot().unmatchedWindows).toHaveLength(0)
    expect(ctx.applicationRuntime.hasObservedWindows(APP_A)).toBe(true)
    await ctx.fiber.dispose()
  })

  it('caches catalog matching indexes across window-only snapshots and rebuilds on catalog changes', async () => {
    const alpha = app(APP_A, { kind: 'win32', executablePath: String.raw`C:\Apps\Alpha\alpha.exe` })
    const { ctx, appRegistry, windowRegistry } = await setup([alpha], registrySnapshot([windowSnapshot(WIN_A1)]))
    expect(appRegistry.listCalls).toBe(1)

    windowRegistry.setSnapshot(registrySnapshot([
      windowSnapshot(WIN_A1, { title: 'new title', updatedRevision: 2 }),
    ], undefined, 2))
    windowRegistry.setSnapshot(registrySnapshot([
      windowSnapshot(WIN_A1, { title: 'another title', updatedRevision: 3 }),
    ], undefined, 3))
    expect(appRegistry.listCalls).toBe(1)

    appRegistry.apps = [app(APP_A, {
      kind: 'win32',
      executablePath: String.raw`C:\Apps\Alpha\alpha.exe`,
    }, { updatedAt: 2 })]
    ctx.emit('app-registry/refresh-completed', {
      totalApps: 1,
      addedCount: 0,
      updatedCount: 1,
      removedCount: 0,
      durationMs: 1,
      faults: [],
    })
    expect(appRegistry.listCalls).toBe(2)
    await ctx.fiber.dispose()
  })

  it('clears foreground application for unmatched/system foreground while preserving app MRU', async () => {
    const alpha = app(APP_A, { kind: 'win32', executablePath: String.raw`C:\Apps\Alpha\alpha.exe` })
    const a1 = windowSnapshot(WIN_A1, { isForeground: true })
    const system = windowSnapshot(WIN_B1, {
      classification: 'SYSTEM',
      executablePath: String.raw`C:\Windows\System32\system.exe`,
      isForeground: true,
    })
    const { ctx, windowRegistry } = await setup([alpha], registrySnapshot([a1], WIN_A1))
    expect(ctx.applicationRuntime.getSnapshot().foregroundAppId).toBe(APP_A)

    windowRegistry.setSnapshot(registrySnapshot([windowSnapshot(WIN_A1), system], WIN_B1, 2))
    expect(ctx.applicationRuntime.getSnapshot().foregroundAppId).toBeUndefined()
    expect(ctx.applicationRuntime.getSnapshot().mruAppIds[0]).toBe(APP_A)
    await ctx.fiber.dispose()
  })

  it('isolates subscriber failures and suppresses exact duplicate runtime projections', async () => {
    const alpha = app(APP_A, { kind: 'win32', executablePath: String.raw`C:\Apps\Alpha\alpha.exe` })
    const initial = registrySnapshot([windowSnapshot(WIN_A1)])
    const { ctx, windowRegistry } = await setup([alpha], initial)
    const broken = vi.fn(() => { throw new Error('listener failure') })
    const healthy = vi.fn()
    ctx.applicationRuntime.subscribe(broken)
    ctx.applicationRuntime.subscribe(healthy)

    windowRegistry.setSnapshot(registrySnapshot([
      windowSnapshot(WIN_A1, { title: 'changed', updatedRevision: 2 }),
    ], undefined, 2))
    expect(broken).toHaveBeenCalledTimes(1)
    expect(healthy).toHaveBeenCalledTimes(1)
    const revision = ctx.applicationRuntime.getSnapshot().revision

    windowRegistry.setSnapshot(registrySnapshot([
      windowSnapshot(WIN_A1, { title: 'changed', updatedRevision: 2 }),
    ], undefined, 2))
    expect(ctx.applicationRuntime.getSnapshot().revision).toBe(revision)
    expect(healthy).toHaveBeenCalledTimes(1)
    await ctx.fiber.dispose()
  })

  it('does not republish when only an irrelevant SYSTEM window changes', async () => {
    const alpha = app(APP_A, { kind: 'win32', executablePath: String.raw`C:\Apps\Alpha\alpha.exe` })
    const a1 = windowSnapshot(WIN_A1)
    const system = windowSnapshot(WIN_B1, { classification: 'SYSTEM' })
    const { ctx, windowRegistry } = await setup([alpha], registrySnapshot([a1, system]))
    const listener = vi.fn()
    ctx.applicationRuntime.subscribe(listener)
    const runtimeRevision = ctx.applicationRuntime.getSnapshot().revision

    windowRegistry.setSnapshot(registrySnapshot([
      a1,
      windowSnapshot(WIN_B1, { classification: 'SYSTEM', title: 'changed', updatedRevision: 2 }),
    ], undefined, 2))

    expect(listener).not.toHaveBeenCalled()
    expect(ctx.applicationRuntime.getSnapshot().revision).toBe(runtimeRevision)
    await ctx.fiber.dispose()
  })

  it('publishes a new runtime snapshot across a Window Registry generation boundary', async () => {
    const alpha = app(APP_A, { kind: 'win32', executablePath: String.raw`C:\Apps\Alpha\alpha.exe` })
    const a1 = windowSnapshot(WIN_A1)
    const { ctx, windowRegistry } = await setup([alpha], registrySnapshot([a1]))
    const before = ctx.applicationRuntime.getSnapshot().revision

    windowRegistry.setSnapshot(registrySnapshot([
      windowSnapshot(WIN_A1, { generation: 2 }),
    ], undefined, 1, 2))

    expect(ctx.applicationRuntime.getSnapshot().revision).toBe(before + 1)
    expect(ctx.applicationRuntime.getSnapshot().windowRegistryGeneration).toBe(2)
    await ctx.fiber.dispose()
  })

  it('stays explicitly not-ready when Window Registry has no authoritative initial snapshot', async () => {
    const alpha = app(APP_A, { kind: 'win32', executablePath: String.raw`C:\Apps\Alpha\alpha.exe` })
    const { ctx } = await setup([alpha], registrySnapshot([], undefined, 0))

    expect(ctx.applicationRuntime.ready).toBe(false)
    expect(() => ctx.applicationRuntime.getSnapshot()).toThrow(
      expect.objectContaining({ code: 'APPLICATION_RUNTIME_NOT_READY' }),
    )
    await ctx.fiber.dispose()
  })
})
