import { win32 as pathWin32 } from 'node:path'
import type { AppId, AppRecord } from '@deepseek-ai/dsh-app-registry'
import type { WindowSnapshot } from '@deepseek-ai/dsh-window-registry'
import type {
  ApplicationWindowMatchKind,
  UnmatchedApplicationWindowReason,
} from './types.ts'

export interface ApplicationWindowMatch {
  readonly appId: AppId
  readonly kind: ApplicationWindowMatchKind
}

export interface ApplicationWindowNoMatch {
  readonly reason: UnmatchedApplicationWindowReason
  readonly candidateAppIds: readonly AppId[]
}

export type ApplicationWindowMatchResult = ApplicationWindowMatch | ApplicationWindowNoMatch

/** Pure, allocation-bounded matcher compiled once per App Registry catalog revision. */
export class ApplicationWindowMatcher {
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
          const targetPath = normalizeWindowsExecutablePath(app.launch.targetPath)
          if (targetPath) appendUnique(this.byShortcutTarget, targetPath, app.id)
          break
        }
      }
    }
  }

  match(window: WindowSnapshot): ApplicationWindowMatchResult {
    if (window.aumid) {
      const aumid = normalizeAumid(window.aumid)
      if (!aumid) {
        return { reason: 'missing-identity-evidence', candidateAppIds: Object.freeze([]) }
      }
      // A present AUMID is stronger than process executable identity. Do not fall through
      // to a shared host executable such as ApplicationFrameHost.exe when it fails to match.
      return resolveCandidates(this.byAumid.get(aumid), 'aumid')
    }

    if (window.executablePath) {
      const executablePath = normalizeWindowsExecutablePath(window.executablePath)
      if (!executablePath) {
        return { reason: 'missing-identity-evidence', candidateAppIds: Object.freeze([]) }
      }

      // A direct executable record outranks a shortcut that happens to target the same EXE.
      const direct = this.byExecutablePath.get(executablePath)
      if (direct && direct.length > 0) return resolveCandidates(direct, 'executable-path')

      const shortcuts = this.byShortcutTarget.get(executablePath)
      if (shortcuts && shortcuts.length > 0) return resolveCandidates(shortcuts, 'shortcut-target')

      return { reason: 'no-catalog-match', candidateAppIds: Object.freeze([]) }
    }

    return { reason: 'missing-identity-evidence', candidateAppIds: Object.freeze([]) }
  }
}

/** Windows path comparison without filesystem I/O or host-platform path semantics. */
export function normalizeWindowsExecutablePath(input: string): string | undefined {
  let value = input.trim()
  if (!value) return undefined

  value = value.replaceAll('/', '\\')
  if (/^\\\\\?\\UNC\\/i.test(value)) {
    value = `\\\\${value.slice(8)}`
  } else if (/^\\\\\?\\/i.test(value)) {
    value = value.slice(4)
  }

  const normalized = pathWin32.normalize(value)
  return normalized ? normalized.toLowerCase() : undefined
}

export function normalizeAumid(input: string): string | undefined {
  const value = input.trim()
  return value ? value.toLowerCase() : undefined
}

function appendUnique(map: Map<string, AppId[]>, key: string, appId: AppId): void {
  const existing = map.get(key)
  if (!existing) {
    map.set(key, [appId])
    return
  }
  if (!existing.includes(appId)) existing.push(appId)
}

function resolveCandidates(
  candidates: readonly AppId[] | undefined,
  kind: ApplicationWindowMatchKind,
): ApplicationWindowMatchResult {
  if (!candidates || candidates.length === 0) {
    return { reason: 'no-catalog-match', candidateAppIds: Object.freeze([]) }
  }

  const ordered = Object.freeze([...candidates].sort(compareIds))
  const first = ordered[0]
  if (!first || ordered.length !== 1) {
    return { reason: 'ambiguous-catalog-match', candidateAppIds: ordered }
  }

  return { appId: first, kind }
}

function compareIds(left: AppId, right: AppId): number {
  return String(left).localeCompare(String(right))
}
