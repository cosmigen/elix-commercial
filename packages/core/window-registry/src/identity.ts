/**
 * Stable Window Lifetime Evidence and Identity Management.
 *
 * Implements the core ELIX identity invariant:
 * 1. `WindowId !== HWND`.
 * 2. HWND recycling by Win32 yields a new, distinct `WindowId`.
 * 3. Native host restarts rehydrate live windows with preserved `WindowId`.
 *
 * @module @deepseek-ai/dsh-window-registry/identity
 */

import type { NativeRawWindow } from '@deepseek-ai/dsh-native-core'
import type { WindowId } from './types.ts'

/** Stored evidence verifying the continuous lifetime of an active window. */
export interface WindowLifetimeEvidence {
  readonly id: WindowId
  readonly hwnd: number
  readonly processId: number
  readonly threadId: number
  readonly processCreationTime: number
  readonly className: string
  readonly executableName?: string | undefined
  readonly firstSeenGeneration: number
  readonly lastSeenGeneration: number
  readonly createdAt: number
}

/** Result of reconciling a window with existing identity records. */
export interface IdentityReconciliationResult {
  readonly id: WindowId
  readonly isNew: boolean
  readonly recycledOldEvidence?: WindowLifetimeEvidence | undefined
}

/**
 * Tracks and mints stable WindowId identities across OS events and host restarts.
 */
export class WindowIdentityTracker {
  private nextSequence = 1
  /** Map from HWND to lifetime evidence. */
  private readonly trackedByHwnd = new Map<number, WindowLifetimeEvidence>()
  /** Map from WindowId to HWND. */
  private readonly hwndById = new Map<WindowId, number>()

  /**
   * Generates a new unique WindowId.
   */
  mintWindowId(
    hwnd: number,
    processId: number,
    processCreationTime: number,
    threadId = 0,
    generation = 1,
  ): WindowId {
    const seq = this.nextSequence++
    return `win_g${generation.toString(16)}_p${processId.toString(16)}_t${threadId.toString(16)}_c${processCreationTime.toString(16)}_h${hwnd.toString(16)}_s${seq.toString(16)}` as WindowId
  }

  /**
   * Verifies whether existing lifetime evidence matches newly observed raw window evidence.
   */
  matchesEvidence(existing: WindowLifetimeEvidence, raw: NativeRawWindow): boolean {
    if (existing.processId !== raw.processId) return false
    if (existing.className !== raw.className) return false
    if (existing.processCreationTime > 0 && raw.processCreationTime > 0) {
      if (existing.processCreationTime !== raw.processCreationTime) return false
    }
    if (existing.threadId > 0 && raw.threadId > 0) {
      if (existing.threadId !== raw.threadId) return false
    }
    if (existing.executableName && raw.executableName) {
      if (existing.executableName !== raw.executableName) return false
    }
    return true
  }

  /**
   * Reconciles a raw window event or snapshot entry with tracked evidence.
   *
   * Detects Win32 HWND recycling: if the HWND is known but processId,
   * processCreationTime, threadId, executableName, or className differs,
   * the old window is treated as recycled/destroyed, and a new WindowId is minted.
   */
  reconcileWindow(raw: NativeRawWindow, generation = 1): IdentityReconciliationResult {
    const existing = this.trackedByHwnd.get(raw.hwnd)

    if (existing) {
      if (this.matchesEvidence(existing, raw)) {
        const updatedEvidence: WindowLifetimeEvidence = {
          ...existing,
          lastSeenGeneration: generation,
        }
        this.trackedByHwnd.set(raw.hwnd, updatedEvidence)
        return {
          id: existing.id,
          isNew: false,
        }
      }

      // HWND recycling detected! The OS recycled the handle for a different window or process.
      this.trackedByHwnd.delete(raw.hwnd)
      this.hwndById.delete(existing.id)

      const newId = this.mintWindowId(raw.hwnd, raw.processId, raw.processCreationTime, raw.threadId, generation)
      const evidence: WindowLifetimeEvidence = {
        id: newId,
        hwnd: raw.hwnd,
        processId: raw.processId,
        threadId: raw.threadId,
        processCreationTime: raw.processCreationTime,
        className: raw.className,
        ...(raw.executableName ? { executableName: raw.executableName } : {}),
        firstSeenGeneration: generation,
        lastSeenGeneration: generation,
        createdAt: Date.now(),
      }
      this.trackedByHwnd.set(raw.hwnd, evidence)
      this.hwndById.set(newId, raw.hwnd)

      return {
        id: newId,
        isNew: true,
        recycledOldEvidence: existing,
      }
    }

    // Brand new window observed
    const newId = this.mintWindowId(raw.hwnd, raw.processId, raw.processCreationTime, raw.threadId, generation)
    const evidence: WindowLifetimeEvidence = {
      id: newId,
      hwnd: raw.hwnd,
      processId: raw.processId,
      threadId: raw.threadId,
      processCreationTime: raw.processCreationTime,
      className: raw.className,
      ...(raw.executableName ? { executableName: raw.executableName } : {}),
      firstSeenGeneration: generation,
      lastSeenGeneration: generation,
      createdAt: Date.now(),
    }
    this.trackedByHwnd.set(raw.hwnd, evidence)
    this.hwndById.set(newId, raw.hwnd)

    return {
      id: newId,
      isNew: true,
    }
  }

  /**
   * Removes tracking evidence for a destroyed HWND.
   */
  removeByHwnd(hwnd: number): WindowLifetimeEvidence | undefined {
    const existing = this.trackedByHwnd.get(hwnd)
    if (existing) {
      this.trackedByHwnd.delete(hwnd)
      this.hwndById.delete(existing.id)
    }
    return existing
  }

  /**
   * Removes tracking evidence by WindowId.
   */
  removeById(id: WindowId): WindowLifetimeEvidence | undefined {
    const hwnd = this.hwndById.get(id)
    if (hwnd !== undefined) {
      return this.removeByHwnd(hwnd)
    }
    return undefined
  }

  /**
   * Retrieves evidence by HWND.
   */
  getByHwnd(hwnd: number): WindowLifetimeEvidence | undefined {
    return this.trackedByHwnd.get(hwnd)
  }

  /**
   * Retrieves HWND by WindowId.
   */
  getHwndById(id: WindowId): number | undefined {
    return this.hwndById.get(id)
  }

  /**
   * Clears all identity tracking records.
   */
  clear(): void {
    this.trackedByHwnd.clear()
    this.hwndById.clear()
  }

  /**
   * Reconciles a complete snapshot of windows (e.g. on host restart or initial enumeration).
   *
   * Preserves existing WindowId for windows whose lifetime evidence matches,
   * detects recycled HWNDs, identifies new windows, and identifies destroyed windows.
   */
  reconcileSnapshot(
    rawWindows: readonly NativeRawWindow[],
    generation = 1,
  ): {
    readonly retained: Map<number, WindowLifetimeEvidence>
    readonly created: Array<{ raw: NativeRawWindow; evidence: WindowLifetimeEvidence; id: WindowId }>
    readonly destroyed: WindowLifetimeEvidence[]
    readonly recycled: Array<{ oldEvidence: WindowLifetimeEvidence; newEvidence: WindowLifetimeEvidence; newId: WindowId }>
  } {
    const rawByHwnd = new Map<number, NativeRawWindow>()
    for (const raw of rawWindows) {
      rawByHwnd.set(raw.hwnd, raw)
    }

    const retained = new Map<number, WindowLifetimeEvidence>()
    const destroyed: WindowLifetimeEvidence[] = []
    const recycled: Array<{ oldEvidence: WindowLifetimeEvidence; newEvidence: WindowLifetimeEvidence; newId: WindowId }> = []
    const created: Array<{ raw: NativeRawWindow; evidence: WindowLifetimeEvidence; id: WindowId }> = []

    // 1. Check existing tracked windows against new enumeration
    for (const [hwnd, existing] of this.trackedByHwnd.entries()) {
      const raw = rawByHwnd.get(hwnd)
      if (!raw) {
        // Window was closed while host was restarting or between snapshots
        destroyed.push(existing)
        this.trackedByHwnd.delete(hwnd)
        this.hwndById.delete(existing.id)
      } else {
        if (this.matchesEvidence(existing, raw)) {
          const updatedEvidence: WindowLifetimeEvidence = {
            ...existing,
            lastSeenGeneration: generation,
          }
          this.trackedByHwnd.set(hwnd, updatedEvidence)
          retained.set(hwnd, updatedEvidence)
        } else {
          // HWND was recycled
          this.trackedByHwnd.delete(hwnd)
          this.hwndById.delete(existing.id)
          const newId = this.mintWindowId(raw.hwnd, raw.processId, raw.processCreationTime, raw.threadId, generation)
          const newEvidence: WindowLifetimeEvidence = {
            id: newId,
            hwnd: raw.hwnd,
            processId: raw.processId,
            threadId: raw.threadId,
            processCreationTime: raw.processCreationTime,
            className: raw.className,
            ...(raw.executableName ? { executableName: raw.executableName } : {}),
            firstSeenGeneration: generation,
            lastSeenGeneration: generation,
            createdAt: Date.now(),
          }
          this.trackedByHwnd.set(raw.hwnd, newEvidence)
          this.hwndById.set(newId, raw.hwnd)
          recycled.push({ oldEvidence: existing, newEvidence, newId })
          created.push({ raw, evidence: newEvidence, id: newId })
        }
      }
    }

    // 2. Identify brand-new windows not previously tracked
    for (const raw of rawWindows) {
      if (!this.trackedByHwnd.has(raw.hwnd)) {
        const newId = this.mintWindowId(raw.hwnd, raw.processId, raw.processCreationTime, raw.threadId, generation)
        const evidence: WindowLifetimeEvidence = {
          id: newId,
          hwnd: raw.hwnd,
          processId: raw.processId,
          threadId: raw.threadId,
          processCreationTime: raw.processCreationTime,
          className: raw.className,
          ...(raw.executableName ? { executableName: raw.executableName } : {}),
          firstSeenGeneration: generation,
          lastSeenGeneration: generation,
          createdAt: Date.now(),
        }
        this.trackedByHwnd.set(raw.hwnd, evidence)
        this.hwndById.set(newId, raw.hwnd)
        created.push({ raw, evidence, id: newId })
      }
    }

    return {
      retained,
      created,
      destroyed,
      recycled,
    }
  }
}
