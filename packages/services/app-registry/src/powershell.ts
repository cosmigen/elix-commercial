/**
 * Isolated, secure, structured PowerShell execution adapter.
 *
 * Enforces:
 * 1. Strict deadlines and abort signal propagation.
 * 2. Absolute prohibition of `shell: true` (uses direct `execFile` via `runNativeCommand`).
 * 3. Zero string interpolation of user input (all scripts are static encoded scripts).
 * 4. Structured JSON output decoding with graceful failure recovery.
 * 5. Safe degradation when PowerShell is unavailable or execution is restricted.
 *
 * @module @deepseek-ai/dsh-app-registry/powershell
 */

import type { NativeCommandRunner } from '@deepseek-ai/dsh-native-command'
import { runNativeCommand } from '@deepseek-ai/dsh-native-command'
import { deadline } from '@deepseek-ai/dsh-timeout'

/** Default execution timeout for PowerShell queries (10 seconds). */
const DEFAULT_POWERSHELL_TIMEOUT_MS = 10_000

/**
 * Options controlling a single PowerShell script invocation.
 */
export interface PowerShellExecutionOptions {
  readonly timeoutMs?: number | undefined
  readonly signal?: AbortSignal | undefined
}

/**
 * Encodes a PowerShell script into a UTF-16LE base64 string for `-EncodedCommand`.
 * Completely prevents argument escaping and shell quoting vulnerabilities.
 *
 * @param script - PowerShell script text.
 * @returns UTF-16LE Base64 encoded string.
 */
export function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/**
 * Isolated adapter for running administrative or shell capability queries via PowerShell.
 */
export class PowerShellAdapter {
  private readonly runner: NativeCommandRunner
  private readonly defaultTimeoutMs: number
  private cachedAvailability: boolean | null = null

  constructor(
    runner: NativeCommandRunner = runNativeCommand,
    defaultTimeoutMs = DEFAULT_POWERSHELL_TIMEOUT_MS,
  ) {
    this.runner = runner
    this.defaultTimeoutMs = defaultTimeoutMs
  }

  /**
   * Probes whether `powershell.exe` is runnable in the current operating system environment.
   *
   * @returns True if PowerShell responds cleanly to version check.
   */
  async isAvailable(): Promise<boolean> {
    if (this.cachedAvailability !== null) {
      return this.cachedAvailability
    }

    if (process.platform !== 'win32') {
      this.cachedAvailability = false
      return false
    }

    try {
      using dl = deadline(undefined, 3_000, 'POWERSHELL_PROBE')
      const encoded = encodePowerShellCommand('$PSVersionTable.PSVersion.Major')
      const result = await this.runner(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
        dl.signal,
      )
      this.cachedAvailability = result.stdout.trim().length > 0
    } catch {
      this.cachedAvailability = false
    }

    return this.cachedAvailability
  }

  /**
   * Executes a static PowerShell script and parses its stdout as structured JSON.
   *
   * @template T - Expected JSON data type.
   * @param script - Static PowerShell script returning JSON via `ConvertTo-Json`.
   * @param options - Cancellation and deadline options.
   * @returns Parsed JSON output or undefined if empty.
   */
  async runScript<T>(
    script: string,
    options?: PowerShellExecutionOptions,
  ): Promise<T | undefined> {
    const timeout = options?.timeoutMs ?? this.defaultTimeoutMs
    using dl = deadline(options?.signal, timeout, 'POWERSHELL_EXECUTION')

    const encoded = encodePowerShellCommand(script)
    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encoded,
    ]

    const result = await this.runner('powershell.exe', args, dl.signal)
    const rawOutput = result.stdout.trim()
    if (rawOutput.length === 0) {
      return undefined
    }

    try {
      return JSON.parse(rawOutput) as T
    } catch (parseError) {
      throw new Error(
        `Failed to parse PowerShell JSON output: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
        { cause: parseError },
      )
    }
  }
}
