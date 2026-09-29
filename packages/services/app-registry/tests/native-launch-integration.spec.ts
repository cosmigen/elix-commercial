import { describe, expect, it } from 'vitest'
import { NativeBridgeClient } from '@deepseek-ai/dsh-native-core'
import { AppRegistryEngine } from '../src/registry.ts'

describe('App Registry Native Launch Integration', () => {
  if (process.platform !== 'win32') {
    it.skip('Skipping Windows native launch on non-Windows', () => {})
    return
  }

  it('selects rust-native launch backend automatically when native host is available', () => {
    expect(NativeBridgeClient.isAvailable()).toBe(true)

    const engine = new AppRegistryEngine()
    expect(engine.activeLaunchBackend).toBe('rust-native')
    engine.dispose()
  })

  it('honors preferNative: false to select typescript-fallback launch backend', () => {
    const engine = new AppRegistryEngine({ preferNative: false })
    expect(engine.activeLaunchBackend).toBe('typescript-fallback')
    engine.dispose()
  })

  it('executes Win32 process launch via native CreateProcessW through registry launch adapter', async () => {
    const engine = new AppRegistryEngine({ preferNative: true })
    expect(engine.activeLaunchBackend).toBe('rust-native')

    const result = await engine.launchAdapter.launchWin32({
      kind: 'win32',
      executablePath: 'cmd.exe',
      arguments: ['/c', 'exit 0'],
    })

    expect(result.success).toBe(true)
    expect(result.pid).toBeDefined()
    expect(typeof result.pid).toBe('number')
    expect(result.pid!).toBeGreaterThan(0)

    engine.dispose()
  })
})
