import { describe, expect, it, vi } from 'vitest'
import { DefaultAppLaunchAdapter } from '../src/launch.ts'
import type {
  AppLaunchAdapter,
  PackagedLaunchSpec,
  ShortcutLaunchSpec,
  Win32LaunchSpec,
} from '../src/types.ts'

describe('AppLaunchAdapter & Execution Architecture', () => {
  it('rejects invalid or unsafe executable paths before spawning', async () => {
    const adapter = new DefaultAppLaunchAdapter()
    const invalidSpec: Win32LaunchSpec = {
      kind: 'win32',
      executablePath: 'C:\\Scripts\\malicious.vbs',
    }

    const result = await adapter.launchWin32(invalidSpec)
    expect(result.success).toBe(false)
    expect(result.error).toContain('Invalid or unsafe executable path')
  })

  it('rejects packaged launch specification when AUMID is empty', async () => {
    const adapter = new DefaultAppLaunchAdapter()
    const emptyAumidSpec: PackagedLaunchSpec = {
      kind: 'packaged',
      aumid: '',
    }

    const result = await adapter.launchPackaged(emptyAumidSpec)
    expect(result.success).toBe(false)
    expect(result.error).toContain('Missing required AUMID')
  })

  it('supports pluggable custom launch adapters (future Rust Native Core contract)', async () => {
    const mockLaunchWin32 = vi.fn().mockResolvedValue({ success: true, pid: 1234 })
    const mockLaunchPackaged = vi.fn().mockResolvedValue({ success: true, pid: 5678 })
    const mockLaunchShortcut = vi.fn().mockResolvedValue({ success: true, pid: 9999 })

    const customAdapter: AppLaunchAdapter = {
      launchWin32: mockLaunchWin32,
      launchPackaged: mockLaunchPackaged,
      launchShortcut: mockLaunchShortcut,
    }

    const win32Spec: Win32LaunchSpec = {
      kind: 'win32',
      executablePath: 'C:\\Windows\\System32\\notepad.exe',
      arguments: ['test.txt'],
    }

    const result = await customAdapter.launchWin32(win32Spec, { additionalArgs: ['--readonly'] })
    expect(result.success).toBe(true)
    expect(result.pid).toBe(1234)
    expect(mockLaunchWin32).toHaveBeenCalledWith(win32Spec, { additionalArgs: ['--readonly'] })

    const pkgSpec: PackagedLaunchSpec = {
      kind: 'packaged',
      aumid: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App',
    }
    const pkgResult = await customAdapter.launchPackaged(pkgSpec)
    expect(pkgResult.success).toBe(true)
    expect(pkgResult.pid).toBe(5678)

    const scSpec: ShortcutLaunchSpec = {
      kind: 'shortcut',
      shortcutPath: 'C:\\Shortcuts\\app.lnk',
      targetPath: 'C:\\App\\app.exe',
    }
    const scResult = await customAdapter.launchShortcut(scSpec)
    expect(scResult.success).toBe(true)
    expect(scResult.pid).toBe(9999)
  })
})
