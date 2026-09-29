import type {
  NativeBridgeClient,
  NativeSurfaceEvent,
  NativeSurfaceSnapshot,
} from '@deepseek-ai/dsh-native-core'
import type { PhysicalBounds, SurfaceCreateOptions, SurfaceZOrderPolicy } from '@deepseek-ai/dsh-surface'
import { vi } from 'vitest'

export interface MockSurfaceRuntime {
  readonly bridge: NativeBridgeClient
  readonly createOptions: SurfaceCreateOptions[]
  readonly show: ReturnType<typeof vi.fn>
  readonly hide: ReturnType<typeof vi.fn>
  readonly reload: ReturnType<typeof vi.fn>
  readonly destroy: ReturnType<typeof vi.fn>
  emit(event: NativeSurfaceEvent): void
}

export function createMockSurfaceRuntime(): MockSurfaceRuntime {
  const snapshots = new Map<string, NativeSurfaceSnapshot>()
  const createOptions: SurfaceCreateOptions[] = []
  let listener: ((event: NativeSurfaceEvent) => void) | undefined
  let nextHwnd = 41_000
  const snapshot = (id: string, overrides: Partial<NativeSurfaceSnapshot> = {}): NativeSurfaceSnapshot => {
    const previous = snapshots.get(id)
    return {
      id,
      hwnd: previous?.hwnd ?? nextHwnd++,
      bounds: previous?.bounds ?? { x: 0, y: 0, width: 800, height: 600 },
      state: previous?.state ?? 'READY',
      visible: previous?.visible ?? false,
      dpi: previous?.dpi ?? 96,
      scaleFactor: previous?.scaleFactor ?? 1,
      focusPolicy: previous?.focusPolicy ?? 'noActivate',
      zOrderPolicy: previous?.zOrderPolicy ?? 'bottom',
      monitorId: previous?.monitorId,
      ...overrides,
    }
  }
  const update = (id: string, overrides: Partial<NativeSurfaceSnapshot>): NativeSurfaceSnapshot => {
    const next = snapshot(id, overrides)
    snapshots.set(id, next)
    return next
  }
  const show = vi.fn(async (id: string) => update(id, { state: 'VISIBLE', visible: true }))
  const hide = vi.fn(async (id: string) => update(id, { state: 'HIDDEN', visible: false }))
  const reload = vi.fn(async (id: string) => update(id, { state: 'READY', visible: false }))
  const destroy = vi.fn(async (id: string) => {
    snapshots.delete(id)
    listener?.({ type: 'destroyed', id })
    return true
  })
  const bridge = {
    surface: {
      onEvent: vi.fn((callback: (event: NativeSurfaceEvent) => void) => {
        listener = callback
        return { dispose: vi.fn(async () => true) }
      }),
      create: vi.fn(async (options: SurfaceCreateOptions) => {
        createOptions.push(options)
        return update(options.id, {
          bounds: options.bounds,
          state: 'READY',
          visible: false,
          dpi: 96,
          scaleFactor: 1,
          focusPolicy: options.focusPolicy ?? 'normal',
          zOrderPolicy: options.zOrderPolicy ?? 'normal',
          monitorId: options.monitorId,
        })
      }),
      show,
      hide,
      setBounds: vi.fn(async (id: string, bounds: PhysicalBounds) => update(id, { bounds })),
      setZOrder: vi.fn(async (id: string, zOrderPolicy: SurfaceZOrderPolicy) => update(id, { zOrderPolicy })),
      navigate: vi.fn(async (id: string) => update(id, {})),
      reload,
      markReady: vi.fn(async (id: string) => update(id, { state: 'READY' })),
      destroy,
      runtimeStatus: vi.fn(async () => ({ available: true, version: 'test' })),
    },
  } as unknown as NativeBridgeClient
  return {
    bridge,
    createOptions,
    show,
    hide,
    reload,
    destroy,
    emit(event): void {
      if (event.type === 'created') snapshots.set(event.snapshot.id, event.snapshot)
      listener?.(event)
    },
  }
}
