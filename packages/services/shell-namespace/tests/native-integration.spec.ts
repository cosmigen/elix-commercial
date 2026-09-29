import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { NativeBridgeClient } from '@deepseek-ai/dsh-native-core'
import { ShellNamespaceEngine } from '../src/engine.ts'

describe('Shell Namespace Native Core Integration', () => {
  if (process.platform !== 'win32') {
    it.skip('Skipping Windows native integration on non-Windows', () => {})
    return
  }

  let tempDir: string

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'elix-shell-native-int-'))
  })

  afterAll(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup error
    }
  })

  it('selects rust-native backend automatically when native host is compiled and available', () => {
    expect(NativeBridgeClient.isAvailable()).toBe(true)

    const engine = new ShellNamespaceEngine()
    expect(engine.activeBackend).toBe('rust-native')
    expect(engine.bridgeClient).toBeDefined()
    engine.dispose()
  })

  it('honors preferNative: false to select typescript-fallback backend', () => {
    const engine = new ShellNamespaceEngine({ preferNative: false })
    expect(engine.activeBackend).toBe('typescript-fallback')
    expect(engine.bridgeClient).toBeUndefined()
    engine.dispose()
  })

  it('operates desktop enumeration seamlessly with rust-native backend', async () => {
    const engine = new ShellNamespaceEngine({ preferNative: true })
    expect(engine.activeBackend).toBe('rust-native')

    const snapshot = await engine.getDesktop()
    expect(snapshot).toBeDefined()
    expect(Array.isArray(snapshot.items)).toBe(true)

    for (const item of snapshot.items) {
      expect(item.id).toBeDefined()
      expect(item.location.path).toBeDefined()
    }

    engine.dispose()
  })

  it('resolves item identity and attributes through rust-native adapters on temporary folder', async () => {
    const engine = new ShellNamespaceEngine({ preferNative: true })
    const sampleFile = path.join(tempDir, 'integration-test-doc.txt')
    fs.writeFileSync(sampleFile, 'native integration content', 'utf8')

    const item = await engine.resolve(sampleFile)
    expect(item).toBeDefined()
    expect(item?.kind).toBe('file')
    expect(item?.displayName).toBe('integration-test-doc.txt')
    expect(item?.id).toMatch(/^fs:[0-9a-fA-F]+:[0-9a-fA-F]+$/)

    const list = await engine.listPath(tempDir)
    expect(list.length).toBeGreaterThanOrEqual(1)
    const found = list.find(i => i.displayName === 'integration-test-doc.txt')
    expect(found).toBeDefined()
    expect(found?.id).toBe(item?.id)

    engine.dispose()
  })
})
