import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  initProfile,
  loadProfile,
  PROFILE_TEMPLATES,
  readProfileManifest,
  resolveProfileDir,
  writeProfileManifest,
} from '../src/index.ts'

const BASE_BUNDLE = '@deepseek-ai/dsh-base'
const WINDOWS_RUNTIME_BUNDLE = '@deepseek-ai/dsh-windows-runtime'

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-runtime-profile-'))
}

function stageInstallation(bundleNames: readonly string[]): string {
  const root = tmp()
  const appDir = join(root, 'app')
  const dependencies: Record<string, string> = {}

  for (const name of bundleNames) {
    dependencies[name] = '0.0.0'
    const dir = join(appDir, 'node_modules', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name,
      version: '0.0.0',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }))
    writeFileSync(join(dir, 'cordis.patch.yml'), '[]\n')
  }

  mkdirSync(appDir, { recursive: true })
  const anchor = join(appDir, 'package.json')
  writeFileSync(anchor, JSON.stringify({ name: 'dsh-test-app', dependencies }))
  return anchor
}

describe('production runtime profile', () => {
  it('ships Windows runtime only in the default profile', () => {
    expect(PROFILE_TEMPLATES.default).toEqual([BASE_BUNDLE, WINDOWS_RUNTIME_BUNDLE])
    expect(PROFILE_TEMPLATES.minimal).toEqual([BASE_BUNDLE])
  })

  it('migrates the previous installation-owned default tuple without losing other manifest fields', () => {
    const anchor = stageInstallation([BASE_BUNDLE, WINDOWS_RUNTIME_BUNDLE])
    const home = tmp()
    const dir = resolveProfileDir('default', home)
    initProfile(dir, [BASE_BUNDLE])

    const original = readProfileManifest('test', dir)
    writeProfileManifest(dir, {
      ...original,
      dependencies: { preserved: '1.2.3' },
    })

    const loaded = loadProfile('test', 'default', anchor, home)
    expect(loaded.layers.map(layer => layer.packageName)).toEqual([BASE_BUNDLE, WINDOWS_RUNTIME_BUNDLE])

    const persisted = readProfileManifest('test', dir)
    expect(persisted.dsh?.profile?.bundles).toEqual([BASE_BUNDLE, WINDOWS_RUNTIME_BUNDLE])
    expect(persisted.dependencies).toEqual({ preserved: '1.2.3' })
    expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).toContain('[]')
  })

  it('does not rewrite a user-owned default bundle tuple', () => {
    const extra = 'example-user-bundle'
    const anchor = stageInstallation([BASE_BUNDLE, WINDOWS_RUNTIME_BUNDLE, extra])
    const home = tmp()
    const dir = resolveProfileDir('default', home)
    initProfile(dir, [BASE_BUNDLE, extra])

    const loaded = loadProfile('test', 'default', anchor, home)
    expect(loaded.layers.map(layer => layer.packageName)).toEqual([BASE_BUNDLE, extra])
    expect(readProfileManifest('test', dir).dsh?.profile?.bundles).toEqual([BASE_BUNDLE, extra])
  })
})
