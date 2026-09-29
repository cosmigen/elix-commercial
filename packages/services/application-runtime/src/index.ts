/**
 * Authoritative ELIX Application Runtime.
 *
 * App Registry owns catalog/launch, Process Observation owns raw process facts,
 * Window Registry owns external-window facts, and Window Control owns mutation.
 * This service alone interprets those authorities into AppId runtime state, MRU,
 * and launch-or-activate behavior.
 *
 * @module @deepseek-ai/dsh-application-runtime
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type {
  AppId,
  AppLaunchOptions,
  AppRecord,
  AppRegistryService,
} from '@deepseek-ai/dsh-app-registry'
import type {
  ProcessEntry,
  ProcessObservationSnapshot,
  ProcessObservationSource,
} from '@deepseek-ai/dsh-process-observation'
import {
  WindowControlError,
  type WindowControlSource,
} from '@deepseek-ai/dsh-window-control'
import type {
  WindowId,
  WindowRegistrySnapshot,
  WindowRegistrySource,
  WindowSnapshot,
} from '@deepseek-ai/dsh-window-registry'
import z from '@deepseek-ai/schemastery'
import { ApplicationWindowMatcher } from './matching.ts'
import { ApplicationProcessMatcher } from './process-matching.ts'
import type {
  ApplicationProcessMatchKind,
  ApplicationRuntimeActionFailure,
  ApplicationRuntimeActionResult,
  ApplicationRuntimeConfig,
  ApplicationRuntimeEntry,
  ApplicationRuntimeSnapshot,
  ApplicationRuntimeSource,
  ApplicationRuntimeState,
  ApplicationWindowMatchKind,
  UnmatchedApplicationWindow,
} from './types.ts'
import { ApplicationRuntimeError } from './types.ts'

export * from './types.ts'
export * from './matching.ts'
export * from './process-matching.ts'

interface MatchedWindow {
  readonly appId: AppId
  readonly window: WindowSnapshot
  readonly kind: ApplicationWindowMatchKind
}

interface MatchedProcess {
  readonly appId: AppId
  readonly process: ProcessEntry
  readonly kind: ApplicationProcessMatchKind
}

interface LaunchFlight {
  readonly signature: string
  readonly promise: Promise<ApplicationRuntimeActionResult>
}

interface PendingLaunchPid {
  readonly appId: AppId
  readonly expiresAt: number
}

const EMPTY_SNAPSHOT: ApplicationRuntimeSnapshot = Object.freeze({
  revision: 0,
  processObservationRevision: 0,
  windowRegistryGeneration: 0,
  windowRegistryRevision: 0,
  applications: Object.freeze([]),
  mruAppIds: Object.freeze([]),
  unmatchedWindows: Object.freeze([]),
  capturedAt: 0,
})

const LAUNCH_PID_HINT_TTL_MS = 15_000

declare module '@deepseek-ai/cordis' {
  interface Context {
    applicationRuntime: ApplicationRuntimeService
  }
  interface Events {
    /** @mode broadcast @param service Initialized coherent Application Runtime service. */
    'application-runtime/ready'(service: ApplicationRuntimeService): void
    /** @mode broadcast @param snapshot Coherent immutable app runtime replacement. */
    'application-runtime/snapshot'(snapshot: ApplicationRuntimeSnapshot): void
  }
}

/** App-level process/window runtime projection and orchestration service. */
export class ApplicationRuntimeService extends Service implements ApplicationRuntimeSource {
  static Config = z.object({ enabled: z.boolean().default(true) })

  private readonly config: ApplicationRuntimeConfig
  private readonly listeners = new Set<(snapshot: ApplicationRuntimeSnapshot) => void>()
  private readonly mruWindows = new Map<AppId, WindowId[]>()
  private readonly launchOrActivateFlights = new Map<AppId, LaunchFlight>()
  private readonly pendingLaunchPids = new Map<number, PendingLaunchPid>()
  private readonly processOwners = new Map<string, AppId>()
  private mruApps: AppId[] = []
  private currentSnapshot = EMPTY_SNAPSHOT
  private semanticKey = ''
  private registrySource: WindowRegistrySource | null = null
  private registryDisposer: (() => void) | null = null
  private processSource: ProcessObservationSource | null = null
  private processDisposer: (() => void) | null = null
  private isReady = false
  private readonly lifecycle = { isDisposed: false }

  // Identity indexes rebuild only when App Registry changes, not on process/window churn.
  private catalogDirty = true
  private catalogById = new Map<AppId, AppRecord>()
  private matcher = new ApplicationWindowMatcher([])
  private processMatcher = new ApplicationProcessMatcher([])

  constructor(ctx: Context, config?: Partial<ApplicationRuntimeConfig>) {
    super(ctx, 'applicationRuntime')
    this.config = { enabled: config?.enabled ?? true }
  }

  [Service.init](): void {
    if (!this.config.enabled) return

    const onCatalogChange = () => {
      this.invalidateCatalogAndReconcile()
    }
    this.ctx.on('app-registry/ready', onCatalogChange)
    this.ctx.on('app-registry/app-added', onCatalogChange)
    this.ctx.on('app-registry/app-updated', onCatalogChange)
    this.ctx.on('app-registry/app-removed', onCatalogChange)
    this.ctx.on('app-registry/refresh-completed', onCatalogChange)
    this.ctx.on('window-registry/ready', (service) => {
      this.attachRegistry(service)
    })
    this.ctx.on('process-observation/ready', (service) => {
      this.attachProcessObservation(service)
    })

    const registry = this.tryWindowRegistry()
    if (registry) this.attachRegistry(registry)
    const processes = this.tryProcessObservation()
    if (processes) this.attachProcessObservation(processes)

    this.ctx.effect(() => () => {
      this.lifecycle.isDisposed = true
      this.registryDisposer?.()
      this.registryDisposer = null
      this.registrySource = null
      this.processDisposer?.()
      this.processDisposer = null
      this.processSource = null
      this.listeners.clear()
      this.mruWindows.clear()
      this.mruApps = []
      this.launchOrActivateFlights.clear()
      this.pendingLaunchPids.clear()
      this.processOwners.clear()
      this.catalogById.clear()
      this.matcher = new ApplicationWindowMatcher([])
      this.processMatcher = new ApplicationProcessMatcher([])
      this.isReady = false
    }, 'applicationRuntime.lifecycle')
  }

  get ready(): boolean {
    return this.isReady && !this.lifecycle.isDisposed
  }

  getSnapshot(): ApplicationRuntimeSnapshot {
    this.assertReadable()
    return this.currentSnapshot
  }

  getApplications(): readonly ApplicationRuntimeEntry[] {
    return this.getSnapshot().applications
  }

  getApplication(appId: AppId): ApplicationRuntimeEntry | undefined {
    return this.getApplications().find(entry => entry.appId === appId)
  }

  getApplicationState(appId: AppId): ApplicationRuntimeState {
    this.requireCatalogApp(appId)
    return this.getApplication(appId)?.state ?? 'stopped'
  }

  getApplicationProcesses(appId: AppId): readonly ProcessEntry[] {
    return this.getApplication(appId)?.processes ?? Object.freeze([])
  }

  getApplicationWindows(appId: AppId): readonly WindowSnapshot[] {
    return this.getApplication(appId)?.windows ?? Object.freeze([])
  }

  hasObservedProcesses(appId: AppId): boolean {
    return this.getApplicationProcesses(appId).length > 0
  }

  hasObservedWindows(appId: AppId): boolean {
    return this.getApplicationWindows(appId).length > 0
  }

  getForegroundApplication(): ApplicationRuntimeEntry | undefined {
    const snapshot = this.getSnapshot()
    return snapshot.foregroundAppId
      ? snapshot.applications.find(entry => entry.appId === snapshot.foregroundAppId)
      : undefined
  }

  getMostRecentWindow(appId: AppId): WindowSnapshot | undefined {
    const entry = this.getApplication(appId)
    return entry ? selectActivationWindow(entry) : undefined
  }

  async activateApplication(appId: AppId): Promise<ApplicationRuntimeActionResult> {
    this.assertReadable()
    this.requireCatalogApp(appId)
    return this.activateExisting(appId, 0)
  }

  /** Explicit fresh launch used by New Window and explicit target/argument actions. */
  launchApplication(
    appId: AppId,
    options?: AppLaunchOptions,
  ): Promise<ApplicationRuntimeActionResult> {
    return this.launchOrActivate(appId, options ?? {})
  }

  launchOrActivate(
    appId: AppId,
    options?: AppLaunchOptions,
  ): Promise<ApplicationRuntimeActionResult> {
    this.assertReadable()
    this.requireCatalogApp(appId)

    const signature = launchOptionsSignature(options)
    const current = this.launchOrActivateFlights.get(appId)
    if (current) {
      if (current.signature === signature) return current.promise
      return Promise.resolve(failedResult(
        appId,
        'CONCURRENT_LAUNCH_CONFLICT',
        'Another launch-or-activate operation for this AppId is already in flight with different launch options',
        true,
      ))
    }

    const operation = this.launchOrActivateInternal(appId, options).finally(() => {
      const active = this.launchOrActivateFlights.get(appId)
      if (active?.promise === operation) this.launchOrActivateFlights.delete(appId)
    })
    this.launchOrActivateFlights.set(appId, { signature, promise: operation })
    return operation
  }

  subscribe(listener: (snapshot: ApplicationRuntimeSnapshot) => void): () => void {
    if (!this.config.enabled) {
      throw new ApplicationRuntimeError(
        'APPLICATION_RUNTIME_DISABLED',
        'Application Runtime is disabled by configuration',
      )
    }
    if (this.lifecycle.isDisposed) {
      throw new ApplicationRuntimeError(
        'APPLICATION_RUNTIME_DISPOSED',
        'Application Runtime service is disposed',
      )
    }

    this.listeners.add(listener)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      this.listeners.delete(listener)
    }
  }

  private invalidateCatalogAndReconcile(): void {
    this.catalogDirty = true
    this.reconcile()
  }

  private ensureCatalog(appRegistry: AppRegistryService): void {
    if (!this.catalogDirty) return
    const apps = appRegistry.list()
    this.catalogById = new Map(apps.map(app => [app.id, app] as const))
    this.matcher = new ApplicationWindowMatcher(apps)
    this.processMatcher = new ApplicationProcessMatcher(apps)
    for (const [key, appId] of this.processOwners) {
      if (!this.catalogById.has(appId)) this.processOwners.delete(key)
    }
    this.catalogDirty = false
  }

  private attachRegistry(registry: WindowRegistrySource): void {
    if (this.lifecycle.isDisposed) return
    if (this.registrySource === registry) {
      this.reconcile()
      return
    }

    this.registryDisposer?.()
    this.registrySource = registry
    this.registryDisposer = registry.subscribe((snapshot) => {
      this.reconcile(snapshot)
    })
    this.reconcile(registry.getSnapshot())
  }

  private attachProcessObservation(processes: ProcessObservationSource): void {
    if (this.lifecycle.isDisposed) return
    if (this.processSource === processes) {
      this.reconcile()
      return
    }

    this.processDisposer?.()
    this.processSource = processes
    this.processDisposer = processes.subscribe((change) => {
      this.reconcile(undefined, change.snapshot)
    })
    this.reconcile(undefined, processes.getSnapshot())
  }

  private reconcile(
    providedWindow?: WindowRegistrySnapshot,
    providedProcess?: ProcessObservationSnapshot,
  ): void {
    if (!this.config.enabled || this.lifecycle.isDisposed) return

    const appRegistry = this.tryAppRegistry()
    const windowRegistry = this.registrySource ?? this.tryWindowRegistry()
    if (!appRegistry?.ready || !windowRegistry) return

    const windowSnapshot = providedWindow ?? windowRegistry.getSnapshot()
    if (windowSnapshot.revision === 0) return
    const processSnapshot = providedProcess
      ?? this.processSource?.getSnapshot()
      ?? EMPTY_PROCESS_SNAPSHOT

    this.ensureCatalog(appRegistry)
    this.pruneLaunchHints(processSnapshot)

    const matchedWindows: MatchedWindow[] = []
    const unmatched: UnmatchedApplicationWindow[] = []
    for (const window of windowSnapshot.windows) {
      if (window.classification !== 'APPLICATION') continue
      const result = this.matcher.match(window)
      if ('appId' in result) {
        matchedWindows.push({ appId: result.appId, window, kind: result.kind })
      } else {
        unmatched.push(Object.freeze({
          windowId: window.id,
          reason: result.reason,
          candidateAppIds: result.candidateAppIds,
        }))
      }
    }

    const matchedProcesses = this.matchProcesses(processSnapshot.processes)
    const matchedWindowsByApp = groupMatchedWindows(matchedWindows)
    const matchedProcessesByApp = groupMatchedProcesses(matchedProcesses)
    const foregroundMatch = windowSnapshot.foregroundWindowId
      ? matchedWindows.find(item => item.window.id === windowSnapshot.foregroundWindowId)
      : undefined

    this.reconcileMru(matchedWindowsByApp, foregroundMatch)

    const activeAppIds = new Set<AppId>([
      ...matchedWindowsByApp.keys(),
      ...matchedProcessesByApp.keys(),
    ])
    const applications: ApplicationRuntimeEntry[] = []
    for (const appId of activeAppIds) {
      const app = this.catalogById.get(appId)
      if (!app) continue
      applications.push(this.buildEntry(
        app,
        matchedWindowsByApp.get(appId) ?? [],
        matchedProcessesByApp.get(appId) ?? [],
        foregroundMatch,
      ))
    }
    applications.sort(compareApplications)

    const nextForegroundAppId = foregroundMatch?.appId
    const nextMruApps = Object.freeze([...this.mruApps])
    const nextUnmatched = Object.freeze(
      [...unmatched].sort((a, b) => String(a.windowId).localeCompare(String(b.windowId))),
    )
    const nextSemanticKey = makeSemanticKey(
      windowSnapshot,
      applications,
      nextMruApps,
      nextForegroundAppId,
      nextUnmatched,
    )

    if (nextSemanticKey === this.semanticKey) return

    const snapshot: ApplicationRuntimeSnapshot = Object.freeze({
      revision: this.currentSnapshot.revision + 1,
      processObservationRevision: processSnapshot.revision,
      windowRegistryGeneration: windowSnapshot.generation,
      windowRegistryRevision: windowSnapshot.revision,
      applications: Object.freeze(applications),
      mruAppIds: nextMruApps,
      ...(nextForegroundAppId ? { foregroundAppId: nextForegroundAppId } : {}),
      unmatchedWindows: nextUnmatched,
      capturedAt: Date.now(),
    })

    this.semanticKey = nextSemanticKey
    this.currentSnapshot = snapshot
    const wasReady = this.isReady
    this.isReady = true

    for (const listener of [...this.listeners]) {
      try {
        listener(snapshot)
      } catch {
        // One consumer cannot corrupt the runtime projection or block other listeners.
      }
    }
    this.ctx.emit('application-runtime/snapshot', snapshot)
    if (!wasReady) this.ctx.emit('application-runtime/ready', this)
  }

  private matchProcesses(processes: readonly ProcessEntry[]): MatchedProcess[] {
    const matched = new Map<string, MatchedProcess>()
    const processByPid = new Map(processes.map(process => [process.identity.pid, process] as const))

    // Strong catalog evidence always wins over launch hints or ancestry.
    for (const process of processes) {
      const direct = this.processMatcher.match(process)
      if ('appId' in direct) {
        matched.set(process.identityKey, {
          appId: direct.appId,
          process,
          kind: direct.kind,
        })
        this.processOwners.set(process.identityKey, direct.appId)
        this.pendingLaunchPids.delete(process.identity.pid)
        continue
      }

      const owned = this.processOwners.get(process.identityKey)
      if (owned !== undefined && this.catalogById.has(owned)) {
        matched.set(process.identityKey, {
          appId: owned,
          process,
          kind: 'launch-pid',
        })
        continue
      }

      const pending = this.pendingLaunchPids.get(process.identity.pid)
      if (pending !== undefined && pending.expiresAt >= Date.now() && this.catalogById.has(pending.appId)) {
        this.processOwners.set(process.identityKey, pending.appId)
        this.pendingLaunchPids.delete(process.identity.pid)
        matched.set(process.identityKey, {
          appId: pending.appId,
          process,
          kind: 'launch-pid',
        })
      }
    }

    // Conservatively inherit app ownership through the current process tree only when the
    // child has no direct catalog identity of its own. Iterate to cover helper grandchildren.
    let changed = true
    while (changed) {
      changed = false
      for (const process of processes) {
        if (matched.has(process.identityKey) || process.parentPid === 0) continue
        const direct = this.processMatcher.match(process)
        if ('appId' in direct || direct.reason === 'ambiguous-catalog-match') continue
        const parent = processByPid.get(process.parentPid)
        if (parent === undefined) continue
        const parentMatch = matched.get(parent.identityKey)
        if (parentMatch === undefined) continue
        const item: MatchedProcess = {
          appId: parentMatch.appId,
          process,
          kind: 'descendant',
        }
        matched.set(process.identityKey, item)
        this.processOwners.set(process.identityKey, parentMatch.appId)
        changed = true
      }
    }

    return [...matched.values()]
  }

  private pruneLaunchHints(snapshot: ProcessObservationSnapshot): void {
    const now = Date.now()
    for (const [pid, hint] of this.pendingLaunchPids) {
      if (hint.expiresAt < now) this.pendingLaunchPids.delete(pid)
    }
    const currentKeys = new Set(snapshot.processes.map(process => process.identityKey))
    for (const key of this.processOwners.keys()) {
      if (!currentKeys.has(key)) this.processOwners.delete(key)
    }
  }

  private reconcileMru(
    matchedByApp: ReadonlyMap<AppId, readonly MatchedWindow[]>,
    foreground: MatchedWindow | undefined,
  ): void {
    const activatableByApp = new Map<AppId, WindowId[]>()

    for (const [appId, items] of matchedByApp.entries()) {
      const currentIds = items
        .filter(item => isActivationEligible(item.window))
        .map(item => item.window.id)
      const currentSet = new Set(currentIds)
      const prior = this.mruWindows.get(appId) ?? []
      const next = prior.filter(id => currentSet.has(id))
      const known = new Set(next)
      const unseen = items
        .filter(item => currentSet.has(item.window.id) && !known.has(item.window.id))
        .sort((a, b) => b.window.firstSeen - a.window.firstSeen || compareWindowIds(a.window.id, b.window.id))
        .map(item => item.window.id)
      next.push(...unseen)
      this.mruWindows.set(appId, next)
      activatableByApp.set(appId, currentIds)
    }

    for (const appId of [...this.mruWindows.keys()]) {
      if (!matchedByApp.has(appId)) this.mruWindows.delete(appId)
    }

    if (foreground && isActivationEligible(foreground.window)) {
      const windowMru = this.mruWindows.get(foreground.appId) ?? []
      this.mruWindows.set(foreground.appId, moveToFront(windowMru, foreground.window.id))
      this.mruApps = moveToFront(this.mruApps, foreground.appId)
    }

    const eligibleApps = new Set(
      [...activatableByApp.entries()]
        .filter(([, ids]) => ids.length > 0)
        .map(([appId]) => appId),
    )
    this.mruApps = this.mruApps.filter(appId => eligibleApps.has(appId))

    const unseenApps = [...eligibleApps]
      .filter(appId => !this.mruApps.includes(appId))
      .sort((left, right) => {
        const leftNewest = newestFirstSeen(matchedByApp.get(left) ?? [])
        const rightNewest = newestFirstSeen(matchedByApp.get(right) ?? [])
        return rightNewest - leftNewest || String(left).localeCompare(String(right))
      })
    this.mruApps.push(...unseenApps)
  }

  private buildEntry(
    app: AppRecord,
    windowMatches: readonly MatchedWindow[],
    processMatches: readonly MatchedProcess[],
    foreground: MatchedWindow | undefined,
  ): ApplicationRuntimeEntry {
    const windows = Object.freeze(
      windowMatches.map(item => item.window).sort((a, b) => compareWindowIds(a.id, b.id)),
    )
    const processes = Object.freeze(
      processMatches
        .map(item => item.process)
        .sort((a, b) => a.identity.pid - b.identity.pid || a.identityKey.localeCompare(b.identityKey)),
    )
    const eligible = new Set(
      windowMatches.filter(item => isActivationEligible(item.window)).map(item => item.window.id),
    )
    const mru = Object.freeze((this.mruWindows.get(app.id) ?? []).filter(id => eligible.has(id)))
    const matchKinds: Partial<Record<WindowId, ApplicationWindowMatchKind>> = {}
    for (const item of windowMatches) matchKinds[item.window.id] = item.kind
    const processMatchKinds: Record<string, ApplicationProcessMatchKind> = {}
    for (const item of processMatches) processMatchKinds[item.process.identityKey] = item.kind

    const foregroundWindowId = foreground?.appId === app.id ? foreground.window.id : undefined
    return Object.freeze({
      appId: app.id,
      app,
      state: windows.length > 0 ? 'running' : 'background',
      processes,
      processMatchKinds: Object.freeze(processMatchKinds),
      windows,
      activatableWindowIds: Object.freeze([...mru]),
      mruWindowIds: mru,
      ...(foregroundWindowId ? { foregroundWindowId } : {}),
      visibleWindowCount: windows.filter(
        window => window.isVisible && !window.isMinimized && !window.isCloaked,
      ).length,
      minimizedWindowCount: windows.filter(window => window.isMinimized).length,
      matchKinds: Object.freeze(matchKinds),
    })
  }

  private async launchOrActivateInternal(
    appId: AppId,
    options?: AppLaunchOptions,
  ): Promise<ApplicationRuntimeActionResult> {
    this.reconcile()

    // Passing launch options is an explicit fresh-launch intent.
    if (options !== undefined) return this.requestLaunch(appId, options)

    const entry = this.getApplication(appId)
    if (entry) {
      const target = selectActivationWindow(entry)
      if (target) return this.activateExisting(appId, 0)
      if (entry.processes.length > 0 && entry.windows.length === 0) {
        return failedResult(
          appId,
          'APP_RUNNING_IN_BACKGROUND',
          'The application is already running in the background without an activatable window',
          false,
        )
      }
      return failedResult(
        appId,
        'NO_ACTIVATABLE_WINDOW',
        'The application has observed windows, but none are currently eligible for activation',
        false,
      )
    }

    const ambiguous = this.currentSnapshot.unmatchedWindows.some(
      window => window.reason === 'ambiguous-catalog-match' && window.candidateAppIds.includes(appId),
    )
    if (ambiguous) {
      return failedResult(
        appId,
        'AMBIGUOUS_EXISTING_WINDOW',
        'An existing window may belong to this application, but catalog identity is ambiguous; refusing to launch a duplicate instance',
        false,
      )
    }

    return this.requestLaunch(appId)
  }

  private async requestLaunch(
    appId: AppId,
    options?: AppLaunchOptions,
  ): Promise<ApplicationRuntimeActionResult> {
    const appRegistry = this.requireAppRegistry()
    const app = this.requireCatalogApp(appId)
    try {
      const launchResult = await appRegistry.launch(appId, options)
      if (!launchResult.success) {
        return Object.freeze({
          appId,
          action: 'failed',
          launchResult,
          completed: false,
          failure: Object.freeze({
            code: 'APP_LAUNCH_FAILED',
            message: launchResult.error ?? `Application '${appId}' failed to launch`,
            retryable: true,
          }),
        })
      }

      // Packaged launch currently passes through explorer.exe, so that PID is not app identity.
      // Win32/shortcut PIDs may seed a short-lived hint until the observer supplies creation time.
      if (launchResult.pid !== undefined && app.launch.kind !== 'packaged') {
        this.pendingLaunchPids.set(launchResult.pid, {
          appId,
          expiresAt: Date.now() + LAUNCH_PID_HINT_TTL_MS,
        })
        void this.processSource?.refresh().catch(() => {})
      }

      return Object.freeze({
        appId,
        action: 'launch-requested',
        launchResult,
        completed: true,
      })
    } catch (error) {
      return failedFromError(appId, 'APP_LAUNCH_FAILED', error, true)
    }
  }

  private async activateExisting(
    appId: AppId,
    retry: number,
  ): Promise<ApplicationRuntimeActionResult> {
    this.reconcile()
    const entry = this.getApplication(appId)
    const target = entry ? selectActivationWindow(entry) : undefined
    if (!target) {
      return failedResult(
        appId,
        'NO_ACTIVATABLE_WINDOW',
        'No observed window for this application is currently eligible for activation',
        true,
      )
    }

    const control = this.requireWindowControl()
    let restoreResult
    try {
      if (target.isMinimized) {
        restoreResult = await control.restore(target.id)
        if (!restoreResult.completed && restoreResult.observation.minimized) {
          return Object.freeze({
            appId,
            action: 'failed',
            windowId: target.id,
            restoreResult,
            completed: false,
            failure: Object.freeze({
              code: 'RESTORE_NOT_CONFIRMED',
              message: `Restore was accepted but not confirmed for WindowId '${target.id}'`,
              retryable: true,
            }),
          })
        }
      }

      const activateResult = await control.activate(target.id)
      if (!activateResult.completed) {
        return Object.freeze({
          appId,
          action: 'failed',
          windowId: target.id,
          ...(restoreResult ? { restoreResult } : {}),
          activateResult,
          completed: false,
          failure: Object.freeze({
            code: 'ACTIVATION_NOT_CONFIRMED',
            message: `Windows did not confirm foreground activation for WindowId '${target.id}'`,
            retryable: true,
          }),
        })
      }

      return Object.freeze({
        appId,
        action: restoreResult ? 'restored-and-activated' : 'activated',
        windowId: target.id,
        ...(restoreResult ? { restoreResult } : {}),
        activateResult,
        completed: true,
      })
    } catch (error) {
      if (retry === 0 && isStaleWindowError(error)) {
        this.reconcile()
        const replacement = this.getMostRecentWindow(appId)
        if (replacement && replacement.id !== target.id) return this.activateExisting(appId, 1)
      }
      return Object.freeze({
        appId,
        action: 'failed',
        windowId: target.id,
        ...(restoreResult ? { restoreResult } : {}),
        completed: false,
        failure: Object.freeze(toActionFailure(error)),
      })
    }
  }

  private assertReadable(): void {
    if (!this.config.enabled) {
      throw new ApplicationRuntimeError(
        'APPLICATION_RUNTIME_DISABLED',
        'Application Runtime is disabled by configuration',
      )
    }
    if (this.lifecycle.isDisposed) {
      throw new ApplicationRuntimeError(
        'APPLICATION_RUNTIME_DISPOSED',
        'Application Runtime service is disposed',
      )
    }
    if (!this.isReady) {
      throw new ApplicationRuntimeError(
        'APPLICATION_RUNTIME_NOT_READY',
        'Application Runtime is waiting for ready App Registry and an authoritative Window Registry snapshot',
        true,
      )
    }
  }

  private tryAppRegistry(): AppRegistryService | undefined {
    return this.ctx.get('appRegistry')
  }

  private requireAppRegistry(): AppRegistryService {
    const registry = this.tryAppRegistry()
    if (!registry?.ready) {
      throw new ApplicationRuntimeError(
        'APP_REGISTRY_UNAVAILABLE',
        'Application Runtime requires a ready ctx.appRegistry',
        true,
      )
    }
    return registry
  }

  private tryWindowRegistry(): WindowRegistrySource | undefined {
    return this.ctx.get('windowRegistry')
  }

  private tryProcessObservation(): ProcessObservationSource | undefined {
    return this.ctx.get('processObservation')
  }

  private requireWindowControl(): WindowControlSource {
    const control = this.ctx.get('windowControl') as WindowControlSource | undefined
    if (!control) {
      throw new ApplicationRuntimeError(
        'WINDOW_CONTROL_UNAVAILABLE',
        'Application Runtime cannot activate an observed window without ctx.windowControl',
        true,
      )
    }
    return control
  }

  private requireCatalogApp(appId: AppId): AppRecord {
    const app = this.requireAppRegistry().get(appId)
    if (!app) {
      throw new ApplicationRuntimeError(
        'UNKNOWN_APP',
        `AppId '${appId}' is not present in App Registry`,
      )
    }
    return app
  }
}

const EMPTY_PROCESS_SNAPSHOT: ProcessObservationSnapshot = Object.freeze({
  revision: 0,
  processes: Object.freeze([]),
  capturedAt: 0,
})

function groupMatchedWindows(matches: readonly MatchedWindow[]): Map<AppId, MatchedWindow[]> {
  const result = new Map<AppId, MatchedWindow[]>()
  for (const item of matches) {
    const bucket = result.get(item.appId)
    if (bucket) bucket.push(item)
    else result.set(item.appId, [item])
  }
  return result
}

function groupMatchedProcesses(matches: readonly MatchedProcess[]): Map<AppId, MatchedProcess[]> {
  const result = new Map<AppId, MatchedProcess[]>()
  for (const item of matches) {
    const bucket = result.get(item.appId)
    if (bucket) bucket.push(item)
    else result.set(item.appId, [item])
  }
  return result
}

function selectActivationWindow(entry: ApplicationRuntimeEntry): WindowSnapshot | undefined {
  const byId = new Map(entry.windows.map(window => [window.id, window] as const))
  const ordered = entry.mruWindowIds.map(id => byId.get(id)).filter(isWindow)
  return ordered.find(window => !window.isMinimized && isActivationEligible(window))
    ?? ordered.find(window => window.isMinimized && isActivationEligible(window))
}

function isWindow(window: WindowSnapshot | undefined): window is WindowSnapshot {
  return window !== undefined
}

function isActivationEligible(window: WindowSnapshot): boolean {
  return window.classification === 'APPLICATION'
    && window.state !== 'hidden'
    && !window.isCloaked
    && window.isEnabled
    && (window.isVisible || window.isMinimized)
}

function newestFirstSeen(items: readonly MatchedWindow[]): number {
  let newest = 0
  for (const item of items) newest = Math.max(newest, item.window.firstSeen)
  return newest
}

function moveToFront<T>(items: readonly T[], item: T): T[] {
  return [item, ...items.filter(existing => existing !== item)]
}

function compareWindowIds(left: WindowId, right: WindowId): number {
  return String(left).localeCompare(String(right))
}

function compareApplications(left: ApplicationRuntimeEntry, right: ApplicationRuntimeEntry): number {
  return left.app.displayName.localeCompare(right.app.displayName)
    || String(left.appId).localeCompare(String(right.appId))
}

function makeSemanticKey(
  windowSnapshot: WindowRegistrySnapshot,
  applications: readonly ApplicationRuntimeEntry[],
  mruAppIds: readonly AppId[],
  foregroundAppId: AppId | undefined,
  unmatched: readonly UnmatchedApplicationWindow[],
): string {
  return JSON.stringify({
    generation: windowSnapshot.generation,
    foregroundAppId,
    mruAppIds,
    applications: applications.map(entry => ({
      appId: entry.appId,
      updatedAt: entry.app.updatedAt,
      launch: entry.app.launch,
      state: entry.state,
      processes: entry.processes.map(process => ({
        identityKey: process.identityKey,
        parentPid: process.parentPid,
        executablePath: process.executablePath,
        aumid: process.aumid,
      })),
      processMatchKinds: entry.processMatchKinds,
      windows: entry.windows.map(window => ({
        id: window.id,
        state: window.state,
        visible: window.isVisible,
        minimized: window.isMinimized,
        maximized: window.isMaximized,
        cloaked: window.isCloaked,
        enabled: window.isEnabled,
        foreground: window.isForeground,
        executablePath: window.executablePath,
        aumid: window.aumid,
        updatedRevision: window.updatedRevision,
        generation: window.generation,
      })),
      mruWindowIds: entry.mruWindowIds,
      matchKinds: entry.matchKinds,
    })),
    unmatched,
  })
}

function launchOptionsSignature(options: AppLaunchOptions | undefined): string {
  return JSON.stringify({
    explicitLaunch: options !== undefined,
    additionalArgs: options?.additionalArgs ?? [],
    workingDirectory: options?.workingDirectory ?? null,
  })
}

function isStaleWindowError(error: unknown): boolean {
  if (error instanceof WindowControlError) return error.code === 'STALE_WINDOW_ID'
  if (error && typeof error === 'object' && 'code' in error) {
    return error.code === 'STALE_WINDOW_ID'
  }
  return false
}

function toActionFailure(error: unknown): ApplicationRuntimeActionFailure {
  if (error instanceof WindowControlError || error instanceof ApplicationRuntimeError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    }
  }
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    const message = 'message' in error && typeof error.message === 'string'
      ? error.message
      : (error instanceof Error ? error.message : JSON.stringify(error))
    const retryable = 'retryable' in error && typeof error.retryable === 'boolean'
      ? error.retryable
      : false
    return { code: error.code, message, retryable }
  }
  return {
    code: 'APPLICATION_RUNTIME_ACTION_FAILED',
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  }
}

function failedResult(
  appId: AppId,
  code: string,
  message: string,
  retryable: boolean,
): ApplicationRuntimeActionResult {
  return Object.freeze({
    appId,
    action: 'failed',
    completed: false,
    failure: Object.freeze({ code, message, retryable }),
  })
}

function failedFromError(
  appId: AppId,
  fallbackCode: string,
  error: unknown,
  retryable: boolean,
): ApplicationRuntimeActionResult {
  const derived = toActionFailure(error)
  return failedResult(
    appId,
    derived.code === 'APPLICATION_RUNTIME_ACTION_FAILED' ? fallbackCode : derived.code,
    derived.message,
    derived.code === 'APPLICATION_RUNTIME_ACTION_FAILED' ? retryable : derived.retryable,
  )
}

export default ApplicationRuntimeService
