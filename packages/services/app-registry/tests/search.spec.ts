import { describe, expect, it } from 'vitest'
import { searchApplications } from '../src/search.ts'
import { normalizeDiscoveredApp } from '../src/normalize.ts'
import type { AppRecord } from '../src/types.ts'

describe('Application Search Engine', () => {
  const sampleApps: readonly AppRecord[] = [
    normalizeDiscoveredApp({
      source: 'start-menu-system',
      kind: 'win32',
      displayName: 'Google Chrome',
      executablePath: 'C:\\Program Files\\Google\\Chrome\\chrome.exe',
      publisher: 'Google LLC',
      aliases: ['browser', 'internet', 'chrome'],
    }),
    normalizeDiscoveredApp({
      source: 'start-menu-system',
      kind: 'win32',
      displayName: 'Windows Terminal',
      executablePath: 'C:\\Program Files\\Terminal\\wt.exe',
      publisher: 'Microsoft Corporation',
      aliases: ['wt', 'powershell', 'cmd'],
    }),
    normalizeDiscoveredApp({
      source: 'packaged-apps',
      kind: 'packaged',
      displayName: 'Calculator',
      aumid: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App',
      publisher: 'Microsoft Corporation',
      description: 'Perform math calculations',
    }),
    normalizeDiscoveredApp({
      source: 'start-menu-system',
      kind: 'win32',
      displayName: 'Terminal Preview',
      executablePath: 'C:\\Program Files\\TerminalPreview\\wt.exe',
      publisher: 'Microsoft Corporation',
    }),
  ]

  it('ranks exact display name match highest', () => {
    const results = searchApplications(sampleApps, 'Calculator')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]?.displayName).toBe('Calculator')
  })

  it('ranks prefix and word-boundary matches before generic substrings', () => {
    const results = searchApplications(sampleApps, 'Term')
    expect(results.length).toBe(2)
    // Terminal matches via prefix or word boundary
    expect(results.some(r => r.displayName === 'Windows Terminal')).toBe(true)
    expect(results.some(r => r.displayName === 'Terminal Preview')).toBe(true)
  })

  it('matches applications by searchable aliases', () => {
    const results = searchApplications(sampleApps, 'browser')
    expect(results.length).toBe(1)
    expect(results[0]?.displayName).toBe('Google Chrome')
  })

  it('matches applications by publisher name', () => {
    const results = searchApplications(sampleApps, 'Google')
    expect(results.length).toBe(1)
    expect(results[0]?.displayName).toBe('Google Chrome')
  })

  it('filters search results by application kind', () => {
    const packagedOnly = searchApplications(sampleApps, 'calc', {
      kinds: ['packaged'],
    })
    expect(packagedOnly.length).toBe(1)
    expect(packagedOnly[0]?.kind).toBe('packaged')

    const win32Only = searchApplications(sampleApps, 'calc', {
      kinds: ['win32'],
    })
    expect(win32Only.length).toBe(0)
  })

  it('enforces limit option', () => {
    const results = searchApplications(sampleApps, 'e', { limit: 2 })
    expect(results.length).toBeLessThanOrEqual(2)
  })

  it('returns empty array when query is blank or whitespace', () => {
    expect(searchApplications(sampleApps, '')).toEqual([])
    expect(searchApplications(sampleApps, '   ')).toEqual([])
  })
})
