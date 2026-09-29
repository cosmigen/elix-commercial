/**
 * Windows `.lnk` Shell Link resolution adapter.
 *
 * Owns extracting structured shortcut metadata from `.lnk` files: target,
 * arguments, working directory, description, and icon reference.
 *
 * CRITICAL ARCHITECTURAL CONSTRAINTS:
 * 1. Phase 4 MUST NEVER execute shortcuts. Shortcut execution belongs to future Intent Router.
 * 2. Shell Namespace owns the `.lnk` item itself as a filesystem object.
 * 3. Does NOT depend on App Registry or translate shortcuts into AppId.
 * 4. PowerShell execution is strictly isolated: no `shell: true`, no user string
 *    interpolation (script is static encoded UTF-16LE base64, inputs passed via arguments),
 *    strict timeouts, safe cancellation.
 * 5. Broken shortcuts are identified without crashing or throwing.
 *
 * Phase 5 Rust Native Core will provide native COM IShellLinkW resolution behind this contract.
 *
 * @module @deepseek-ai/dsh-shell-namespace/shortcuts
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { runNativeCommand } from '@deepseek-ai/dsh-native-command'
import { deadline } from '@deepseek-ai/dsh-timeout'
import { expandEnvironmentStrings } from './known-folders.ts'
import type { ShellShortcutMetadata } from './types.ts'

/**
 * Adapter contract for resolving Windows shortcut (.lnk) metadata.
 */
export interface ShellLinkResolver {
  /**
   * Resolves metadata for a single shortcut file.
   *
   * @param linkPath - Path to the `.lnk` file.
   * @param signal - Optional cancellation signal.
   * @returns Resolved shortcut metadata or undefined if unreadable.
   */
  resolve(linkPath: string, signal?: AbortSignal): Promise<ShellShortcutMetadata | undefined>

  /**
   * Resolves metadata for multiple shortcut files in a single batch pass.
   *
   * @param linkPaths - List of `.lnk` file paths.
   * @param signal - Optional cancellation signal.
   * @returns Map of link path to resolved shortcut metadata.
   */
  resolveBatch(
    linkPaths: readonly string[],
    signal?: AbortSignal,
  ): Promise<Map<string, ShellShortcutMetadata>>
}

/**
 * Raw data structure returned by PowerShell shortcut inspection script.
 */
interface RawShortcutOutput {
  path: string
  target: string | null
  arguments: string | null
  workingDirectory: string | null
  description: string | null
  iconLocation: string | null
}


/**
 * Encodes a script to base64 UTF-16LE for PowerShell `-EncodedCommand`.
 *
 * @param script - Script text.
 * @returns Base64 string.
 */
function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/**
 * Parses raw command-line arguments string into a string array.
 *
 * @param rawArgs - Raw arguments string.
 * @returns Array of individual argument tokens.
 */
export function parseArgumentsString(rawArgs?: string | null): readonly string[] | undefined {
  if (!rawArgs || rawArgs.trim().length === 0) {
    return undefined
  }
  const trimmed = rawArgs.trim()
  // Match tokens: either quoted strings or whitespace-delimited words
  const regex = /(?:[^\s"']+|"[^"]*"|'[^']*')+/g
  const matches = trimmed.match(regex)
  if (!matches) {
    return [trimmed]
  }
  return matches.map((m) => {
    if ((m.startsWith('"') && m.endsWith('"')) || (m.startsWith("'") && m.endsWith("'"))) {
      return m.slice(1, -1)
    }
    return m
  })
}

/**
 * Default Windows shortcut resolver using isolated PowerShell COM adapter.
 */
export class DefaultShellLinkResolver implements ShellLinkResolver {
  private readonly timeoutMs: number
  private readonly cache = new Map<string, ShellShortcutMetadata>()

  constructor(options?: { timeoutMs?: number }) {
    this.timeoutMs = options?.timeoutMs ?? 5_000
  }

  async resolve(linkPath: string, signal?: AbortSignal): Promise<ShellShortcutMetadata | undefined> {
    const normalized = path.resolve(linkPath)
    const cached = this.cache.get(normalized)
    if (cached) {
      return cached
    }

    const batch = await this.resolveBatch([normalized], signal)
    return batch.get(normalized)
  }

  async resolveBatch(
    linkPaths: readonly string[],
    signal?: AbortSignal,
  ): Promise<Map<string, ShellShortcutMetadata>> {
    const results = new Map<string, ShellShortcutMetadata>()
    if (linkPaths.length === 0) {
      return results
    }

    const missingPaths: string[] = []
    for (const p of linkPaths) {
      const normalized = path.resolve(p)
      const cached = this.cache.get(normalized)
      if (cached) {
        results.set(normalized, cached)
      } else {
        missingPaths.push(normalized)
      }
    }

    if (missingPaths.length === 0) {
      return results
    }

    if (process.platform !== 'win32') {
      // Non-Windows stub: identify as shortcut without native COM
      for (const p of missingPaths) {
        const meta: ShellShortcutMetadata = {
          target: undefined,
          isBroken: false,
        }
        results.set(p, meta)
        this.cache.set(p, meta)
      }
      return results
    }

    try {
      using dl = deadline(signal, this.timeoutMs, 'RESOLVE_SHELL_LINKS')

      // Encode paths as base64 UTF-8 JSON payload to eliminate escaping/injection risks
      const b64Paths = Buffer.from(JSON.stringify(missingPaths), 'utf8').toString('base64')
      const script = `
$sh = New-Object -ComObject WScript.Shell
$rawJson = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64Paths}'))
$paths = $rawJson | ConvertFrom-Json
$results = @()
foreach ($p in $paths) {
  if (Test-Path -LiteralPath $p) {
    try {
      $sc = $sh.CreateShortcut($p)
      $results += [PSCustomObject]@{
        path = $p
        target = $sc.TargetPath
        arguments = $sc.Arguments
        workingDirectory = $sc.WorkingDirectory
        description = $sc.Description
        iconLocation = $sc.IconLocation
      }
    } catch {
      $results += [PSCustomObject]@{
        path = $p
        target = $null
        arguments = $null
        workingDirectory = $null
        description = $null
        iconLocation = $null
      }
    }
  }
}
$results | ConvertTo-Json -Depth 2 -Compress
`
      const encoded = encodePowerShell(script)

      const procResult = await runNativeCommand(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
        dl.signal,
      )

      if (procResult.stdout && procResult.stdout.trim().length > 0) {
        const parsed = JSON.parse(procResult.stdout.trim()) as
          | RawShortcutOutput
          | RawShortcutOutput[]
        const items = Array.isArray(parsed) ? parsed : [parsed]

        for (const item of items) {
          if (!item.path) continue
          const normPath = path.resolve(item.path)
          let target = item.target?.trim() || undefined
          if (target && ((target.startsWith('"') && target.endsWith('"')) || (target.startsWith("'") && target.endsWith("'")))) {
            target = target.slice(1, -1).trim()
          }
          const args = parseArgumentsString(item.arguments)
          let workingDirectory = item.workingDirectory?.trim() || undefined
          if (workingDirectory && ((workingDirectory.startsWith('"') && workingDirectory.endsWith('"')) || (workingDirectory.startsWith("'") && workingDirectory.endsWith("'")))) {
            workingDirectory = workingDirectory.slice(1, -1).trim()
          }
          const description = item.description?.trim() || undefined

          // Check if target exists; if target was specified but doesn't exist, it's broken
          let isBroken = false
          if (target && !/^[a-zA-Z]+:\/\//.test(target)) {
            // Not a URL
            try {
              const expanded = expandEnvironmentStrings(target)
              isBroken = !fs.existsSync(expanded)
            } catch {
              isBroken = true
            }
          }

          let iconRef = undefined
          if (item.iconLocation && item.iconLocation.trim().length > 0) {
            const parts = item.iconLocation.split(',')
            const iconPath = parts[0]?.trim()
            const iconIdx = parts[1] ? parseInt(parts[1].trim(), 10) : 0
            if (iconPath) {
              iconRef = {
                kind: 'resource' as const,
                sourcePath: iconPath,
                resourceIndex: isNaN(iconIdx) ? 0 : iconIdx,
              }
            }
          }

          const meta: ShellShortcutMetadata = {
            target,
            arguments: args,
            workingDirectory,
            description,
            icon: iconRef,
            isBroken,
          }

          results.set(normPath, meta)
          this.cache.set(normPath, meta)
        }
      }
    } catch {
      // Degrade gracefully on PowerShell failure
    }

    // Ensure all requested paths have at least an empty metadata entry
    for (const p of missingPaths) {
      if (!results.has(p)) {
        const fallbackMeta: ShellShortcutMetadata = {
          target: undefined,
          isBroken: true,
        }
        results.set(p, fallbackMeta)
        this.cache.set(p, fallbackMeta)
      }
    }

    return results
  }

  /** Clears cached shortcut metadata. */
  clearCache(): void {
    this.cache.clear()
  }
}

/**
 * In-memory Mock Shell Link resolver for headless tests.
 */
export class MockShellLinkResolver implements ShellLinkResolver {
  private readonly shortcuts = new Map<string, ShellShortcutMetadata>()

  constructor(initial?: Record<string, ShellShortcutMetadata>) {
    if (initial) {
      for (const [k, v] of Object.entries(initial)) {
        this.shortcuts.set(path.resolve(k), v)
      }
    }
  }

  resolve(linkPath: string): Promise<ShellShortcutMetadata | undefined> {
    const norm = path.resolve(linkPath)
    return Promise.resolve(
      this.shortcuts.get(norm) ?? {
        target: undefined,
        isBroken: true,
      },
    )
  }

  resolveBatch(
    linkPaths: readonly string[],
  ): Promise<Map<string, ShellShortcutMetadata>> {
    const res = new Map<string, ShellShortcutMetadata>()
    for (const p of linkPaths) {
      const norm = path.resolve(p)
      res.set(
        norm,
        this.shortcuts.get(norm) ?? {
          target: undefined,
          isBroken: true,
        },
      )
    }
    return Promise.resolve(res)
  }

  setShortcut(linkPath: string, meta: ShellShortcutMetadata): void {
    this.shortcuts.set(path.resolve(linkPath), meta)
  }
}
