import { execFileSync, spawn } from 'node:child_process'
import * as path from 'node:path'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function main(): Promise<void> {
  const cwd = process.cwd()
  const child = spawn(process.execPath, ['--import', 'tsx/esm', 'packages/services/application-runtime/demo/process-lifecycle.ts'], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout.on('data', data => process.stdout.write(data))
  child.stderr.on('data', data => process.stderr.write(data))
  await sleep(5000)
  const hwndText = execFileSync('powershell.exe', [
    '-NoProfile',
    '-Command',
    "$p = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like '*Phase 16D*' } | Select-Object -First 1; if ($p) { $p.MainWindowHandle }",
  ], { encoding: 'utf8' }).trim()
  if (hwndText.length > 0) {
    execFileSync('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.resolve(cwd, '.audit', 'phase1-through-16d', 'capture_window.ps1'),
      hwndText,
      path.resolve(cwd, '.agents', 'reports', 'visual-audit', 'evidence', 'P16D_lifecycle_visible_window.png'),
    ], { stdio: 'inherit' })
  } else {
    execFileSync('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.resolve(cwd, '.audit', 'phase1-through-16d', 'capture_screen.ps1'),
      path.resolve(cwd, '.agents', 'reports', 'visual-audit', 'evidence', 'P16D_lifecycle_visible_window.png'),
    ], { stdio: 'inherit' })
  }
  const exitCode = await new Promise<number>(resolve => {
    child.once('exit', (code, signal) => resolve(code ?? (signal === null ? 1 : 1)))
  })
  if (exitCode !== 0) throw new Error(`Phase 16D child exited with ${exitCode}`)
}

main().catch(error => {
  console.error('Phase 16D screen wrapper failed:', error)
  process.exitCode = 1
})
