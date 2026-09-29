import { describe, expect, it, vi } from 'vitest'
import type {
  NativeForegroundWindowContext,
  NativeWindowsContextChange,
  NativeWindowsContextSnapshot,
  NativeWindowsMonitor,
} from '@deepseek-ai/dsh-native-core'
import { WindowsContextState, normalizeNativeSnapshot } from '../src/index.ts'

const primary: NativeWindowsMonitor = {
  id: 'monitor:primary' as NativeWindowsMonitor['id'],
  deviceName: String.raw`\\.\DISPLAY1`,
  friendlyName: 'Primary',
  bounds: { x: 0, y: 0, width: 2560, height: 1440 },
  workArea: { x: 0, y: 0, width: 2560, height: 1400 },
  dpiX: 144,
  dpiY: 144,
  scaleFactor: 1.5,
  isPrimary: true,
}

const secondary: NativeWindowsMonitor = {
  id: 'monitor:secondary' as NativeWindowsMonitor['id'],
  deviceName: String.raw`\\.\DISPLAY2`,
  bounds: { x: -1920, y: -120, width: 1920, height: 1080 },
  workArea: { x: -1920, y: -120, width: 1920, height: 1040 },
  dpiX: 120,
  dpiY: 120,
  scaleFactor: 1.25,
  isPrimary: false,
}

function foreground(overrides: Partial<NativeForegroundWindowContext> = {}): NativeForegroundWindowContext {
  return {
    nativeId: 'hwnd:1234',
    processId: 100,
    threadId: 101,
    monitorId: primary.id,
    bounds: { x: 10, y: 10, width: 1200, height: 900 },
    isVisible: true,
    isMinimized: false,
    isCloaked: false,
    isToolWindow: false,
    isShellWindow: false,
    isFullscreen: false,
    ...overrides,
  }
}

function snapshot(
  revision: number,
  overrides: Partial<NativeWindowsContextSnapshot> = {},
): NativeWindowsContextSnapshot {
  return {
    revision,
    monitors: [primary, secondary],
    primaryMonitorId: primary.id,
    foreground: foreground(),
    capturedAt: revision,
    ...overrides,
  }
}

function event(
  reason: NativeWindowsContextChange['reason'],
  value: NativeWindowsContextSnapshot,
): NativeWindowsContextChange {
  return { reason, snapshot: value }
}

describe('WindowsContextState', () => {
  it('normalizes coherent topology while preserving negative physical coordinates and DPI', () => {
    const normalized = normalizeNativeSnapshot(snapshot(1), 7)
    expect(normalized.revision).toBe(7)
    expect(normalized.monitors[1]?.bounds).toEqual({ x: -1920, y: -120, width: 1920, height: 1080 })
    expect(normalized.monitors[0]?.scaleFactor).toBe(1.5)
    expect(normalized.primaryMonitorId).toBe(primary.id)
    expect(Object.isFrozen(normalized)).toBe(true)
    expect(Object.isFrozen(normalized.monitors)).toBe(true)
    expect(Object.isFrozen(normalized.monitors[0]?.bounds)).toBe(true)
  })

  it('publishes atomic complete revisions for primary and topology changes', () => {
    const state = new WindowsContextState()
    const changes: number[] = []
    state.subscribe(change => changes.push(change.revision))
    state.apply(event('initial', snapshot(1)))
    const changedMonitors = [
      { ...primary, isPrimary: false },
      { ...secondary, isPrimary: true },
    ]
    const change = state.apply(event('topology', snapshot(2, {
      monitors: changedMonitors,
      primaryMonitorId: secondary.id,
    })))
    expect(change?.revision).toBe(2)
    expect(change?.snapshot.primaryMonitorId).toBe(secondary.id)
    expect(change?.snapshot.monitors.filter(monitor => monitor.isPrimary)).toHaveLength(1)
    expect(changes).toEqual([1, 2])
  })

  it('tracks foreground geometry and fullscreen changes without a foreground switch', () => {
    const state = new WindowsContextState()
    state.apply(event('initial', snapshot(1)))
    const geometry = state.apply(event('foreground-geometry', snapshot(2, {
      foreground: foreground({ bounds: { x: 0, y: 0, width: 2560, height: 1440 } }),
    })))
    const fullscreen = state.apply(event('fullscreen', snapshot(3, {
      foreground: foreground({
        bounds: { x: 0, y: 0, width: 2560, height: 1440 },
        isFullscreen: true,
        fullscreenReason: 'monitor-covering-borderless',
      }),
    })))
    expect(geometry?.snapshot.foreground?.nativeId).toBe('hwnd:1234')
    expect(fullscreen?.snapshot.foreground?.isFullscreen).toBe(true)
    expect(fullscreen?.revision).toBe(3)
  })

  it.each([
    ['minimized', { isMinimized: true }],
    ['invisible', { isVisible: false }],
    ['cloaked', { isCloaked: true }],
    ['tool', { isToolWindow: true }],
    ['shell', { isShellWindow: true }],
  ])('rejects a native %s foreground instead of publishing fabricated state', (_name, overrides) => {
    const state = new WindowsContextState()
    state.apply(event('initial', snapshot(1)))
    expect(() => state.apply(event('foreground', snapshot(2, {
      foreground: foreground(overrides),
    })))).toThrow(/filtered or unknown/)
    expect(state.getSnapshot().revision).toBe(1)
  })

  it('retains the previous known-good topology after an invalid partial replacement', () => {
    const state = new WindowsContextState()
    state.apply(event('initial', snapshot(1)))
    expect(() => state.apply(event('topology', snapshot(2, {
      monitors: [{ ...primary, isPrimary: false }],
      primaryMonitorId: primary.id,
    })))).toThrow(/exactly one matching primary/)
    expect(state.getSnapshot().monitors).toHaveLength(2)
    expect(state.getSnapshot().revision).toBe(1)
  })

  it('isolates callback exceptions and continues later revisions', () => {
    const state = new WindowsContextState()
    const later = vi.fn()
    state.subscribe(() => { throw new Error('listener failure') })
    state.subscribe(later)
    state.apply(event('initial', snapshot(1)))
    state.apply(event('refresh', snapshot(2)))
    expect(later).toHaveBeenCalledTimes(2)
    expect(state.getSnapshot().revision).toBe(2)
  })

  it('accepts a null foreground context without throwing', () => {
    const state = new WindowsContextState()
    const change = state.apply(event('initial', snapshot(1, { foreground: null })))
    expect(change?.snapshot.foreground).toBeNull()
    expect(state.getSnapshot().foreground).toBeNull()
  })
})
