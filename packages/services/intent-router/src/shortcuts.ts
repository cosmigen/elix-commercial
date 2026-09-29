/**
 * Shortcut inspection and resolution subsystem for ELIX Intent Router.
 * Resolves Windows .lnk files, detects and terminates recursive loops,
 * and categorizes targets into app, file, folder, URL, or unsupported.
 *
 * @module @deepseek-ai/dsh-intent-router/shortcuts
 */

import type { AppRegistryEngine, AppRegistryService } from '@deepseek-ai/dsh-app-registry'
import { DefaultShellLinkResolver, type ShellLinkResolver } from '@deepseek-ai/dsh-shell-namespace'
import { safeStat } from './operations.ts'
import type { ResolvedTarget } from './types.ts'
import { InvalidInputError } from './validation.ts'

/** URL protocol scheme regex. */
const URL_SCHEME_REGEX = /^[a-z][a-z0-9+.-]*:\/\//i

/** Maximum permitted depth for nested shortcut chains before failing for recursion. */
const MAX_SHORTCUT_CHAIN_DEPTH = 16

/**
 * Resolves effective target metadata from a Windows shortcut (.lnk) file.
 */
export class ShortcutResolver {
  constructor(private readonly linkResolverSource?: ShellLinkResolver | (() => ShellLinkResolver | undefined)) {}

  private getLinkResolver(): ShellLinkResolver {
    const res = typeof this.linkResolverSource === 'function' ? this.linkResolverSource() : this.linkResolverSource
    return res ?? new DefaultShellLinkResolver()
  }

  /**
   * Resolves the effective target pointed to by a shortcut file.
   *
   * @param shortcutPath - Physical path to .lnk file.
   * @param appRegistry - Optional App Registry instance to associate app shortcuts with AppIds.
   * @returns ResolvedTarget descriptor.
   */
  async resolveEffectiveTarget(
    shortcutPath: string,
    appRegistry?: AppRegistryEngine | AppRegistryService,
  ): Promise<ResolvedTarget> {
    const linkResolver = this.getLinkResolver()
    const visited = new Set<string>([shortcutPath.toLowerCase()])
    let currentPath = shortcutPath
    let currentMeta = await linkResolver.resolve(currentPath)
    if (!currentMeta) {
      return {
        kind: 'unsupported',
        pathOrUri: currentPath,
        isBroken: true,
      }
    }

    // Follow shortcut chain if shortcut points to another shortcut
    while (
      currentMeta.target &&
      currentMeta.target.toLowerCase().endsWith('.lnk') &&
      !currentMeta.isBroken
    ) {
      const nextTarget = currentMeta.target
      const normNext = nextTarget.toLowerCase()

      if (visited.has(normNext) || visited.size >= MAX_SHORTCUT_CHAIN_DEPTH) {
        throw new InvalidInputError(
          `Recursive shortcut loop or excessive chain depth detected at "${nextTarget}".`,
          'CONFLICT',
        )
      }

      visited.add(normNext)
      currentPath = nextTarget
      const nextMeta = await linkResolver.resolve(currentPath)
      if (!nextMeta) {
        return {
          kind: 'unsupported',
          pathOrUri: currentPath,
          isBroken: true,
        }
      }
      currentMeta = nextMeta
    }

    const rawTarget = currentMeta.target?.trim()
    if (!rawTarget || currentMeta.isBroken) {
      return {
        kind: 'unsupported',
        pathOrUri: rawTarget ?? currentPath,
        isBroken: true,
        arguments: currentMeta.arguments,
        workingDirectory: currentMeta.workingDirectory,
      }
    }

    // 1. Check for URL target (http://, https://, etc.)
    if (URL_SCHEME_REGEX.test(rawTarget) || rawTarget.toLowerCase().startsWith('mailto:')) {
      return {
        kind: 'url',
        pathOrUri: rawTarget,
        arguments: currentMeta.arguments,
        workingDirectory: currentMeta.workingDirectory,
      }
    }

    // 2. Check for Application (.exe target or known AUMID)
    const isExe = rawTarget.toLowerCase().endsWith('.exe')
    if (isExe) {
      let matchedAppId: string | undefined
      if (appRegistry) {
        const apps = appRegistry.list()
        const normTarget = rawTarget.replace(/\\/g, '/').toLowerCase()
        const matched = apps.find((app) => {
          if (app.launch.kind === 'win32' || app.launch.kind === 'shortcut') {
            const exe = (app.launch as { executablePath?: string }).executablePath ?? (app.launch as { targetPath?: string }).targetPath
            return exe && exe.replace(/\\/g, '/').toLowerCase() === normTarget
          }
          return false
        })
        if (matched) {
          matchedAppId = matched.id
        }
      }

      return {
        kind: 'app',
        pathOrUri: rawTarget,
        ...(matchedAppId ? { appId: matchedAppId as import('./types.ts').AppId } : {}),
        arguments: currentMeta.arguments,
        workingDirectory: currentMeta.workingDirectory,
      }
    }

    // 3. Check filesystem target (file vs folder)
    const stat = await safeStat(rawTarget)
    if (!stat) {
      return {
        kind: 'unsupported',
        pathOrUri: rawTarget,
        isBroken: true,
        arguments: currentMeta.arguments,
        workingDirectory: currentMeta.workingDirectory,
      }
    }

    if (stat.isDirectory()) {
      return {
        kind: 'folder',
        pathOrUri: rawTarget,
        arguments: currentMeta.arguments,
        workingDirectory: currentMeta.workingDirectory,
      }
    }

    return {
      kind: 'file',
      pathOrUri: rawTarget,
      arguments: currentMeta.arguments,
      workingDirectory: currentMeta.workingDirectory,
    }
  }
}
