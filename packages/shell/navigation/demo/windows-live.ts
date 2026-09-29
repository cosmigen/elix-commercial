import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import GlobalInputService from '@deepseek-ai/dsh-global-input'
import { createNativeBridge } from '@deepseek-ai/dsh-native-core'
import SpacesService from '@deepseek-ai/dsh-spaces'
import WindowControlService from '@deepseek-ai/dsh-window-control'
import WindowRegistryService from '@deepseek-ai/dsh-window-registry'
import ShellNavigationService from '../src/index.ts'

function parseDuration(argv: readonly string[]): number {
  if (argv.length === 0) return 60
  if (argv[0] === '--seconds' && argv[1]) {
    const seconds = Number(argv[1])
    if (Number.isFinite(seconds) && seconds >= 5 && seconds <= 600) return seconds
  }
  throw new Error('Usage: pnpm demo:phase18b -- [--seconds 5..600]')
}

function describeSpace(ctx: Context): string {
  const snapshot = ctx.spaces.getSnapshot()
  const current = snapshot.spaces.find(space => space.id === snapshot.currentSpaceId)
  if (!current) return snapshot.currentSpaceId ?? '(unknown)'
  return `${current.name || `Desktop ${(current.index ?? 0) + 1}`} (${current.id})`
}

async function main(): Promise<void> {
  if (process.platform !== 'win32') throw new Error('Phase 18B live acceptance requires Windows.')

  const seconds = parseDuration(process.argv.slice(2))
  const nativeHostPath = join(process.cwd(), 'native', 'target', 'debug', 'elix-native-host.exe')
  const bridge = createNativeBridge({ binaryPath: nativeHostPath, debug: false })
  const ctx = new Context()

  try {
    await bridge.connect()
    if (bridge.getCapabilities()?.globalInput !== true) {
      throw new Error('Native host does not advertise globalInput. Rebuild elix-native-bridge from the Phase 18B branch.')
    }

    await ctx.plugin(WindowRegistryService, { enabled: true, bridge })
    await ctx.plugin(SpacesService, { enabled: true, bridge })
    await ctx.plugin(GlobalInputService, { enabled: true, bridge, pollIntervalMs: 40 })
    await ctx.plugin(WindowControlService, { enabled: true, bridge })
    await ctx.plugin(ShellNavigationService, {
      enabled: true,
      registerDefaultBindings: true,
      globalInput: ctx.globalInput,
      spaces: ctx.spaces,
      windowRegistry: ctx.windowRegistry,
      windowControl: ctx.windowControl,
    })

    await ctx.windowRegistry.refresh()
    await ctx.spaces.refresh()
    const statuses = await ctx.shellNavigation.initializeBindings()

    console.log('='.repeat(78))
    console.log(' ELIX Phase 18B — GLOBAL INPUT & SHELL NAVIGATION LIVE ACCEPTANCE')
    console.log('='.repeat(78))
    console.log(`\nProvider: ${ctx.globalInput.getCapabilities().provider}`)
    console.log(`Current Space: ${describeSpace(ctx)}`)
    console.log('\nBindings:')
    for (const status of statuses) {
      console.log(`  ${status.state.padEnd(10)} ${status.command.padEnd(24)} ${status.bindingId}${status.error ? ` | ${status.error}` : ''}`)
    }

    const registered = statuses.filter(status => status.state === 'registered')
    if (registered.length !== 7) {
      throw new Error(`Expected 7 registered Phase 18B default bindings, got ${registered.length}.`)
    }

    console.log('\nLive keys:')
    console.log('  Ctrl+Alt+Shift+Right      -> next Space')
    console.log('  Ctrl+Alt+Shift+Left       -> previous Space')
    console.log('  Ctrl+Alt+Shift+O          -> Overview toggle')
    console.log('  Ctrl+Alt+Shift+J          -> task-switcher next selection')
    console.log('  Ctrl+Alt+Shift+K          -> task-switcher previous selection')
    console.log('  Ctrl+Alt+Shift+Enter      -> commit selected task')
    console.log('  Ctrl+Alt+Shift+Escape     -> cancel navigation')
    console.log('\nThe terminal does NOT need focus. Switch to another app and press the chords.')
    console.log(`Watching for ${seconds}s...\n`)

    let events = 0
    const stopNavigation = ctx.shellNavigation.subscribe(event => {
      events++
      const state = event.current
      const selected = state.selectedWindowId
        ? ctx.windowRegistry.getWindow(state.selectedWindowId)
        : undefined
      console.log(
        `[NAV ${events}] ${event.origin} ${event.command} | mode=${state.mode} offset=${state.taskSwitchOffset}`
        + ` | selected=${selected?.title || selected?.executableName || selected?.id || '-'} | Space=${describeSpace(ctx)}`,
      )
    })

    const stopInput = ctx.globalInput.subscribe(event => {
      console.log(`[INPUT] ${event.bindingId} seq=${event.sequence} key=${event.key}`)
    })

    try {
      await new Promise(resolve => setTimeout(resolve, seconds * 1000))
    } finally {
      stopNavigation()
      stopInput()
    }

    if (events === 0) throw new Error('No Phase 18B navigation event was observed during the acceptance window.')
    console.log(`\n[PASS] Observed ${events} semantic shell-navigation event(s).`)
  } finally {
    await ctx.fiber.dispose().catch(() => undefined)
    await bridge.dispose().catch(() => undefined)
  }
}

main().catch(error => {
  console.error(`[FAIL] ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exitCode = 1
})
