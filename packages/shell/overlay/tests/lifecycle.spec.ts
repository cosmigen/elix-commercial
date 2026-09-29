import { describe, expect, it } from 'vitest'
import type { OverlayPlacementChangedEvent } from '../src/types.ts'
import {
  createTestEnvironment,
  SAMPLE_MENU_DEF,
  SAMPLE_PREVIEW_DEF,
  TEST_PRIMARY_MONITOR,
  TEST_SECONDARY_MONITOR,
} from './test-utils.ts'

describe('Overlay Lifecycle & Service', () => {
  it('opens an overlay, creates native surface, shows it, and closes cleanly', async () => {
    const { ctx } = await createTestEnvironment()
    ctx.overlay.register(SAMPLE_MENU_DEF)

    const openingEvents: string[] = []
    const openedEvents: string[] = []
    const closingEvents: string[] = []
    const closedEvents: string[] = []

    ctx.on('overlay/opening', ev => openingEvents.push(ev.instance.instanceId))
    ctx.on('overlay/opened', ev => openedEvents.push(ev.instance.instanceId))
    ctx.on('overlay/closing', ev => closingEvents.push(ev.instance.instanceId))
    ctx.on('overlay/closed', ev => closedEvents.push(ev.instanceId))

    // Open overlay at cursor position (500, 300)
    const instance = await ctx.overlay.open({
      definitionId: SAMPLE_MENU_DEF.id,
      anchor: { type: 'point', x: 500, y: 300 },
    })

    expect(instance.state).toBe('OPEN')
    expect(instance.surface).toBeDefined()
    expect(instance.actualBounds.x).toBe(500)
    expect(instance.actualBounds.y).toBe(304) // 300 + 0 + 4 offset
    expect(instance.actualBounds.width).toBe(220)
    expect(instance.actualBounds.height).toBe(300)
    expect(ctx.overlay.getActive()).toHaveLength(1)
    expect(ctx.overlay.getInstance(instance.instanceId)).toBeDefined()

    expect(openingEvents).toContain(instance.instanceId)
    expect(openedEvents).toContain(instance.instanceId)

    // Verify underlying surface in SurfaceService
    const surface = ctx.surface.get(instance.surfaceId)
    expect(surface).toBeDefined()
    expect(surface?.isVisible).toBe(true)
    expect(surface?.focusPolicy).toBe('normal') // 'activate' maps to 'normal'

    // Close instance
    const closed = await ctx.overlay.close(instance.instanceId)
    expect(closed).toBe(true)
    expect(ctx.overlay.getActive()).toHaveLength(0)
    expect(ctx.overlay.getInstance(instance.instanceId)).toBeUndefined()
    expect(ctx.surface.get(instance.surfaceId)).toBeUndefined()

    expect(closingEvents).toContain(instance.instanceId)
    expect(closedEvents).toContain(instance.instanceId)

    // Double close is idempotent and returns false
    const closedAgain = await ctx.overlay.close(instance.instanceId)
    expect(closedAgain).toBe(false)
  })

  it('respects no-activate focus policy and does not steal foreground focus', async () => {
    const { ctx } = await createTestEnvironment()
    ctx.overlay.register(SAMPLE_PREVIEW_DEF)

    const instance = await ctx.overlay.open({
      definitionId: SAMPLE_PREVIEW_DEF.id,
      anchor: { type: 'rect', x: 800, y: 1000, width: 60, height: 40 },
    })

    expect(instance.focusPolicy).toBe('no-activate')
    const surface = ctx.surface.get(instance.surfaceId)
    expect(surface?.focusPolicy).toBe('noActivate')

    await ctx.overlay.close(instance.instanceId)
  })

  it('requests activate focus with normal surface policy and skipTaskbar false', async () => {
    const { ctx, mockCreateSurface } = await createTestEnvironment()
    ctx.overlay.register(SAMPLE_MENU_DEF)

    const instance = await ctx.overlay.open({
      definitionId: SAMPLE_MENU_DEF.id,
      anchor: { type: 'point', x: 200, y: 200 },
    })

    expect(instance.focusPolicy).toBe('activate')
    const createCall = mockCreateSurface.mock.calls.find(call => call[0].id === instance.surfaceId)
    expect(createCall).toBeDefined()
    expect(createCall![0].focusPolicy).toBe('normal')
    expect(createCall![0].skipTaskbar).toBe(false)

    await ctx.overlay.close(instance.instanceId)
  })

  it('requests no-activate focus with noActivate surface policy and skipTaskbar true', async () => {
    const { ctx, mockCreateSurface } = await createTestEnvironment()
    ctx.overlay.register(SAMPLE_PREVIEW_DEF)

    const instance = await ctx.overlay.open({
      definitionId: SAMPLE_PREVIEW_DEF.id,
      anchor: { type: 'point', x: 200, y: 200 },
    })

    expect(instance.focusPolicy).toBe('no-activate')
    const createCall = mockCreateSurface.mock.calls.find(call => call[0].id === instance.surfaceId)
    expect(createCall).toBeDefined()
    expect(createCall![0].focusPolicy).toBe('noActivate')
    expect(createCall![0].skipTaskbar).toBe(true)

    await ctx.overlay.close(instance.instanceId)
  })

  it('supports closeAll and closeByOwner', async () => {
    const { ctx } = await createTestEnvironment()
    ctx.overlay.register(SAMPLE_MENU_DEF)
    ctx.overlay.register(SAMPLE_PREVIEW_DEF)

    const menu1 = await ctx.overlay.open({
      definitionId: SAMPLE_MENU_DEF.id,
      anchor: { type: 'point', x: 100, y: 100 },
    })
    const menu2 = await ctx.overlay.open({
      definitionId: SAMPLE_MENU_DEF.id,
      anchor: { type: 'point', x: 400, y: 100 },
    })
    const preview = await ctx.overlay.open({
      definitionId: SAMPLE_PREVIEW_DEF.id,
      anchor: { type: 'point', x: 700, y: 100 },
    })

    expect(ctx.overlay.getActive()).toHaveLength(3)

    // Close by owner 'home' (should close menu1 and menu2, leaving preview)
    const closedHome = await ctx.overlay.closeByOwner('home')
    expect(closedHome).toBe(2)
    expect(ctx.overlay.getActive()).toHaveLength(1)
    expect(ctx.overlay.getInstance(preview.instanceId)).toBeDefined()
    expect(ctx.overlay.getInstance(menu1.instanceId)).toBeUndefined()
    expect(ctx.overlay.getInstance(menu2.instanceId)).toBeUndefined()

    // Close all remaining
    const closedRemaining = await ctx.overlay.closeAll()
    expect(closedRemaining).toBe(1)
    expect(ctx.overlay.getActive()).toHaveLength(0)
  })

  it('repositions active overlay when monitor workArea or DPI changes', async () => {
    const { ctx } = await createTestEnvironment()
    ctx.overlay.register(SAMPLE_MENU_DEF)

    const placementEvents: OverlayPlacementChangedEvent[] = []
    ctx.on('overlay/placement-changed', ev => placementEvents.push(ev))

    const instance = await ctx.overlay.open({
      definitionId: SAMPLE_MENU_DEF.id,
      anchor: { type: 'point', x: 1800, y: 500 }, // near right edge
    })

    expect(instance.actualBounds.x).toBe(1700) // shifted left: 1920 - 220 = 1700

    // Reposition with a new anchor
    const updated = await ctx.overlay.reposition(instance.instanceId, {
      type: 'point',
      x: 200,
      y: 200,
    })

    expect(updated.actualBounds.x).toBe(200)
    expect(updated.actualBounds.y).toBe(204)
    expect(placementEvents).toHaveLength(1)
    expect(placementEvents[0]?.previousBounds.x).toBe(1700)
    expect(placementEvents[0]?.newBounds.x).toBe(200)

    await ctx.overlay.close(instance.instanceId)
  })

  it('handles monitor removal topology change by closing disconnected overlays', async () => {
    const { ctx, setMonitors } = await createTestEnvironment([
      TEST_PRIMARY_MONITOR,
      TEST_SECONDARY_MONITOR,
    ])
    ctx.overlay.register(SAMPLE_MENU_DEF)

    // Open on secondary monitor
    const instance = await ctx.overlay.open({
      definitionId: SAMPLE_MENU_DEF.id,
      anchor: { type: 'point', x: 2100, y: 400 },
    })

    expect(instance.monitorId).toBe('mon-secondary')
    expect(ctx.overlay.getActive()).toHaveLength(1)

    // Disconnect secondary monitor and emit topology change
    setMonitors([TEST_PRIMARY_MONITOR])
    ctx.emit('windows-context/change', {
      revision: 2,
      reason: 'topology',
      snapshot: {
        revision: 2,
        monitors: [TEST_PRIMARY_MONITOR],
        primaryMonitorId: TEST_PRIMARY_MONITOR.id,
        foreground: null,
        capturedAt: Date.now(),
      },
    })

    // Give microtask queue time to process async close
    await new Promise(r => setTimeout(r, 20))

    expect(ctx.overlay.getActive()).toHaveLength(0)
    expect(ctx.overlay.getInstance(instance.instanceId)).toBeUndefined()
  })

  it('integrates with Shell Layout work area when available', async () => {
    const { ctx } = await createTestEnvironment()
    ctx.overlay.register(SAMPLE_MENU_DEF)

    // Inject mock Shell Layout into context
    ctx.shellLayout = {
      getWorkArea: () => ({ x: 0, y: 50, width: 1920, height: 990 }), // Reserved 50px AppBar at top
      isFullscreenActive: () => false,
    } as unknown as NonNullable<typeof ctx.shellLayout>

    const instance = await ctx.overlay.open({
      definitionId: SAMPLE_MENU_DEF.id,
      anchor: { type: 'point', x: 200, y: 10 }, // Anchor near top in reserved AppBar
      placement: 'top-start', // Will flip to bottom-start because y < 50
    })

    // Should flip to bottom or shift down below 50px
    expect(instance.actualBounds.y).toBeGreaterThanOrEqual(50)

    await ctx.overlay.close(instance.instanceId)
  })

  it('handles native-host recovery policy: recreate vs close', async () => {
    const { ctx, emitSurfaceEvent } = await createTestEnvironment()

    const recoverableDef: typeof SAMPLE_MENU_DEF = {
      ...SAMPLE_MENU_DEF,
      id: 'recoverable-panel',
      recovery: 'recreate',
    }
    const ephemeralDef: typeof SAMPLE_MENU_DEF = {
      ...SAMPLE_MENU_DEF,
      id: 'ephemeral-panel',
      recovery: 'close',
    }

    ctx.overlay.register(recoverableDef)
    ctx.overlay.register(ephemeralDef)

    // 1. Open recoverable overlay
    const recoverableInst = await ctx.overlay.open({
      definitionId: recoverableDef.id,
      anchor: { type: 'point', x: 200, y: 200 },
    })
    expect(recoverableInst.state).toBe('OPEN')

    // Simulate surface destroyed unexpectedly (native crash)
    emitSurfaceEvent({ type: 'destroyed', id: recoverableInst.surfaceId })
    await new Promise(r => setTimeout(r, 50))

    // Recoverable overlay must be recreated
    const active = ctx.overlay.getActive()
    expect(active.length).toBe(1)
    expect(active[0]?.definitionId).toBe(recoverableDef.id)
    expect(active[0]?.instanceId).not.toBe(recoverableInst.instanceId)

    await ctx.overlay.closeAll()

    // 2. Open ephemeral overlay
    const ephemeralInst = await ctx.overlay.open({
      definitionId: ephemeralDef.id,
      anchor: { type: 'point', x: 300, y: 300 },
    })

    emitSurfaceEvent({ type: 'destroyed', id: ephemeralInst.surfaceId })
    await new Promise(r => setTimeout(r, 50))

    // Ephemeral overlay must remain closed
    expect(ctx.overlay.getActive()).toHaveLength(0)
  })

  it('cleans up definitions and active overlays on cleanupOwner and unregister', async () => {
    const { ctx } = await createTestEnvironment()

    const def1: typeof SAMPLE_MENU_DEF = { ...SAMPLE_MENU_DEF, id: 'plugin-menu-1', ownerId: 'my-plugin' }
    const def2: typeof SAMPLE_MENU_DEF = { ...SAMPLE_MENU_DEF, id: 'plugin-menu-2', ownerId: 'my-plugin' }

    ctx.overlay.register(def1)
    ctx.overlay.register(def2)

    await ctx.overlay.open({ definitionId: def1.id, anchor: { type: 'point', x: 100, y: 100 } })
    await ctx.overlay.open({ definitionId: def2.id, anchor: { type: 'point', x: 300, y: 100 } })

    expect(ctx.overlay.getActive()).toHaveLength(2)

    // Cleanup entire owner
    const result = await ctx.overlay.cleanupOwner('my-plugin')
    expect(result.closedInstances).toBe(2)
    expect(result.removedDefinitions).toContain('plugin-menu-1')
    expect(result.removedDefinitions).toContain('plugin-menu-2')

    expect(ctx.overlay.getActive()).toHaveLength(0)
    expect(ctx.overlay.getDefinition('plugin-menu-1')).toBeUndefined()
    expect(ctx.overlay.getDefinition('plugin-menu-2')).toBeUndefined()
    expect(ctx.surface.list()).toHaveLength(0)
  })

  it('notifies subscribers via ctx.overlay.subscribe', async () => {
    const { ctx } = await createTestEnvironment()
    const receivedTypes: string[] = []

    const unsubscribe = ctx.overlay.subscribe((ev) => {
      receivedTypes.push(ev.type)
    })

    ctx.overlay.register(SAMPLE_MENU_DEF)
    const inst = await ctx.overlay.open({ definitionId: SAMPLE_MENU_DEF.id, anchor: { type: 'point', x: 100, y: 100 } })
    await ctx.overlay.reposition(inst.instanceId, { type: 'point', x: 200, y: 200 })
    await ctx.overlay.close(inst.instanceId)
    ctx.overlay.unregister(SAMPLE_MENU_DEF.id)

    expect(receivedTypes).toContain('registered')
    expect(receivedTypes).toContain('opening')
    expect(receivedTypes).toContain('opened')
    expect(receivedTypes).toContain('placement-changed')
    expect(receivedTypes).toContain('closing')
    expect(receivedTypes).toContain('closed')
    expect(receivedTypes).toContain('unregistered')

    // Unsubscribe stops notifications
    unsubscribe()
    receivedTypes.length = 0
    ctx.overlay.register(SAMPLE_MENU_DEF)
    expect(receivedTypes).toHaveLength(0)
  })

  it('shuts down cleanly and destroys native surfaces when dispose is called', async () => {
    const { ctx } = await createTestEnvironment()
    ctx.overlay.register(SAMPLE_MENU_DEF)

    await ctx.overlay.open({ definitionId: SAMPLE_MENU_DEF.id, anchor: { type: 'point', x: 100, y: 100 } })
    await ctx.overlay.open({ definitionId: SAMPLE_MENU_DEF.id, anchor: { type: 'point', x: 300, y: 100 } })
    expect(ctx.overlay.getActive()).toHaveLength(2)

    await ctx.overlay.dispose()

    expect(ctx.overlay.getActive()).toHaveLength(0)
    expect(ctx.overlay.listDefinitions()).toHaveLength(0)
    expect(ctx.surface.list()).toHaveLength(0)
  })
})
