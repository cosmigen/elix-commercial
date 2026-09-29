/**
 * Native Application Launch adapter backed by the Rust Native Core.
 *
 * Implements AppLaunchAdapter using CreateProcessW without shell invocation for Win32
 * and shell AppsFolder protocol for Packaged applications over the typed bridge.
 *
 * @module @deepseek-ai/dsh-native-core/adapters/launch
 */

import type { NativeBridgeClient } from '../client.ts'

export interface AppLaunchOptions {
  readonly additionalArgs?: readonly string[] | undefined
  readonly workingDirectory?: string | undefined
}

export interface AppLaunchResult {
  readonly success: boolean
  readonly pid?: number | undefined
  readonly error?: string | undefined
}

export interface Win32LaunchSpec {
  readonly kind: 'win32'
  readonly executablePath: string
  readonly arguments?: readonly string[] | undefined
  readonly workingDirectory?: string | undefined
}

export interface PackagedLaunchSpec {
  readonly kind: 'packaged'
  readonly aumid: string
}

export interface ShortcutLaunchSpec {
  readonly kind: 'shortcut'
  readonly shortcutPath: string
  readonly targetPath?: string | undefined
  readonly arguments?: readonly string[] | undefined
  readonly workingDirectory?: string | undefined
}

export interface AppLaunchAdapter {
  launchWin32(spec: Win32LaunchSpec, options?: AppLaunchOptions): Promise<AppLaunchResult>
  launchPackaged(spec: PackagedLaunchSpec, options?: AppLaunchOptions): Promise<AppLaunchResult>
  launchShortcut(spec: ShortcutLaunchSpec, options?: AppLaunchOptions): Promise<AppLaunchResult>
}

/**
 * App launch adapter delegating to Rust Native Core.
 */
export class NativeAppLaunchAdapter implements AppLaunchAdapter {
  private readonly client: NativeBridgeClient

  constructor(client: NativeBridgeClient) {
    this.client = client
  }

  async launchWin32(
    spec: Win32LaunchSpec,
    options?: AppLaunchOptions,
  ): Promise<AppLaunchResult> {
    const mergedArgs = [
      ...(spec.arguments ?? []),
      ...(options?.additionalArgs ?? []),
    ]

    const effectiveCwd = options?.workingDirectory ?? spec.workingDirectory

    const res = await this.client.process.launchWin32({
      executablePath: spec.executablePath,
      arguments: mergedArgs.length > 0 ? mergedArgs : undefined,
      workingDirectory: effectiveCwd,
    })

    return {
      success: res.success,
      pid: res.pid,
      error: res.error,
    }
  }

  async launchPackaged(
    spec: PackagedLaunchSpec,
    options?: AppLaunchOptions,
  ): Promise<AppLaunchResult> {
    const res = await this.client.process.launchPackaged({
      aumid: spec.aumid,
      arguments: options?.additionalArgs,
    })

    return {
      success: res.success,
      pid: res.pid,
      error: res.error,
    }
  }

  async launchShortcut(
    spec: ShortcutLaunchSpec,
    options?: AppLaunchOptions,
  ): Promise<AppLaunchResult> {
    if (spec.targetPath && spec.targetPath.toLowerCase().endsWith('.exe')) {
      return this.launchWin32(
        {
          kind: 'win32',
          executablePath: spec.targetPath,
          arguments: spec.arguments,
          workingDirectory: spec.workingDirectory,
        },
        options,
      )
    }

    // Delegate shortcut launch via explorer.exe invocation
    const target = spec.targetPath ?? spec.shortcutPath
    return this.launchWin32(
      {
        kind: 'win32',
        executablePath: 'explorer.exe',
        arguments: [target, ...(options?.additionalArgs ?? [])],
        workingDirectory: options?.workingDirectory ?? spec.workingDirectory,
      },
      options,
    )
  }
}
