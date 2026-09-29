import { describe, expect, it } from 'vitest'
import {
  createTestEnvironment,
  SAMPLE_MENU_DEF,
} from './test-utils.ts'

describe('Overlay Nesting, Submenus, and Stacking Groups', () => {
  const submenuDef = {
    ...SAMPLE_MENU_DEF,
    id: 'desktop-submenu',
    size: { width: 160, height: 200 },
  }

  it('manages parent-child overlay nesting and cascaded teardown', async () => {
    const { ctx } = await createTestEnvironment()
    ctx.overlay.register(SAMPLE_MENU_DEF)
    ctx.overlay.register(submenuDef)

    // 1. Open parent context menu
    const parent = await ctx.overlay.open({
      definitionId: SAMPLE_MENU_DEF.id,
      anchor: { type: 'point', x: 300, y: 300 },
    })

    expect(parent.childInstanceIds).toHaveLength(0)

    // 2. Open submenu anchored to item inside parent menu
    const child = await ctx.overlay.open({
      definitionId: submenuDef.id,
      parentInstanceId: parent.instanceId,
      anchor: {
        type: 'surface-relative',
        surfaceId: parent.surfaceId,
        rect: { x: 0, y: 80, width: 220, height: 30 },
      },
      placement: 'right-start',
    })

    const refreshedParent = ctx.overlay.getInstance(parent.instanceId)
    expect(refreshedParent?.childInstanceIds).toContain(child.instanceId)
    expect(child.parentInstanceId).toBe(parent.instanceId)
    expect(ctx.overlay.getActive()).toHaveLength(2)

    // 3. Close parent: must automatically close child first
    const closed = await ctx.overlay.close(parent.instanceId)
    expect(closed).toBe(true)

    expect(ctx.overlay.getActive()).toHaveLength(0)
    expect(ctx.overlay.getInstance(child.instanceId)).toBeUndefined()
    expect(ctx.overlay.getInstance(parent.instanceId)).toBeUndefined()
  })

  it('allows closing child without closing parent', async () => {
    const { ctx } = await createTestEnvironment()
    ctx.overlay.register(SAMPLE_MENU_DEF)
    ctx.overlay.register(submenuDef)

    const parent = await ctx.overlay.open({
      definitionId: SAMPLE_MENU_DEF.id,
      anchor: { type: 'point', x: 300, y: 300 },
    })

    const child = await ctx.overlay.open({
      definitionId: submenuDef.id,
      parentInstanceId: parent.instanceId,
      anchor: { type: 'point', x: 520, y: 380 },
    })

    expect(ctx.overlay.getActive()).toHaveLength(2)

    // Close child only
    await ctx.overlay.close(child.instanceId)

    expect(ctx.overlay.getActive()).toHaveLength(1)
    expect(ctx.overlay.getInstance(parent.instanceId)).toBeDefined()
    expect(ctx.overlay.getInstance(child.instanceId)).toBeUndefined()

    await ctx.overlay.close(parent.instanceId)
  })

  it('enforces maximum nesting depth limits', async () => {
    const { ctx } = await createTestEnvironment()
    ctx.overlay.register(SAMPLE_MENU_DEF)

    let currentParentId: string | undefined

    // With default maxNestingDepth = 10, nesting 11 times must throw
    for (let i = 0; i < 10; i++) {
      const inst = await ctx.overlay.open({
        definitionId: SAMPLE_MENU_DEF.id,
        parentInstanceId: currentParentId,
        anchor: { type: 'point', x: 100 + i * 20, y: 100 },
      })
      currentParentId = inst.instanceId
    }

    expect(ctx.overlay.getActive()).toHaveLength(10)

    // Attempting depth 11 must be rejected
    await expect(
      ctx.overlay.open({
        definitionId: SAMPLE_MENU_DEF.id,
        parentInstanceId: currentParentId,
        anchor: { type: 'point', x: 400, y: 100 },
      }),
    ).rejects.toThrow(/Maximum overlay nesting depth \(10\) exceeded/)

    await ctx.overlay.closeAll()
  })

  it('rejects nesting on non-existent or closed parent', async () => {
    const { ctx } = await createTestEnvironment()
    ctx.overlay.register(SAMPLE_MENU_DEF)

    await expect(
      ctx.overlay.open({
        definitionId: SAMPLE_MENU_DEF.id,
        parentInstanceId: 'non-existent-parent',
        anchor: { type: 'point', x: 100, y: 100 },
      }),
    ).rejects.toThrow(/does not exist/)
  })

  it('enforces exclusive stack groups by closing previous group siblings', async () => {
    const { ctx } = await createTestEnvironment()

    const flyoutA = {
      ...SAMPLE_MENU_DEF,
      id: 'wifi-flyout',
      stack: { group: 'status-flyouts', exclusive: true },
    }
    const flyoutB = {
      ...SAMPLE_MENU_DEF,
      id: 'battery-flyout',
      stack: { group: 'status-flyouts', exclusive: true },
    }

    ctx.overlay.register(flyoutA)
    ctx.overlay.register(flyoutB)

    // Open Wi-Fi flyout
    const instA = await ctx.overlay.open({
      definitionId: flyoutA.id,
      anchor: { type: 'point', x: 1700, y: 1000 },
    })

    expect(ctx.overlay.getActive()).toHaveLength(1)
    expect(ctx.overlay.getInstance(instA.instanceId)).toBeDefined()

    // Open Battery flyout (exclusive group sibling)
    const instB = await ctx.overlay.open({
      definitionId: flyoutB.id,
      anchor: { type: 'point', x: 1750, y: 1000 },
    })

    // instA should have been closed automatically!
    expect(ctx.overlay.getActive()).toHaveLength(1)
    expect(ctx.overlay.getInstance(instA.instanceId)).toBeUndefined()
    expect(ctx.overlay.getInstance(instB.instanceId)).toBeDefined()

    await ctx.overlay.close(instB.instanceId)
  })

  it('rejects cycle creation in parent-child nesting hierarchies', async () => {
    const { ctx } = await createTestEnvironment()
    ctx.overlay.register(SAMPLE_MENU_DEF)

    const parent = await ctx.overlay.open({
      definitionId: SAMPLE_MENU_DEF.id,
      anchor: { type: 'point', x: 200, y: 200 },
    })

    // 1. Direct self-parenting
    expect(() => {
      // @ts-expect-error accessing internal registry for invariant test
      ctx.overlay.instances.validateNesting(parent.instanceId, 10, parent.instanceId)
    }).toThrow(/cannot be its own parent/)

    // 2. Transitive cycle
    const child = await ctx.overlay.open({
      definitionId: SAMPLE_MENU_DEF.id,
      parentInstanceId: parent.instanceId,
      anchor: { type: 'point', x: 420, y: 200 },
    })

    expect(() => {
      // @ts-expect-error accessing internal registry for invariant test
      ctx.overlay.instances.validateNesting(child.instanceId, 10, parent.instanceId)
    }).toThrow(/Cycle detected/)

    await ctx.overlay.closeAll()
  })

  it('cascades repositioning to surface-relative child submenus when parent moves', async () => {
    const { ctx } = await createTestEnvironment()
    ctx.overlay.register(SAMPLE_MENU_DEF)
    ctx.overlay.register(submenuDef)

    // Open parent at (300, 300)
    const parent = await ctx.overlay.open({
      definitionId: SAMPLE_MENU_DEF.id,
      anchor: { type: 'point', x: 300, y: 300 },
    })

    // Open child submenu anchored surface-relative to parent
    const child = await ctx.overlay.open({
      definitionId: submenuDef.id,
      parentInstanceId: parent.instanceId,
      anchor: {
        type: 'surface-relative',
        surfaceId: parent.instanceId,
        rect: { x: 220, y: 40, width: 100, height: 30 },
      },
      placement: 'right-start',
    })

    const initialChildX = child.actualBounds.x
    const initialChildY = child.actualBounds.y

    // Reposition parent to new location (500, 400)
    await ctx.overlay.reposition(parent.instanceId, {
      type: 'point',
      x: 500,
      y: 400,
    })

    const updatedChild = ctx.overlay.getInstance(child.instanceId)
    expect(updatedChild).toBeDefined()
    expect(updatedChild?.actualBounds.x).not.toBe(initialChildX)
    expect(updatedChild?.actualBounds.y).not.toBe(initialChildY)

    await ctx.overlay.closeAll()
  })

  it('honors stackLevel priority (tooltip > modal > normal) in getTopmost regardless of open order', async () => {
    const { ctx } = await createTestEnvironment()

    const normalDef = { ...SAMPLE_MENU_DEF, id: 'normal-def', stack: { stackLevel: 'normal' as const } }
    const modalDef = { ...SAMPLE_MENU_DEF, id: 'modal-def', stack: { stackLevel: 'modal' as const } }
    const tooltipDef = { ...SAMPLE_MENU_DEF, id: 'tooltip-def', stack: { stackLevel: 'tooltip' as const } }

    ctx.overlay.register(normalDef)
    ctx.overlay.register(modalDef)
    ctx.overlay.register(tooltipDef)

    // 1. Open normal first
    const normal1 = await ctx.overlay.open({ definitionId: normalDef.id, anchor: { type: 'point', x: 100, y: 100 } })
    expect(ctx.overlay.getTopmost()?.instanceId).toBe(normal1.instanceId)

    // 2. Open modal second
    const modal = await ctx.overlay.open({ definitionId: modalDef.id, anchor: { type: 'point', x: 200, y: 100 } })
    expect(ctx.overlay.getTopmost()?.instanceId).toBe(modal.instanceId)

    // 3. Open normal third (opened AFTER modal, but modal has higher stackLevel)
    await ctx.overlay.open({ definitionId: normalDef.id, anchor: { type: 'point', x: 300, y: 100 } })
    expect(ctx.overlay.getTopmost()?.instanceId).toBe(modal.instanceId)

    // 4. Open tooltip (highest stackLevel)
    const tooltip = await ctx.overlay.open({ definitionId: tooltipDef.id, anchor: { type: 'point', x: 400, y: 100 } })
    expect(ctx.overlay.getTopmost()?.instanceId).toBe(tooltip.instanceId)

    await ctx.overlay.closeAll()
  })
})
