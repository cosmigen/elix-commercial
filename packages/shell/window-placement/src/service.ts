import { Context, Service } from '@deepseek-ai/cordis'
import type {
  WindowControlResult,
  WindowControlSource,
  WindowPlacementConstraints,
} from '@deepseek-ai/dsh-window-control'
import type {
  WindowChange,
  WindowId,
  WindowRegistrySource,
  WindowSnapshot,
} from '@deepseek-ai/dsh-window-registry'
import type {
  PhysicalPixelRect,
  WindowsContextSource,
  WindowsContextSnapshot,
  WindowsMonitor,
} from '@deepseek-ai/dsh-windows-context'
import type { ShellLayoutSource } from '@deepseek-ai/dsh-shell-layout'
import z from '@deepseek-ai/schemastery'
import {
  clampRectFullyOrAccessibly,
  computeZoneRect,
  constrainPlacementRect,
  preserveOffsetRect,
  rectNear,
  type PlacementAnchor,
} from './geometry.ts'
import type {
  NamedPlacementLayout,
  NamedPlacementResult,
  PlacementAdjustment,
  PlacementFailureReason,
  PlacementOptions,
  PlacementRecord,
  PlacementRecordEvent,
  PlacementResult,
  PlacementTarget,
  WindowPlacementConfig,
  WindowPlacementSource,
} from './types.ts'

interface Dependencies {
  readonly windowControl: WindowControlSource
  readonly registry: WindowRegistrySource
  readonly windowsContext: WindowsContextSource
  readonly shellLayout: ShellLayoutSource
}

interface PlacementPlan {
  readonly monitor: WindowsMonitor
  readonly displayRevision: number
  readonly displayBasis: string
  readonly workArea: PhysicalPixelRect
  readonly requestedRect: PhysicalPixelRect
  readonly effectiveRect: PhysicalPixelRect
  readonly constraints: WindowPlacementConstraints
  readonly adjustments: readonly PlacementAdjustment[]
}

const MAX_DISPLAY_REPLANS = 4
const TITLE_BAR_VISIBLE_DIP = 48

function now(): number {
  return Date.now()
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const code = Reflect.get(error, 'code')
  return typeof code === 'string' ? code : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function frozenRect(rect: PhysicalPixelRect): PhysicalPixelRect {
  return Object.freeze({ ...rect })
}

function displayPlacementBasis(snapshot: WindowsContextSnapshot): string {
  const monitors = snapshot.monitors
    .map(monitor => ({
      id: String(monitor.id),
      bounds: monitor.bounds,
      workArea: monitor.workArea,
      dpiX: monitor.dpiX,
      dpiY: monitor.dpiY,
      scaleFactor: monitor.scaleFactor,
      isPrimary: monitor.isPrimary,
    }))
    .sort((left, right) => left.id.localeCompare(right.id))
  return JSON.stringify({
    primaryMonitorId: String(snapshot.primaryMonitorId),
    monitors,
  })
}

function frozenRecord(record: PlacementRecord): PlacementRecord {
  return Object.freeze({
    ...record,
    originalBounds: frozenRect(record.originalBounds),
    lastAppliedBounds: frozenRect(record.lastAppliedBounds),
    lastTarget: Object.freeze({ ...record.lastTarget }) as PlacementTarget,
  })
}

function isResizePlacement(target: PlacementTarget): boolean {
  return target.kind !== 'center' && target.kind !== 'move-to-monitor'
}

function mapOperationalFailure(error: unknown): PlacementFailureReason {
  switch (errorCode(error)) {
    case 'STALE_WINDOW_ID':
    case 'STALE_WINDOW':
    case 'IDENTITY_UNVERIFIABLE':
      return 'stale-window-id'
    case 'TARGET_NOT_APPLICATION':
    case 'WINDOW_NOT_CONTROLLABLE':
    case 'TARGET_NOT_TOP_LEVEL':
    case 'TARGET_PROTECTED':
      return 'target-not-application'
    default:
      return 'native-mutation-failed'
  }
}

export class WindowPlacementService extends Service implements WindowPlacementSource {
  static Config = z.object({
    enabled: z.boolean().default(true),
    maxDisplayReplans: z.number().default(2),
  })

  private readonly config: WindowPlacementConfig
  private readonly records = new Map<WindowId, PlacementRecord>()
  private readonly listeners = new Set<(event: PlacementRecordEvent) => void>()
  /** Suppresses Registry echoes while one explicit placement transaction owns geometry. */
  private readonly activeOperations = new Set<WindowId>()
  private disposed = false

  constructor(ctx: Context, config?: Partial<WindowPlacementConfig>) {
    super(ctx, 'windowPlacement')
    this.config = {
      enabled: config?.enabled ?? true,
      maxDisplayReplans: Math.max(
        1,
        Math.min(MAX_DISPLAY_REPLANS, Math.floor(config?.maxDisplayReplans ?? 2)),
      ),
    }
  }

  [Service.init](): void {
    if (!this.config.enabled) return

    this.ctx.on('window-registry/window-changed', (change) => {
      this.handleExternalWindowChange(change)
    })
    this.ctx.on('window-registry/window-destroyed', (window) => {
      this.invalidateRecord(window.id, 'source-window-destroyed')
    })
    this.ctx.on('window-registry/recovered', () => {
      const registry = this.dependencies()?.registry
      if (!registry) return
      for (const [windowId, record] of [...this.records]) {
        const current = registry.getWindow(windowId)
        if (!current || current.generation !== record.sourceRegistryGeneration) {
          this.invalidateRecord(windowId, 'registry-generation-changed')
        }
      }
    })
    this.ctx.effect(() => () => {
      this.disposed = true
      this.records.clear()
      this.listeners.clear()
      this.activeOperations.clear()
    }, 'windowPlacement.lifecycle')

    this.ctx.emit('window-placement/ready', this)
  }

  place(
    windowId: WindowId,
    target: PlacementTarget,
    options: PlacementOptions = {},
  ): Promise<PlacementResult> {
    if (this.activeOperations.has(windowId)) {
      return Promise.resolve(this.rejected(
        windowId,
        target,
        'operation-conflict',
        `A placement operation is already active for WindowId '${windowId}'.`,
      ))
    }
    return this.withOperation(windowId, () => this.placeInternal(windowId, target, options))
  }

  private async placeInternal(
    windowId: WindowId,
    target: PlacementTarget,
    options: PlacementOptions,
  ): Promise<PlacementResult> {
    if (options.signal?.aborted) return this.cancelled(windowId, target)
    const deps = this.dependencies()
    if (!deps) {
      return this.rejected(
        windowId,
        target,
        'authority-unavailable',
        'Placement dependencies are unavailable.',
      )
    }

    let source = deps.registry.getWindow(windowId)
    const validation = this.validateSource(windowId, source, target)
    if (validation) return validation
    source = source as WindowSnapshot

    let existingRecord = this.records.get(windowId)
    if (existingRecord && existingRecord.sourceRegistryGeneration !== source.generation) {
      this.invalidateRecord(windowId, 'registry-generation-changed')
      existingRecord = undefined
    }

    let rollbackBounds = frozenRect(source.bounds)
    const rollbackState = source.state
    const rollbackMonitorId = source.monitorId
    let rollbackNeeded = false
    let originalBounds = frozenRect(source.bounds)
    const originalState: 'normal' | 'maximized' = source.state === 'maximized' ? 'maximized' : 'normal'
    const originalMonitorId = source.monitorId

    if (source.state === 'maximized') {
      const restored = await this.restoreToNormal(deps, windowId)
      if (!restored.ok) {
        return this.rejected(
          windowId,
          target,
          'restore-before-placement-failed',
          restored.detail,
        )
      }
      source = deps.registry.getWindow(windowId)
      if (!source || source.state !== 'normal') {
        return this.rejected(
          windowId,
          target,
          'restore-before-placement-failed',
          'Window Registry did not confirm a normal window after restore.',
        )
      }
      originalBounds = frozenRect(source.bounds)
      rollbackBounds = frozenRect(source.bounds)
      rollbackNeeded = true
    }

    const geometryBasis = source

    if (options.signal?.aborted) {
      await this.rollbackSafe(deps, windowId, rollbackBounds, rollbackState, rollbackMonitorId)
      return this.cancelled(windowId, target)
    }

    const recordBase = existingRecord ?? frozenRecord({
      windowId,
      originalBounds,
      originalState,
      originalMonitorId,
      sourceRegistryGeneration: source.generation,
      createdDisplayRevision: deps.windowsContext.getSnapshot().revision,
      createdAt: now(),
      lastTarget: target,
      lastAppliedBounds: originalBounds,
      lastAppliedMonitorId: originalMonitorId,
      updatedAt: now(),
    })

    let lastPlan: PlacementPlan | undefined
    let allowMonitorFallback = false

    for (let attempt = 0; attempt < this.config.maxDisplayReplans; attempt++) {
      if (options.signal?.aborted) {
        await this.rollbackSafe(deps, windowId, rollbackBounds, rollbackState, rollbackMonitorId)
        return this.cancelled(windowId, target, lastPlan)
      }

      const liveSource = deps.registry.getWindow(windowId)
      if (!liveSource || liveSource.generation !== source.generation) {
        return this.rejected(
          windowId,
          target,
          'stale-window-id',
          'WindowId no longer resolves to the same registry lifetime.',
        )
      }

      const snapshot = deps.windowsContext.getSnapshot()
      let plan: PlacementPlan
      try {
        const planned = await this.plan(
          deps,
          liveSource,
          geometryBasis,
          target,
          snapshot,
          allowMonitorFallback,
        )
        plan = planned.plan
        allowMonitorFallback = planned.monitorFallback
      } catch (error) {
        if (errorCode(error) === 'SHELL_LAYOUT_CHANGED') {
          allowMonitorFallback = true
          continue
        }
        const mapped = this.mapPlanFailure(windowId, target, error)
        if (rollbackNeeded) {
          await this.rollbackSafe(deps, windowId, rollbackBounds, rollbackState, rollbackMonitorId)
        }
        return mapped
      }
      lastPlan = plan

      if (!this.isPlanCurrent(deps, plan)) {
        allowMonitorFallback = true
        continue
      }

      if (options.signal?.aborted) {
        await this.rollbackSafe(deps, windowId, rollbackBounds, rollbackState, rollbackMonitorId)
        return this.cancelled(windowId, target, plan)
      }

      let controlResult: WindowControlResult
      try {
        controlResult = await deps.windowControl.setBounds(windowId, plan.effectiveRect)
        rollbackNeeded = true
        await deps.registry.refresh()
      } catch (error) {
        await this.rollbackSafe(deps, windowId, rollbackBounds, rollbackState, rollbackMonitorId)
        return this.rejected(
          windowId,
          target,
          mapOperationalFailure(error),
          errorMessage(error),
          plan,
        )
      }

      if (options.signal?.aborted) {
        await this.rollbackSafe(deps, windowId, rollbackBounds, rollbackState, rollbackMonitorId)
        return this.cancelled(windowId, target, plan)
      }

      if (!this.isPlanCurrent(deps, plan)) {
        allowMonitorFallback = true
        continue
      }

      const postSnapshot = deps.windowsContext.getSnapshot()
      const observed = controlResult.observation.bounds
        ?? deps.registry.getWindow(windowId)?.bounds
      if (!observed) {
        await this.rollbackSafe(deps, windowId, rollbackBounds, rollbackState, rollbackMonitorId)
        return this.rejected(
          windowId,
          target,
          'geometry-refused',
          'No post-placement geometry could be observed.',
          plan,
        )
      }

      const adjustments = [...plan.adjustments]
      let status: 'applied' | 'adjusted' = adjustments.length ? 'adjusted' : 'applied'
      if (!rectNear(observed, plan.effectiveRect)) {
        if (rectNear(observed, liveSource.bounds)) {
          await this.rollbackSafe(deps, windowId, rollbackBounds, rollbackState, rollbackMonitorId)
          return this.rejected(
            windowId,
            target,
            'geometry-refused',
            'The application did not accept the negotiated geometry.',
            plan,
          )
        }
        adjustments.push('window-adjusted-geometry')
        status = 'adjusted'
      }

      if (allowMonitorFallback && !adjustments.includes('monitor-fallback')) {
        adjustments.push('monitor-fallback')
        status = 'adjusted'
      }

      const afterWindow = deps.registry.getWindow(windowId)
      const updatedRecord = frozenRecord({
        ...recordBase,
        lastTarget: target,
        lastAppliedBounds: observed,
        lastAppliedMonitorId: afterWindow?.monitorId ?? plan.monitor.id,
        updatedAt: now(),
      })
      const eventType = existingRecord ? 'updated' : 'created'
      this.records.set(windowId, updatedRecord)
      this.emitRecord({ type: eventType, windowId, record: updatedRecord })

      return Object.freeze({
        windowId,
        target,
        status,
        monitorId: afterWindow?.monitorId ?? plan.monitor.id,
        displayRevision: postSnapshot.revision,
        requestedRect: frozenRect(plan.requestedRect),
        appliedRect: frozenRect(observed),
        constraints: plan.constraints,
        adjustments: Object.freeze([...new Set(adjustments)]),
      })
    }

    await this.rollbackSafe(deps, windowId, rollbackBounds, rollbackState, rollbackMonitorId)
    return this.rejected(
      windowId,
      target,
      'display-topology-unstable',
      'Display topology or Shell Layout work area changed repeatedly while placement was being negotiated.',
      lastPlan,
    )
  }

  restorePlacement(
    windowId: WindowId,
    options: PlacementOptions = {},
  ): Promise<PlacementResult> {
    if (this.activeOperations.has(windowId)) {
      return Promise.resolve(this.rejected(
        windowId,
        undefined,
        'operation-conflict',
        `A placement operation is already active for WindowId '${windowId}'.`,
      ))
    }
    return this.withOperation(windowId, () => this.restorePlacementInternal(windowId, options))
  }

  private async restorePlacementInternal(
    windowId: WindowId,
    options: PlacementOptions,
  ): Promise<PlacementResult> {
    const record = this.records.get(windowId)
    if (!record) {
      return Object.freeze({
        windowId,
        status: 'rejected',
        adjustments: Object.freeze([]),
        reason: 'no-placement-record',
      })
    }
    if (options.signal?.aborted) return this.cancelled(windowId)

    const deps = this.dependencies()
    if (!deps) {
      return this.rejected(
        windowId,
        undefined,
        'authority-unavailable',
        'Placement dependencies are unavailable.',
      )
    }
    let source = deps.registry.getWindow(windowId)
    if (!source || source.generation !== record.sourceRegistryGeneration) {
      this.invalidateRecord(windowId, 'source-window-lifetime-changed')
      return this.rejected(
        windowId,
        undefined,
        'stale-window-id',
        'WindowId no longer resolves to the recorded lifetime.',
      )
    }

    const rollbackBounds = frozenRect(source.bounds)
    const rollbackState = source.state
    const rollbackMonitorId = source.monitorId
    const snapshot = deps.windowsContext.getSnapshot()
    const displayBasis = displayPlacementBasis(snapshot)
    let monitor = record.originalMonitorId
      ? snapshot.monitors.find(candidate => candidate.id === record.originalMonitorId)
      : undefined
    const adjustments: PlacementAdjustment[] = []
    if (!monitor) {
      monitor = source.monitorId
        ? snapshot.monitors.find(candidate => candidate.id === source?.monitorId)
        : undefined
      monitor ??= snapshot.monitors.find(candidate => candidate.id === snapshot.primaryMonitorId)
      if (monitor) adjustments.push('monitor-fallback')
    }
    if (!monitor) {
      return this.rejected(
        windowId,
        undefined,
        'unknown-monitor',
        'No connected monitor can receive restored geometry.',
      )
    }

    const workArea = deps.shellLayout.getWorkArea(monitor.id)
    if (!workArea) {
      return this.rejected(
        windowId,
        undefined,
        'shell-work-area-unavailable',
        'Shell Layout has no work area for restore target.',
      )
    }

    let constraints: WindowPlacementConstraints
    try {
      constraints = await deps.windowControl.getPlacementConstraints(windowId)
    } catch (error) {
      return this.rejected(
        windowId,
        undefined,
        'placement-constraints-unavailable',
        errorMessage(error),
      )
    }

    if (!this.isRestoreBasisCurrent(deps, displayBasis, monitor.id, workArea)) {
      return this.rejected(
        windowId,
        undefined,
        'display-topology-unstable',
        'Display topology or Shell Layout work area changed while restore geometry was being negotiated.',
      )
    }

    const titleBarPx = Math.max(1, Math.round(TITLE_BAR_VISIBLE_DIP * monitor.scaleFactor))
    const accessibleOriginal = clampRectFullyOrAccessibly(
      record.originalBounds,
      workArea,
      titleBarPx,
      titleBarPx * 2,
    )
    if (!rectNear(accessibleOriginal, record.originalBounds, 0)) {
      adjustments.push('work-area-clamp')
    }
    const constrained = constrainPlacementRect(
      accessibleOriginal,
      source.bounds,
      workArea,
      constraints,
      { horizontal: 'center', vertical: 'center' },
      false,
      titleBarPx,
    )
    adjustments.push(...constrained.adjustments)

    if (options.signal?.aborted) return this.cancelled(windowId)

    let restoredBounds: PhysicalPixelRect | undefined
    try {
      if (source.state === 'maximized' || source.state === 'minimized') {
        const restored = await deps.windowControl.restore(windowId)
        if (!restored.completed) throw new Error('Window did not enter normal state before geometry restore.')
        await deps.registry.refresh()
        source = deps.registry.getWindow(windowId)
      }
      if (!source || source.state !== 'normal') {
        throw new Error('Window Registry did not confirm a normal state before geometry restore.')
      }

      if (options.signal?.aborted) {
        await this.rollbackSafe(deps, windowId, rollbackBounds, rollbackState, rollbackMonitorId)
        return this.cancelled(windowId)
      }
      if (!this.isRestoreBasisCurrent(deps, displayBasis, monitor.id, workArea)) {
        await this.rollbackSafe(deps, windowId, rollbackBounds, rollbackState, rollbackMonitorId)
        return this.rejected(
          windowId,
          undefined,
          'display-topology-unstable',
          'Display topology or Shell Layout work area changed before restore geometry could be applied.',
        )
      }

      const boundsResult = await deps.windowControl.setBounds(windowId, constrained.rect)
      await deps.registry.refresh()
      restoredBounds = boundsResult.observation.bounds ?? deps.registry.getWindow(windowId)?.bounds
      if (!restoredBounds) throw new Error('Restore produced no observable bounds.')

      if (!this.isRestoreBasisCurrent(deps, displayBasis, monitor.id, workArea)) {
        await this.rollbackSafe(deps, windowId, rollbackBounds, rollbackState, rollbackMonitorId)
        return this.rejected(
          windowId,
          undefined,
          'display-topology-unstable',
          'Display topology or Shell Layout work area changed while restore geometry was being applied.',
        )
      }

      if (!rectNear(restoredBounds, constrained.rect)) {
        if (rectNear(restoredBounds, source.bounds)) {
          throw new Error('Application refused the saved restore geometry.')
        }
        adjustments.push('window-adjusted-geometry')
      }

      if (options.signal?.aborted) {
        await this.rollbackSafe(deps, windowId, rollbackBounds, rollbackState, rollbackMonitorId)
        return this.cancelled(windowId)
      }

      if (record.originalState === 'maximized') {
        const maximized = await deps.windowControl.maximize(windowId)
        if (!maximized.completed) throw new Error('Original maximized state could not be restored.')
        await deps.registry.refresh()
      }
    } catch (error) {
      await this.rollbackSafe(deps, windowId, rollbackBounds, rollbackState, rollbackMonitorId)
      return this.rejected(windowId, undefined, 'restore-failed', errorMessage(error))
    }

    if (options.signal?.aborted) {
      await this.rollbackSafe(deps, windowId, rollbackBounds, rollbackState, rollbackMonitorId)
      return this.cancelled(windowId)
    }

    this.records.delete(windowId)
    this.emitRecord({ type: 'restored', windowId, record, reason: 'explicit-restore' })
    return Object.freeze({
      windowId,
      status: adjustments.length ? 'adjusted' : 'applied',
      monitorId: monitor.id,
      displayRevision: deps.windowsContext.getSnapshot().revision,
      requestedRect: frozenRect(record.originalBounds),
      appliedRect: restoredBounds ? frozenRect(restoredBounds) : frozenRect(constrained.rect),
      constraints,
      adjustments: Object.freeze([...new Set(adjustments)]),
    })
  }

  establishFreePlacement(windowId: WindowId): boolean {
    if (this.activeOperations.has(windowId)) return false
    const record = this.records.get(windowId)
    if (!record) return false
    this.records.delete(windowId)
    this.emitRecord({ type: 'released', windowId, record, reason: 'free-placement-established' })
    return true
  }

  getPlacementRecord(windowId: WindowId): PlacementRecord | undefined {
    return this.records.get(windowId)
  }

  listPlacementRecords(): readonly PlacementRecord[] {
    return Object.freeze([...this.records.values()])
  }

  async applyNamedLayout(
    layout: NamedPlacementLayout,
    options: PlacementOptions = {},
  ): Promise<NamedPlacementResult> {
    if (!layout.name.trim()) throw new TypeError('Named placement layout requires a non-empty name.')
    const seen = new Set<WindowId>()
    const results: PlacementResult[] = []

    for (const entry of layout.entries) {
      if (seen.has(entry.windowId)) {
        results.push(this.rejected(
          entry.windowId,
          entry.target,
          'duplicate-layout-target',
          'A named layout may target a WindowId only once.',
        ))
        continue
      }
      seen.add(entry.windowId)

      if (options.signal?.aborted) {
        results.push(this.cancelled(entry.windowId, entry.target))
        continue
      }

      try {
        results.push(await this.place(entry.windowId, entry.target, options))
      } catch (error) {
        results.push(this.rejected(
          entry.windowId,
          entry.target,
          'native-mutation-failed',
          errorMessage(error),
        ))
      }
    }

    return Object.freeze({
      name: layout.name,
      results: Object.freeze(results),
      applied: results.filter(result => result.status === 'applied').length,
      adjusted: results.filter(result => result.status === 'adjusted').length,
      rejected: results.filter(result => result.status === 'rejected').length,
      cancelled: results.filter(result => result.status === 'cancelled').length,
    })
  }

  subscribe(listener: (event: PlacementRecordEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private dependencies(): Dependencies | undefined {
    if (this.disposed) return undefined
    const windowControl = this.ctx.get('windowControl') as WindowControlSource | undefined
    const registry = this.ctx.get('windowRegistry') as WindowRegistrySource | undefined
    const windowsContext = this.ctx.get('windowsContext') as WindowsContextSource | undefined
    const shellLayout = this.ctx.get('shellLayout') as ShellLayoutSource | undefined
    if (!windowControl || !registry || !windowsContext || !shellLayout) return undefined
    return { windowControl, registry, windowsContext, shellLayout }
  }

  private validateSource(
    requestedWindowId: WindowId,
    source: WindowSnapshot | undefined,
    target?: PlacementTarget,
  ): PlacementResult | undefined {
    if (!source) {
      return this.rejected(requestedWindowId, target, 'stale-window-id', 'WindowId does not resolve.')
    }
    if (source.classification !== 'APPLICATION' || source.isShellWindow) {
      return this.rejected(
        source.id,
        target,
        'target-not-application',
        'Only application windows are eligible for manual placement.',
      )
    }
    if (!source.isVisible || source.state === 'hidden') {
      return this.rejected(source.id, target, 'window-hidden', 'Hidden windows are not placed implicitly.')
    }
    if (source.isMinimized || source.state === 'minimized') {
      return this.rejected(
        source.id,
        target,
        'window-minimized',
        'Minimized windows must be explicitly restored before placement.',
      )
    }
    return undefined
  }

  private async plan(
    deps: Dependencies,
    liveSource: WindowSnapshot,
    geometryBasis: WindowSnapshot,
    target: PlacementTarget,
    snapshot: WindowsContextSnapshot,
    allowMonitorFallback: boolean,
  ): Promise<{ readonly plan: PlacementPlan; readonly monitorFallback: boolean }> {
    let monitor = this.resolveTargetMonitor(geometryBasis, target, snapshot)
    let monitorFallback = false
    if (!monitor && allowMonitorFallback) {
      monitor = liveSource.monitorId
        ? snapshot.monitors.find(candidate => candidate.id === liveSource.monitorId)
        : undefined
      monitor ??= snapshot.monitors.find(candidate => candidate.id === snapshot.primaryMonitorId)
      monitorFallback = Boolean(monitor)
    }
    if (!monitor) {
      throw Object.assign(new Error('Target monitor is not connected.'), { code: 'UNKNOWN_MONITOR' })
    }

    const workArea = deps.shellLayout.getWorkArea(monitor.id)
    if (!workArea) {
      throw Object.assign(
        new Error('Shell Layout has no negotiated work area for the target monitor.'),
        { code: 'SHELL_WORK_AREA_UNAVAILABLE' },
      )
    }

    let constraints: WindowPlacementConstraints
    try {
      constraints = await deps.windowControl.getPlacementConstraints(liveSource.id)
    } catch (error) {
      throw Object.assign(
        new Error(errorMessage(error)),
        { code: 'PLACEMENT_CONSTRAINTS_UNAVAILABLE' },
      )
    }

    const currentWorkArea = deps.shellLayout.getWorkArea(monitor.id)
    if (!currentWorkArea || !rectNear(currentWorkArea, workArea, 0)) {
      throw Object.assign(
        new Error('Shell Layout work area changed during placement negotiation.'),
        { code: 'SHELL_LAYOUT_CHANGED' },
      )
    }

    let requestedRect: PhysicalPixelRect
    let anchor: PlacementAnchor
    if (target.kind === 'move-to-monitor') {
      if ((target.placement ?? 'preserve-offset') === 'center') {
        const centered = computeZoneRect(workArea, 'center', geometryBasis.bounds)
        requestedRect = centered.rect
        anchor = centered.anchor
      } else {
        const sourceMonitor = geometryBasis.monitorId
          ? snapshot.monitors.find(candidate => candidate.id === geometryBasis.monitorId)
          : undefined
        const sourceWorkArea = sourceMonitor
          ? deps.shellLayout.getWorkArea(sourceMonitor.id)
          : undefined
        if (sourceWorkArea) {
          requestedRect = preserveOffsetRect(geometryBasis.bounds, sourceWorkArea, workArea)
          anchor = { horizontal: 'start', vertical: 'start' }
        } else {
          const centered = computeZoneRect(workArea, 'center', geometryBasis.bounds)
          requestedRect = centered.rect
          anchor = centered.anchor
          monitorFallback = true
        }
      }
    } else {
      const zone = computeZoneRect(workArea, target.kind, geometryBasis.bounds)
      requestedRect = zone.rect
      anchor = zone.anchor
    }

    const titleBarPx = Math.max(1, Math.round(TITLE_BAR_VISIBLE_DIP * monitor.scaleFactor))
    const constrained = constrainPlacementRect(
      requestedRect,
      geometryBasis.bounds,
      workArea,
      constraints,
      anchor,
      isResizePlacement(target),
      titleBarPx,
    )
    if (constrained.rejectedNonresizable) {
      throw Object.assign(new Error('Target window does not expose a sizing frame.'), {
        code: 'NONRESIZABLE_WINDOW',
      })
    }

    return {
      plan: {
        monitor,
        displayRevision: snapshot.revision,
        displayBasis: displayPlacementBasis(snapshot),
        workArea: frozenRect(workArea),
        requestedRect: frozenRect(requestedRect),
        effectiveRect: frozenRect(constrained.rect),
        constraints,
        adjustments: constrained.adjustments,
      },
      monitorFallback,
    }
  }

  private resolveTargetMonitor(
    source: WindowSnapshot,
    target: PlacementTarget,
    snapshot: WindowsContextSnapshot,
  ): WindowsMonitor | undefined {
    const explicit = target.monitorId
    if (explicit) return snapshot.monitors.find(monitor => monitor.id === explicit)
    if (source.monitorId) {
      const current = snapshot.monitors.find(monitor => monitor.id === source.monitorId)
      if (current) return current
    }
    return snapshot.monitors.find(monitor => monitor.id === snapshot.primaryMonitorId)
  }

  private isPlanCurrent(deps: Dependencies, plan: PlacementPlan): boolean {
    if (displayPlacementBasis(deps.windowsContext.getSnapshot()) !== plan.displayBasis) return false
    const currentWorkArea = deps.shellLayout.getWorkArea(plan.monitor.id)
    return currentWorkArea !== undefined && rectNear(currentWorkArea, plan.workArea, 0)
  }

  private isRestoreBasisCurrent(
    deps: Dependencies,
    displayBasis: string,
    monitorId: string,
    workArea: PhysicalPixelRect,
  ): boolean {
    if (displayPlacementBasis(deps.windowsContext.getSnapshot()) !== displayBasis) return false
    const currentWorkArea = deps.shellLayout.getWorkArea(monitorId)
    return currentWorkArea !== undefined && rectNear(currentWorkArea, workArea, 0)
  }

  private async restoreToNormal(
    deps: Dependencies,
    windowId: WindowId,
  ): Promise<{ readonly ok: boolean; readonly detail?: string }> {
    try {
      const result = await deps.windowControl.restore(windowId)
      await deps.registry.refresh()
      return result.completed
        ? { ok: true }
        : { ok: false, detail: 'Window did not complete the restore transition.' }
    } catch (error) {
      return { ok: false, detail: errorMessage(error) }
    }
  }

  private async rollbackSafe(
    deps: Dependencies,
    windowId: WindowId,
    bounds: PhysicalPixelRect,
    state: WindowSnapshot['state'],
    preferredMonitorId: WindowSnapshot['monitorId'],
  ): Promise<void> {
    try {
      let current = deps.registry.getWindow(windowId)
      if (!current) return
      if (current.state === 'maximized' || current.state === 'minimized') {
        await deps.windowControl.restore(windowId)
        await deps.registry.refresh()
        current = deps.registry.getWindow(windowId)
      }
      if (!current || current.state !== 'normal') return

      const snapshot = deps.windowsContext.getSnapshot()
      let monitor = preferredMonitorId
        ? snapshot.monitors.find(candidate => candidate.id === preferredMonitorId)
        : undefined
      monitor ??= current.monitorId
        ? snapshot.monitors.find(candidate => candidate.id === current?.monitorId)
        : undefined
      monitor ??= snapshot.monitors.find(candidate => candidate.id === snapshot.primaryMonitorId)

      let safeBounds = bounds
      if (monitor) {
        const workArea = deps.shellLayout.getWorkArea(monitor.id)
        if (workArea) {
          const titleBarPx = Math.max(1, Math.round(TITLE_BAR_VISIBLE_DIP * monitor.scaleFactor))
          safeBounds = clampRectFullyOrAccessibly(bounds, workArea, titleBarPx, titleBarPx * 2)
          try {
            const constraints = await deps.windowControl.getPlacementConstraints(windowId)
            safeBounds = constrainPlacementRect(
              safeBounds,
              current.bounds,
              workArea,
              constraints,
              { horizontal: 'center', vertical: 'center' },
              false,
              titleBarPx,
            ).rect
          } catch (_constraintError) {
            // Accessibility clamping remains safe when app-specific constraints cannot be queried.
          }
        }
      }

      await deps.windowControl.setBounds(windowId, safeBounds)
      await deps.registry.refresh()
      if (state === 'maximized') {
        await deps.windowControl.maximize(windowId)
        await deps.registry.refresh()
      } else if (state === 'minimized') {
        await deps.windowControl.minimize(windowId)
        await deps.registry.refresh()
      }
    } catch (_rollbackError) {
      // Rollback is best effort; never mask the primary placement outcome.
    }
  }

  private async withOperation<T>(windowId: WindowId, action: () => Promise<T>): Promise<T> {
    if (this.activeOperations.has(windowId)) {
      throw new Error(`A placement operation is already active for WindowId '${windowId}'.`)
    }
    this.activeOperations.add(windowId)
    try {
      return await action()
    } finally {
      this.activeOperations.delete(windowId)
    }
  }

  private handleExternalWindowChange(change: WindowChange): void {
    const record = this.records.get(change.id)
    if (!record || this.activeOperations.has(change.id)) return
    if (!change.changes.some(kind => kind === 'bounds' || kind === 'state' || kind === 'monitor')) {
      return
    }

    const isPlacementEcho = change.window.state === 'normal'
      && rectNear(change.window.bounds, record.lastAppliedBounds)
      && (
        record.lastAppliedMonitorId === undefined
        || change.window.monitorId === record.lastAppliedMonitorId
      )
    if (isPlacementEcho) return

    this.invalidateRecord(change.id, 'external-window-geometry-change')
  }

  private invalidateRecord(windowId: WindowId, reason: string): void {
    const record = this.records.get(windowId)
    if (!record) return
    this.records.delete(windowId)
    this.emitRecord({ type: 'invalidated', windowId, record, reason })
  }

  private emitRecord(event: PlacementRecordEvent): void {
    const frozen = Object.freeze({ ...event })
    for (const listener of [...this.listeners]) {
      try {
        listener(frozen)
      } catch (error) {
        this.ctx.emit(
          'window-placement/fault',
          error instanceof Error ? error : new Error(String(error)),
        )
      }
    }
    this.ctx.emit('window-placement/record-changed', frozen)
  }

  private mapPlanFailure(
    windowId: WindowId,
    target: PlacementTarget,
    error: unknown,
  ): PlacementResult {
    switch (errorCode(error)) {
      case 'UNKNOWN_MONITOR':
        return this.rejected(windowId, target, 'unknown-monitor', errorMessage(error))
      case 'SHELL_WORK_AREA_UNAVAILABLE':
        return this.rejected(windowId, target, 'shell-work-area-unavailable', errorMessage(error))
      case 'NONRESIZABLE_WINDOW':
        return this.rejected(windowId, target, 'nonresizable-window', errorMessage(error))
      case 'PLACEMENT_CONSTRAINTS_UNAVAILABLE':
        return this.rejected(windowId, target, 'placement-constraints-unavailable', errorMessage(error))
      default:
        return this.rejected(windowId, target, mapOperationalFailure(error), errorMessage(error))
    }
  }

  private rejected(
    windowId: WindowId,
    target: PlacementTarget | undefined,
    reason: PlacementFailureReason,
    detail?: string,
    plan?: PlacementPlan,
  ): PlacementResult {
    return Object.freeze({
      windowId,
      target,
      status: 'rejected',
      monitorId: plan?.monitor.id,
      displayRevision: plan?.displayRevision,
      requestedRect: plan?.requestedRect,
      appliedRect: undefined,
      constraints: plan?.constraints,
      adjustments: Object.freeze(plan ? [...plan.adjustments] : []),
      reason,
      detail,
    })
  }

  private cancelled(
    windowId: WindowId,
    target?: PlacementTarget,
    plan?: PlacementPlan,
  ): PlacementResult {
    return Object.freeze({
      windowId,
      target,
      status: 'cancelled',
      monitorId: plan?.monitor.id,
      displayRevision: plan?.displayRevision,
      requestedRect: plan?.requestedRect,
      constraints: plan?.constraints,
      adjustments: Object.freeze(plan ? [...plan.adjustments] : []),
    })
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    windowPlacement: WindowPlacementService
  }
  interface Events {
    /** @mode broadcast @param service Initialized Phase 17B placement policy authority. */
    'window-placement/ready'(service: WindowPlacementService): void
    /** @mode broadcast @param event Placement record lifecycle transition. */
    'window-placement/record-changed'(event: PlacementRecordEvent): void
    /** @mode broadcast @param error Placement policy fault isolated from consumers. */
    'window-placement/fault'(error: Error): void
  }
}
