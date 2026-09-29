import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import { createNativeBridge } from '@deepseek-ai/dsh-native-core'
import WindowsContextService from '@deepseek-ai/dsh-windows-context'
import WindowRegistryService, { type WindowId, type WindowSnapshot } from '@deepseek-ai/dsh-window-registry'
import WindowControlService from '@deepseek-ai/dsh-window-control'
import ShellLayoutService from '@deepseek-ai/dsh-shell-layout'
import WindowPlacementService from '@deepseek-ai/dsh-window-placement'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function captureWindow(hwnd: number, name: string): void {
  const pngPath = path.resolve(process.cwd(), '.agents', 'reports', 'visual-audit', 'evidence', `${name}.png`)
  const script = path.resolve(process.cwd(), '.audit', 'phase1-through-16d', 'capture_window.ps1')
  execFileSync('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-File', script, String(hwnd), pngPath], { stdio: 'inherit' })
  console.log(`[CAPTURED] ${path.basename(pngPath)}`)
}

function captureScreen(name: string): void {
  const pngPath = path.resolve(process.cwd(), '.agents', 'reports', 'visual-audit', 'evidence', `${name}.png`)
  const script = path.resolve(process.cwd(), '.audit', 'phase1-through-16d', 'capture_screen.ps1')
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, pngPath], { stdio: 'inherit' })
  console.log(`[CAPTURED] ${path.basename(pngPath)}`)
}

function updateNotepad(hwnd: number, text: string): void {
  const script = path.resolve(process.cwd(), 'artifacts', 'phase17a-real-app-acceptance', 'update_notepad.py')
  execFileSync('python', [script, `0x${hwnd.toString(16)}`, text], { stdio: 'inherit' })
}

async function waitForWindow(
  registry: WindowRegistryService,
  existing: ReadonlySet<WindowId>,
  pid: number | undefined,
  titleFragment: string,
): Promise<WindowSnapshot> {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    await registry.refresh()
    const match = registry.getWindows().find(window => (
      window.className === 'Notepad'
      && window.isVisible
      && window.state === 'normal'
      && (
        window.title.toLowerCase().includes(titleFragment.toLowerCase())
        || (!existing.has(window.id) && (pid === undefined || window.processId === pid || window.classification === 'APPLICATION'))
      )
    ))
    if (match) return match
    await sleep(50)
  }
  throw new Error('Phase 17B did not observe the dedicated restored Notepad window')
}

function assertApplied(label: string, result: { status: string; appliedRect?: unknown }): void {
  console.log(`[${label}] status=${result.status} appliedRect=${JSON.stringify(result.appliedRect ?? null)}`)
  if (result.status !== 'applied' && result.status !== 'adjusted') {
    throw new Error(`${label} did not apply: ${JSON.stringify(result)}`)
  }
}

async function main(): Promise<void> {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'elix-phase17b-visual-audit-'))
  const testFile = path.join(stateDir, 'ELIX_PHASE17B_PLACEMENT.txt')
  fs.writeFileSync(testFile, 'ELIX Phase 17B manual placement acceptance\r\n', 'utf8')
  const bridge = createNativeBridge({
    binaryPath: path.resolve(process.cwd(), 'native', 'target', 'debug', 'elix-native-host.exe'),
    supervisor: { autoRestart: true, initialBackoffMs: 20, maxBackoffMs: 100 },
  })
  const ctx = new Context()
  let child: ChildProcess | undefined
  let target: WindowSnapshot | undefined

  try {
    await bridge.connect()
    await ctx.plugin(WindowsContextService, { enabled: true, bridge })
    await ctx.plugin(WindowRegistryService, { enabled: true, bridge })
    await ctx.plugin(WindowControlService, { enabled: true, bridge })
    await ctx.plugin(ShellLayoutService, { enabled: true })
    await ctx.plugin(WindowPlacementService, { enabled: true, maxDisplayReplans: 2 })
    await sleep(250)

    const existing = new Set(ctx.windowRegistry.getWindows().map(window => window.id))
    child = spawn('notepad.exe', [testFile], { stdio: 'ignore', windowsHide: false })
    target = await waitForWindow(ctx.windowRegistry, existing, child.pid, path.basename(testFile))
    console.log(`[TARGET] WindowId=${target.id} HWND=0x${target.hwnd.toString(16)} PID=${target.processId}`)
    updateNotepad(target.hwnd, '============================================================\r\n ELIX PHASE 17B — MANUAL WINDOW PLACEMENT\r\n============================================================\r\nCurrent state: ORIGINAL RESTORE BASELINE\r\nPolicy: work-area-aware physical-pixel placement\r\n============================================================')
    await sleep(300)
    captureWindow(target.hwnd, 'P17B_placement_original')

    const left = await ctx.windowPlacement.place(target.id, { kind: 'left-half' })
    try {
      assertApplied('LEFT HALF', left)
    } catch (error) {
      if (target) captureWindow(target.hwnd, 'P17B_placement_failure_constraints')
      throw error
    }
    await sleep(300)
    captureScreen('P17B_placement_left_half')

    const right = await ctx.windowPlacement.place(target.id, { kind: 'right-half' })
    assertApplied('RIGHT HALF', right)
    await sleep(300)
    captureScreen('P17B_placement_right_half')

    let restore: Awaited<ReturnType<typeof ctx.windowPlacement.restorePlacement>>
    try {
      restore = await ctx.windowPlacement.restorePlacement(target.id)
      assertApplied('RESTORE', restore)
    } catch (error) {
      captureScreen('P17B_placement_restore_failure')
      throw error
    }
    await sleep(300)
    captureWindow(target.hwnd, 'P17B_placement_restored')

    const record = ctx.windowPlacement.getPlacementRecord(target.id)
    if (record) throw new Error('Phase 17B retained a placement record after successful restore')
    console.log('[RECORD] released after successful restore')

    const closed = await ctx.windowControl.close(target.id)
    console.log(`[CLOSE] accepted=${closed.accepted} completed=${closed.completed}`)
    await sleep(250)
    const stale = await ctx.windowPlacement.place(target.id, { kind: 'center' })
    console.log(`[STALE-ID] status=${stale.status} reason=${stale.reason ?? '-'} detail=${stale.detail ?? '-'}`)
    if (stale.reason !== 'stale-window-id') throw new Error(`Expected stale-window-id rejection, got ${JSON.stringify(stale)}`)
    console.log('PHASE 17B VISUAL RUNNER PASSED')
  } finally {
    if (target && ctx.windowRegistry.getWindow(target.id)) await ctx.windowControl.close(target.id).catch(() => undefined)
    await ctx.fiber.dispose().catch(() => undefined)
    await bridge.dispose().catch(() => undefined)
    if (child && child.exitCode === null && child.pid !== undefined) {
      try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
    }
    try { fs.rmSync(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) } catch (error) {
      console.warn(`Phase 17B temporary cleanup was not complete: ${String(error)}`)
    }
  }
}

main().catch(error => {
  console.error('PHASE 17B VISUAL RUNNER FAILED')
  console.error(error)
  process.exitCode = 1
})
