import { describe, expect, it } from 'vitest'
import {
  createTestEnvironment,
  SAMPLE_MENU_DEF,
} from './test-utils.ts'

describe('Overlay Async Races & Failure Rollbacks', () => {
  it('handles genuine immediate close during open without resurrecting zombie overlay', async () => {
    const { ctx } = await createTestEnvironment()
    ctx.overlay.register(SAMPLE_MENU_DEF)

    // Launch open without awaiting
    const openPromise = ctx.overlay.open({
      definitionId: SAMPLE_MENU_DEF.id,
      anchor: { type: 'point', x: 200, y: 200 },
    })

    // Immediately locate instance in CREATING/OPENING state and trigger close
    const openingInst = ctx.overlay.getActive()[0]
    expect(openingInst).toBeDefined()
    if (openingInst) {
      await ctx.overlay.close(openingInst.instanceId)
    }

    const instance = await openPromise
    expect(instance.state).toBe('CLOSED')
    expect(ctx.overlay.getActive()).toHaveLength(0)
    expect(ctx.surface.list()).toHaveLength(0)
  })

  it('aborts cleanly when parent closes while child submenu is opening', async () => {
    const { ctx } = await createTestEnvironment()
    ctx.overlay.register(SAMPLE_MENU_DEF)

    const parent = await ctx.overlay.open({
      definitionId: SAMPLE_MENU_DEF.id,
      anchor: { type: 'point', x: 200, y: 200 },
    })
    expect(parent.state).toBe('OPEN')

    // Start opening child submenu
    const childPromise = ctx.overlay.open({
      definitionId: SAMPLE_MENU_DEF.id,
      parentInstanceId: parent.instanceId,
      anchor: { type: 'point', x: 420, y: 200 },
    })

    // Close parent while child is opening
    await ctx.overlay.close(parent.instanceId)

    const child = await childPromise
    expect(child.state).toBe('CLOSED')
    expect(ctx.overlay.getActive()).toHaveLength(0)
    expect(ctx.surface.list()).toHaveLength(0)
  })

  it('handles rapid simultaneous opens in the same exclusive group cleanly', async () => {
    const { ctx } = await createTestEnvironment()

    const flyoutA = {
      ...SAMPLE_MENU_DEF,
      id: 'concurrent-flyout-a',
      stack: { group: 'exclusive-tray', exclusive: true },
    }
    const flyoutB = {
      ...SAMPLE_MENU_DEF,
      id: 'concurrent-flyout-b',
      stack: { group: 'exclusive-tray', exclusive: true },
    }

    ctx.overlay.register(flyoutA)
    ctx.overlay.register(flyoutB)

    // Launch both opens concurrently
    const [instA, instB] = await Promise.all([
      ctx.overlay.open({ definitionId: flyoutA.id, anchor: { type: 'point', x: 100, y: 100 } }),
      ctx.overlay.open({ definitionId: flyoutB.id, anchor: { type: 'point', x: 200, y: 100 } }),
    ])

    const active = ctx.overlay.getActive()
    expect(active).toHaveLength(1)
    expect(ctx.surface.list()).toHaveLength(1)

    // Exactly one must be OPEN and the other CLOSED
    const openCount = [instA, instB].filter(i => ctx.overlay.getInstance(i.instanceId)?.state === 'OPEN').length
    expect(openCount).toBe(1)

    await ctx.overlay.closeAll()
    expect(ctx.surface.list()).toHaveLength(0)
  })

  it('aborts open cleanly if definition is unregistered while open is in flight', async () => {
    const { ctx } = await createTestEnvironment()
    ctx.overlay.register(SAMPLE_MENU_DEF)

    // Launch open without awaiting
    const openPromise = ctx.overlay.open({
      definitionId: SAMPLE_MENU_DEF.id,
      anchor: { type: 'point', x: 200, y: 200 },
    })

    // Immediately unregister definition
    ctx.overlay.unregister(SAMPLE_MENU_DEF.id)

    const result = await openPromise
    expect(result.state).toBe('CLOSED')
    expect(ctx.overlay.getActive()).toHaveLength(0)
    expect(ctx.surface.list()).toHaveLength(0)
  })

  it('rolls back cleanly if surface creation fails', async () => {
    const { ctx, mockCreateSurface } = await createTestEnvironment()
    ctx.overlay.register(SAMPLE_MENU_DEF)

    // Force mock bridge to throw on create
    mockCreateSurface.mockRejectedValueOnce(
      new Error('Synthetic native HWND allocation failure'),
    )

    const faultedEvents: string[] = []
    ctx.on('overlay/faulted', (ev) => {
      faultedEvents.push(ev.instanceId)
    })

    await expect(
      ctx.overlay.open({
        definitionId: SAMPLE_MENU_DEF.id,
        anchor: { type: 'point', x: 200, y: 200 },
      }),
    ).rejects.toThrow(/Synthetic native HWND allocation failure/)

    expect(ctx.overlay.getActive()).toHaveLength(0)
    expect(faultedEvents).toHaveLength(1)
    expect(ctx.surface.list()).toHaveLength(0)
  })

  it('executes 20 rapid sequential open and close cycles without leaking state', async () => {
    const { ctx } = await createTestEnvironment()
    ctx.overlay.register(SAMPLE_MENU_DEF)

    for (let i = 0; i < 20; i++) {
      const inst = await ctx.overlay.open({
        definitionId: SAMPLE_MENU_DEF.id,
        anchor: { type: 'point', x: 100 + (i % 5) * 50, y: 100 },
      })
      expect(inst.state).toBe('OPEN')
      const closed = await ctx.overlay.close(inst.instanceId)
      expect(closed).toBe(true)
    }

    expect(ctx.overlay.getActive()).toHaveLength(0)
    expect(ctx.surface.list()).toHaveLength(0)
  })

  it('handles Escape key dismissal while overlay open is in-flight without leaving zombie window', async () => {
    const { ctx } = await createTestEnvironment()
    ctx.overlay.register(SAMPLE_MENU_DEF)

    const openPromise = ctx.overlay.open({
      definitionId: SAMPLE_MENU_DEF.id,
      anchor: { type: 'point', x: 200, y: 200 },
    })

    const dismissed = await ctx.overlay.notifyEscapeKey()
    expect(dismissed).toBeDefined()

    const instance = await openPromise
    expect(instance.state).toBe('CLOSED')
    expect(ctx.overlay.getActive()).toHaveLength(0)
    expect(ctx.surface.list()).toHaveLength(0)
  })

  it('handles owner unregister / closeByOwner while overlay is opening', async () => {
    const { ctx } = await createTestEnvironment()
    ctx.overlay.register(SAMPLE_MENU_DEF)

    const openPromise = ctx.overlay.open({
      definitionId: SAMPLE_MENU_DEF.id,
      anchor: { type: 'point', x: 200, y: 200 },
    })

    await ctx.overlay.closeByOwner(SAMPLE_MENU_DEF.ownerId)

    const instance = await openPromise
    expect(instance.state).toBe('CLOSED')
    expect(ctx.overlay.getActive()).toHaveLength(0)
    expect(ctx.surface.list()).toHaveLength(0)
  })

  it('handles outside click received while overlay is opening', async () => {
    const { ctx } = await createTestEnvironment()
    ctx.overlay.register(SAMPLE_MENU_DEF)

    const openPromise = ctx.overlay.open({
      definitionId: SAMPLE_MENU_DEF.id,
      anchor: { type: 'point', x: 200, y: 200 },
    })

    await ctx.overlay.notifyOutsideClick({ x: 50, y: 50 })

    const instance = await openPromise
    expect(instance.state).toBe('CLOSED')
    expect(ctx.overlay.getActive()).toHaveLength(0)
    expect(ctx.surface.list()).toHaveLength(0)
  })
})
