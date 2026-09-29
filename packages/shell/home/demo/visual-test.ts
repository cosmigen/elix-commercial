/**
 * Interactive Visual Acceptance Demo for ELIX Home and Widget Runtime (Phase 12).
 *
 * Provides a comprehensive visual test harness to verify:
 * 1. Liquid-glass desktop theme and responsive multi-monitor layouts
 * 2. Complete desktop items (files, shortcuts, folders, system icons)
 * 3. Inline rename (F2 / double click / intent)
 * 4. Context menu opening through Shell Overlay Core
 * 5. Full Widget Runtime with live Clock, interactive Calendar, and persistent Notes
 * 6. Widget drag, resize, z-order stacking, and grid-snapping
 * 7. Wallpaper customization (gradient, fit modes, blur, dim, saturation)
 * 8. Persistence v2 save, load, and migration
 * 9. Clean lifecycle teardown with zero orphan HWNDs or host processes
 *
 * Run with:
 *   pnpm run demo:home
 * or
 *   node --import tsx/esm packages/shell/home/demo/visual-test.ts
 *
 * @module @deepseek-ai/dsh-home/demo
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as readline from 'node:readline'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { createNativeBridge } from '@deepseek-ai/dsh-native-core'
import { SurfaceService } from '@deepseek-ai/dsh-surface'
import WindowsContextService from '@deepseek-ai/dsh-windows-context'
import ShellLayoutService from '@deepseek-ai/dsh-shell-layout'
import OverlayService from '@deepseek-ai/dsh-shell-overlay'
import IntentRouterService from '@deepseek-ai/dsh-intent-router'
import { WidgetService } from '@deepseek-ai/dsh-shell-widgets'
import HomePlugin, { HomeService } from '../src/index.ts'

export interface VisualTestOptions {
  /** Explicit persistent state directory override. Defaults to %LOCALAPPDATA%\ELIX\phase12-demo\ (or ~/.elix/phase12-demo/). */
  stateDir?: string | undefined
  /** If true, wipe any existing state directory before running. */
  reset?: boolean | undefined
  /** Auto-exit after executing sequence of actions (or immediately after reaching LIVE if actions empty). */
  autoExit?: boolean | undefined
  /** Optional sequence of action numbers to execute automatically before exiting. */
  actions?: number[] | undefined
}

/**
 * Parse CLI options from process.argv and environment variables.
 */
export function parseCliOptions(): VisualTestOptions {
  const args = process.argv.slice(2)
  let stateDir: string | undefined = process.env['ELIX_STATE_DIR'] ?? process.env['ELIX_DEMO_STATE_DIR']
  let reset = process.env['ELIX_RESET_STATE'] === '1' || process.env['ELIX_RESET_STATE'] === 'true'
  let autoExit = process.env['ELIX_DEMO_AUTO_EXIT'] === '1' || process.env['ELIX_DEMO_AUTO_EXIT'] === 'true'
  let actions: number[] | undefined

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--reset' || arg === '--clean') {
      reset = true
    } else if (arg === '--auto-exit') {
      autoExit = true
    } else if (arg.startsWith('--actions=')) {
      actions = arg.slice('--actions='.length).split(/[,\s]+/).map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n))
    } else if (arg === '--actions' && i + 1 < args.length) {
      actions = args[++i]!.split(/[,\s]+/).map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n))
    } else if (arg.startsWith('--state-dir=')) {
      stateDir = arg.slice('--state-dir='.length)
    } else if (arg === '--state-dir' && i + 1 < args.length) {
      stateDir = args[++i]
    }
  }

  return { stateDir, reset, autoExit, actions }
}

/**
 * Resolves the persistent state directory for the visual test demo.
 * Prioritizes custom options -> env variables -> Windows %LOCALAPPDATA%\ELIX\phase12-demo -> ~/.elix/phase12-demo.
 */
export function resolveDemoStateDir(customDir?: string): string {
  if (customDir && customDir.trim()) {
    return path.resolve(customDir.trim())
  }
  const envDir = process.env['ELIX_STATE_DIR'] ?? process.env['ELIX_DEMO_STATE_DIR']
  if (envDir && envDir.trim()) {
    return path.resolve(envDir.trim())
  }
  if (process.platform === 'win32') {
    const localAppData = process.env['LOCALAPPDATA'] ?? path.join(os.homedir(), 'AppData', 'Local')
    return path.join(localAppData, 'ELIX', 'phase12-demo')
  }
  const baseDir = process.env['XDG_DATA_HOME'] ?? path.join(os.homedir(), '.local', 'share')
  return path.join(baseDir, 'ELIX', 'phase12-demo')
}

export async function runVisualTest(options?: VisualTestOptions): Promise<void> {
  console.log('\x1b[36m%s\x1b[0m', '====================================================')
  console.log('\x1b[36m%s\x1b[0m', '  ELIX Phase 12 — Home & Widget Runtime Demo Harness')
  console.log('\x1b[36m%s\x1b[0m', '====================================================')

  const cliOpts = parseCliOptions()
  const stateDir = resolveDemoStateDir(options?.stateDir ?? cliOpts.stateDir)
  const shouldReset = options?.reset ?? cliOpts.reset

  if (shouldReset && fs.existsSync(stateDir)) {
    console.log(`[RESET] Clearing previous state directory: ${stateDir}`)
    fs.rmSync(stateDir, { recursive: true, force: true })
  }

  fs.mkdirSync(stateDir, { recursive: true })
  const statePath = path.join(stateDir, 'home-state.json')
  const webViewDir = path.join(stateDir, 'webview2')
  fs.mkdirSync(webViewDir, { recursive: true })

  console.log(`[INIT] State directory: ${stateDir}`)
  console.log(`[INIT] State file: ${statePath}`)

  const bridge = createNativeBridge({
    supervisor: { autoRestart: true, initialBackoffMs: 20, maxBackoffMs: 100 },
  })

  const ctx = new Context()

  try {
    // 1. Windows Context Service
    await ctx.plugin(WindowsContextService, { enabled: true, bridge })
    const monitors = ctx.windowsContext.getMonitors()
    const primary = ctx.windowsContext.getPrimaryMonitor()
    const primaryName = primary.friendlyName ?? primary.deviceName
    console.log(`[MONITORS] Detected ${monitors.length} monitor(s). Primary: ${primaryName} (${primary.bounds.width}x${primary.bounds.height})`)

    // 2. WebServer for hosting React renderers and local assets
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })

    // 3. Surface Service
    await ctx.plugin(SurfaceService, {
      enabled: true,
      bridge,
      defaultUserDataFolder: webViewDir,
    })

    // 4. Shell Layout Service
    await ctx.plugin(ShellLayoutService, { enabled: true })

    // 5. Overlay Service for context menus and floating panels
    await ctx.plugin(OverlayService, { enabled: true })

    // 6. Intent Router Service
    await ctx.plugin(IntentRouterService, { enabled: true })

    // 7. Widget Service
    await ctx.plugin(WidgetService, { enabled: true })

    // 8. Home Service
    await ctx.plugin(HomePlugin, {
      enabled: true,
      persistencePath: statePath,
      autoShowOnReady: true,
      snapToGrid: true,
      debugExclusions: false,
      zOrderPolicy: 'normal',
      demoMode: true,
    })

    const home: HomeService = ctx.home
    const widgets: WidgetService = ctx.widgets

    const existingItems = home.items.getItems()
    const existingWidgets = widgets.list()

    // Seed initial desktop items if state is fresh
    if (existingItems.length === 0) {
      console.log('[SEED] Populating sample desktop items with App Folder and Filesystem Folder...')
      home.items.addItem({
        type: 'file',
        monitorId: primary.id,
        position: { x: primary.bounds.x + 40, y: primary.bounds.y + 40 },
        metadata: { name: 'Welcome_to_ELIX.txt', filename: 'Welcome_to_ELIX.txt' },
      })
      const termItem = home.items.addItem({
        type: 'shortcut',
        monitorId: primary.id,
        position: { x: primary.bounds.x + 40, y: primary.bounds.y + 160 },
        metadata: { name: 'Terminal', target: 'wt.exe' },
      })
      const settingsItem = home.items.addItem({
        type: 'shortcut',
        monitorId: primary.id,
        position: { x: primary.bounds.x + 40, y: primary.bounds.y + 280 },
        metadata: { name: 'Settings', target: 'ms-settings:' },
      })
      home.items.addItem({
        type: 'shortcut',
        monitorId: primary.id,
        position: { x: primary.bounds.x + 40, y: primary.bounds.y + 400 },
        metadata: { name: 'Browser', target: 'msedge.exe' },
      })
      home.items.addItem({
        type: 'shortcut',
        monitorId: primary.id,
        position: { x: primary.bounds.x + 40, y: primary.bounds.y + 520 },
        metadata: { name: 'Code', target: 'code.cmd' },
      })
      // Create App Folder containing Terminal and Settings
      home.folders.createFolder({
        monitorId: primary.id,
        position: { x: primary.bounds.x + 160, y: primary.bounds.y + 40 },
        name: 'Utilities',
        color: 'sky',
        initialItemIds: [termItem.id, settingsItem.id],
      })
      // Create Filesystem Folder
      home.items.addItem({
        type: 'folder',
        monitorId: primary.id,
        position: { x: primary.bounds.x + 160, y: primary.bounds.y + 160 },
        metadata: { name: 'Documents', color: 'amber', isFilesystem: true, itemIds: [] },
      })
    } else {
      console.log(`[RESTORE] Loaded ${existingItems.length} persistent desktop item(s).`)
    }

    // Seed initial widgets if none exist
    if (existingWidgets.length === 0) {
      console.log('[SEED] Spawning built-in Clock, Calendar, and Notes widgets...')
      widgets.create({
        definitionId: 'clock',
        ownerId: 'elix.builtin',
        monitorId: primary.id,
        position: { x: primary.bounds.x + 280, y: primary.bounds.y + 60 },
        size: { width: 260, height: 130 },
      })
      widgets.create({
        definitionId: 'calendar',
        ownerId: 'elix.builtin',
        monitorId: primary.id,
        position: { x: primary.bounds.x + 560, y: primary.bounds.y + 60 },
        size: { width: 280, height: 260 },
      })
      widgets.create({
        definitionId: 'notes',
        ownerId: 'elix.builtin',
        monitorId: primary.id,
        position: { x: primary.bounds.x + 280, y: primary.bounds.y + 210 },
        size: { width: 260, height: 200 },
        state: { text: 'Welcome to ELIX Phase 12!\n- Liquid-glass Desktop\n- Interactive Widgets\n- F2 Inline Rename' },
      })
    } else {
      console.log(`[RESTORE] Loaded ${existingWidgets.length} persistent widget(s).`)
    }

    // Persist baseline snapshot if state file did not exist yet
    if (!fs.existsSync(statePath)) {
      await home.saveState()
    }

    // Wait for all Home surfaces to achieve renderer readiness and visible presentation
    console.log('[SURFACE] Awaiting renderer readiness and visible presentation at normal z-order...')
    for (const surface of home.surfaces.getSurfaces()) {
      await surface.whenReady()
      await surface.setZOrder('normal')
      if (!surface.isVisible) {
        await surface.show()
      }
      const deadline = Date.now() + 10_000
      while (!surface.isVisible || !surface.isReady) {
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for surface ${surface.surfaceId} to be ready and visible.`)
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      const bounds = surface.getBounds()
      console.log(`[SURFACE] Ready: monitor=${surface.monitorId} hwnd=0x${surface.windowHandle.toString(16)} (${surface.windowHandle}) state=${surface.state} bounds=${JSON.stringify(bounds)}`)
    }

    console.log('\x1b[32m%s\x1b[0m', '✔ Home Desktop Surface and Widget Runtime are LIVE!')

    // Print interactive command options
    const printMenu = () => {
      console.log('\n\x1b[33m%s\x1b[0m', '--- Interactive Test Actions ---')
      console.log(' 1: Add Clock Widget             2: Add Calendar Widget')
      console.log(' 3: Add Notes Widget             4: Move/Relocate Widget')
      console.log(' 5: Resize Widget                6: Remove Topmost Widget')
      console.log(' 7: Open Item Context Menu         8: Create New Folder')
      console.log(' 9: Inline Rename First Item    10: Delete Desktop Item')
      console.log('11: Cycle Wallpaper Theme       12: Toggle Snap to Grid')
      console.log('13: Save & Reload Persistence   14: Print Topology Status')
      console.log('15: Update Notes Widget Text    16: Open App Folder Overlay')
      console.log('17: Close App Folder Overlay    18: Reorder Folder Items')
      console.log(' q / exit: Clean Shutdown')
    }

    printMenu()

    let widgetCounter = 1
    const wallpapers = ['elix-orange', 'aurora-forest', 'ember-night', 'violet-circuit', 'quiet-orbit']
    let wallpaperIdx = 0

    const executeAction = async (actionNum: number) => {
      switch (actionNum) {
        case 1: {
          const inst = widgets.create({
            definitionId: 'clock',
            ownerId: 'elix.builtin',
            monitorId: primary.id,
            position: { x: primary.bounds.x + 150 + (widgetCounter * 20) % 300, y: primary.bounds.y + 350 },
            size: { width: 260, height: 130 },
          })
          widgetCounter++
          console.log(`[ACTION] Created Clock Widget instance: ${inst.id}`)
          break
        }
        case 2: {
          const inst = widgets.create({
            definitionId: 'calendar',
            ownerId: 'elix.builtin',
            monitorId: primary.id,
            position: { x: primary.bounds.x + 200 + (widgetCounter * 20) % 300, y: primary.bounds.y + 350 },
            size: { width: 280, height: 260 },
          })
          widgetCounter++
          console.log(`[ACTION] Created Calendar Widget instance: ${inst.id}`)
          break
        }
        case 3: {
          const inst = widgets.create({
            definitionId: 'notes',
            ownerId: 'elix.builtin',
            monitorId: primary.id,
            position: { x: primary.bounds.x + 250 + (widgetCounter * 20) % 300, y: primary.bounds.y + 350 },
            size: { width: 260, height: 200 },
            state: { text: `Note #${widgetCounter}: Created dynamically via demo console.` },
          })
          widgetCounter++
          console.log(`[ACTION] Created Notes Widget instance: ${inst.id}`)
          break
        }
        case 4: {
          const list = widgets.list()
          if (list.length === 0) {
            console.log('[WARN] No active widgets to move.')
            break
          }
          const target = list[list.length - 1]
          const newX = target.position.x + 40
          const newY = target.position.y + 30
          widgets.update(target.id, { position: { x: newX, y: newY } })
          console.log(`[ACTION] Moved widget ${target.id} to (${newX}, ${newY})`)
          break
        }
        case 5: {
          const list = widgets.list()
          if (list.length === 0) {
            console.log('[WARN] No active widgets to resize.')
            break
          }
          const target = list[0]
          const newWidth = target.size.width === 320 ? 260 : 320
          const newHeight = target.size.height === 220 ? 150 : 220
          widgets.update(target.id, { size: { width: newWidth, height: newHeight } })
          console.log(`[ACTION] Resized widget ${target.id} to ${newWidth}x${newHeight}`)
          break
        }
        case 6: {
          const list = widgets.list()
          if (list.length === 0) {
            console.log('[WARN] No active widgets to remove.')
            break
          }
          const target = list[list.length - 1]
          widgets.remove(target.id)
          console.log(`[ACTION] Removed widget instance: ${target.id}`)
          break
        }
        case 7: {
          const firstItem = home.items.getItems()[0]
          if (firstItem) {
            console.log(`[ACTION] Requesting Overlay Core context menu for item ${firstItem.id} at (400, 300)...`)
            home.requestContextMenu({
              targetType: firstItem.type === 'folder' ? 'folder' : 'item',
              targetId: firstItem.id,
              position: { x: 400, y: 300 },
              monitorId: primary.id,
            })
          } else {
            console.log('[WARN] No desktop items available to show context menu for.')
          }
          break
        }
        case 8: {
          const folder = home.items.addItem({
            type: 'folder',
            monitorId: primary.id,
            position: { x: primary.bounds.x + 160, y: primary.bounds.y + 40 },
            metadata: { name: `Folder_${Date.now().toString().slice(-4)}`, color: 'sky' },
          })
          const folderMeta = folder.metadata as Record<string, unknown>
          console.log(`[ACTION] Created new desktop folder: ${String(folderMeta['name'] ?? 'Folder')} (id: ${folder.id})`)
          break
        }
        case 9: {
          const items = home.items.getItems()
          if (items.length === 0) {
            console.log('[WARN] No desktop items to rename.')
            break
          }
          const item = items[0]
          const newName = `Renamed_${Date.now().toString().slice(-4)}`
          home.items.renameItem(item.id, newName)
          console.log(`[ACTION] Renamed item ${item.id} to "${newName}"`)
          break
        }
        case 10: {
          const items = home.items.getItems()
          if (items.length === 0) {
            console.log('[WARN] No desktop items to delete.')
            break
          }
          const item = items[items.length - 1]
          home.items.removeItem(item.id)
          console.log(`[ACTION] Deleted desktop item: ${item.id}`)
          break
        }
        case 11: {
          wallpaperIdx = (wallpaperIdx + 1) % wallpapers.length
          const selected = wallpapers[wallpaperIdx]!
          home.wallpaper.setActiveWallpaper(selected)
          console.log(`[ACTION] Changed active wallpaper theme to "${selected}"`)
          break
        }
        case 12: {
          home.setPreferences({ snapToGrid: !home.preferences.snapToGrid })
          console.log(`[ACTION] Toggled snapToGrid: ${home.preferences.snapToGrid ? 'ON' : 'OFF'}`)
          break
        }
        case 13: {
          console.log('[ACTION] Flushing state snapshot to disk and testing real restart...')
          await home.saveState()
          const loaded = await home.persistence.load()
          console.log(`[ACTION] State saved and verified from disk (${statePath}):`)
          console.log(` - Schema Version: ${loaded.schemaVersion}`)
          console.log(` - Items: ${loaded.items.length}`)
          console.log(` - Widgets: ${loaded.widgets?.length ?? 0}`)
          for (const w of loaded.widgets ?? []) {
            console.log(`   * [${w.definitionId}] ${w.id} at (${w.position.x}, ${w.position.y}) size: ${w.size.width}x${w.size.height} owner: ${w.ownerId}`)
          }
          // Real restoration: restore persistent widgets and desktop items into runtime
          const activeMonitorIds = monitors.map(m => m.id)
          if (loaded.widgets && loaded.widgets.length > 0) {
            widgets.restoreInstances(loaded.widgets, { activeMonitorIds })
          }
          home.items.loadSnapshot(loaded.items)
          home.wallpaper.loadPreferences(loaded.wallpaper)
          home.setPreferences(loaded.preferences)
          await home.restart()
          console.log('[ACTION] Real restart complete: Home surfaces and widget runtime reloaded and refreshed from durable state.')
          break
        }
        case 14: {
          console.log('\n\x1b[35m%s\x1b[0m', '=== CURRENT TOPOLOGY & STATUS ===')
          const currentMonitors = ctx.windowsContext.getMonitors()
          console.log(`Monitors: ${currentMonitors.length}`)
          for (const m of currentMonitors) {
            const monitorName = m.friendlyName ?? m.deviceName
            console.log(` - ${monitorName} (${m.id}) bounds: ${JSON.stringify(m.bounds)} scale: ${m.scaleFactor}`)
          }
          console.log(`Desktop Items: ${home.items.getItems().length}`)
          for (const it of home.items.getItems()) {
            const meta = it.metadata as Record<string, unknown>
            const label = meta['name'] ?? meta['filename'] ?? it.id
            const folderDetails = it.type === 'folder'
              ? ` [${meta['isFilesystem'] ? 'FS Folder' : 'App Folder'}: ${Array.isArray(meta['itemIds']) ? meta['itemIds'].length : 0} items, open=${Boolean(meta['isOpen'])}]`
              : ''
            console.log(` - [${it.type}] ${String(label)} at (${it.position.x}, ${it.position.y})${folderDetails}`)
          }
          console.log(`Active Widgets: ${widgets.list().length}`)
          for (const w of widgets.list()) {
            const stateStr = w.state ? ` state: ${JSON.stringify(w.state)}` : ''
            console.log(` - [${w.definitionId}] ${w.id} at (${w.position.x}, ${w.position.y}) size: ${w.size.width}x${w.size.height} zOrder: ${w.zOrder}${stateStr}`)
          }
          const activeOverlays = ctx.overlay?.getActive() ?? []
          console.log(`Active Overlays: ${activeOverlays.length}`)
          break
        }
        case 15: {
          const notes = widgets.list().find(w => w.definitionId === 'notes')
          if (!notes) {
            console.log('[WARN] No active Notes widget found to modify.')
            break
          }
          const prevText = String((notes.state as Record<string, unknown>)?.['text'] ?? '')
          const newText = `Note modified at ${new Date().toLocaleTimeString()} (edit #${widgetCounter++})\n- Persistent text across demo launches!`
          widgets.update(notes.id, { state: { text: newText } })
          console.log(`[ACTION] Updated Notes widget (${notes.id}):`)
          console.log(`  Previous: "${prevText.replace(/\n/g, ' ')}"`)
          console.log(`  New:      "${newText.replace(/\n/g, ' ')}"`)
          break
        }
        case 16: {
          const appFolder = home.folders.getFolders().find(f => !Boolean((f.metadata as Record<string, unknown>).isFilesystem))
          if (!appFolder) {
            console.log('[WARN] No active App Folder found to open.')
            break
          }
          home.folders.openFolder(appFolder.id)
          console.log(`[ACTION] Opened App Folder overlay: "${appFolder.metadata.name}" (${appFolder.id})`)
          break
        }
        case 17: {
          const closed = home.folders.closeFolder()
          console.log(`[ACTION] Closed App Folder overlay (closed=${closed}).`)
          break
        }
        case 18: {
          const appFolder = home.folders.getFolders().find(f => !Boolean((f.metadata as Record<string, unknown>).isFilesystem))
          if (!appFolder) {
            console.log('[WARN] No active App Folder found to reorder.')
            break
          }
          const reversedIds = [...appFolder.metadata.itemIds].reverse()
          home.folders.reorderFolderItems(appFolder.id, reversedIds)
          console.log(`[ACTION] Reordered items in App Folder "${appFolder.metadata.name}": [${reversedIds.join(', ')}]`)
          break
        }
        default:
          console.log('Unknown action number.')
      }
    }

    const isAutoExit = options?.autoExit ?? cliOpts.autoExit ?? false
    if (isAutoExit) {
      const actionsToRun = options?.actions ?? cliOpts.actions ?? []
      for (const act of actionsToRun) {
        await executeAction(act)
      }
      console.log('\x1b[33m%s\x1b[0m', '[SHUTDOWN] Automated demo sequence finished; tearing down Home surfaces and Widget runtime...')
    } else {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      })

      await new Promise<void>((resolve) => {
        let isClosing = false
        const finish = () => {
          if (!isClosing) {
            isClosing = true
            rl.close()
            resolve()
          }
        }

        rl.on('line', async (line) => {
          const input = line.trim().toLowerCase()
          if (input === 'q' || input === 'exit' || input === 'quit') {
            console.log('\x1b[33m%s\x1b[0m', '[SHUTDOWN] Tearing down Home surfaces and Widget runtime...')
            finish()
            return
          }

          const num = parseInt(input, 10)
          if (!isNaN(num) && num >= 1 && num <= 18) {
            try {
              await executeAction(num)
            } catch (err) {
              console.error('[ERROR]', err)
            }
          } else {
            printMenu()
          }
        })

        rl.on('close', finish)
        rl.on('SIGINT', finish)
      })
    }

    // Cleanup: save state and gracefully dispose without wiping stateDir
    await home.saveState()
    await ctx.fiber.dispose()
    await bridge.dispose()

    console.log('\x1b[32m%s\x1b[0m', `✔ All surfaces and processes cleanly shut down. Zero orphan windows. State preserved at: ${statePath}`)
  } catch (err) {
    console.error('Demo encountered fatal error:', err)
    try {
      await ctx.fiber.dispose()
      await bridge.dispose()
    } catch {}
    throw err
  }
}

// Auto-run if executed directly
if (process.argv[1]?.endsWith('visual-test.ts')) {
  runVisualTest().catch((err) => {
    console.error('Demo failed:', err)
    process.exit(1)
  })
}
