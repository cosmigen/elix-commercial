import { Context } from '@deepseek-ai/cordis'
import { createNativeBridge } from '@deepseek-ai/dsh-native-core'
import WindowsContextService from '@deepseek-ai/dsh-windows-context'
import { describe, expect, it } from 'vitest'
import ShellLayoutService from '../src/index.ts'

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 15_000,
  intervalMs = 50,
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
  throw new Error(`waitUntil condition timed out after ${timeoutMs}ms`)
}

describe('Shell Layout - Live Windows Acceptance', () => {
  it.skipIf(process.platform !== 'win32')(
    'coordinates live Windows monitors, native AppBar sync, hide/show, recovery, and complete cleanup',
    async () => {
      const bridge = createNativeBridge()
      const context = new Context()
      const testResId = 'live-test-shell-layout-bar'

      try {
        await bridge.connect()

        await context.plugin(WindowsContextService, { enabled: true, bridge })
        await context.plugin(ShellLayoutService, {
          enabled: true,
          syncNativeWorkArea: true,
          bridge,
        })

        // Step 1: Capture baseline work area
        const monitors = context.windowsContext.getMonitors()
        expect(monitors.length).toBeGreaterThan(0)
        const primary = context.windowsContext.getPrimaryMonitor()
        expect(primary).toBeDefined()

        const baselineWorkArea = context.shellLayout.getWorkArea(primary.id)
        expect(baselineWorkArea).toBeDefined()
        expect(baselineWorkArea).toEqual(primary.workArea)

        // Step 2: Register AppBar reservation
        const handle = context.shellLayout.registerReservation({
          id: testResId,
          monitorId: primary.id,
          ownerId: 'windows-live-test',
          kind: 'edge',
          edge: 'top',
          rect: {
            x: primary.bounds.x,
            y: primary.bounds.y,
            width: primary.bounds.width,
            height: 40,
          },
          affectsWorkArea: true,
          affectsHomeLayout: true,
        })

        // Step 3: Verify native registration exists
        await waitUntil(async () => {
          const list = await bridge.appBar.getRegistered()
          return list.some(item => item.id === testResId)
        }, 5000)

        const registeredStep3 = await bridge.appBar.getRegistered()
        const foundStep3 = registeredStep3.find(item => item.id === testResId)
        expect(foundStep3).toBeDefined()
        expect(foundStep3?.edge).toBe('top')

        // Step 4: Verify effective rectangle reconciled back into Shell Layout
        await waitUntil(() => {
          const res = handle.get()
          return res?.effectiveRect !== undefined
        }, 5000)

        const resStep4 = handle.get()
        expect(resStep4?.effectiveRect).toBeDefined()
        expect(resStep4?.effectiveRect?.height).toBe(40)
        expect(foundStep3?.rect.height).toBe(40)

        const activeWorkAreaStep4 = context.shellLayout.getWorkArea(primary.id)
        expect(activeWorkAreaStep4?.y).toBe(baselineWorkArea!.y + 40)
        expect(activeWorkAreaStep4?.height).toBe(baselineWorkArea!.height - 40)

        // Step 5: Update reservation thickness
        handle.update({
          rect: {
            x: primary.bounds.x,
            y: primary.bounds.y,
            width: primary.bounds.width,
            height: 52,
          },
        })

        // Step 6: Verify native rectangle changed appropriately
        await waitUntil(async () => {
          const list = await bridge.appBar.getRegistered()
          const item = list.find(b => b.id === testResId)
          return item !== undefined && item.rect.height === 52
        }, 5000)

        const registeredStep6 = await bridge.appBar.getRegistered()
        const foundStep6 = registeredStep6.find(item => item.id === testResId)
        expect(foundStep6?.rect.height).toBe(52)

        const activeWorkAreaStep6 = context.shellLayout.getWorkArea(primary.id)
        expect(activeWorkAreaStep6?.height).toBe(baselineWorkArea!.height - 52)

        // Step 7: Hide/suspend reservation
        handle.update({ visible: false })

        // Step 8: Verify native AppBar is removed or suspended
        await waitUntil(async () => {
          const list = await bridge.appBar.getRegistered()
          return !list.some(item => item.id === testResId)
        }, 5000)

        const registeredStep8 = await bridge.appBar.getRegistered()
        expect(registeredStep8.find(item => item.id === testResId)).toBeUndefined()
        const workAreaWhileHidden = context.shellLayout.getWorkArea(primary.id)
        expect(workAreaWhileHidden).toEqual(baselineWorkArea)

        // Step 9: Show/reapply reservation
        handle.update({ visible: true })

        // Step 10: Verify registration returns
        await waitUntil(async () => {
          const list = await bridge.appBar.getRegistered()
          const item = list.find(b => b.id === testResId)
          return item !== undefined && item.rect.height === 52
        }, 5000)

        const registeredStep10 = await bridge.appBar.getRegistered()
        const foundStep10 = registeredStep10.find(item => item.id === testResId)
        expect(foundStep10).toBeDefined()
        expect(foundStep10?.rect.height).toBe(52)

        // Step 11: Crash native host
        const preCrashGen = bridge.getHostGeneration()
        await bridge.crashHost()

        // Step 12: Wait for supervisor recovery
        await waitUntil(
          () => bridge.getStatus() === 'ready' && bridge.getHostGeneration() > preCrashGen,
          15_000,
        )

        // Step 13: Verify desired AppBar reservation re-registers automatically after supervisor recovery
        await waitUntil(async () => {
          const list = await bridge.appBar.getRegistered()
          return list.some(item => item.id === testResId)
        }, 15_000)

        const registeredAfterRecovery = await bridge.appBar.getRegistered()
        const foundRecovery = registeredAfterRecovery.find(item => item.id === testResId)
        expect(foundRecovery).toBeDefined()
        expect(foundRecovery?.rect.height).toBe(52)

        // Step 14: Remove reservation
        const removed = handle.dispose()
        expect(removed).toBe(true)

        // Step 15: Verify original Windows state is restored
        await waitUntil(async () => {
          const list = await bridge.appBar.getRegistered()
          return !list.some(item => item.id === testResId)
        }, 5000)

        const restoredWorkArea = context.shellLayout.getWorkArea(primary.id)
        expect(restoredWorkArea).toEqual(baselineWorkArea)

        const finalRegistered = await bridge.appBar.getRegistered()
        expect(finalRegistered.find(item => item.id === testResId)).toBeUndefined()
      } finally {
        await bridge.appBar.unregister(testResId).catch(() => {})
        await context.fiber.dispose()
        await bridge.dispose()
      }
    },
  )
})
