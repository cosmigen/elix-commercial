import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createNativeBridge,
  NativeBridgeClient,
  NativeKnownFolderResolver,
  NativeFileIdentityAdapter,
  NativeShellLinkResolver,
  NativeShellIconResolver,
  NativeNamespaceWatcherAdapter,
  NativeAppLaunchAdapter,
} from '../src/index.ts'

describe('Native Core Adapters', () => {
  let bridge: NativeBridgeClient
  let tempDir: string

  beforeAll(async () => {
    bridge = createNativeBridge()
    await bridge.connect()
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'elix-native-adapters-'))
  })

  afterAll(async () => {
    await bridge.dispose()
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup error
    }
  })

  describe('NativeKnownFolderResolver', () => {
    it('resolves individual canonical known folders', async () => {
      const resolver = new NativeKnownFolderResolver(bridge)
      const desktop = await resolver.resolve('Desktop')
      expect(desktop.id).toBe('Desktop')
      expect(desktop.available).toBe(true)
      expect(desktop.isVirtual).toBe(false)
      expect(desktop.path).toBeDefined()

      const recycleBin = await resolver.resolve('RecycleBin')
      expect(recycleBin.id).toBe('RecycleBin')
      expect(recycleBin.isVirtual).toBe(true)
      expect(recycleBin.displayName).toBe('Recycle Bin')
    })

    it('resolves all 12 canonical known folders into a map', async () => {
      const resolver = new NativeKnownFolderResolver(bridge)
      const map = await resolver.resolveAll()
      expect(map.size).toBe(12)
      expect(map.has('Desktop')).toBe(true)
      expect(map.has('PublicDesktop')).toBe(true)
      expect(map.has('RecycleBin')).toBe(true)
      expect(map.has('StartMenu')).toBe(true)
      expect(map.has('Programs')).toBe(true)
      expect(map.has('Startup')).toBe(true)
    })
  })

  describe('NativeFileIdentityAdapter', () => {
    it('returns Win32 FILE_ID_INFO based native-stable identity for existing files', async () => {
      const adapter = new NativeFileIdentityAdapter(bridge)
      const testFile = path.join(tempDir, 'test-file.txt')
      fs.writeFileSync(testFile, 'hello world', 'utf8')

      const identity = await adapter.identify(testFile)
      expect(identity.canonicalPath.toLowerCase()).toBe(testFile.toLowerCase().replace(/\\/g, '/'))
      expect(identity.id).toMatch(/^fs:[0-9a-fA-F]+:[0-9a-fA-F]+$/)
      expect(identity.quality).toBe('native-stable')
      expect(identity.volumeSerialNumber).toBeDefined()
      expect(identity.fileId).toBeDefined()
    })

    it('returns deterministic path hash fallback for non-existent paths', async () => {
      const adapter = new NativeFileIdentityAdapter(bridge)
      const nonExistent = path.join(tempDir, 'ghost-nonexistent.txt')

      const identity = await adapter.identify(nonExistent)
      expect(identity.quality).toBe('path-fallback')
      expect(identity.id).toMatch(/^path:[0-9a-f]{16}$/)
    })
  })

  describe('NativeShellLinkResolver', () => {
    it('handles non-existent shortcut cleanly', async () => {
      const resolver = new NativeShellLinkResolver(bridge)
      const nonExistent = path.join(tempDir, 'ghost.lnk')
      const result = await resolver.resolve(nonExistent)
      expect(result).toBeUndefined()
    })

    it('handles batch resolution with non-existent shortcuts', async () => {
      const resolver = new NativeShellLinkResolver(bridge)
      const batch = await resolver.resolveBatch([
        path.join(tempDir, 'a.lnk'),
        path.join(tempDir, 'b.lnk'),
      ])
      expect(batch.size).toBe(0)
    })
  })

  describe('NativeShellIconResolver', () => {
    it('resolves reference for folder, system, and virtual kinds', () => {
      const resolver = new NativeShellIconResolver(bridge)
      const folderRef = resolver.resolveReference('folder', 'C:/folder')
      expect(folderRef.kind).toBe('fallback')
      if (folderRef.kind === 'fallback') {
        expect(folderRef.defaultIconId).toBe('generic-folder')
      }

      const virtualRef = resolver.resolveReference('virtual', 'shell:::{RecycleBin}')
      expect(virtualRef.kind).toBe('fallback')
      if (virtualRef.kind === 'fallback') {
        expect(virtualRef.defaultIconId).toBe('generic-system')
      }
    })

    it('resolves reference for image files and extensions', () => {
      const resolver = new NativeShellIconResolver(bridge)
      const pngRef = resolver.resolveReference('file', 'C:/image.png', '.png')
      expect(pngRef.kind).toBe('file')
      if (pngRef.kind === 'file') {
        expect(pngRef.filePath).toBe('C:/image.png')
      }

      const txtRef = resolver.resolveReference('file', 'C:/notes.txt', '.txt')
      expect(txtRef.kind).toBe('extension')
      if (txtRef.kind === 'extension') {
        expect(txtRef.extension).toBe('.txt')
      }

      const exeRef = resolver.resolveReference('file', 'C:/app.exe', '.exe')
      expect(exeRef.kind).toBe('resource')
      if (exeRef.kind === 'resource') {
        expect(exeRef.sourcePath).toBe('C:/app.exe')
        expect(exeRef.resourceIndex).toBe(0)
      }
    })

    it('resolves shortcut icon metadata references correctly', () => {
      const resolver = new NativeShellIconResolver(bridge)
      const withResourceIcon = resolver.resolveReference('shortcut', 'C:/link.lnk', '.lnk', {
        isBroken: false,
        icon: {
          kind: 'resource',
          sourcePath: 'C:/Windows/System32/shell32.dll',
          resourceIndex: 42,
        },
      })
      expect(withResourceIcon.kind).toBe('resource')
      if (withResourceIcon.kind === 'resource') {
        expect(withResourceIcon.sourcePath).toBe('C:/Windows/System32/shell32.dll')
        expect(withResourceIcon.resourceIndex).toBe(42)
      }
    })
  })

  describe('NativeNamespaceWatcherAdapter', () => {
    it('creates debounced container subscription and cleans up on unwatch', async () => {
      const adapter = new NativeNamespaceWatcherAdapter(bridge, { debounceMs: 25 })
      const watchDir = path.join(tempDir, 'watch-target')
      fs.mkdirSync(watchDir, { recursive: true })

      let _callCount = 0
      const sub = adapter.watch(watchDir, () => {
        _callCount++
      })

      expect(sub.path.toLowerCase()).toBe(path.resolve(watchDir).toLowerCase())
      sub.dispose()
      adapter.dispose()
    })
  })

  describe('NativeAppLaunchAdapter', () => {
    it('launches Win32 executable with arguments', async () => {
      const adapter = new NativeAppLaunchAdapter(bridge)
      const res = await adapter.launchWin32({
        kind: 'win32',
        executablePath: 'cmd.exe',
        arguments: ['/c', 'exit 0'],
      })

      expect(res.success).toBe(true)
      expect(res.pid).toBeDefined()
    })

    it('returns structured error on invalid executable path', async () => {
      const adapter = new NativeAppLaunchAdapter(bridge)
      const res = await adapter.launchWin32({
        kind: 'win32',
        executablePath: 'C:/nonexistent/binary/that/cannot/exist.exe',
      })

      expect(res.success).toBe(false)
      expect(res.error).toBeDefined()
    })
  })
})
