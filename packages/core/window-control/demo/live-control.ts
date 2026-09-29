/** Interactive live acceptance console for Phase 14 Window Control. */

import { spawn, type ChildProcess } from 'node:child_process'
import * as readline from 'node:readline'
import { Context } from '@deepseek-ai/cordis'
import { createNativeBridge, type NativeBridgeClient } from '@deepseek-ai/dsh-native-core'
import WindowRegistryService, { type WindowId, type WindowSnapshot } from '@deepseek-ai/dsh-window-registry'
import WindowsContextService from '@deepseek-ai/dsh-windows-context'
import WindowControlService, { type WindowControlResult } from '../src/index.ts'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function waitForNewNotepad(
  registry: WindowRegistryService,
  existingIds: Set<WindowId>,
  pid: number | undefined,
): Promise<WindowSnapshot> {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    await registry.refresh()
    const candidates = registry.getWindows().filter(window =>
      window.classification === 'APPLICATION'
      && window.executableName?.toLowerCase() === 'notepad.exe'
      && !existingIds.has(window.id)
      && window.isVisible
      && window.bounds.width > 0
      && window.bounds.height > 0
      && (pid === undefined || window.processId === pid || window.classification === 'APPLICATION'),
    )
    if (candidates.length > 0) {
      return candidates.sort((a, b) => b.firstSeen - a.firstSeen)[0]!
    }
    await sleep(50)
  }
  throw new Error('Timed out waiting for the dedicated Notepad window to enter Window Registry')
}

async function waitForBridgeRecovery(
  bridge: NativeBridgeClient,
  previousGeneration: number,
): Promise<void> {
  const deadline = Date.now() + 7000
  while (Date.now() < deadline) {
    if (bridge.getHostGeneration() > previousGeneration && bridge.isReady()) return
    await sleep(50)
  }
  throw new Error('Timed out waiting for native host recovery')
}

async function waitForStableWindowId(
  registry: WindowRegistryService,
  windowId: WindowId,
): Promise<WindowSnapshot> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const window = registry.getWindow(windowId)
    if (window) return window
    await sleep(50)
  }
  throw new Error(`WindowId '${windowId}' did not recover after native host restart`)
}

function printResult(result: WindowControlResult) {
  const observation = result.observation
  const bounds = observation.bounds
    ? ` x=${observation.bounds.x} y=${observation.bounds.y} w=${observation.bounds.width} h=${observation.bounds.height}`
    : ''
  console.log(
    `[${result.action}] accepted=${result.accepted} completed=${result.completed}`
    + ` exists=${observation.exists} visible=${observation.visible}`
    + ` minimized=${observation.minimized} maximized=${observation.maximized}`
    + ` foreground=${observation.foreground}${bounds}`,
  )
}

async function main() {
  if (process.platform !== 'win32') {
    throw new Error('Window Control live acceptance requires Windows')
  }

  console.log('='.repeat(72))
  console.log('   ELIX Phase 14 — Window Control Live Acceptance Console')
  console.log('='.repeat(72))

  const bridge = createNativeBridge({ debug: false })
  await bridge.connect()
  const caps = bridge.getCapabilities()
  console.log(`[Native capability] windowControl=${caps?.windowControl === true}`)

  const ctx = new Context()
  ctx.plugin(WindowsContextService, { enabled: true, bridge })
  ctx.plugin(WindowRegistryService, { enabled: true, bridge })
  ctx.plugin(WindowControlService, { enabled: true, bridge })
  await sleep(250)

  const before = new Set(ctx.windowRegistry.getWindows().map(window => window.id))
  console.log('Launching a dedicated Notepad instance for destructive-safe acceptance...')
  let child: ChildProcess | null = spawn('notepad.exe', [], { stdio: 'ignore' })
  const target = await waitForNewNotepad(ctx.windowRegistry, before, child.pid)
  const targetId = target.id
  console.log(`[Target] ${target.title} | ${target.id} | HWND 0x${target.hwnd.toString(16)} | PID ${target.processId}`)

  const printCurrent = () => {
    const window = ctx.windowRegistry.getWindow(targetId)
    if (!window) {
      console.log('[Registry] target WindowId no longer exists')
      return
    }
    const b = window.bounds
    console.log(
      `[Registry] state=${window.state} foreground=${window.isForeground}`
      + ` monitor=${window.monitorId ?? '<unknown>'}`
      + ` x=${b.x} y=${b.y} w=${b.width} h=${b.height}`,
    )
  }

  const execute = async (label: string, command: () => Promise<WindowControlResult>) => {
    try {
      console.log(`\n> ${label}`)
      printResult(await command())
      await sleep(100)
      printCurrent()
    } catch (error) {
      console.error(`[${label}]`, error)
    }
  }

  const recoverHost = async () => {
    const beforeRecovery = ctx.windowRegistry.getWindow(targetId)
    if (!beforeRecovery) {
      console.log('[RECOVERY] target has already been closed; recovery check skipped')
      return
    }

    const generation = bridge.getHostGeneration()
    console.log(`\n> crash native host generation ${generation}`)
    await bridge.sendRequest('bridge/crash', {}).catch(() => undefined)
    await waitForBridgeRecovery(bridge, generation)
    const recovered = await waitForStableWindowId(ctx.windowRegistry, targetId)

    console.log(
      `[RECOVERY] host generation=${bridge.getHostGeneration()}`
      + ` stableWindowId=${recovered.id === targetId}`
      + ` hwnd=0x${recovered.hwnd.toString(16)}`,
    )
    await execute('post-recovery restore', () => ctx.windowControl.restore(targetId))
  }

  console.log('\nCommands:')
  console.log('  [a] Activate / foreground')
  console.log('  [n] Minimize')
  console.log('  [m] Maximize')
  console.log('  [r] Restore')
  console.log('  [p] Move +60,+40 physical pixels (restored only)')
  console.log('  [z] Resize +80,+60 physical pixels (restored only)')
  console.log('  [t] Move to next monitor, centered (if present; restored only)')
  console.log('  [x] Crash/recover native host and reuse the same WindowId')
  console.log('  [s] Print current registry state')
  console.log('  [c] Close dedicated Notepad and verify stale WindowId rejection')
  console.log('  [q] Quit and clean up')
  printCurrent()

  const cleanup = async () => {
    const live = ctx.windowRegistry.getWindow(targetId)
    if (live) {
      await ctx.windowControl.close(targetId).catch(() => undefined)
      await sleep(200)
    }
    if (child && child.exitCode === null) {
      child.kill()
    }
    child = null
    await ctx.fiber.dispose()
    await bridge.dispose()
  }

  let commandBusy = false
  const handleCommand = async (name: string) => {
    const key = name.trim().toLowerCase()
    if (!key) return
    if (key === 'q') {
      if (process.stdin.isTTY && process.stdin.setRawMode) {
        try { process.stdin.setRawMode(false) } catch {}
      }
      console.log('\nCleaning up...')
      await cleanup()
      process.exit(0)
    }
    if (key === 's') {
      printCurrent()
      return
    }
    if (commandBusy) {
      console.log('[BUSY] wait for the current Window Control command to finish')
      return
    }

    commandBusy = true
    try {
      if (key === 'a') await execute('activate', () => ctx.windowControl.activate(targetId))
      if (key === 'n') await execute('minimize', () => ctx.windowControl.minimize(targetId))
      if (key === 'm') await execute('maximize', () => ctx.windowControl.maximize(targetId))
      if (key === 'r') await execute('restore', () => ctx.windowControl.restore(targetId))
      if (key === 'p') {
        const live = ctx.windowRegistry.getWindow(targetId)
        if (live) {
          await execute('move', () => ctx.windowControl.move(
            targetId,
            live.bounds.x + 60,
            live.bounds.y + 40,
          ))
        }
      }
      if (key === 'z') {
        const live = ctx.windowRegistry.getWindow(targetId)
        if (live) {
          await execute('resize', () => ctx.windowControl.resize(
            targetId,
            live.bounds.width + 80,
            live.bounds.height + 60,
          ))
        }
      }
      if (key === 't') {
        const live = ctx.windowRegistry.getWindow(targetId)
        const monitors = ctx.windowsContext.getMonitors()
        const targetMonitor = monitors.find(monitor => monitor.id !== live?.monitorId)
        if (!targetMonitor) {
          console.log('[moveToMonitor] only one monitor is available; skipped')
        } else {
          await execute('moveToMonitor', () => ctx.windowControl.moveToMonitor(
            targetId,
            targetMonitor.id,
            { placement: 'center' },
          ))
        }
      }
      if (key === 'x') {
        await recoverHost()
      }
      if (key === 'c') {
        await execute('close', () => ctx.windowControl.close(targetId))
        await sleep(150)
        try {
          await ctx.windowControl.activate(targetId)
          console.error('[STALE-ID CHECK] unexpected success after close')
        } catch (error) {
          console.log(`[STALE-ID CHECK] rejected as expected: ${String(error)}`)
        }
      }
    } finally {
      commandBusy = false
    }
  }

  if (process.stdin.isTTY && process.stdin.setRawMode) {
    readline.emitKeypressEvents(process.stdin)
    process.stdin.setRawMode(true)
    process.stdin.on('keypress', async (_str, key) => {
      if (key.ctrl && key.name === 'c') {
        await handleCommand('q')
      } else if (key.name) {
        await handleCommand(key.name)
      }
    })
  } else {
    const rl = readline.createInterface({ input: process.stdin })
    rl.on('line', async (line) => {
      for (const ch of line.trim().split('')) {
        await handleCommand(ch)
      }
    })
  }
}

main().catch((error) => {
  console.error('Window Control demo failed:', error)
  process.exit(1)
})
