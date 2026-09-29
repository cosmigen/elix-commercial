import { Context } from '@deepseek-ai/cordis'
import type { NativeAppBarSpec, NativeBridgeClient } from '@deepseek-ai/dsh-native-core'
import type { MonitorId, WindowsContextChange } from '@deepseek-ai/dsh-windows-context'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ShellLayoutService } from '../src/index.ts'
import type { ShellReservationHandle } from '../src/types.ts'

describe('Shell Layout - Lifecycle and Robustness', () => {
  let ctx: Context
  let mockBridge: NativeBridgeClient

  beforeEach(() => {
    ctx = new Context()
    mockBridge = {
      appBar: {
        register: vi.fn(async (spec: NativeAppBarSpec) => ({
          x: spec.rect.x,
          y: spec.rect.y,
          width: spec.rect.width,
          height: spec.rect.height,
        })),
        unregister: vi.fn(async () => true),
        getRegistered: vi.fn(async () => []),
      },
    } as unknown as NativeBridgeClient
  })

  afterEach(async () => {
    await ctx.fiber.dispose()
  })

  it('handles rapid reservation churn without race conditions', async () => {
    await ctx.plugin(ShellLayoutService, { enabled: true })
    const layout = ctx.shellLayout

    const handles: ShellReservationHandle[] = []
    for (let i = 0; i < 50; i++) {
      handles.push(
        layout.registerReservation({
          id: `churn-${i}`,
          monitorId: 'mon-1',
          ownerId: 'test',
          kind: 'edge',
          edge: 'bottom',
          rect: { x: 0, y: 1000, width: 1920, height: 10 + i },
        }),
      )
    }

    expect(layout.getReservations()).toHaveLength(50)

    // Dispose half of them
    for (let i = 0; i < 25; i++) {
      expect(handles[i]?.dispose()).toBe(true)
    }
    expect(layout.getReservations()).toHaveLength(25)

    // Re-dispose should safely return false
    for (let i = 0; i < 25; i++) {
      expect(handles[i]?.dispose()).toBe(false)
    }
    expect(layout.getReservations()).toHaveLength(25)
  })

  it('tolerates native bridge errors gracefully without throwing to caller', async () => {
    const faultingBridge = {
      appBar: {
        register: vi.fn(async () => {
          throw new Error('Win32 SHAppBarMessage failure')
        }),
        unregister: vi.fn(async () => {
          throw new Error('Unregister error')
        }),
        getRegistered: vi.fn(async () => []),
      },
    } as unknown as NativeBridgeClient

    await ctx.plugin(ShellLayoutService, {
      enabled: true,
      syncNativeWorkArea: true,
      bridge: faultingBridge,
    })
    const layout = ctx.shellLayout

    // Should not throw even if native bridge throws
    const handle = layout.registerReservation({
      id: 'failing-bar',
      monitorId: 'mon-1',
      ownerId: 'test',
      kind: 'edge',
      edge: 'top',
      rect: { x: 0, y: 0, width: 1920, height: 40 },
    })

    expect(layout.getReservation('failing-bar')).toBeDefined()
    expect(handle.dispose()).toBe(true)
  })

  it('re-registers active AppBars upon native host crash recovery', async () => {
    await ctx.plugin(ShellLayoutService, {
      enabled: true,
      syncNativeWorkArea: true,
      bridge: mockBridge,
    })
    const layout = ctx.shellLayout

    layout.registerReservation({
      id: 'persistent-dock',
      monitorId: 'mon-1',
      ownerId: 'dock',
      kind: 'edge',
      edge: 'bottom',
      rect: { x: 0, y: 1000, width: 1920, height: 80 },
    })

    expect(mockBridge.appBar.register).toHaveBeenCalledTimes(1)

    // Simulate native crash recovery event
    const recoveryChange: WindowsContextChange = {
      revision: 2,
      reason: 'recovered',
      snapshot: {
        revision: 2,
        monitors: [{
          id: 'mon-1' as MonitorId,
          deviceName: String.raw`\\.\DISPLAY1`,
          bounds: { x: 0, y: 0, width: 1920, height: 1080 },
          workArea: { x: 0, y: 0, width: 1920, height: 1040 },
          dpiX: 96,
          dpiY: 96,
          scaleFactor: 1,
          isPrimary: true,
        }],
        primaryMonitorId: 'mon-1' as MonitorId,
        foreground: null,
        capturedAt: Date.now(),
      },
    }

    ctx.emit('windows-context/change', recoveryChange)

    // Allow async reconciliation to execute
    await new Promise(resolve => setTimeout(resolve, 50))

    // reconcileAll should have re-registered the active dock
    expect(mockBridge.appBar.register).toHaveBeenCalledTimes(2)
  })

  it('handles rapid update ordering with generation fencing so latest update wins', async () => {
    await ctx.plugin(ShellLayoutService, {
      enabled: true,
      syncNativeWorkArea: true,
      bridge: mockBridge,
    })
    const layout = ctx.shellLayout

    const handle = layout.registerReservation({
      id: 'racing-bar',
      monitorId: 'mon-1',
      ownerId: 'test',
      kind: 'edge',
      edge: 'top',
      rect: { x: 0, y: 0, width: 1920, height: 40 },
    })

    // Rapidly update height 4 times
    handle.update({ rect: { x: 0, y: 0, width: 1920, height: 48 } })
    handle.update({ rect: { x: 0, y: 0, width: 1920, height: 56 } })
    handle.update({ rect: { x: 0, y: 0, width: 1920, height: 64 } })

    // Final committed desired state
    const finalRes = handle.get()
    expect(finalRes?.rect.height).toBe(64)

    // Allow async native calls to settle
    await new Promise(resolve => setTimeout(resolve, 50))

    // Last call sent to register must be height 64
    const lastCall = vi.mocked(mockBridge.appBar.register).mock.lastCall
    expect(lastCall).toBeDefined()
    expect(lastCall?.[0].id).toBe('racing-bar')
    expect(lastCall?.[0].rect.height).toBe(64)

    handle.dispose()
  })

  it('synchronizes hide and show with native AppBar registration without leaking', async () => {
    await ctx.plugin(ShellLayoutService, {
      enabled: true,
      syncNativeWorkArea: true,
      bridge: mockBridge,
    })
    const layout = ctx.shellLayout

    const handle = layout.registerReservation({
      id: 'visibility-bar',
      monitorId: 'mon-1',
      ownerId: 'test',
      kind: 'edge',
      edge: 'top',
      rect: { x: 0, y: 0, width: 1920, height: 40 },
    })

    expect(mockBridge.appBar.register).toHaveBeenCalledTimes(1)

    // Hide: should unregister natively
    handle.update({ visible: false })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(mockBridge.appBar.unregister).toHaveBeenCalledWith('visibility-bar')

    // Show: should re-register natively
    handle.update({ visible: true })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(mockBridge.appBar.register).toHaveBeenCalledTimes(2)

    handle.dispose()
  })

  it('tolerates repeated recovery events without duplicate accumulation or monotonic growth', async () => {
    await ctx.plugin(ShellLayoutService, {
      enabled: true,
      syncNativeWorkArea: true,
      bridge: mockBridge,
    })
    const layout = ctx.shellLayout

    layout.registerReservation({
      id: 'resilient-bar',
      monitorId: 'mon-1',
      ownerId: 'test',
      kind: 'edge',
      edge: 'top',
      rect: { x: 0, y: 0, width: 1920, height: 40 },
    })

    const recoveryChange: WindowsContextChange = {
      revision: 1,
      reason: 'recovered',
      snapshot: {
        revision: 1,
        monitors: [{
          id: 'mon-1' as MonitorId,
          deviceName: String.raw`\\.\DISPLAY1`,
          bounds: { x: 0, y: 0, width: 1920, height: 1080 },
          workArea: { x: 0, y: 0, width: 1920, height: 1040 },
          dpiX: 96,
          dpiY: 96,
          scaleFactor: 1,
          isPrimary: true,
        }],
        primaryMonitorId: 'mon-1' as MonitorId,
        foreground: null,
        capturedAt: Date.now(),
      },
    }

    // Repeated crash/recovery cycles
    for (let cycle = 0; cycle < 3; cycle++) {
      ctx.emit('windows-context/change', recoveryChange)
      await new Promise(resolve => setTimeout(resolve, 30))
    }

    // 1 initial + 3 recoveries = 4 registrations total (1 per recovery, no duplicates or exponential growth)
    expect(mockBridge.appBar.register).toHaveBeenCalledTimes(4)
  })

  it('transitions to DISPOSED and prevents further mutations upon fiber disposal', async () => {
    await ctx.plugin(ShellLayoutService, { enabled: true })
    const layout = ctx.shellLayout

    expect(layout.getLifecycleState()).toBe('ACTIVE')

    await ctx.fiber.dispose()

    expect(layout.getLifecycleState()).toBe('DISPOSED')

    expect(() =>
      layout.registerReservation({
        id: 'post-disposed',
        monitorId: 'mon-1',
        ownerId: 'test',
        kind: 'edge',
        edge: 'top',
        rect: { x: 0, y: 0, width: 100, height: 10 },
      }),
    ).toThrow('Cannot register reservation on disposed ShellLayoutService.')

    expect(layout.removeReservation('anything')).toBe(false)
  })

  it('unregisters in-flight registration if disposed before register finishes', async () => {
    let resolveRegister: ((val: { x: number; y: number; width: number; height: number }) => void) | undefined
    const delayedBridge = {
      appBar: {
        register: vi.fn(
          () =>
            new Promise<{ x: number; y: number; width: number; height: number }>((resolve) => {
              resolveRegister = resolve
            }),
        ),
        unregister: vi.fn(async () => true),
        getRegistered: vi.fn(async () => []),
      },
    } as unknown as NativeBridgeClient

    await ctx.plugin(ShellLayoutService, {
      enabled: true,
      syncNativeWorkArea: true,
      bridge: delayedBridge,
    })
    const layout = ctx.shellLayout

    layout.registerReservation({
      id: 'in-flight-bar',
      monitorId: 'mon-1',
      ownerId: 'test',
      kind: 'edge',
      edge: 'top',
      rect: { x: 0, y: 0, width: 1920, height: 40 },
    })

    expect(delayedBridge.appBar.register).toHaveBeenCalledTimes(1)

    // Disposal reaches quiescence after the pending native call settles.
    const disposePromise = ctx.fiber.dispose()
    resolveRegister?.({ x: 0, y: 0, width: 1920, height: 40 })
    await disposePromise

    // Because it was disposed, it must immediately unregister to prevent leaking
    expect(delayedBridge.appBar.unregister).toHaveBeenCalledWith('in-flight-bar')
  })

  it('does not resurrect concurrently removed reservation during host recovery', async () => {
    let resolveFirstRegister: (() => void) | undefined
    let registerCount = 0
    const controlledBridge = {
      appBar: {
        register: vi.fn(async (spec: NativeAppBarSpec) => {
          registerCount++
          if (registerCount === 3) {
            // Delay the 3rd register call (during recovery)
            await new Promise<void>((resolve) => {
              resolveFirstRegister = resolve
            })
          }
          return {
            x: spec.rect.x,
            y: spec.rect.y,
            width: spec.rect.width,
            height: spec.rect.height,
          }
        }),
        unregister: vi.fn(async () => true),
        getRegistered: vi.fn(async () => []),
      },
    } as unknown as NativeBridgeClient

    await ctx.plugin(ShellLayoutService, {
      enabled: true,
      syncNativeWorkArea: true,
      bridge: controlledBridge,
    })
    const layout = ctx.shellLayout

    layout.registerReservation({
      id: 'bar-a',
      monitorId: 'mon-1',
      ownerId: 'test',
      kind: 'edge',
      edge: 'top',
      rect: { x: 0, y: 0, width: 1920, height: 40 },
    })
    layout.registerReservation({
      id: 'bar-b',
      monitorId: 'mon-1',
      ownerId: 'test',
      kind: 'edge',
      edge: 'bottom',
      rect: { x: 0, y: 1000, width: 1920, height: 40 },
    })

    expect(controlledBridge.appBar.register).toHaveBeenCalledTimes(2)

    // Simulate recovery event
    const recoveryChange: WindowsContextChange = {
      revision: 2,
      reason: 'recovered',
      snapshot: {
        revision: 2,
        monitors: [{
          id: 'mon-1' as MonitorId,
          deviceName: String.raw`\\.\DISPLAY1`,
          bounds: { x: 0, y: 0, width: 1920, height: 1080 },
          workArea: { x: 0, y: 0, width: 1920, height: 1040 },
          dpiX: 96,
          dpiY: 96,
          scaleFactor: 1,
          isPrimary: true,
        }],
        primaryMonitorId: 'mon-1' as MonitorId,
        foreground: null,
        capturedAt: Date.now(),
      },
    }

    ctx.emit('windows-context/change', recoveryChange)
    await new Promise(resolve => setTimeout(resolve, 20))

    // While recovery is processing bar-a, user removes bar-b
    layout.removeReservation('bar-b')

    // Release recovery processing
    resolveFirstRegister?.()
    await new Promise(resolve => setTimeout(resolve, 50))

    // bar-b must NOT have been re-registered
    const calls = vi.mocked(controlledBridge.appBar.register).mock.calls
    const registeredIdsDuringRecovery = calls.slice(2).map(c => c[0].id)
    expect(registeredIdsDuringRecovery).toContain('bar-a')
    expect(registeredIdsDuringRecovery).not.toContain('bar-b')
  })
})
