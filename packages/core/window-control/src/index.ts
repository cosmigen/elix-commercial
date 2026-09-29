/**
 * Authoritative ELIX Window Control Core service.
 *
 * Window Registry remains the read-only identity/state authority. Window Control accepts
 * only stable WindowIds, re-resolves the current snapshot before every command, and then
 * sends lifetime evidence to the native host for a second HWND/PID/TID/process-lifetime
 * validation immediately before mutation.
 *
 * @module @deepseek-ai/dsh-window-control
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { getSharedNativeBridge, type NativeBridgeClient } from '@deepseek-ai/dsh-native-core'
import type {
  WindowId,
  WindowRegistrySource,
  WindowSnapshot,
} from '@deepseek-ai/dsh-window-registry'
import type {
  MonitorId,
  PhysicalPixelRect,
  WindowsContextSource,
  WindowsMonitor,
} from '@deepseek-ai/dsh-windows-context'
import z from '@deepseek-ai/schemastery'
import type {
  MoveToMonitorOptions,
  NativeWindowControlTarget,
  WindowControlAction,
  WindowControlConfig,
  WindowControlObservation,
  WindowControlResult,
  WindowControlSource,
  WindowPlacementConstraints,
} from './types.ts'
import { WindowControlError } from './types.ts'

export * from './types.ts'

const MAX_WINDOW_DIMENSION = 100_000
const MAX_VIRTUAL_COORDINATE = 1_000_000

type NativeWindowControlAction = WindowControlAction | 'queryPlacementConstraints'

interface NativeWindowControlRequest {
  readonly action: NativeWindowControlAction
  readonly target: NativeWindowControlTarget
  readonly bounds?: PhysicalPixelRect | undefined
}

interface NativeWindowControlResult {
  readonly action: NativeWindowControlAction
  readonly hwnd: number
  readonly accepted: boolean
  readonly completed: boolean
  readonly observation: WindowControlObservation
  readonly placementConstraints?: WindowPlacementConstraints | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    windowControl: WindowControlService
  }
  interface Events {
    /** @mode broadcast @param service Initialized Window Control command service. */
    'window-control/ready'(service: WindowControlService): void
  }
}

/** Guarded command authority for external user-facing application windows. */
export class WindowControlService extends Service implements WindowControlSource {
  static Config = z.object({ enabled: z.boolean().default(true) })

  private readonly config: WindowControlConfig
  private bridgeInstance: NativeBridgeClient | null = null
  private readonly lifecycle = { isDisposed: false }

  constructor(ctx: Context, config?: Partial<WindowControlConfig>) {
    super(ctx, 'windowControl')
    this.config = {
      enabled: config?.enabled ?? true,
      bridge: config?.bridge,
    }
  }

  [Service.init](): void {
    if (!this.config.enabled) return
    this.bridgeInstance = this.config.bridge ?? getSharedNativeBridge()
    this.ctx.effect(() => () => {
      this.lifecycle.isDisposed = true
      this.bridgeInstance = null
    }, 'windowControl.lifecycle')
    this.ctx.emit('window-control/ready', this)
  }

  private get registry(): WindowRegistrySource {
    const service = this.ctx.get('windowRegistry') as WindowRegistrySource | undefined
    if (!service) {
      throw new WindowControlError(
        'WINDOW_REGISTRY_UNAVAILABLE',
        'Window Control requires ctx.windowRegistry as the live WindowId authority',
      )
    }
    return service
  }

  private get windowsContext(): WindowsContextSource {
    const service = this.ctx.get('windowsContext') as WindowsContextSource | undefined
    if (!service) {
      throw new WindowControlError(
        'WINDOWS_CONTEXT_UNAVAILABLE',
        'Window Control requires ctx.windowsContext for monitor placement',
      )
    }
    return service
  }

  private get bridge(): NativeBridgeClient {
    if (!this.config.enabled) {
      throw new WindowControlError(
        'WINDOW_CONTROL_DISABLED',
        'Window Control is disabled by configuration',
      )
    }
    if (this.lifecycle.isDisposed) {
      throw new WindowControlError('WINDOW_CONTROL_DISPOSED', 'Window Control service is disposed')
    }
    return this.bridgeInstance ?? this.config.bridge ?? getSharedNativeBridge()
  }

  private resolveControllable(windowId: WindowId): WindowSnapshot {
    const window = this.registry.getWindow(windowId)
    if (!window) {
      throw new WindowControlError(
        'STALE_WINDOW_ID',
        `WindowId '${windowId}' is no longer present in Window Registry`,
      )
    }
    if (window.classification !== 'APPLICATION') {
      throw new WindowControlError(
        'TARGET_NOT_APPLICATION',
        `WindowId '${windowId}' is classified as ${window.classification}; Window Control mutates APPLICATION windows only`,
      )
    }
    return window
  }

  private buildNativeTarget(window: WindowSnapshot): NativeWindowControlTarget {
    return {
      hwnd: window.hwnd,
      processId: window.processId,
      threadId: window.threadId,
      processCreationTime: window.processCreationTime,
      className: window.className,
    }
  }

  private async execute(
    windowId: WindowId,
    action: WindowControlAction,
    bounds?: PhysicalPixelRect,
  ): Promise<WindowControlResult> {
    const window = this.resolveControllable(windowId)

    if (action !== 'close' && window.state === 'hidden') {
      throw new WindowControlError(
        'WINDOW_NOT_VISIBLE',
        `Cannot ${action} hidden WindowId '${windowId}'`,
      )
    }
    if (action === 'setBounds') {
      if (window.state !== 'normal' || !window.isVisible) {
        throw new WindowControlError(
          'WINDOW_NOT_NORMAL',
          `setBounds requires a visible restored window; current state is '${window.state}'`,
        )
      }
      if (!bounds) {
        throw new WindowControlError('INVALID_BOUNDS', 'setBounds requires physical-pixel bounds')
      }
      validateBounds(bounds)
    }

    const request: NativeWindowControlRequest = {
      action,
      target: this.buildNativeTarget(window),
      ...(bounds ? { bounds } : {}),
    }
    const native = await this.bridge.sendRequest<NativeWindowControlResult>(
      'windowControl/execute',
      request,
    )

    return Object.freeze({
      windowId,
      action,
      hwnd: native.hwnd,
      accepted: native.accepted,
      completed: native.completed,
      observation: freezeObservation(native.observation),
    })
  }

  activate(windowId: WindowId): Promise<WindowControlResult> {
    return this.execute(windowId, 'activate')
  }

  minimize(windowId: WindowId): Promise<WindowControlResult> {
    return this.execute(windowId, 'minimize')
  }

  maximize(windowId: WindowId): Promise<WindowControlResult> {
    return this.execute(windowId, 'maximize')
  }

  restore(windowId: WindowId): Promise<WindowControlResult> {
    return this.execute(windowId, 'restore')
  }

  close(windowId: WindowId): Promise<WindowControlResult> {
    return this.execute(windowId, 'close')
  }

  setBounds(windowId: WindowId, bounds: PhysicalPixelRect): Promise<WindowControlResult> {
    return this.execute(windowId, 'setBounds', bounds)
  }

  move(windowId: WindowId, x: number, y: number): Promise<WindowControlResult> {
    const window = this.resolveControllable(windowId)
    return this.setBounds(windowId, {
      x,
      y,
      width: window.bounds.width,
      height: window.bounds.height,
    })
  }

  resize(windowId: WindowId, width: number, height: number): Promise<WindowControlResult> {
    const window = this.resolveControllable(windowId)
    return this.setBounds(windowId, {
      x: window.bounds.x,
      y: window.bounds.y,
      width,
      height,
    })
  }

  async moveToMonitor(
    windowId: WindowId,
    monitorId: MonitorId,
    options: MoveToMonitorOptions = {},
  ): Promise<WindowControlResult> {
    const window = this.resolveControllable(windowId)
    if (window.state !== 'normal' || !window.isVisible) {
      throw new WindowControlError(
        'WINDOW_NOT_NORMAL',
        `moveToMonitor requires a visible restored window; current state is '${window.state}'`,
      )
    }

    const targetMonitor = this.windowsContext.getMonitor(monitorId)
    if (!targetMonitor) {
      throw new WindowControlError(
        'UNKNOWN_MONITOR',
        `MonitorId '${monitorId}' is not present in Windows Context`,
      )
    }

    const placement = options.placement ?? 'preserve-offset'
    const sourceMonitor = window.monitorId
      ? this.windowsContext.getMonitor(window.monitorId)
      : undefined
    const targetBounds = placement === 'center'
      ? centerOnMonitor(window.bounds, targetMonitor)
      : preserveMonitorOffset(window.bounds, sourceMonitor, targetMonitor)

    return this.setBounds(windowId, targetBounds)
  }

  async getPlacementConstraints(windowId: WindowId): Promise<WindowPlacementConstraints> {
    const window = this.resolveControllable(windowId)
    const request: NativeWindowControlRequest = {
      action: 'queryPlacementConstraints',
      target: this.buildNativeTarget(window),
    }
    const native = await this.bridge.sendRequest<NativeWindowControlResult>(
      'windowControl/execute',
      request,
    )

    // The native host fences identity immediately before entering the foreign window procedure.
    // Fence the response again against Registry before accepting app-provided constraint data: a
    // destroyed/recycled HWND must never let stale WM_GETMINMAXINFO results influence placement.
    const current = this.registry.getWindow(windowId)
    if (!current || !sameWindowLifetime(window, current)) {
      throw new WindowControlError(
        'STALE_WINDOW_ID',
        `WindowId '${windowId}' changed lifetime while placement constraints were being queried`,
        true,
      )
    }

    const constraints = native.placementConstraints
    if (!constraints) {
      throw new WindowControlError(
        'PLACEMENT_CONSTRAINTS_UNAVAILABLE',
        `Native Window Control did not return placement constraints for WindowId '${windowId}'`,
        true,
      )
    }
    if (
      constraints.visibleBounds.width <= 0
      || constraints.visibleBounds.height <= 0
      || invalidOptionalTrack(constraints.minTrackWidth)
      || invalidOptionalTrack(constraints.minTrackHeight)
      || invalidOptionalTrack(constraints.maxTrackWidth)
      || invalidOptionalTrack(constraints.maxTrackHeight)
    ) {
      throw new WindowControlError(
        'PLACEMENT_CONSTRAINTS_INVALID',
        `Native Window Control returned invalid placement constraints for WindowId '${windowId}'`,
      )
    }

    return Object.freeze({
      ...constraints,
      visibleBounds: Object.freeze({ ...constraints.visibleBounds }),
    })
  }
}

function sameWindowLifetime(before: WindowSnapshot, after: WindowSnapshot): boolean {
  return before.id === after.id
    && before.hwnd === after.hwnd
    && before.processId === after.processId
    && before.threadId === after.threadId
    && before.processCreationTime === after.processCreationTime
    && before.generation === after.generation
}

function invalidOptionalTrack(value: number | undefined): boolean {
  return value !== undefined && (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0)
}

function freezeObservation(observation: WindowControlObservation): WindowControlObservation {
  return Object.freeze({
    ...observation,
    ...(observation.bounds
      ? { bounds: Object.freeze({ ...observation.bounds }) }
      : {}),
  })
}

function validateBounds(bounds: PhysicalPixelRect): void {
  const values = [bounds.x, bounds.y, bounds.width, bounds.height]
  if (!values.every(Number.isFinite) || !values.every(Number.isInteger)) {
    throw new WindowControlError(
      'INVALID_BOUNDS',
      'Window geometry must use finite integer physical-pixel values',
    )
  }
  if (bounds.width <= 0 || bounds.height <= 0) {
    throw new WindowControlError('INVALID_BOUNDS', 'Window width and height must be positive')
  }
  if (bounds.width > MAX_WINDOW_DIMENSION || bounds.height > MAX_WINDOW_DIMENSION) {
    throw new WindowControlError(
      'INVALID_BOUNDS',
      `Window width and height must not exceed ${MAX_WINDOW_DIMENSION} physical pixels`,
    )
  }
  if (Math.abs(bounds.x) > MAX_VIRTUAL_COORDINATE || Math.abs(bounds.y) > MAX_VIRTUAL_COORDINATE) {
    throw new WindowControlError(
      'INVALID_BOUNDS',
      `Window coordinates must remain within +/-${MAX_VIRTUAL_COORDINATE} physical pixels`,
    )
  }
}

function centerOnMonitor(
  window: PhysicalPixelRect,
  monitor: WindowsMonitor,
): PhysicalPixelRect {
  return clampToWorkArea({
    x: monitor.workArea.x + Math.round((monitor.workArea.width - window.width) / 2),
    y: monitor.workArea.y + Math.round((monitor.workArea.height - window.height) / 2),
    width: window.width,
    height: window.height,
  }, monitor)
}

function preserveMonitorOffset(
  window: PhysicalPixelRect,
  source: WindowsMonitor | undefined,
  target: WindowsMonitor,
): PhysicalPixelRect {
  if (!source) return centerOnMonitor(window, target)
  return clampToWorkArea({
    x: target.workArea.x + (window.x - source.workArea.x),
    y: target.workArea.y + (window.y - source.workArea.y),
    width: window.width,
    height: window.height,
  }, target)
}

function clampToWorkArea(rect: PhysicalPixelRect, monitor: WindowsMonitor): PhysicalPixelRect {
  const area = monitor.workArea
  const x = rect.width >= area.width
    ? area.x
    : Math.min(Math.max(rect.x, area.x), area.x + area.width - rect.width)
  const y = rect.height >= area.height
    ? area.y
    : Math.min(Math.max(rect.y, area.y), area.y + area.height - rect.height)
  return { ...rect, x, y }
}

export default WindowControlService
