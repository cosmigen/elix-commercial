import type { AppId, AppRecord } from '@deepseek-ai/dsh-app-registry'
import type { ProcessEntry } from '@deepseek-ai/dsh-process-observation'
import { normalizeAumid, normalizeWindowsExecutablePath } from './matching.ts'
import type { ApplicationProcessMatchKind } from './types.ts'

export interface ApplicationProcessMatch {
  readonly appId: AppId
  readonly kind: ApplicationProcessMatchKind
}

export interface ApplicationProcessNoMatch {
  readonly reason: 'missing-identity-evidence' | 'no-catalog-match' | 'ambiguous-catalog-match'
  readonly candidateAppIds: readonly AppId[]
}

export type ApplicationProcessMatchResult = ApplicationProcessMatch | ApplicationProcessNoMatch

/** Pure catalog matcher for raw process facts. App-level launch hints/lineage are layered later. */
export class ApplicationProcessMatcher {
  private readonly byAumid = new Map<string, AppId[]>()
  private readonly byExecutablePath = new Map<string, AppId[]>()
  private readonly byShortcutTarget = new Map<string, AppId[]>()

  constructor(apps: readonly AppRecord[]) {
    for (const app of apps) {
      switch (app.launch.kind) {
        case 'packaged': {
          const aumid = normalizeAumid(app.launch.aumid)
          if (aumid) appendUnique(this.byAumid, aumid, app.id)
          break
        }
        case 'win32': {
          const executablePath = normalizeWindowsExecutablePath(app.launch.executablePath)
          if (executablePath) appendUnique(this.byExecutablePath, executablePath, app.id)
          break
        }
        case 'shortcut': {
          const target = normalizeWindowsExecutablePath(app.launch.targetPath)
          if (target) appendUnique(this.byShortcutTarget, target, app.id)
          break
        }
      }
    }
  }

  match(process: ProcessEntry): ApplicationProcessMatchResult {
    if (process.aumid) {
      const aumid = normalizeAumid(process.aumid)
      if (!aumid) return noMatch('missing-identity-evidence')
      return resolveCandidates(this.byAumid.get(aumid), 'aumid')
    }

    if (process.executablePath) {
      const executablePath = normalizeWindowsExecutablePath(process.executablePath)
      if (!executablePath) return noMatch('missing-identity-evidence')

      const direct = this.byExecutablePath.get(executablePath)
      if (direct && direct.length > 0) return resolveCandidates(direct, 'executable-path')

      const shortcut = this.byShortcutTarget.get(executablePath)
      if (shortcut && shortcut.length > 0) return resolveCandidates(shortcut, 'shortcut-target')
      return noMatch('no-catalog-match')
    }

    return noMatch('missing-identity-evidence')
  }
}

function appendUnique(map: Map<string, AppId[]>, key: string, appId: AppId): void {
  const current = map.get(key)
  if (current === undefined) {
    map.set(key, [appId])
    return
  }
  if (!current.includes(appId)) current.push(appId)
}

function resolveCandidates(
  candidates: readonly AppId[] | undefined,
  kind: ApplicationProcessMatchKind,
): ApplicationProcessMatchResult {
  if (!candidates || candidates.length === 0) return noMatch('no-catalog-match')
  const ordered = Object.freeze([...candidates].sort((a, b) => String(a).localeCompare(String(b))))
  const appId = ordered[0]
  if (appId === undefined || ordered.length !== 1) {
    return { reason: 'ambiguous-catalog-match', candidateAppIds: ordered }
  }
  return { appId, kind }
}

function noMatch(reason: ApplicationProcessNoMatch['reason']): ApplicationProcessNoMatch {
  return { reason, candidateAppIds: Object.freeze([]) }
}
