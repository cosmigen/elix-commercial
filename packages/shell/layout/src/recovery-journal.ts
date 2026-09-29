/**
 * Durable recovery journal for risky ELIX shell-boundary mutations.
 *
 * The normal Shell Layout registry is ephemeral. This journal is deliberately
 * tiny and independent: it records only the evidence needed to decide whether
 * a replacement transition was left unfinished after an abnormal exit.
 *
 * @module @deepseek-ai/dsh-shell-layout/recovery-journal
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ShellMode } from './types.ts'

export type ShellRecoveryJournalStatus =
  | 'armed'
  | 'restoring'
  | 'recovered'

export interface ShellRecoveryJournalState {
  readonly version: 1
  readonly sessionId: string
  readonly controllerGeneration: number
  readonly status: ShellRecoveryJournalStatus
  readonly previousMode: ShellMode
  readonly desiredMode: ShellMode
  readonly intendedMutation: 'taskbar-replacement'
  readonly nativeBarIds: readonly string[]
  readonly updatedAt: number
  readonly recoveryReason?: string | undefined
}

export interface ArmShellRecoveryJournalInput {
  readonly sessionId: string
  readonly controllerGeneration: number
  readonly previousMode: ShellMode
  readonly desiredMode: 'replacement'
  readonly nativeBarIds: readonly string[]
}

/** Returns the per-user default path without depending on themed/profile services. */
export function getDefaultShellRecoveryJournalPath(): string {
  const localAppData = process.env.LOCALAPPDATA?.trim()
  const base = localAppData && localAppData.length > 0
    ? localAppData
    : join(homedir(), 'AppData', 'Local')
  return join(base, 'ELIX', 'recovery', 'shell-layout.json')
}

/** Session identity used only to prevent one Windows session restoring another. */
export function getDefaultShellRecoverySessionId(): string {
  const username = process.env.USERNAME?.trim() || 'unknown-user'
  const session = process.env.SESSIONNAME?.trim() || 'interactive'
  return `${username}:${session}`
}

function isShellMode(value: unknown): value is ShellMode {
  return value === 'coexistence' || value === 'overlay' || value === 'replacement'
}

function parseJournalState(value: unknown): ShellRecoveryJournalState | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as Record<string, unknown>
  if (candidate.version !== 1) return undefined
  if (typeof candidate.sessionId !== 'string' || candidate.sessionId.length === 0) return undefined
  if (!Number.isSafeInteger(candidate.controllerGeneration) || Number(candidate.controllerGeneration) < 0) {
    return undefined
  }
  if (
    candidate.status !== 'armed' &&
    candidate.status !== 'restoring' &&
    candidate.status !== 'recovered'
  ) {
    return undefined
  }
  if (!isShellMode(candidate.previousMode) || !isShellMode(candidate.desiredMode)) return undefined
  if (candidate.intendedMutation !== 'taskbar-replacement') return undefined
  if (!Array.isArray(candidate.nativeBarIds)) return undefined

  const nativeBarIds: string[] = []
  for (const id of candidate.nativeBarIds) {
    if (typeof id !== 'string') return undefined
    nativeBarIds.push(id)
  }

  if (!Number.isFinite(candidate.updatedAt)) return undefined
  if (candidate.recoveryReason !== undefined && typeof candidate.recoveryReason !== 'string') {
    return undefined
  }

  return {
    version: 1,
    sessionId: candidate.sessionId,
    controllerGeneration: Number(candidate.controllerGeneration),
    status: candidate.status,
    previousMode: candidate.previousMode,
    desiredMode: candidate.desiredMode,
    intendedMutation: 'taskbar-replacement',
    nativeBarIds: Object.freeze(nativeBarIds),
    updatedAt: Number(candidate.updatedAt),
    ...(typeof candidate.recoveryReason === 'string'
      ? { recoveryReason: candidate.recoveryReason }
      : {}),
  }
}

/**
 * Small synchronous journal intentionally suitable for startup/shutdown paths.
 * Writes use write+fsync+atomic rename so a crash cannot silently replace the
 * last valid record with a partially written JSON document.
 */
export class ShellRecoveryJournal {
  constructor(readonly path = getDefaultShellRecoveryJournalPath()) {}

  read(): ShellRecoveryJournalState | undefined {
    if (!existsSync(this.path)) return undefined
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, 'utf8'))
      return parseJournalState(parsed)
    } catch {
      return undefined
    }
  }

  arm(input: ArmShellRecoveryJournalInput): ShellRecoveryJournalState {
    if (!input.sessionId.trim()) {
      throw new TypeError('Recovery journal sessionId must be non-empty.')
    }
    if (!Number.isSafeInteger(input.controllerGeneration) || input.controllerGeneration < 0) {
      throw new RangeError('Recovery journal controllerGeneration must be a non-negative safe integer.')
    }

    const state: ShellRecoveryJournalState = {
      version: 1,
      sessionId: input.sessionId,
      controllerGeneration: input.controllerGeneration,
      status: 'armed',
      previousMode: input.previousMode,
      desiredMode: input.desiredMode,
      intendedMutation: 'taskbar-replacement',
      nativeBarIds: Object.freeze([...new Set(input.nativeBarIds)].sort()),
      updatedAt: Date.now(),
    }
    this.writeAtomic(state)
    return state
  }

  markRestoring(reason: string): ShellRecoveryJournalState | undefined {
    const current = this.read()
    if (!current) return undefined
    const next: ShellRecoveryJournalState = {
      ...current,
      status: 'restoring',
      recoveryReason: reason,
      updatedAt: Date.now(),
    }
    this.writeAtomic(next)
    return next
  }

  markRecovered(reason = 'restored'): ShellRecoveryJournalState | undefined {
    const current = this.read()
    if (!current) return undefined
    const next: ShellRecoveryJournalState = {
      ...current,
      status: 'recovered',
      recoveryReason: reason,
      updatedAt: Date.now(),
    }
    this.writeAtomic(next)
    return next
  }

  /** Clears only a completed record. Armed/restoring evidence is never discarded blindly. */
  clearRecovered(): boolean {
    const current = this.read()
    if (!current || current.status !== 'recovered') return false
    try {
      unlinkSync(this.path)
      return true
    } catch {
      return false
    }
  }

  private writeAtomic(state: ShellRecoveryJournalState): void {
    const parent = dirname(this.path)
    mkdirSync(parent, { recursive: true })

    const temporaryPath = `${this.path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`
    const payload = `${JSON.stringify(state, null, 2)}\n`
    let descriptor: number | undefined

    try {
      descriptor = openSync(temporaryPath, 'wx')
      writeFileSync(descriptor, payload, 'utf8')
      fsyncSync(descriptor)
      closeSync(descriptor)
      descriptor = undefined
      renameSync(temporaryPath, this.path)
    } catch (error) {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor)
        } catch {
          // Preserve original journal failure.
        }
      }
      try {
        unlinkSync(temporaryPath)
      } catch {
        // Best-effort cleanup of an incomplete temporary file.
      }
      throw error
    }
  }
}
