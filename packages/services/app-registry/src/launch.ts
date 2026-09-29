/**
 * Application launch specification execution and pluggable launch adapter.
 *
 * Enforces:
 * 1. Strict separation of executable path, arguments, and working directory.
 * 2. Absolute prohibition of `shell: true` for arbitrary command strings.
 * 3. Detached process spawning with unref() so no parent-child process locks remain.
 * 4. Pluggable {@link AppLaunchAdapter} contract ready for future Rust Native Core replacement.
 *
 * @module @deepseek-ai/dsh-app-registry/launch
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import type {
  AppLaunchAdapter,
  AppLaunchOptions,
  AppLaunchResult,
  PackagedLaunchSpec,
  ShortcutLaunchSpec,
  Win32LaunchSpec,
} from './types.ts'
import { isValidFilePath } from './normalize.ts'

/**
 * Default production launch adapter for Windows and development environments.
 */
export class DefaultAppLaunchAdapter implements AppLaunchAdapter {
  /**
   * Spawns a Win32 desktop application directly without a command shell.
   *
   * @param spec - Typed Win32 launch specification.
   * @param options - Additional launch parameters.
   * @returns Outcome of the spawn attempt.
   */
  launchWin32(
    spec: Win32LaunchSpec,
    options?: AppLaunchOptions,
  ): Promise<AppLaunchResult> {
    const { executablePath, arguments: baseArgs, workingDirectory: baseCwd } = spec

    if (!isValidFilePath(executablePath)) {
      return Promise.resolve({
        success: false,
        error: `Invalid or unsafe executable path: "${executablePath}"`,
      })
    }

    const mergedArgs: string[] = [
      ...(baseArgs ?? []),
      ...(options?.additionalArgs ?? []),
    ]

    const effectiveCwd = options?.workingDirectory ?? baseCwd

    try {
      const child = spawn(executablePath, mergedArgs, {
        cwd: effectiveCwd && existsSync(effectiveCwd) ? effectiveCwd : undefined,
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
        shell: false,
      })

      // Attach error listener to prevent unhandled 'error' events from crashing host
      child.on('error', () => {})

      // Detach child so ELIX does not hold process handle or prevent exit
      child.unref()

      return Promise.resolve({
        success: true,
        pid: child.pid,
      })
    } catch (err) {
      return Promise.resolve({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /**
   * Launches a packaged MSIX/UWP application via the Windows Shell AppsFolder protocol.
   *
   * @param spec - Packaged launch specification containing canonical AUMID.
   * @param options - Additional launch parameters.
   * @returns Outcome of the launch request.
   */
  launchPackaged(
    spec: PackagedLaunchSpec,
    options?: AppLaunchOptions,
  ): Promise<AppLaunchResult> {
    const { aumid } = spec
    if (!aumid || aumid.trim().length === 0) {
      return Promise.resolve({
        success: false,
        error: 'Missing required AUMID for packaged application launch',
      })
    }

    // Windows Shell standard invocation: explorer.exe shell:AppsFolder\<AUMID>
    const targetUri = `shell:AppsFolder\\${aumid.trim()}`
    const extraArgs = options?.additionalArgs ?? []

    try {
      const child = spawn('explorer.exe', [targetUri, ...extraArgs], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
        shell: false,
      })

      child.on('error', () => {})
      child.unref()

      return Promise.resolve({
        success: true,
        pid: child.pid,
      })
    } catch (err) {
      return Promise.resolve({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /**
   * Launches a shortcut-backed application by delegating to its target or explorer.
   *
   * @param spec - Shortcut launch specification.
   * @param options - Additional launch parameters.
   * @returns Outcome of the launch request.
   */
  launchShortcut(
    spec: ShortcutLaunchSpec,
    options?: AppLaunchOptions,
  ): Promise<AppLaunchResult> {
    const { targetPath, shortcutPath, arguments: baseArgs, workingDirectory } = spec

    // If target executable exists and ends with .exe, launch directly as Win32
    if (targetPath && targetPath.toLowerCase().endsWith('.exe')) {
      return this.launchWin32(
        {
          kind: 'win32',
          executablePath: targetPath,
          arguments: baseArgs,
          workingDirectory,
        },
        options,
      )
    }

    // Otherwise launch shortcut file via explorer
    if (shortcutPath && isValidFilePath(shortcutPath)) {
      try {
        const child = spawn('explorer.exe', [shortcutPath], {
          detached: true,
          stdio: 'ignore',
          windowsHide: false,
          shell: false,
        })

        child.on('error', () => {})
        child.unref()

        return Promise.resolve({
          success: true,
          pid: child.pid,
        })
      } catch (err) {
        return Promise.resolve({
          success: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    return Promise.resolve({
      success: false,
      error: `Cannot launch shortcut with invalid target or path: "${shortcutPath}"`,
    })
  }
}
