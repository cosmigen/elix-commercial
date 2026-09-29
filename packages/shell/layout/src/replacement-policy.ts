/**
 * Fail-closed replacement policy state machine for ELIX Shell Layout.
 *
 * Phase 16A does not enable production taskbar replacement. This component
 * models the authorization boundary that later Dock/Status-Bar/native-access
 * integration must satisfy before a hide mutation is allowed.
 *
 * @module @deepseek-ai/dsh-shell-layout/replacement-policy
 */

export type ReplacementBlockReason =
  | 'capability-disabled'
  | 'guardian-unavailable'
  | 'recovering'
  | 'missing-surface-readiness'
  | 'native-access-active'

export interface ShellSurfaceReadiness {
  readonly ownerId: string
  readonly ownerGeneration: number
  readonly monitorId: string
  readonly interactive: boolean
  readonly revealReady: boolean
}

export interface ReplacementEvaluation {
  readonly allowed: boolean
  readonly epoch: number
  readonly reasons: readonly ReplacementBlockReason[]
  readonly uncoveredMonitorIds: readonly string[]
}

export interface ReplacementAuthorization {
  readonly accepted: boolean
  readonly epoch: number
  readonly evaluation: ReplacementEvaluation
}

export interface NativeAccessToken {
  readonly id: string
  readonly epoch: number
  readonly reason: string
}

interface ReadinessEntry extends ShellSurfaceReadiness {
  readonly key: string
}

/**
 * Controller-epoch policy used to fence replacement/native-access races.
 * It performs no native mutation itself.
 */
export class ShellReplacementPolicy {
  private readonly readiness = new Map<string, ReadinessEntry>()
  private readonly nativeAccess = new Map<string, NativeAccessToken>()
  private capabilityEnabled = false
  private guardianReady = false
  private recovering = false
  private epoch = 1
  private tokenSequence = 0

  getEpoch(): number {
    return this.epoch
  }

  setCapabilityEnabled(enabled: boolean): void {
    if (this.capabilityEnabled === enabled) return
    this.capabilityEnabled = enabled
    this.bumpEpoch()
  }

  setGuardianReady(ready: boolean): void {
    if (this.guardianReady === ready) return
    this.guardianReady = ready
    this.bumpEpoch()
  }

  reportSurfaceReadiness(state: ShellSurfaceReadiness): void {
    if (!state.ownerId.trim()) {
      throw new TypeError('surface readiness ownerId must be non-empty')
    }
    if (!state.monitorId.trim()) {
      throw new TypeError('surface readiness monitorId must be non-empty')
    }
    if (!Number.isSafeInteger(state.ownerGeneration) || state.ownerGeneration < 0) {
      throw new RangeError('surface readiness ownerGeneration must be a non-negative safe integer')
    }

    for (const [key, existing] of this.readiness) {
      if (existing.ownerId !== state.ownerId) continue
      if (existing.ownerGeneration > state.ownerGeneration) {
        throw new Error(
          `stale surface readiness for owner "${state.ownerId}" generation ${state.ownerGeneration}`,
        )
      }
      if (existing.ownerGeneration < state.ownerGeneration) {
        this.readiness.delete(key)
      }
    }

    const key = `${state.ownerId}:${state.ownerGeneration}:${state.monitorId}`
    this.readiness.set(key, { ...state, key })
    this.bumpEpoch()
  }

  releaseOwner(ownerId: string, ownerGeneration: number): number {
    let removed = 0
    for (const [key, existing] of this.readiness) {
      if (
        existing.ownerId === ownerId &&
        existing.ownerGeneration === ownerGeneration
      ) {
        this.readiness.delete(key)
        removed += 1
      }
    }
    if (removed > 0) this.bumpEpoch()
    return removed
  }

  acquireNativeAccess(reason: string): NativeAccessToken {
    if (!reason.trim()) {
      throw new TypeError('native access reason must be non-empty')
    }
    this.bumpEpoch()
    const token: NativeAccessToken = Object.freeze({
      id: `native-access:${this.epoch}:${++this.tokenSequence}`,
      epoch: this.epoch,
      reason,
    })
    this.nativeAccess.set(token.id, token)
    return token
  }

  releaseNativeAccess(token: NativeAccessToken): boolean {
    const current = this.nativeAccess.get(token.id)
    if (!current || current.epoch !== token.epoch) return false
    this.nativeAccess.delete(token.id)
    this.bumpEpoch()
    return true
  }

  beginRecovery(): number {
    this.recovering = true
    this.nativeAccess.clear()
    this.bumpEpoch()
    return this.epoch
  }

  completeRecovery(): number {
    if (!this.recovering) return this.epoch
    this.recovering = false
    this.bumpEpoch()
    return this.epoch
  }

  evaluate(requiredMonitorIds: readonly string[]): ReplacementEvaluation {
    const reasons: ReplacementBlockReason[] = []
    if (!this.capabilityEnabled) reasons.push('capability-disabled')
    if (!this.guardianReady) reasons.push('guardian-unavailable')
    if (this.recovering) reasons.push('recovering')
    if (this.nativeAccess.size > 0) reasons.push('native-access-active')

    const uncoveredMonitorIds = [...new Set(requiredMonitorIds)]
      .filter(monitorId => !this.hasReadySurface(monitorId))
      .sort()

    if (uncoveredMonitorIds.length > 0) {
      reasons.push('missing-surface-readiness')
    }

    return Object.freeze({
      allowed: reasons.length === 0,
      epoch: this.epoch,
      reasons: Object.freeze(reasons),
      uncoveredMonitorIds: Object.freeze(uncoveredMonitorIds),
    })
  }

  authorizeReplacement(requiredMonitorIds: readonly string[]): ReplacementAuthorization {
    const evaluation = this.evaluate(requiredMonitorIds)
    return Object.freeze({
      accepted: evaluation.allowed,
      epoch: evaluation.epoch,
      evaluation,
    })
  }

  /** Late native completion may mutate only while its controller epoch remains current. */
  isAuthorizationCurrent(epoch: number): boolean {
    return !this.recovering && epoch === this.epoch
  }

  private hasReadySurface(monitorId: string): boolean {
    for (const entry of this.readiness.values()) {
      if (
        entry.monitorId === monitorId &&
        entry.interactive &&
        entry.revealReady
      ) {
        return true
      }
    }
    return false
  }

  private bumpEpoch(): void {
    this.epoch += 1
  }
}
