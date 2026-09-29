/**
 * Interactive Live Demo for ELIX Window Registry Core.
 *
 * Demonstrates real-time authoritative Windows window tracking:
 * - Real-time WinEvent message-loop observation
 * - Stable WindowId (WindowId != HWND) across lifecycle
 * - Functional classification (APPLICATION, SHELL, TOOL, TRANSIENT, SYSTEM)
 * - Monitor association via Windows Context
 * - Active foreground application tracking
 * - Non-destructive recovery
 *
 * Run with:
 *   pnpm run demo:window-registry
 * or
 *   node --import tsx/esm packages/core/window-registry/demo/live-registry.ts
 *
 * @module @deepseek-ai/dsh-window-registry/demo
 */

import * as readline from 'node:readline'
import { Context } from '@deepseek-ai/cordis'
import { createNativeBridge } from '@deepseek-ai/dsh-native-core'
import WindowsContextService from '@deepseek-ai/dsh-windows-context'
import WindowRegistryService, { type WindowSnapshot } from '../src/index.ts'

async function main() {
  console.log('='.repeat(70))
  console.log('   ELIX Window Registry Core — Live Inspection Console')
  console.log('='.repeat(70))
  console.log('Initializing Native Bridge and Cordis context...')

  const bridge = createNativeBridge({ debug: false })
  await bridge.connect()

  const ctx = new Context()
  ctx.plugin(WindowsContextService, { enabled: true, bridge })
  ctx.plugin(WindowRegistryService, { enabled: true, bridge })

  await new Promise(resolve => setTimeout(resolve, 200))

  const registry = ctx.windowRegistry

  function printSummary() {
    const snapshot = registry.getSnapshot()
    const windows = snapshot.windows

    console.log(`\n[Registry Snapshot] Revision: ${snapshot.revision} | Active Windows: ${windows.length}`)
    const fg = registry.getForegroundWindow()
    console.log(`[Foreground Window] ${fg ? `${fg.title || '<untitled>'} (${fg.id}, HWND 0x${fg.hwnd.toString(16)})` : 'None'}`)

    const counts: Record<string, number> = {}
    for (const w of windows) {
      counts[w.classification] = (counts[w.classification] ?? 0) + 1
    }
    console.log('[Classifications] ' + Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(' | '))

    console.log('\n' + '-'.repeat(165))
    console.log(
      'HWND'.padEnd(12) +
      'WindowId'.padEnd(55) +
      'Classification'.padEnd(16) +
      'State'.padEnd(12) +
      'Monitor'.padEnd(24) +
      'Process'.padEnd(20) +
      'Title',
    )
    console.log('-'.repeat(165))

    // Display top 25 windows
    const sample = windows.slice(0, 25)
    for (const w of sample) {
      const hwndStr = `0x${w.hwnd.toString(16)}`.padEnd(12)
      const idStr = w.id.padEnd(55)
      const classStr = w.classification.padEnd(16)
      const stateStr = (w.isForeground ? `*${w.state}` : w.state).padEnd(12)
      const monitorStr = (w.monitorId ?? '<unknown>').padEnd(24)
      const procStr = `${w.executableName ?? `PID:${w.processId}`}`.padEnd(20)
      const titleStr = w.title ? (w.title.length > 30 ? `${w.title.slice(0, 27)}...` : w.title) : '<no-title>'

      console.log(`${hwndStr}${idStr}${classStr}${stateStr}${monitorStr}${procStr}${titleStr}`)
    }
    if (windows.length > 25) {
      console.log(`... and ${windows.length - 25} more windows`)
    }
    console.log('-'.repeat(165))
  }

  // Subscribe to real-time events
  ctx.on('window-registry/window-created', (w: WindowSnapshot) => {
    console.log(`[+] Created: ${w.title || '<untitled>'} (${w.classification}) HWND: 0x${w.hwnd.toString(16)} -> ${w.id}`)
  })

  ctx.on('window-registry/window-destroyed', (w: WindowSnapshot) => {
    console.log(`[-] Destroyed: ${w.title || '<untitled>'} HWND: 0x${w.hwnd.toString(16)} (was ${w.id})`)
  })

  ctx.on('window-registry/window-title-changed', (change) => {
    console.log(`[~] Title Changed: 0x${change.hwnd.toString(16)} "${change.previous}" -> "${change.current}"`)
  })

  ctx.on('window-registry/window-bounds-changed', (change) => {
    const b = change.current
    console.log(`[↔] Bounds Changed: 0x${change.hwnd.toString(16)} -> x=${b.x} y=${b.y} w=${b.width} h=${b.height} monitor=${change.window.monitorId ?? '<unknown>'}`)
  })

  ctx.on('window-registry/window-state-changed', (change) => {
    console.log(`[#] State Changed: 0x${change.hwnd.toString(16)} ${change.previous} -> ${change.current}`)
  })

  ctx.on('window-registry/window-changed', (change) => {
    if (change.changes.includes('monitor')) {
      console.log(`[M] Monitor Changed: 0x${change.window.hwnd.toString(16)} -> ${change.window.monitorId ?? '<unknown>'}`)
    }
  })

  ctx.on('window-registry/window-foreground-changed', (ev) => {
    console.log(`[*] Foreground Active: ${ev.current?.title || '<none>'} (HWND: 0x${ev.current?.hwnd.toString(16) ?? '0'})`)
  })

  ctx.on('window-registry/recovered', () => {
    console.log('[R] Window Registry recovered after native host restart')
    printSummary()
  })

  printSummary()

  console.log('\nCommands:')
  console.log('  [r] Refresh snapshot')
  console.log('  [s] Print window list summary')
  console.log('  [x] Crash native host to verify automatic recovery')
  console.log('  [q] Quit demo')

  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin)
    process.stdin.setRawMode(true)

    process.stdin.on('keypress', async (_str, key) => {
      if (key.ctrl && key.name === 'c' || key.name === 'q') {
        console.log('\nShutting down...')
        await ctx.fiber.dispose()
        await bridge.dispose()
        process.exit(0)
      } else if (key.name === 'r') {
        console.log('\nRefreshing...')
        await registry.refresh()
        printSummary()
      } else if (key.name === 's') {
        printSummary()
      } else if (key.name === 'x') {
        console.log('\nCrashing native host intentionally; waiting for supervisor recovery...')
        await bridge.crashHost()
      }
    })
  } else {
    // Non-interactive mode (e.g. CI or piped execution): print summary and exit after 500ms
    setTimeout(async () => {
      await ctx.fiber.dispose()
      await bridge.dispose()
      process.exit(0)
    }, 500)
  }
}

main().catch((err) => {
  console.error('Demo error:', err)
  process.exit(1)
})
