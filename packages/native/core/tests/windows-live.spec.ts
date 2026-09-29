import * as child_process from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createNativeBridge,
  NativeBridgeClient,
} from '../src/index.ts'
import type { WatcherChangeEvent } from '../src/types.ts'

describe('Native Core Windows Live Acceptance', () => {
  if (process.platform !== 'win32') {
    it.skip('Skipping Windows live tests on non-Windows platform', () => {})
    return
  }

  let bridge: NativeBridgeClient
  let tempDir: string

  beforeAll(async () => {
    bridge = createNativeBridge()
    await bridge.connect()
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'elix-native-live-'))
  })

  afterAll(async () => {
    await bridge.dispose()
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup error
    }
  })

  it('resolves real Windows Known Folders on host machine', async () => {
    const desktop = await bridge.knownFolders.resolve('Desktop')
    expect(desktop.available).toBe(true)
    expect(desktop.isVirtual).toBe(false)
    expect(desktop.path).toBeDefined()
    expect(fs.existsSync(desktop.path!)).toBe(true)

    const publicDesktop = await bridge.knownFolders.resolve('PublicDesktop')
    expect(publicDesktop.available).toBe(true)
    expect(publicDesktop.path).toBeDefined()
    expect(fs.existsSync(publicDesktop.path!)).toBe(true)

    const startMenu = await bridge.knownFolders.resolve('StartMenu')
    expect(startMenu.available).toBe(true)
    expect(startMenu.path).toBeDefined()
    expect(fs.existsSync(startMenu.path!)).toBe(true)

    const recycleBin = await bridge.knownFolders.resolve('RecycleBin')
    expect(recycleBin.available).toBe(true)
    expect(recycleBin.isVirtual).toBe(true)
    expect(recycleBin.displayName).toBe('Recycle Bin')
  })

  it('guarantees LOCATION != IDENTITY invariant across rename on NTFS volume', async () => {
    const originalPath = path.join(tempDir, 'source-item.txt')
    const renamedPath = path.join(tempDir, 'renamed-item.txt')
    fs.writeFileSync(originalPath, 'persistence payload', 'utf8')

    // 1. Identify original file
    const originalIdentity = await bridge.files.identify(originalPath)
    expect(originalIdentity.quality).toBe('native-stable')
    expect(originalIdentity.id).toMatch(/^fs:[0-9a-fA-F]+:[0-9a-fA-F]+$/)
    expect(originalIdentity.volumeSerialNumber).toBeDefined()
    expect(originalIdentity.fileId).toBeDefined()

    // 2. Rename file on the same volume
    fs.renameSync(originalPath, renamedPath)

    // 3. Identify renamed file
    const renamedIdentity = await bridge.files.identify(renamedPath)
    expect(renamedIdentity.quality).toBe('native-stable')

    // 4. Critical invariant: ID must remain identical despite path change
    expect(renamedIdentity.id).toBe(originalIdentity.id)
    expect(renamedIdentity.volumeSerialNumber).toBe(originalIdentity.volumeSerialNumber)
    expect(renamedIdentity.fileId).toBe(originalIdentity.fileId)
    expect(renamedIdentity.canonicalPath).not.toBe(originalIdentity.canonicalPath)
  })

  it('resolves real host COM Shell Link (.lnk) without process execution', async () => {
    // Locate a real Start Menu shortcut on host
    const startMenuDir = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs')
    let sampleLnk: string | null = null

    function findFirstLnk(dir: string): string | null {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true })
        for (const entry of entries) {
          const full = path.join(dir, entry.name)
          if (entry.isFile() && entry.name.toLowerCase().endsWith('.lnk')) {
            return full
          }
          if (entry.isDirectory()) {
            const nested = findFirstLnk(full)
            if (nested) return nested
          }
        }
      } catch {
        // Ignore read errors
      }
      return null
    }

    sampleLnk = findFirstLnk(startMenuDir)
    if (!sampleLnk) {
      const commonPrograms = 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs'
      sampleLnk = findFirstLnk(commonPrograms)
    }

    if (!sampleLnk) {
      // If no start menu shortcuts exist, skip shortcut inspection
      return
    }

    const meta = await bridge.shortcuts.resolve(sampleLnk)
    expect(meta).toBeDefined()
    expect(typeof meta.isBroken).toBe('boolean')
    // Link inspection extracts target/icon metadata without launching
  })

  it('queries real PE icons from host system binary using Win32 API', async () => {
    const explorerPath = 'C:/Windows/explorer.exe'
    const cmdPath = 'C:/Windows/System32/cmd.exe'
    const targetBinary = fs.existsSync(explorerPath) ? explorerPath : cmdPath

    const iconDesc = await bridge.icons.resolve(targetBinary, false)
    expect(iconDesc.reference).toBeDefined()
    expect(iconDesc.hasEmbeddedIcon).toBe(true)
    expect(iconDesc.totalResourceIcons).toBeGreaterThan(0)
    expect(iconDesc.reference.kind).toBe('resource')
  })

  it('delivers real directory change events via native ReadDirectoryChangesW watcher', async () => {
    const watchFolder = path.join(tempDir, 'native-watcher-live')
    fs.mkdirSync(watchFolder, { recursive: true })

    const events: string[] = []
    const sub = await bridge.watcher.watch(watchFolder, (ev) => {
      events.push(ev.changeType)
    })

    try {
      // Trigger a change by creating a file
      const dummyFile = path.join(watchFolder, 'watch-event-file.tmp')
      fs.writeFileSync(dummyFile, 'watcher data', 'utf8')

      // Wait for native overlapped event to arrive
      const start = Date.now()
      while (events.length === 0 && Date.now() - start < 2000) {
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      expect(events.length).toBeGreaterThan(0)
    } finally {
      await sub.unwatch()
    }
  })

  it('follows a reparse-point container target without watching its subtree recursively', async () => {
    const target = path.join(tempDir, 'reparse-target')
    const link = path.join(tempDir, 'reparse-container')
    const nested = path.join(target, 'nested')
    fs.mkdirSync(nested, { recursive: true })
    fs.symlinkSync(target, link, 'junction')

    const events: WatcherChangeEvent[] = []
    const sub = await bridge.watcher.watch(link, event => events.push(event))
    try {
      fs.writeFileSync(path.join(target, 'root.txt'), 'root')
      const rootStart = Date.now()
      while (!events.some(event => event.fileName === 'root.txt') && Date.now() - rootStart < 2_000) {
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      expect(events.some(event => event.fileName === 'root.txt')).toBe(true)

      events.length = 0
      fs.writeFileSync(path.join(nested, 'nested.txt'), 'nested')
      await new Promise(resolve => setTimeout(resolve, 200))
      expect(events.some(event => event.fileName === 'nested.txt')).toBe(false)
    } finally {
      await sub.unwatch()
    }
  })

  it('reports canonical virtual-screen physical pixels matching current display mode', async () => {
    const snapshot = await bridge.windowsContext.getSnapshot()
    expect(snapshot.monitors.length).toBeGreaterThan(0)
    const primary = snapshot.monitors.find(m => m.isPrimary)
    expect(primary).toBeDefined()
    expect(primary?.bounds.width).toBeGreaterThan(0)
    expect(primary?.bounds.height).toBeGreaterThan(0)
    expect(primary?.dpiX).toBeGreaterThanOrEqual(96)
    expect(primary?.scaleFactor).toBeCloseTo((primary?.dpiX ?? 96) / 96, 6)

    const output = child_process.execSync(
      'powershell.exe -NoProfile -Command "(Get-CimInstance Win32_VideoController | Where-Object { $_.CurrentHorizontalResolution -gt 0 } | Select-Object -First 1).CurrentHorizontalResolution, (Get-CimInstance Win32_VideoController | Where-Object { $_.CurrentHorizontalResolution -gt 0 } | Select-Object -First 1).CurrentVerticalResolution"',
      { encoding: 'utf8', timeout: 20_000 },
    )
    const lines = output
      .trim()
      .split(/\r?\n/)
      .map(s => Number.parseInt(s.trim(), 10))
    const width = lines[0]
    const height = lines[1]
    expect(width).toBeGreaterThan(0)
    expect(height).toBeGreaterThan(0)
    expect(primary?.bounds.width).toBe(width)
    expect(primary?.bounds.height).toBe(height)
  }, 20_000)
})
