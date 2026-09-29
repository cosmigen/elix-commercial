import { execFileSync, spawn } from 'node:child_process'
import * as path from 'node:path'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function main(): Promise<void> {
  const cwd = process.cwd()
  const child = spawn(process.execPath, ['--import', 'tsx/esm', 'packages/services/application-runtime/demo/live-runtime.ts'], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout.on('data', data => process.stdout.write(data))
  child.stderr.on('data', data => process.stderr.write(data))
  const captureScript = path.resolve(cwd, '.audit', 'phase1-through-16d', 'capture_window.ps1')
  const outputPath = path.resolve(cwd, '.agents', 'reports', 'visual-audit', 'evidence', 'P15_application_runtime_visible_window.png')
  let captured = false
  const deadline = Date.now() + 8000
  while (!captured && Date.now() < deadline) {
    const hwnd = execFileSync('powershell.exe', [
      '-NoProfile',
      '-Command',
      "$p = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like '*Phase 15 Acceptance*' } | Select-Object -First 1; if ($p) { $p.MainWindowHandle }",
    ], { encoding: 'utf8' }).trim()
    if (hwnd.length > 0) {
      execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', captureScript, hwnd, outputPath], { stdio: 'inherit' })
      captured = true
    } else {
      await sleep(100)
    }
  }
  const exitCode = await new Promise<number>(resolve => child.once('exit', code => resolve(code ?? 1)))
  if (!captured) throw new Error('Phase 15 visible acceptance window was not observed for capture')
  if (exitCode !== 0) throw new Error(`Phase 15 child exited with ${exitCode}`)
}

main().catch(error => {
  console.error('Phase 15 screen wrapper failed:', error)
  process.exitCode = 1
})
