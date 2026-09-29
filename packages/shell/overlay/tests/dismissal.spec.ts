import { describe, expect, it } from 'vitest'
import {
  createTestEnvironment,
  SAMPLE_MENU_DEF,
  SAMPLE_PREVIEW_DEF,
} from './test-utils.ts'
import type { OverlayDefinition } from '../src/types.ts'

describe('Overlay Dismissal Policies', () => {
  it('dismisses topmost popup via Escape, prioritizing children before parent', async () => {
    const { ctx } = await createTestEnvironment()
    ctx.overlay.register(SAMPLE_MENU_DEF)

    const parent = await ctx.overlay.open({
      definitionId: SAMPLE_MENU_DEF.id,
      anchor: { type: 'point', x: 200, y: 200 },
    })

    const child = await ctx.overlay.open({
      definitionId: SAMPLE_MENU_DEF.id,
      parentInstanceId: parent.instanceId,
      anchor: { type: 'point', x: 420, y: 250 },
    })

    expect(ctx.overlay.getActive()).toHaveLength(2)

    // First Escape: closes child first!
    const dismissedFirst = await ctx.overlay.notifyEscapeKey()
    expect(dismissedFirst).toBe(child.instanceId)
    expect(ctx.overlay.getActive()).toHaveLength(1)
    expect(ctx.overlay.getInstance(parent.instanceId)).toBeDefined()
    expect(ctx.overlay.getInstance(child.instanceId)).toBeUndefined()

    // Second Escape: closes parent
    const dismissedSecond = await ctx.overlay.notifyEscapeKey()
    expect(dismissedSecond).toBe(parent.instanceId)
    expect(ctx.overlay.getActive()).toHaveLength(0)

    // Third Escape: nothing to dismiss, returns undefined
    const dismissedThird = await ctx.overlay.notifyEscapeKey()
    expect(dismissedThird).toBeUndefined()
  })

  it('respects dismiss.escape: false', async () => {
    const { ctx } = await createTestEnvironment()
    const nonDismissableDef = {
      ...SAMPLE_MENU_DEF,
      id: 'persistent-panel',
      dismiss: { escape: false, outsideClick: false },
    }
    ctx.overlay.register(nonDismissableDef)

    const inst = await ctx.overlay.open({
      definitionId: nonDismissableDef.id,
      anchor: { type: 'point', x: 200, y: 200 },
    })

    const dismissed = await ctx.overlay.notifyEscapeKey()
    expect(dismissed).toBeUndefined()
    expect(ctx.overlay.getActive()).toHaveLength(1)

    await ctx.overlay.close(inst.instanceId)
  })

  it('dismisses overlays upon outside click while preserving inside clicks', async () => {
    const { ctx } = await createTestEnvironment()
    ctx.overlay.register(SAMPLE_MENU_DEF)

    // Menu bounds: { x: 200, y: 204, width: 220, height: 300 }
    // -> X: 200 to 420, Y: 204 to 504
    const parent = await ctx.overlay.open({
      definitionId: SAMPLE_MENU_DEF.id,
      anchor: { type: 'point', x: 200, y: 200 },
    })

    // 1. Click inside parent bounds
    const insideRes = await ctx.overlay.notifyOutsideClick({ x: 250, y: 250 })
    expect(insideRes).toHaveLength(0)
    expect(ctx.overlay.getActive()).toHaveLength(1)

    // 2. Open child submenu: { x: 424, y: 254, width: 220, height: 300 }
    const child = await ctx.overlay.open({
      definitionId: SAMPLE_MENU_DEF.id,
      parentInstanceId: parent.instanceId,
      anchor: { type: 'point', x: 420, y: 250 },
    })
    expect(child.state).toBe('OPEN')

    // 3. Click inside child bounds: both remain open
    const childInsideRes = await ctx.overlay.notifyOutsideClick({ x: 450, y: 300 })
    expect(childInsideRes).toHaveLength(0)
    expect(ctx.overlay.getActive()).toHaveLength(2)

    // 4. Click outside both (e.g. at 50, 50): root and child close!
    const outsideRes = await ctx.overlay.notifyOutsideClick({ x: 50, y: 50 })
    expect(outsideRes).toContain(parent.instanceId)
    expect(ctx.overlay.getActive()).toHaveLength(0)
  })

  it('preserves overlays when hitSurfaceId matches', async () => {
    const { ctx } = await createTestEnvironment()
    ctx.overlay.register(SAMPLE_MENU_DEF)

    const parent = await ctx.overlay.open({
      definitionId: SAMPLE_MENU_DEF.id,
      anchor: { type: 'point', x: 200, y: 200 },
    })

    // Hit on parent's surface
    const res = await ctx.overlay.notifyOutsideClick(undefined, parent.surfaceId)
    expect(res).toHaveLength(0)
    expect(ctx.overlay.getActive()).toHaveLength(1)

    // Hit on another unknown surface
    const outsideRes = await ctx.overlay.notifyOutsideClick(undefined, 'other-random-surface')
    expect(outsideRes).toContain(parent.instanceId)
    expect(ctx.overlay.getActive()).toHaveLength(0)
  })

  it('cleans up active overlays and surfaces when context fiber is disposed', async () => {
    const { ctx } = await createTestEnvironment()
    ctx.overlay.register(SAMPLE_MENU_DEF)
    ctx.overlay.register(SAMPLE_PREVIEW_DEF)

    const menu = await ctx.overlay.open({
      definitionId: SAMPLE_MENU_DEF.id,
      anchor: { type: 'point', x: 100, y: 100 },
    })
    const preview = await ctx.overlay.open({
      definitionId: SAMPLE_PREVIEW_DEF.id,
      anchor: { type: 'point', x: 300, y: 100 },
    })

    expect(ctx.surface.get(menu.surfaceId)).toBeDefined()
    expect(ctx.surface.get(preview.surfaceId)).toBeDefined()

    const overlay = ctx.overlay
    const surfaceService = ctx.surface

    // Dispose context fiber
    await ctx.fiber.dispose()

    expect(overlay.getActive()).toHaveLength(0)
    expect(surfaceService.get(menu.surfaceId)).toBeUndefined()
    expect(surfaceService.get(preview.surfaceId)).toBeUndefined()
  })

  it('dispatches Escape dismissal from native surface/input-key event child-first', async () => {
    const { ctx, emitSurfaceEvent } = await createTestEnvironment()
    ctx.overlay.register(SAMPLE_MENU_DEF)

    const parent = await ctx.overlay.open({
      definitionId: SAMPLE_MENU_DEF.id,
      anchor: { type: 'point', x: 200, y: 200 },
    })
    const child = await ctx.overlay.open({
      definitionId: SAMPLE_MENU_DEF.id,
      parentInstanceId: parent.instanceId,
      anchor: { type: 'point', x: 420, y: 250 },
    })

    expect(ctx.overlay.getActive()).toHaveLength(2)

    // Emit native Escape on child surface
    emitSurfaceEvent({ type: 'inputKey', id: child.surfaceId, key: 'Escape' })
    await new Promise(r => setTimeout(r, 20))

    // Child is dismissed first, parent remains open
    expect(ctx.overlay.getActive()).toHaveLength(1)
    expect(ctx.overlay.getInstance(parent.instanceId)).toBeDefined()
    expect(ctx.overlay.getInstance(child.instanceId)).toBeUndefined()

    // Second Escape on parent surface dismisses parent
    emitSurfaceEvent({ type: 'inputKey', id: parent.surfaceId, key: 'Escape' })
    await new Promise(r => setTimeout(r, 20))
    expect(ctx.overlay.getActive()).toHaveLength(0)
  })

  it('dispatches outside click dismissal from native surface/pointer event', async () => {
    const { ctx, emitSurfaceEvent } = await createTestEnvironment()
    ctx.overlay.register(SAMPLE_MENU_DEF)

    const hostSurface = await ctx.surface.create({
      id: 'host-surface',
      bounds: { x: 0, y: 0, width: 1000, height: 800 },
    })

    const parent = await ctx.overlay.open({
      definitionId: SAMPLE_MENU_DEF.id,
      anchor: { type: 'point', x: 200, y: 200 },
    })
    const child = await ctx.overlay.open({
      definitionId: SAMPLE_MENU_DEF.id,
      parentInstanceId: parent.instanceId,
      anchor: { type: 'point', x: 420, y: 250 },
    })

    // Pointer down on child surface keeps tree open
    emitSurfaceEvent({ type: 'pointer', id: child.surfaceId, action: 'down', x: 450, y: 300 })
    await new Promise(r => setTimeout(r, 20))
    expect(ctx.overlay.getActive()).toHaveLength(2)

    // Pointer down on host surface outside the overlay tree dismisses root and child
    emitSurfaceEvent({ type: 'pointer', id: hostSurface.id, action: 'down', x: 50, y: 50 })
    await new Promise(r => setTimeout(r, 20))
    expect(ctx.overlay.getActive()).toHaveLength(0)
  })

  it('strictly enforces authoritative definition owner and rejects ownerId mismatch', async () => {
    const { ctx } = await createTestEnvironment()
    ctx.overlay.register(SAMPLE_MENU_DEF)

    // Matching ownerId succeeds and instance inherits definition ownerId
    const inst = await ctx.overlay.open({
      definitionId: SAMPLE_MENU_DEF.id,
      ownerId: SAMPLE_MENU_DEF.ownerId,
      anchor: { type: 'point', x: 100, y: 100 },
    })
    expect(inst.ownerId).toBe(SAMPLE_MENU_DEF.ownerId)
    await ctx.overlay.close(inst.instanceId)

    // Omitted ownerId succeeds and instance inherits definition ownerId
    const inst2 = await ctx.overlay.open({
      definitionId: SAMPLE_MENU_DEF.id,
      anchor: { type: 'point', x: 100, y: 100 },
    })
    expect(inst2.ownerId).toBe(SAMPLE_MENU_DEF.ownerId)
    await ctx.overlay.close(inst2.instanceId)

    // Mismatched ownerId throws synchronously
    await expect(
      ctx.overlay.open({
        definitionId: SAMPLE_MENU_DEF.id,
        ownerId: 'rogue-imposter',
        anchor: { type: 'point', x: 100, y: 100 },
      }),
    ).rejects.toThrow(/ownerId mismatch/)
  })

  it('handles double dismissal idempotently and safely', async () => {
    const { ctx } = await createTestEnvironment()
    ctx.overlay.register(SAMPLE_MENU_DEF)

    const inst = await ctx.overlay.open({
      definitionId: SAMPLE_MENU_DEF.id,
      anchor: { type: 'point', x: 100, y: 100 },
    })

    const first = await ctx.overlay.close(inst.instanceId)
    expect(first).toBe(true)
    const second = await ctx.overlay.close(inst.instanceId)
    expect(second).toBe(false)
  })

  it('keeps overlay tree open on click inside root or child, and closes tree on outside click', async () => {
    const { ctx, emitSurfaceEvent } = await createTestEnvironment()
    ctx.overlay.register(SAMPLE_MENU_DEF)

    const hostSurface = await ctx.surface.create({
      id: 'host-surface-click-test',
      bounds: { x: 0, y: 0, width: 1200, height: 900 },
    })

    const root = await ctx.overlay.open({
      definitionId: SAMPLE_MENU_DEF.id,
      anchor: { type: 'point', x: 300, y: 300 },
    })
    const child = await ctx.overlay.open({
      definitionId: SAMPLE_MENU_DEF.id,
      parentInstanceId: root.instanceId,
      anchor: { type: 'point', x: 520, y: 350 },
    })

    expect(ctx.overlay.getActive()).toHaveLength(2)

    // Click inside root -> tree remains open
    emitSurfaceEvent({ type: 'pointer', id: root.surfaceId, action: 'down', x: 350, y: 350 })
    await new Promise(r => setTimeout(r, 20))
    expect(ctx.overlay.getActive()).toHaveLength(2)

    // Click inside child -> tree remains open
    emitSurfaceEvent({ type: 'pointer', id: child.surfaceId, action: 'down', x: 550, y: 400 })
    await new Promise(r => setTimeout(r, 20))
    expect(ctx.overlay.getActive()).toHaveLength(2)

    // Click outside entire tree on host surface -> tree closes
    emitSurfaceEvent({ type: 'pointer', id: hostSurface.id, action: 'down', x: 50, y: 50 })
    await new Promise(r => setTimeout(r, 20))
    expect(ctx.overlay.getActive()).toHaveLength(0)
  })

  it('handles native input dismissal during OPENING state without orphan surfaces', async () => {
    const { ctx, emitSurfaceEvent } = await createTestEnvironment()
    ctx.overlay.register(SAMPLE_MENU_DEF)

    const hostSurface = await ctx.surface.create({
      id: 'host-surface-opening-test',
      bounds: { x: 0, y: 0, width: 1000, height: 800 },
    })

    // Launch open without awaiting
    const openPromise = ctx.overlay.open({
      definitionId: SAMPLE_MENU_DEF.id,
      anchor: { type: 'point', x: 200, y: 200 },
    })

    // Emit Escape on host surface while overlay is opening
    emitSurfaceEvent({ type: 'inputKey', id: hostSurface.id, key: 'Escape' })

    const inst = await openPromise
    expect(inst.state).toBe('CLOSED')
    expect(ctx.overlay.getActive()).toHaveLength(0)
    expect(ctx.surface.list().filter(s => s.id !== hostSurface.id)).toHaveLength(0)
  })

  it('handles rapid double input events safely without unhandled exceptions', async () => {
    const { ctx, emitSurfaceEvent } = await createTestEnvironment()
    ctx.overlay.register(SAMPLE_MENU_DEF)

    const inst = await ctx.overlay.open({
      definitionId: SAMPLE_MENU_DEF.id,
      anchor: { type: 'point', x: 200, y: 200 },
    })

    // Emit two Escape events back-to-back
    emitSurfaceEvent({ type: 'inputKey', id: inst.surfaceId, key: 'Escape' })
    emitSurfaceEvent({ type: 'inputKey', id: inst.surfaceId, key: 'Escape' })

    await new Promise(r => setTimeout(r, 40))
    expect(ctx.overlay.getActive()).toHaveLength(0)
    expect(ctx.surface.list()).toHaveLength(0)
  })

  it('verifies owner cleanup closes only target owner instances and definitions', async () => {
    const { ctx } = await createTestEnvironment()

    const defA: OverlayDefinition = { ...SAMPLE_MENU_DEF, id: 'def-a', ownerId: 'plugin-a' }
    const defB: OverlayDefinition = { ...SAMPLE_MENU_DEF, id: 'def-b', ownerId: 'plugin-b' }

    ctx.overlay.register(defA)
    ctx.overlay.register(defB)

    const instA = await ctx.overlay.open({
      definitionId: defA.id,
      anchor: { type: 'point', x: 100, y: 100 },
    })
    const instB = await ctx.overlay.open({
      definitionId: defB.id,
      anchor: { type: 'point', x: 300, y: 100 },
    })

    expect(ctx.overlay.getActive()).toHaveLength(2)

    // Clean up only plugin-a
    const result = await ctx.overlay.cleanupOwner('plugin-a')
    expect(result.closedInstances).toBe(1)
    expect(result.removedDefinitions).toContain('def-a')

    // Plugin-a instance closed and definition removed
    expect(ctx.overlay.getInstance(instA.instanceId)).toBeUndefined()
    expect(ctx.overlay.getDefinition('def-a')).toBeUndefined()

    // Plugin-b remains completely intact
    expect(ctx.overlay.getActive()).toHaveLength(1)
    expect(ctx.overlay.getInstance(instB.instanceId)?.state).toBe('OPEN')
    expect(ctx.overlay.getDefinition('def-b')).toBeDefined()

    await ctx.overlay.cleanupOwner('plugin-b')
    expect(ctx.overlay.getActive()).toHaveLength(0)
  })

  it('correctly integrates no-activate focus policy with native surface and Escape dismissal', async () => {
    const { ctx, emitSurfaceEvent } = await createTestEnvironment()

    const noActivateDef: OverlayDefinition = {
      ...SAMPLE_MENU_DEF,
      id: 'no-activate-preview',
      focusPolicy: 'no-activate',
    }
    ctx.overlay.register(noActivateDef)

    const inst = await ctx.overlay.open({
      definitionId: noActivateDef.id,
      anchor: { type: 'point', x: 150, y: 150 },
    })

    expect(inst.state).toBe('OPEN')
    expect(inst.surface?.focusPolicy).toBe('noActivate')

    // Escape still dismisses no-activate popup
    emitSurfaceEvent({ type: 'inputKey', id: inst.surfaceId, key: 'Escape' })
    await new Promise(r => setTimeout(r, 20))
    expect(ctx.overlay.getActive()).toHaveLength(0)
  })

  it('safely unbinds event listeners upon OverlayService dispose', async () => {
    const { ctx, emitSurfaceEvent } = await createTestEnvironment()
    ctx.overlay.register(SAMPLE_MENU_DEF)

    const inst = await ctx.overlay.open({
      definitionId: SAMPLE_MENU_DEF.id,
      anchor: { type: 'point', x: 100, y: 100 },
    })

    await ctx.overlay.dispose()

    // Emitting input events after dispose must not throw or resurrect
    expect(() => {
      emitSurfaceEvent({ type: 'inputKey', id: inst.surfaceId, key: 'Escape' })
      emitSurfaceEvent({ type: 'pointer', id: inst.surfaceId, action: 'down', x: 0, y: 0 })
    }).not.toThrow()
  })
})
