import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createNativeBridge } from '@deepseek-ai/dsh-native-core'
import WindowRegistryService, {
  type WindowId,
  type WindowSnapshot,
} from '@deepseek-ai/dsh-window-registry'
import SpacesService, { type SpaceId } from '../src/index.ts'

type Command =
  | { readonly kind: 'inspect' }
  | { readonly kind: 'smoke' }
  | { readonly kind: 'watch', readonly seconds: number }
  | { readonly kind: 'switch', readonly spaceId: SpaceId }
  | { readonly kind: 'create', readonly name?: string | undefined }
  | { readonly kind: 'rename', readonly spaceId: SpaceId, readonly name: string }
  | { readonly kind: 'remove', readonly spaceId: SpaceId, readonly fallbackSpaceId: SpaceId }
  | { readonly kind: 'move-title', readonly titleQuery: string, readonly destination?: SpaceId | undefined }

function parseArgs(argv: readonly string[]): Command {
  if (argv.length === 0) return { kind: 'inspect' }

  if (argv[0] === '--shell-smoke') return { kind: 'smoke' }

  if (argv[0] === '--watch') {
    const seconds = argv[1] === undefined ? 20 : Number(argv[1])
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 300) {
      throw new Error('--watch duration must be between 1 and 300 seconds.')
    }
    return { kind: 'watch', seconds }
  }

  if (argv[0] === '--switch') {
    if (!argv[1]) throw new Error('Usage: pnpm demo:phase18a -- --switch <SpaceId>')
    return { kind: 'switch', spaceId: argv[1] as SpaceId }
  }

  if (argv[0] === '--create') {
    return argv[1] === undefined
      ? { kind: 'create' }
      : { kind: 'create', name: argv[1] }
  }

  if (argv[0] === '--rename') {
    if (!argv[1] || !argv[2]) {
      throw new Error('Usage: pnpm demo:phase18a -- --rename <SpaceId> <name>')
    }
    return { kind: 'rename', spaceId: argv[1] as SpaceId, name: argv[2] }
  }

  if (argv[0] === '--remove') {
    if (!argv[1] || !argv[2]) {
      throw new Error('Usage: pnpm demo:phase18a -- --remove <SpaceId> <fallbackSpaceId>')
    }
    return {
      kind: 'remove',
      spaceId: argv[1] as SpaceId,
      fallbackSpaceId: argv[2] as SpaceId,
    }
  }

  if (argv[0] === '--move-current-title') {
    if (!argv[1]) {
      throw new Error(
        'Usage: pnpm demo:phase18a -- --move-current-title <unique-title-substring> [destinationSpaceId]',
      )
    }
    return {
      kind: 'move-title',
      titleQuery: argv[1],
      ...(argv[2] ? { destination: argv[2] as SpaceId } : {}),
    }
  }

  throw new Error(
    `Unknown Phase 18A acceptance argument '${argv[0]}'. Use no arguments, --shell-smoke, --watch, --switch, --create, --rename, --remove, or --move-current-title.`,
  )
}

function windowLabel(window: WindowSnapshot): string {
  return window.title || window.executableName || '(untitled)'
}

function resolveUniqueApplication(
  applications: readonly WindowSnapshot[],
  titleQuery: string,
): WindowSnapshot {
  const normalized = titleQuery.toLocaleLowerCase()
  const matches = applications.filter(window =>
    windowLabel(window).toLocaleLowerCase().includes(normalized),
  )
  if (matches.length === 0) {
    throw new Error(`No current APPLICATION window matches '${titleQuery}'.`)
  }
  if (matches.length > 1) {
    throw new Error(
      `Title query '${titleQuery}' matched ${matches.length} APPLICATION windows: ${matches.map(windowLabel).join(' | ')}`,
    )
  }
  return matches[0]!
}

function printSnapshot(snapshot: ReturnType<SpacesService['getSnapshot']>): void {
  console.log('\n=== ELIX Phase 18A Spaces snapshot ===')
  console.log(`revision: ${snapshot.revision}`)
  console.log(`provider: ${snapshot.capabilities.provider}`)
  console.log(`completeness: ${snapshot.completeness}`)
  console.log(`currentSpaceId: ${snapshot.currentSpaceId ?? '(unknown)'}`)
  console.log(`unresolvedWindowIds: ${snapshot.unresolvedWindowIds.length}`)
  console.log(`spaces: ${snapshot.spaces.length}`)
  for (const space of snapshot.spaces) {
    const metadata = [
      space.index === undefined ? undefined : `index=${space.index}`,
      space.name ? `name=${JSON.stringify(space.name)}` : undefined,
      `windows=${space.windowIds.length}`,
    ].filter(Boolean).join(' ')
    console.log(`  ${space.isCurrent ? '*' : ' '} ${space.id} ${metadata}`)
    for (const windowId of space.windowIds) console.log(`      - ${windowId}`)
  }
}

function assertFullShellProvider(spaces: SpacesService): void {
  const capabilities = spaces.getCapabilities()
  const required = [
    capabilities.enumerateSpaces,
    capabilities.switchSpace,
    capabilities.createSpace,
    capabilities.removeSpace,
    capabilities.renameSpace,
    capabilities.moveWindow,
  ]
  if (
    capabilities.provider !== 'windows-shell-virtual-desktop'
    || required.some(value => value !== true)
  ) {
    throw new Error(
      `Full Phase 18A Shell provider is unavailable. Active capabilities: ${JSON.stringify(capabilities)}`,
    )
  }
}

async function printApplicationMembership(ctx: Context): Promise<readonly WindowSnapshot[]> {
  const applications = ctx.windowRegistry
    .getWindows()
    .filter(window => window.classification === 'APPLICATION')
  console.log(`\nAPPLICATION windows: ${applications.length}`)
  for (const window of applications) {
    try {
      const membership = await ctx.spaces.getWindowSpace(window.id)
      console.log(
        `[PASS] ${window.id} | ${windowLabel(window)} | ${membership.spaceId} | current=${membership.onCurrentSpace}`,
      )
    } catch (error) {
      console.log(
        `[WARN] ${window.id} | ${windowLabel(window)} | ${String(error)}`,
      )
    }
  }
  return applications
}

async function runShellSmoke(spaces: SpacesService): Promise<void> {
  assertFullShellProvider(spaces)
  const before = await spaces.refresh()
  const originalCurrent = before.currentSpaceId
  if (!originalCurrent) throw new Error('Shell provider did not expose a current Space.')

  const acceptanceName = `ELIX 18A Acceptance ${Date.now()}`
  let createdId: SpaceId | undefined
  try {
    console.log(`\n[SMOKE] Creating temporary Space '${acceptanceName}'...`)
    const created = await spaces.createSpace(acceptanceName)
    createdId = created.id
    console.log(`[PASS] create ${created.id}`)

    const renamedName = `${acceptanceName} Renamed`
    const renamed = await spaces.renameSpace(created.id, renamedName)
    if (renamed.name !== renamedName) throw new Error('Rename verification mismatch.')
    console.log(`[PASS] rename ${renamed.id} -> ${JSON.stringify(renamed.name)}`)

    const switched = await spaces.switchSpace(created.id)
    if (switched.currentSpaceId !== created.id) throw new Error('Switch-to-created verification mismatch.')
    console.log(`[PASS] switch ${originalCurrent} -> ${created.id}`)

    const switchedBack = await spaces.switchSpace(originalCurrent)
    if (switchedBack.currentSpaceId !== originalCurrent) throw new Error('Switch-back verification mismatch.')
    console.log(`[PASS] switch ${created.id} -> ${originalCurrent}`)

    const removed = await spaces.removeSpace(created.id, originalCurrent)
    if (removed.spaces.some(space => space.id === created.id)) {
      throw new Error('Temporary Space still exists after remove.')
    }
    createdId = undefined
    console.log('[PASS] remove temporary Space with explicit fallback')
    console.log('\n[PASS] Phase 18A Shell lifecycle smoke completed.')
  } finally {
    if (createdId) {
      try {
        const current = spaces.getCurrentSpaceId()
        if (current === createdId) await spaces.switchSpace(originalCurrent)
        await spaces.removeSpace(createdId, originalCurrent)
        console.log(`[INFO] Cleaned up temporary acceptance Space ${createdId}.`)
      } catch (error) {
        console.warn(`[WARN] Temporary acceptance Space cleanup needs attention: ${String(error)}`)
      }
    }
  }
}

async function main(): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error('Phase 18A live acceptance requires Windows.')
  }

  const command = parseArgs(process.argv.slice(2))
  const nativeHostPath = join(process.cwd(), 'native', 'target', 'debug', 'elix-native-host.exe')
  const bridge = createNativeBridge({ binaryPath: nativeHostPath, debug: false })
  const ctx = new Context()

  try {
    await bridge.connect()
    if (bridge.getCapabilities()?.spaces !== true) {
      throw new Error('Native host does not advertise Spaces. Rebuild elix-native-bridge from this branch.')
    }

    await ctx.plugin(WindowRegistryService, { enabled: true, bridge })
    await ctx.plugin(SpacesService, { enabled: true, bridge })
    await ctx.windowRegistry.refresh()
    const snapshot = await ctx.spaces.refresh()

    console.log('='.repeat(78))
    console.log(' ELIX Phase 18A — WINDOWS SPACES LIVE ACCEPTANCE')
    console.log('='.repeat(78))
    console.log('\nCapabilities:')
    console.log(JSON.stringify(ctx.spaces.getCapabilities(), null, 2))
    printSnapshot(snapshot)

    if (command.kind === 'inspect') {
      await printApplicationMembership(ctx)
      if (ctx.spaces.getCapabilities().provider === 'windows-shell-virtual-desktop') {
        console.log('\n[PASS] Full Shell provider runtime probe succeeded.')
        console.log('[INFO] Run `pnpm demo:phase18a -- --shell-smoke` for create/rename/switch/remove acceptance.')
        console.log('[INFO] Keep a uniquely named app on another desktop and run')
        console.log('       `pnpm demo:phase18a -- --move-current-title "notepad_test.txt"` for move acceptance.')
        console.log('[INFO] Run `pnpm demo:phase18a -- --watch 20` and use Win+Ctrl+Left/Right or Task View')
        console.log('       during the watch window to verify external desktop-change detection.')
      } else {
        console.log('\n[PASS] Documented membership fallback is healthy.')
        console.log('[WARN] Full Shell provider did not runtime-qualify on this Windows session/build.')
      }
      return
    }

    if (command.kind === 'smoke') {
      await runShellSmoke(ctx.spaces)
      printSnapshot(await ctx.spaces.refresh())
      return
    }

    if (command.kind === 'watch') {
      assertFullShellProvider(ctx.spaces)
      console.log(`\n[WATCH] Watching Spaces for ${command.seconds}s. Change desktops externally now.`)
      let events = 0
      const stop = ctx.spaces.subscribe(next => {
        events++
        console.log(`\n[CHANGE ${events}]`)
        printSnapshot(next)
      })
      try {
        await new Promise(resolve => setTimeout(resolve, command.seconds * 1000))
      } finally {
        stop()
      }
      if (events === 0) {
        throw new Error('No Spaces change was observed during the watch interval.')
      }
      console.log(`\n[PASS] Observed ${events} Spaces snapshot change event(s).`)
      return
    }

    if (command.kind === 'switch') {
      assertFullShellProvider(ctx.spaces)
      const result = await ctx.spaces.switchSpace(command.spaceId)
      console.log(`[PASS] switched current Space -> ${result.currentSpaceId}`)
      printSnapshot(result)
      return
    }

    if (command.kind === 'create') {
      assertFullShellProvider(ctx.spaces)
      const created = await ctx.spaces.createSpace(command.name)
      console.log(`[PASS] created ${created.id}${created.name ? ` name=${JSON.stringify(created.name)}` : ''}`)
      printSnapshot(await ctx.spaces.refresh())
      return
    }

    if (command.kind === 'rename') {
      assertFullShellProvider(ctx.spaces)
      const renamed = await ctx.spaces.renameSpace(command.spaceId, command.name)
      console.log(`[PASS] renamed ${renamed.id} -> ${JSON.stringify(renamed.name ?? '')}`)
      printSnapshot(await ctx.spaces.refresh())
      return
    }

    if (command.kind === 'remove') {
      assertFullShellProvider(ctx.spaces)
      const result = await ctx.spaces.removeSpace(command.spaceId, command.fallbackSpaceId)
      console.log(`[PASS] removed ${command.spaceId}; fallback=${command.fallbackSpaceId}`)
      printSnapshot(result)
      return
    }

    assertFullShellProvider(ctx.spaces)
    const applications = ctx.windowRegistry
      .getWindows()
      .filter(window => window.classification === 'APPLICATION')
    const source = resolveUniqueApplication(applications, command.titleQuery)
    const before = await ctx.spaces.getWindowSpace(source.id)
    const destination = command.destination ?? ctx.spaces.getCurrentSpaceId()
    if (!destination) throw new Error('No current destination Space is available.')
    if (before.spaceId === destination) {
      throw new Error(`Window '${windowLabel(source)}' is already on destination ${destination}.`)
    }

    console.log(`\n[MOVE] ${source.id} | ${windowLabel(source)} | ${before.spaceId} -> ${destination}`)
    const result = await ctx.spaces.moveWindowToSpace(source.id as WindowId, destination)
    if (result.spaceId !== destination) throw new Error('Move verification mismatch.')
    console.log(`[PASS] move committed ${before.spaceId} -> ${result.spaceId}`)
    printSnapshot(await ctx.spaces.refresh())
  } finally {
    await ctx.fiber.dispose().catch(() => undefined)
    await bridge.dispose().catch(() => undefined)
  }
}

main().catch(error => {
  console.error(`[FAIL] ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exitCode = 1
})
