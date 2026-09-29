import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createNativeBridge, type NativeBridgeClient } from '@deepseek-ai/dsh-native-core'
import { SurfaceService } from '@deepseek-ai/dsh-surface'
import WindowsContextService from '@deepseek-ai/dsh-windows-context'
import ShellLayoutService from '@deepseek-ai/dsh-shell-layout'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import OverlayService from '../src/index.ts'
import type { OverlayDefinition } from '../src/types.ts'

async function waitForForegroundNativeId(
  ctx: Context,
  expected: string,
): Promise<string | undefined> {
  const deadline = Date.now() + 1_000
  let actual = (await ctx.windowsContext.refresh()).foreground?.nativeId
  while (actual !== expected && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20))
    actual = (await ctx.windowsContext.refresh()).foreground?.nativeId
  }
  return actual
}

describe('Overlay Core Live Windows Acceptance', () => {
  if (process.platform !== 'win32') {
    it.skip('Skipping Windows live tests on non-Windows platform', () => {})
    return
  }

  let bridge: NativeBridgeClient
  let ctx: Context
  let tempUserDataDir: string

  const liveMenuHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>ELIX Overlay Acceptance</title>
  <style>
    body {
      margin: 0;
      padding: 12px;
      background: #1e293b;
      color: #f8fafc;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      user-select: none;
      border: 1px solid #334155;
      border-radius: 8px;
      box-sizing: border-box;
    }
    .header { font-size: 13px; font-weight: 600; color: #38bdf8; margin-bottom: 8px; }
    .item { padding: 6px 10px; font-size: 13px; border-radius: 4px; cursor: pointer; }
    .item:hover { background: #3b82f6; color: #fff; }
    .badge { float: right; font-size: 11px; background: #22c55e; color: #000; padding: 1px 6px; border-radius: 4px; }
  </style>
</head>
<body>
  <div class="header">ELIX Overlay Surface <span class="badge">ACTIVE</span></div>
  <div class="item">Open Terminal</div>
  <div class="item">Settings & Preferences</div>
  <div class="item">Inspect Window Info</div>
</body>
</html>`

  const liveDefinition: OverlayDefinition = {
    id: 'live-desktop-context-menu',
    ownerId: 'live-test',
    size: { width: 240, height: 160 },
    defaultPlacement: 'auto',
    focusPolicy: 'activate',
    renderer: {
      type: 'html',
      target: liveMenuHtml,
    },
    dismiss: {
      outsideClick: true,
      escape: true,
    },
  }

  beforeAll(async () => {
    bridge = createNativeBridge()
    await bridge.connect()
    tempUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'elix-overlay-live-'))

    ctx = new Context()
    await ctx.plugin(WindowsContextService, { enabled: true, bridge })
    await ctx.plugin(ShellLayoutService, { enabled: true, bridge })
    await ctx.plugin(SurfaceService, {
      enabled: true,
      bridge,
      defaultUserDataFolder: tempUserDataDir,
    })
    await ctx.plugin(OverlayService, { enabled: true })

    await new Promise(resolve => setTimeout(resolve, 100))
  })

  afterAll(async () => {
    await ctx.fiber.dispose()
    await bridge.dispose()
    try {
      fs.rmSync(tempUserDataDir, { recursive: true, force: true })
    } catch {
      // Ignore directory cleanup error
    }
  })

  afterEach(async () => {
    await ctx.overlay.closeAll()
  })

  it(
    'coordinates live Windows monitors, Surface Core HWND, placement, reposition, Escape, and complete teardown',
    async () => {
      // Step 1: Query live monitors from Windows Context
      const monitors = ctx.windowsContext.getMonitors()
      expect(monitors.length).toBeGreaterThan(0)
      const primary = ctx.windowsContext.getPrimaryMonitor()
      expect(primary).toBeDefined()

      // Step 2: Register definition
      ctx.overlay.register(liveDefinition)
      expect(ctx.overlay.getDefinition('live-desktop-context-menu')).toBeDefined()

      // Step 3: Open overlay anchored near center of primary monitor
      const anchorX = primary.bounds.x + Math.round(primary.bounds.width / 2)
      const anchorY = primary.bounds.y + Math.round(primary.bounds.height / 2)

      const instance = await ctx.overlay.open({
        definitionId: liveDefinition.id,
        anchor: { type: 'point', x: anchorX, y: anchorY },
      })

      expect(instance).toBeDefined()
      expect(instance.state).toBe('OPEN')
      expect(instance.surface).toBeDefined()
      expect(instance.surface?.hwnd).toBeGreaterThan(0)

      // Verify ready-before-show and visibility
      expect(instance.surface?.isVisible).toBe(true)
      expect(instance.actualBounds.width).toBe(240)
      expect(instance.actualBounds.height).toBe(160)

      // Query real-time focus state: activating popup must immediately receive keyboard focus
      const focusState = await instance.surface!.getFocusState()
      expect(focusState.hasKeyboardFocus).toBe(true)

      // When environment permits foreground window ownership (interactive desktop session),
      // assert real-time foreground ownership and Windows Context synchronization.
      if (focusState.foregroundHwnd !== 0) {
        expect(focusState.isForeground).toBe(true)
        expect(focusState.hwnd).toBe(focusState.foregroundHwnd)
        const expectedNativeId = `hwnd:${instance.surface!.hwnd.toString(16)}`
        expect(await waitForForegroundNativeId(ctx, expectedNativeId)).toBe(expectedNativeId)
      } else {
        expect(focusState.isForeground).toBe(false)
      }

      // Brief dwell to ensure presentation is visible and painted
      await new Promise(r => setTimeout(r, 100))

      // Step 4: Reposition overlay to another location
      const newAnchorX = primary.bounds.x + 300
      const newAnchorY = primary.bounds.y + 300
      const repositioned = await ctx.overlay.reposition(instance.instanceId, {
        type: 'point',
        x: newAnchorX,
        y: newAnchorY,
      })

      expect(repositioned.actualBounds.x).toBe(primary.bounds.x + 300)
      expect(repositioned.actualBounds.y).toBe(primary.bounds.y + 300 + 4) // + 4 offset
      expect(instance.surface?.bounds.x).toBe(primary.bounds.x + 300)

      await new Promise(r => setTimeout(r, 50))

      // Step 5: Test Escape dismissal
      const dismissedId = await ctx.overlay.notifyEscapeKey()
      expect(dismissedId).toBe(instance.instanceId)

      // Step 6: Verify overlay is closed and native surface destroyed
      expect(ctx.overlay.getActive()).toHaveLength(0)
      expect(ctx.overlay.getInstance(instance.instanceId)).toBeUndefined()
      expect(ctx.surface.get(instance.surfaceId)).toBeUndefined()

      // Step 7: Open a second popup and explicitly close it
      const secondInstance = await ctx.overlay.open({
        definitionId: liveDefinition.id,
        anchor: { type: 'point', x: primary.bounds.x + 400, y: primary.bounds.y + 400 },
      })
      expect(secondInstance.state).toBe('OPEN')
      expect(ctx.overlay.getActive()).toHaveLength(1)

      const closed = await ctx.overlay.close(secondInstance.instanceId)
      expect(closed).toBe(true)

      // Step 8: Verify zero orphan state
      expect(ctx.overlay.getActive()).toHaveLength(0)
      expect(ctx.surface.list()).toHaveLength(0)
    },
    20000,
  )

  it(
    'verifies live no-activate popup preserves foreground window without stealing focus',
    async () => {
      const primary = ctx.windowsContext.getPrimaryMonitor()

      const noActivateDef: OverlayDefinition = {
        id: 'live-noactivate-preview',
        ownerId: 'live-test',
        size: { width: 200, height: 120 },
        defaultPlacement: 'top',
        focusPolicy: 'no-activate',
        renderer: {
          type: 'html',
          target: '<html><body style="background:#1e293b;color:#fff;">Preview</body></html>',
        },
        dismiss: { outsideClick: false, escape: true },
      }

      ctx.overlay.register(noActivateDef)

      // 1. Record foreground window before opening
      const fgBefore = ctx.windowsContext.getSnapshot().foreground?.nativeId

      // 2. Open no-activate popup
      const instance = await ctx.overlay.open({
        definitionId: noActivateDef.id,
        anchor: {
          type: 'point',
          x: primary.bounds.x + 300,
          y: primary.bounds.y + 300,
        },
      })

      expect(instance.state).toBe('OPEN')
      expect(instance.surface?.focusPolicy).toBe('noActivate')
      expect(instance.surface?.isVisible).toBe(true)

      // 3. Dwell to allow any potential activation attempt to complete
      await new Promise(r => setTimeout(r, 150))

      // 4. Verify foreground window was NOT stolen by the no-activate popup HWND
      const focusState = await instance.surface!.getFocusState()
      expect(focusState.isForeground).toBe(false)
      expect(focusState.hwnd).not.toBe(focusState.foregroundHwnd)
      expect(focusState.hasKeyboardFocus).toBe(false)

      const fgAfter = ctx.windowsContext.getSnapshot().foreground?.nativeId
      expect(fgAfter).not.toBe(String(instance.surface?.hwnd))
      if (fgBefore) {
        expect(fgAfter).toBe(fgBefore)
      }

      // 5. Clean teardown
      await ctx.overlay.close(instance.instanceId)
      expect(ctx.overlay.getActive()).toHaveLength(0)
      expect(ctx.surface.list()).toHaveLength(0)
    },
    20000,
  )

  it(
    'verifies live activating popup immediately receives keyboard focus and native accelerator Escape key dismisses it',
    async () => {
      const primary = ctx.windowsContext.getPrimaryMonitor()

      const activatingDef: OverlayDefinition = {
        id: 'live-activating-menu',
        ownerId: 'live-test',
        size: { width: 220, height: 180 },
        defaultPlacement: 'auto',
        focusPolicy: 'activate',
        renderer: {
          type: 'html',
          target: '<html><body style="background:#1e293b;color:#fff;">Activating Menu</body></html>',
        },
        dismiss: { outsideClick: true, escape: true },
      }

      ctx.overlay.register(activatingDef)

      const instance = await ctx.overlay.open({
        definitionId: activatingDef.id,
        anchor: {
          type: 'point',
          x: primary.bounds.x + 450,
          y: primary.bounds.y + 450,
        },
      })

      expect(instance.state).toBe('OPEN')
      expect(instance.surface?.focusPolicy).toBe('normal')
      expect(instance.surface?.isVisible).toBe(true)

      await new Promise(r => setTimeout(r, 100))

      // Assert real-time Win32 focus and foreground status from native host
      const focusState = await instance.surface!.getFocusState()
      expect(focusState.hasKeyboardFocus).toBe(true)

      // When environment permits foreground window ownership, assert foreground match and Windows Context
      if (focusState.foregroundHwnd !== 0) {
        expect(focusState.isForeground).toBe(true)
        expect(focusState.hwnd).toBe(focusState.foregroundHwnd)
        const expectedNativeId = `hwnd:${instance.surface!.hwnd.toString(16)}`
        expect(await waitForForegroundNativeId(ctx, expectedNativeId)).toBe(expectedNativeId)
      } else {
        expect(focusState.isForeground).toBe(false)
      }

      // Test Escape dismissal via native accelerator event path (surface/input-key)
      const closedPromise = new Promise<void>((resolve) => {
        const unbind = ctx.on('overlay/closed', ({ instanceId, reason }) => {
          if (instanceId === instance.instanceId && reason === 'escape') {
            unbind()
            resolve()
          }
        })
      })

      ctx.emit('surface/input-key', { surface: instance.surface!, key: 'Escape' })
      await closedPromise

      expect(ctx.overlay.getActive()).toHaveLength(0)
      expect(ctx.surface.list()).toHaveLength(0)
    },
    20000,
  )
})
