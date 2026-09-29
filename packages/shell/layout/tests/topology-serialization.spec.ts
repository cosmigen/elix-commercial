import { Context } from '@deepseek-ai/cordis'
import type { NativeAppBarSpec, NativeBridgeClient } from '@deepseek-ai/dsh-native-core'
import type { MonitorId, WindowsContextChange } from '@deepseek-ai/dsh-windows-context'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ShellLayoutService } from '../src/index.ts'

function recoveredChange(revision: number): WindowsContextChange {
  return {
    revision,
    reason: 'recovered',
    snapshot: {
      revision,
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
}

describe('Shell Layout - topology reconciliation serialization', () => {
  let ctx: Context | undefined

  afterEach(async () => {
    if (ctx) await ctx.fiber.dispose()
    ctx = undefined
  })

  it('serializes overlapping Windows Context recovery changes and returns lifecycle to ACTIVE', async () => {
    ctx = new Context()
    const pendingRegisters: Array<() => void> = []
    let registerCount = 0

    const bridge = {
      appBar: {
        register: vi.fn(async (spec: NativeAppBarSpec) => {
          registerCount += 1
          if (registerCount > 1) {
            await new Promise<void>(resolve => pendingRegisters.push(resolve))
          }
          return { ...spec.rect }
        }),
        unregister: vi.fn(async () => true),
        getRegistered: vi.fn(async () => []),
      },
    } as unknown as NativeBridgeClient

    await ctx.plugin(ShellLayoutService, {
      enabled: true,
      syncNativeWorkArea: true,
      bridge,
    })
    const layout = ctx.shellLayout

    layout.registerReservation({
      id: 'serialized-recovery-bar',
      monitorId: 'mon-1',
      ownerId: 'test',
      kind: 'edge',
      edge: 'top',
      rect: { x: 0, y: 0, width: 1920, height: 40 },
    })
    expect(bridge.appBar.register).toHaveBeenCalledTimes(1)

    ctx.emit('windows-context/change', recoveredChange(2))
    ctx.emit('windows-context/change', recoveredChange(3))

    await vi.waitFor(() => {
      expect(bridge.appBar.register).toHaveBeenCalledTimes(2)
    })
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(bridge.appBar.register).toHaveBeenCalledTimes(2)
    expect(layout.getLifecycleState()).toBe('RECONCILING')

    const first = pendingRegisters.shift()
    expect(first).toBeDefined()
    first?.()

    await vi.waitFor(() => {
      expect(bridge.appBar.register).toHaveBeenCalledTimes(3)
    })
    expect(layout.getLifecycleState()).toBe('RECONCILING')

    const second = pendingRegisters.shift()
    expect(second).toBeDefined()
    second?.()

    await vi.waitFor(() => {
      expect(layout.getLifecycleState()).toBe('ACTIVE')
    })
  })
})
