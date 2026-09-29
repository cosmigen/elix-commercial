/**
 * Test utilities and mock fixtures for Overlay Core tests.
 */

import { Context } from '@deepseek-ai/cordis'
import type {
  NativeBridgeClient,
  NativeSurfaceEvent,
  NativeSurfaceSnapshot,
} from '@deepseek-ai/dsh-native-core'
import {
  SurfaceService,
  type PhysicalBounds,
  type SurfaceCreateOptions,
  type SurfaceZOrderPolicy,
} from '@deepseek-ai/dsh-surface'
import type { MonitorId, WindowsContextService, WindowsMonitor } from '@deepseek-ai/dsh-windows-context'
import { vi, type Mock } from 'vitest'
import { OverlayService } from '../src/index.ts'
import type { OverlayDefinition } from '../src/types.ts'

export const TEST_PRIMARY_MONITOR: WindowsMonitor = {
  id: 'mon-primary' as MonitorId,
  deviceName: 'DISPLAY1',
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
  dpiX: 96,
  dpiY: 96,
  scaleFactor: 1.0,
  isPrimary: true,
}

export const TEST_SECONDARY_MONITOR: WindowsMonitor = {
  id: 'mon-secondary' as MonitorId,
  deviceName: 'DISPLAY2',
  bounds: { x: 1920, y: 0, width: 1920, height: 1080 },
  workArea: { x: 1920, y: 0, width: 1920, height: 1040 },
  dpiX: 144,
  dpiY: 144,
  scaleFactor: 1.5,
  isPrimary: false,
}

let nextHwnd = 10000

export function createMockBridge(): {
  bridge: NativeBridgeClient
  emitSurfaceEvent: (event: NativeSurfaceEvent) => void
  mockCreateSurface: Mock<(opts: SurfaceCreateOptions) => Promise<NativeSurfaceSnapshot>>
} {
  let eventListener: ((event: NativeSurfaceEvent) => void) | undefined
  const activeSurfaces = new Map<string, NativeSurfaceSnapshot>()

  const emitSurfaceEvent = (event: NativeSurfaceEvent): void => {
    if (eventListener) {
      eventListener(event)
    }
  }

  const mockCreateSurface = vi.fn(async (opts: SurfaceCreateOptions) => {
    const hwnd = nextHwnd++
    const snapshot: NativeSurfaceSnapshot = {
      id: opts.id,
      hwnd,
      bounds: opts.bounds,
      state: 'READY',
      visible: false,
      dpi: 96,
      scaleFactor: 1.0,
      focusPolicy: opts.focusPolicy ?? 'normal',
      zOrderPolicy: opts.zOrderPolicy ?? 'topmost',
      monitorId: opts.monitorId,
    }
    activeSurfaces.set(opts.id, snapshot)
    return snapshot
  })

  const bridge = {
    surface: {
      onEvent: vi.fn((listener: (event: NativeSurfaceEvent) => void) => {
        eventListener = listener
        return { dispose: vi.fn(async () => true) }
      }),
      create: mockCreateSurface,
      show: vi.fn(async (id: string) => {
        const snap = activeSurfaces.get(id)
        if (!snap) throw new Error(`Surface not found: ${id}`)
        const updated = { ...snap, visible: true, state: 'VISIBLE' as const }
        activeSurfaces.set(id, updated)
        return updated
      }),
      hide: vi.fn(async (id: string) => {
        const snap = activeSurfaces.get(id)
        if (!snap) throw new Error(`Surface not found: ${id}`)
        const updated = { ...snap, visible: false, state: 'HIDDEN' as const }
        activeSurfaces.set(id, updated)
        return updated
      }),
      setBounds: vi.fn(async (id: string, bounds: PhysicalBounds) => {
        const snap = activeSurfaces.get(id)
        if (!snap) throw new Error(`Surface not found: ${id}`)
        const updated = { ...snap, bounds }
        activeSurfaces.set(id, updated)
        return updated
      }),
      setZOrder: vi.fn(async (id: string, zOrderPolicy: SurfaceZOrderPolicy) => {
        const snap = activeSurfaces.get(id)
        if (!snap) throw new Error(`Surface not found: ${id}`)
        const updated = { ...snap, zOrderPolicy }
        activeSurfaces.set(id, updated)
        return updated
      }),
      navigate: vi.fn(async (id: string) => {
        const snap = activeSurfaces.get(id)
        if (!snap) throw new Error(`Surface not found: ${id}`)
        return snap
      }),
      reload: vi.fn(async (id: string) => {
        const snap = activeSurfaces.get(id)
        if (!snap) throw new Error(`Surface not found: ${id}`)
        return snap
      }),
      markReady: vi.fn(async (id: string) => {
        const snap = activeSurfaces.get(id)
        if (!snap) throw new Error(`Surface not found: ${id}`)
        return snap
      }),
      destroy: vi.fn(async (id: string) => {
        activeSurfaces.delete(id)
        emitSurfaceEvent({ type: 'destroyed', id })
        return true
      }),
      runtimeStatus: vi.fn(async () => ({ available: true, version: '152.0.4191.66' })),
    },
  } as unknown as NativeBridgeClient

  return { bridge, emitSurfaceEvent, mockCreateSurface }
}

export async function createTestEnvironment(monitors: WindowsMonitor[] = [TEST_PRIMARY_MONITOR]): Promise<{
  ctx: Context
  bridge: NativeBridgeClient
  emitSurfaceEvent: (event: NativeSurfaceEvent) => void
  setMonitors: (monitors: WindowsMonitor[]) => void
  mockCreateSurface: Mock<(opts: SurfaceCreateOptions) => Promise<NativeSurfaceSnapshot>>
}> {
  const { bridge, emitSurfaceEvent, mockCreateSurface } = createMockBridge()
  const ctx = new Context()

  let currentMonitors = [...monitors]

  // Mock windowsContext service
  const mockWindowsContext = {
    getMonitors: () => currentMonitors,
    getMonitor: (id: string) => currentMonitors.find(m => m.id === id),
    getPrimaryMonitor: () => currentMonitors.find(m => m.isPrimary) ?? currentMonitors[0],
    getForegroundContext: () => null,
    getSnapshot: () => ({ foreground: undefined, monitors: currentMonitors }),
  } as unknown as WindowsContextService

  ctx.provide('windowsContext')
  ctx.windowsContext = mockWindowsContext

  await ctx.plugin(SurfaceService, { enabled: true, bridge })
  await ctx.plugin(OverlayService, { enabled: true })
  await new Promise(resolve => setTimeout(resolve, 25))

  const setMonitors = (newMonitors: WindowsMonitor[]): void => {
    currentMonitors = [...newMonitors]
  }

  return { ctx, bridge, emitSurfaceEvent, setMonitors, mockCreateSurface }
}

export const SAMPLE_MENU_DEF: OverlayDefinition = {
  id: 'desktop-context-menu',
  ownerId: 'home',
  size: { width: 220, height: 300 },
  defaultPlacement: 'auto',
  focusPolicy: 'activate',
  renderer: {
    type: 'html',
    target: '<div class="menu">Desktop Menu</div>',
  },
  dismiss: {
    outsideClick: true,
    escape: true,
  },
}

export const SAMPLE_PREVIEW_DEF: OverlayDefinition = {
  id: 'dock-preview',
  ownerId: 'dock',
  size: { width: 180, height: 120 },
  defaultPlacement: 'top',
  focusPolicy: 'no-activate',
  renderer: {
    type: 'html',
    target: '<div class="preview">Dock Preview</div>',
  },
  dismiss: {
    outsideClick: false,
    escape: true,
  },
}
