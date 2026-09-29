import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const patchPath = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))

function patchText(): string {
  return readFileSync(patchPath, 'utf8')
}

function configuredIds(): string[] {
  return [...patchText().matchAll(/^\s+- id: ([a-z0-9-]+)\s*$/gmu)].map(match => match[1] ?? '')
}

describe('Windows runtime production composition', () => {
  it('mounts raw/native authorities before higher-level interpretation', () => {
    expect(configuredIds()).toEqual([
      'windows-context',
      'surface',
      'window-registry',
      'spaces',
      'global-input',
      'window-preview',
      'window-control',
      'shell-navigation',
      'shell-layout',
      'window-placement',
      'app-registry',
      'process-observation',
      'application-runtime',
    ])
  })

  it('mounts Spaces immediately after Window Registry and before shell consumers', () => {
    const ids = configuredIds()
    const spaces = ids.indexOf('spaces')
    expect(ids.indexOf('window-registry')).toBeLessThan(spaces)
    expect(spaces).toBeLessThan(ids.indexOf('shell-navigation'))
    expect(spaces).toBeLessThan(ids.indexOf('window-preview'))
    expect(spaces).toBeLessThan(ids.indexOf('shell-layout'))
    expect(patchText()).toContain("name: '@deepseek-ai/dsh-spaces'")
  })

  it('mounts Global Input and Window Control before Shell Navigation', () => {
    const ids = configuredIds()
    const navigation = ids.indexOf('shell-navigation')
    expect(ids.indexOf('spaces')).toBeLessThan(ids.indexOf('global-input'))
    expect(ids.indexOf('global-input')).toBeLessThan(navigation)
    expect(ids.indexOf('window-registry')).toBeLessThan(navigation)
    expect(ids.indexOf('window-control')).toBeLessThan(navigation)
    expect(navigation).toBeLessThan(ids.indexOf('shell-layout'))
    expect(patchText()).toContain("name: '@deepseek-ai/dsh-global-input'")
    expect(patchText()).toContain("name: '@deepseek-ai/dsh-shell-navigation'")
  })

  it('mounts standalone Preview after both destination Surface and source Window Registry authorities', () => {
    const ids = configuredIds()
    expect(ids.indexOf('surface')).toBeLessThan(ids.indexOf('window-registry'))
    expect(ids.indexOf('surface')).toBeLessThan(ids.indexOf('window-preview'))
    expect(ids.indexOf('window-registry')).toBeLessThan(ids.indexOf('window-preview'))
    expect(patchText()).toContain("name: '@deepseek-ai/dsh-window-preview'")
    expect(patchText()).not.toContain("name: '@deepseek-ai/dsh-surface/preview'")
  })

  it('mounts placement only after Context, Registry, Control, and Shell Layout authorities', () => {
    const ids = configuredIds()
    const placement = ids.indexOf('window-placement')
    expect(ids.indexOf('windows-context')).toBeLessThan(placement)
    expect(ids.indexOf('window-registry')).toBeLessThan(placement)
    expect(ids.indexOf('window-control')).toBeLessThan(placement)
    expect(ids.indexOf('shell-layout')).toBeLessThan(placement)
    expect(patchText()).toContain("name: '@deepseek-ai/dsh-window-placement'")
  })

  it('does not mutate the native Windows work area merely to enable manual placement', () => {
    expect(patchText()).toContain('syncNativeWorkArea: false')
  })

  it('keeps Process Observation before Application Runtime', () => {
    const ids = configuredIds()
    expect(ids.indexOf('process-observation')).toBeGreaterThan(ids.indexOf('app-registry'))
    expect(ids.indexOf('process-observation')).toBeLessThan(ids.indexOf('application-runtime'))
  })
})
