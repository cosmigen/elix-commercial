import { describe, expect, it } from 'vitest'
import { ShellReplacementPolicy } from '../src/index.ts'

describe('Shell Layout - Replacement Policy State Machine', () => {
  it('is disabled and guardian-blocked by default', () => {
    const policy = new ShellReplacementPolicy()
    const evaluation = policy.evaluate(['monitor-a'])

    expect(evaluation.allowed).toBe(false)
    expect(evaluation.reasons).toContain('capability-disabled')
    expect(evaluation.reasons).toContain('guardian-unavailable')
    expect(evaluation.reasons).toContain('missing-surface-readiness')
    expect(evaluation.uncoveredMonitorIds).toEqual(['monitor-a'])
  })

  it('requires interactive reveal-ready coverage on every requested monitor', () => {
    const policy = new ShellReplacementPolicy()
    policy.setCapabilityEnabled(true)
    policy.setGuardianReady(true)

    policy.reportSurfaceReadiness({
      ownerId: 'dock',
      ownerGeneration: 1,
      monitorId: 'monitor-a',
      interactive: true,
      revealReady: true,
    })

    const partial = policy.evaluate(['monitor-a', 'monitor-b'])
    expect(partial.allowed).toBe(false)
    expect(partial.uncoveredMonitorIds).toEqual(['monitor-b'])

    policy.reportSurfaceReadiness({
      ownerId: 'dock',
      ownerGeneration: 1,
      monitorId: 'monitor-b',
      interactive: true,
      revealReady: true,
    })

    expect(policy.evaluate(['monitor-a', 'monitor-b'])).toMatchObject({
      allowed: true,
      reasons: [],
      uncoveredMonitorIds: [],
    })
  })

  it('owner generation advance invalidates older readiness evidence', () => {
    const policy = new ShellReplacementPolicy()
    policy.setCapabilityEnabled(true)
    policy.setGuardianReady(true)

    policy.reportSurfaceReadiness({
      ownerId: 'dock',
      ownerGeneration: 3,
      monitorId: 'monitor-a',
      interactive: true,
      revealReady: true,
    })
    expect(policy.evaluate(['monitor-a']).allowed).toBe(true)

    policy.reportSurfaceReadiness({
      ownerId: 'dock',
      ownerGeneration: 4,
      monitorId: 'monitor-b',
      interactive: true,
      revealReady: true,
    })

    expect(policy.evaluate(['monitor-a']).uncoveredMonitorIds).toEqual(['monitor-a'])
    expect(() => {
      policy.reportSurfaceReadiness({
        ownerId: 'dock',
        ownerGeneration: 3,
        monitorId: 'monitor-a',
        interactive: true,
        revealReady: true,
      })
    }).toThrow(/stale surface readiness/i)
  })

  it('temporary native access fences replacement until the scoped token is released', () => {
    const policy = new ShellReplacementPolicy()
    policy.setCapabilityEnabled(true)
    policy.setGuardianReady(true)
    policy.reportSurfaceReadiness({
      ownerId: 'dock',
      ownerGeneration: 1,
      monitorId: 'monitor-a',
      interactive: true,
      revealReady: true,
    })

    expect(policy.evaluate(['monitor-a']).allowed).toBe(true)

    const token = policy.acquireNativeAccess('open-native-tray')
    expect(policy.evaluate(['monitor-a']).reasons).toContain('native-access-active')
    expect(policy.releaseNativeAccess(token)).toBe(true)
    expect(policy.releaseNativeAccess(token)).toBe(false)
    expect(policy.evaluate(['monitor-a']).allowed).toBe(true)
  })

  it('recovery invalidates an old accepted epoch so a late hide cannot win', () => {
    const policy = new ShellReplacementPolicy()
    policy.setCapabilityEnabled(true)
    policy.setGuardianReady(true)
    policy.reportSurfaceReadiness({
      ownerId: 'dock',
      ownerGeneration: 1,
      monitorId: 'monitor-a',
      interactive: true,
      revealReady: true,
    })

    const authorization = policy.authorizeReplacement(['monitor-a'])
    expect(authorization.accepted).toBe(true)
    expect(policy.isAuthorizationCurrent(authorization.epoch)).toBe(true)

    policy.beginRecovery()

    expect(policy.isAuthorizationCurrent(authorization.epoch)).toBe(false)
    expect(policy.evaluate(['monitor-a']).reasons).toContain('recovering')

    policy.completeRecovery()
    expect(policy.isAuthorizationCurrent(authorization.epoch)).toBe(false)
  })

  it('loss of guardian or owner readiness immediately fences an existing authorization', () => {
    const policy = new ShellReplacementPolicy()
    policy.setCapabilityEnabled(true)
    policy.setGuardianReady(true)
    policy.reportSurfaceReadiness({
      ownerId: 'dock',
      ownerGeneration: 8,
      monitorId: 'monitor-a',
      interactive: true,
      revealReady: true,
    })

    const authorization = policy.authorizeReplacement(['monitor-a'])
    expect(authorization.accepted).toBe(true)

    policy.setGuardianReady(false)
    expect(policy.isAuthorizationCurrent(authorization.epoch)).toBe(false)
    expect(policy.evaluate(['monitor-a']).reasons).toContain('guardian-unavailable')

    policy.setGuardianReady(true)
    expect(policy.releaseOwner('dock', 8)).toBe(1)
    expect(policy.evaluate(['monitor-a']).reasons).toContain('missing-surface-readiness')
  })
})
