import { describe, expect, it } from 'vitest'
import {
  NativeBridgeClient,
  NativeBridgeError,
  createNativeBridge,
  findNativeHostBinary,
} from '../src/index.ts'

describe('Native Bridge Client', () => {
  it('locates the compiled elix-native-host.exe binary', () => {
    const binPath = findNativeHostBinary()
    expect(binPath).toBeDefined()
    expect(binPath?.endsWith('elix-native-host.exe')).toBe(true)
    expect(NativeBridgeClient.isAvailable()).toBe(true)
  })

  it('performs handshake and negotiates capabilities', async () => {
    const bridge = createNativeBridge()
    try {
      const handshake = await bridge.connect()
      expect(handshake.protocolVersion).toBe(1)
      expect(handshake.nativeVersion).toBe('0.1.0')
      expect(handshake.capabilities.knownFolders).toBe(true)
      expect(handshake.capabilities.fileIdentity).toBe(true)
      expect(handshake.capabilities.shellLinks).toBe(true)
      expect(handshake.capabilities.shellIcons).toBe(true)
      expect(handshake.capabilities.namespaceWatch).toBe(true)
      expect(handshake.capabilities.processLaunch).toBe(true)
      expect(handshake.capabilities.windowsContext).toBe(true)
      expect(bridge.getStatus()).toBe('ready')
      expect(bridge.isReady()).toBe(true)
      expect(bridge.getCapabilities()?.fileIdentity).toBe(true)
      expect(bridge.getHandshake()?.protocolVersion).toBe(1)
    } finally {
      await bridge.dispose()
      expect(bridge.getStatus()).toBe('closed')
    }
  })

  it('executes ping request/response round-trip', async () => {
    const bridge = createNativeBridge()
    try {
      const pingTime = await bridge.ping()
      expect(pingTime).toBeGreaterThan(0)
      expect(Date.now() - pingTime).toBeLessThan(5000)
    } finally {
      await bridge.dispose()
    }
  })

  it('returns structured errors for unknown RPC methods', async () => {
    const bridge = createNativeBridge()
    try {
      await expect(bridge.sendRequest('unrecognized/method')).rejects.toThrow(NativeBridgeError)
    } finally {
      await bridge.dispose()
    }
  })

  it('handles request timeout cleanly', async () => {
    const bridge = createNativeBridge()
    try {
      await expect(bridge.sendRequest('bridge/delay', { ms: 200 }, 20)).rejects.toThrow(NativeBridgeError)
    } finally {
      await bridge.dispose()
    }
  })

  it('throws structured NativeBridgeError when binary does not exist', async () => {
    const bridge = createNativeBridge({ binaryPath: 'C:/fake_elix_native_host_nonexistent.exe' })
    try {
      await expect(bridge.connect()).rejects.toThrow(NativeBridgeError)
      expect(bridge.getStatus()).toBe('faulted')
    } finally {
      await bridge.dispose()
    }
  })

  it('rejects subsequent requests immediately when bridge is closed', async () => {
    const bridge = createNativeBridge()
    await bridge.connect()
    await bridge.dispose()
    expect(bridge.getStatus()).toBe('closed')

    await expect(bridge.ping()).rejects.toMatchObject({
      domain: 'bridge',
      code: 'BRIDGE_CLOSED',
    })
  })

  it('idempotently returns existing handshake on multiple connect calls', async () => {
    const bridge = createNativeBridge()
    try {
      const hs1 = await bridge.connect()
      const hs2 = await bridge.connect()
      expect(hs1).toBe(hs2)
    } finally {
      await bridge.dispose()
    }
  })
})
