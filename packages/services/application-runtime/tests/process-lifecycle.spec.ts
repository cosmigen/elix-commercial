import { Context } from '@deepseek-ai/cordis'
import type { AppId, AppRecord, AppRegistryService } from '@deepseek-ai/dsh-app-registry'
import type {
  ProcessEntry,
  ProcessIdentity,
  ProcessObservationChange,
  ProcessObservationSnapshot,
  ProcessObservationSource,
} from '@deepseek-ai/dsh-process-observation'
import type {
  WindowId,
  WindowRegistrySnapshot,
  WindowRegistrySource,
  WindowSnapshot,
} from '@deepseek-ai/dsh-window-registry'
import { describe, expect, it } from 'vitest'
import ApplicationRuntimeService from '../src/index.ts'
import { ApplicationProcessMatcher } from '../src/process-matching.ts'

const APP_A = 'app:a' as AppId
const WIN_A = 'win:a' as WindowId

function app(id: AppId, executablePath: string): AppRecord {
  return {
    id,
    kind: 'win32',
    displayName: String(id),
    icon: { kind: 'fallback', defaultIconId: 'generic-app' },
    launch: { kind: 'win32', executablePath },
    source: 'manual',
    aliases: [],
    firstSeenAt: 1,
    lastSeenAt: 1,
    updatedAt: 1,
  }
}

function processEntry(
  pid: number,
  creationTime: number,
  executablePath: string,
  parentPid = 1,
): ProcessEntry {
  return Object.freeze({
    identity: Object.freeze({ pid, creationTime }),
    identityKey: `${pid}:${creationTime}`,
    identityQuality: 'stable',
    parentPid,
    executablePath,
    executableName: executablePath.split(/[/\\]/u).at(-1),
    observedAt: 1,
  })
}

function processSnapshot(
  revision: number,
  processes: readonly ProcessEntry[],
): ProcessObservationSnapshot {
  return Object.freeze({ revision, processes: Object.freeze([...processes]), capturedAt: revision })
}

class MutableProcessObservation implements ProcessObservationSource {
  private listeners = new Set<(change: ProcessObservationChange) => void>()

  constructor(private snapshot: ProcessObservationSnapshot) {}

  setSnapshot(snapshot: ProcessObservationSnapshot): void {
    const previous = this.snapshot
    this.snapshot = snapshot
    const previousKeys = new Set(previous.processes.map(process => process.identityKey))
    const nextKeys = new Set(snapshot.processes.map(process => process.identityKey))
    const change: ProcessObservationChange = {
      reason: previous.revision === 0 ? 'initial' : 'changed',
      snapshot,
      started: snapshot.processes.filter(process => !previousKeys.has(process.identityKey)),
      exited: previous.processes.filter(process => !nextKeys.has(process.identityKey)),
      updated: [],
    }
    for (const listener of [...this.listeners]) listener(change)
  }

  getSnapshot(): ProcessObservationSnapshot {
    return this.snapshot
  }

  getProcesses(): readonly ProcessEntry[] {
    return this.snapshot.processes
  }

  getProcess(identity: ProcessIdentity): ProcessEntry | undefined {
    return this.snapshot.processes.find(process => (
      process.identity.pid === identity.pid && process.identity.creationTime === identity.creationTime
    ))
  }

  getProcessByPid(pid: number): ProcessEntry | undefined {
    return this.snapshot.processes.find(process => process.identity.pid === pid)
  }

  async refresh(): Promise<ProcessObservationSnapshot> {
    return this.snapshot
  }

  subscribe(listener: (change: ProcessObservationChange) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

class MutableWindowRegistry implements WindowRegistrySource {
  private listeners = new Set<(snapshot: WindowRegistrySnapshot) => void>()

  constructor(private snapshot: WindowRegistrySnapshot) {}

  setSnapshot(snapshot: WindowRegistrySnapshot): void {
    this.snapshot = snapshot
    for (const listener of [...this.listeners]) listener(snapshot)
  }

  getSnapshot(): WindowRegistrySnapshot { return this.snapshot }
  getWindows(): readonly WindowSnapshot[] { return this.snapshot.windows }
  getWindow(id: WindowId): WindowSnapshot | undefined { return this.snapshot.windows.find(window => window.id === id) }
  getByHwnd(hwnd: number): WindowSnapshot | undefined { return this.snapshot.windows.find(window => window.hwnd === hwnd) }
  getByProcessId(pid: number): readonly WindowSnapshot[] { return this.snapshot.windows.filter(window => window.processId === pid) }
  getForegroundWindow(): WindowSnapshot | undefined { return undefined }
  getWindowsForMonitor(): readonly WindowSnapshot[] { return [] }
  async refresh(): Promise<WindowRegistrySnapshot> { return this.snapshot }
  subscribe(listener: (snapshot: WindowRegistrySnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

function windows(
  revision: number,
  items: readonly WindowSnapshot[] = [],
): WindowRegistrySnapshot {
  return { generation: 1, revision, windows: items, capturedAt: revision }
}

function window(pid: number, executablePath: string): WindowSnapshot {
  return {
    id: WIN_A,
    hwnd: 0x1001,
    processId: pid,
    threadId: 200,
    processCreationTime: 111,
    executablePath,
    executableName: 'alpha.exe',
    title: 'Alpha',
    className: 'AlphaWindow',
    bounds: { x: 0, y: 0, width: 800, height: 600 },
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
    firstSeen: 1,
    updatedRevision: 1,
    generation: 1,
    capturedAt: 1,
  }
}

async function setup(
  application: AppRecord,
  processObservation: MutableProcessObservation,
  windowRegistry: MutableWindowRegistry,
): Promise<Context> {
  const ctx = new Context()
  const appRegistry = {
    ready: true,
    list: () => [application],
    get: (id: AppId) => id === application.id ? application : undefined,
    launch: async () => ({ success: true, pid: 999 }),
  }
  ctx.provide('appRegistry')
  ctx.appRegistry = appRegistry as unknown as AppRegistryService
  ctx.provide('processObservation')
  ctx.processObservation = processObservation as unknown as typeof ctx.processObservation
  ctx.provide('windowRegistry')
  ctx.windowRegistry = windowRegistry as unknown as typeof ctx.windowRegistry
  ctx.plugin(ApplicationRuntimeService, { enabled: true })
  await new Promise(resolve => setTimeout(resolve, 10))
  return ctx
}

describe('Application Runtime process lifecycle', () => {
  it('matches raw process identity by executable path and rejects ambiguous catalog ownership', () => {
    const first = app(APP_A, String.raw`C:\Apps\Alpha\alpha.exe`)
    const matcher = new ApplicationProcessMatcher([first])
    const process = processEntry(101, 111, String.raw`c:/apps/alpha/ALPHA.exe`)

    expect(matcher.match(process)).toEqual({ appId: APP_A, kind: 'executable-path' })

    const second = app('app:other' as AppId, String.raw`C:\Apps\Alpha\alpha.exe`)
    expect(new ApplicationProcessMatcher([first, second]).match(process)).toMatchObject({
      reason: 'ambiguous-catalog-match',
      candidateAppIds: [APP_A, second.id],
    })
  })

  it('projects background -> running -> stopped without duplicating process/window authority', async () => {
    const executablePath = String.raw`C:\Apps\Alpha\alpha.exe`
    const alpha = app(APP_A, executablePath)
    const process = processEntry(101, 111, executablePath)
    const processes = new MutableProcessObservation(processSnapshot(1, [process]))
    const registry = new MutableWindowRegistry(windows(1))
    const ctx = await setup(alpha, processes, registry)

    expect(ctx.applicationRuntime.getApplicationState(APP_A)).toBe('background')
    expect(ctx.applicationRuntime.getApplication(APP_A)).toMatchObject({
      state: 'background',
      processes: [{ identityKey: '101:111' }],
      windows: [],
    })

    registry.setSnapshot(windows(2, [window(101, executablePath)]))
    expect(ctx.applicationRuntime.getApplicationState(APP_A)).toBe('running')
    expect(ctx.applicationRuntime.getApplication(APP_A)?.windows).toHaveLength(1)

    registry.setSnapshot(windows(3))
    expect(ctx.applicationRuntime.getApplicationState(APP_A)).toBe('background')

    processes.setSnapshot(processSnapshot(2, []))
    expect(ctx.applicationRuntime.getApplicationState(APP_A)).toBe('stopped')
    expect(ctx.applicationRuntime.getApplication(APP_A)).toBeUndefined()

    await ctx.fiber.dispose()
  })

  it('does not treat a recycled PID as the prior process identity', async () => {
    const executablePath = String.raw`C:\Apps\Alpha\alpha.exe`
    const alpha = app(APP_A, executablePath)
    const first = processEntry(101, 111, executablePath)
    const processes = new MutableProcessObservation(processSnapshot(1, [first]))
    const registry = new MutableWindowRegistry(windows(1))
    const ctx = await setup(alpha, processes, registry)

    expect(ctx.applicationRuntime.getApplicationProcesses(APP_A)[0]?.identityKey).toBe('101:111')

    processes.setSnapshot(processSnapshot(2, [processEntry(101, 222, executablePath)]))
    expect(ctx.applicationRuntime.getApplicationProcesses(APP_A)[0]?.identityKey).toBe('101:222')

    await ctx.fiber.dispose()
  })
})
