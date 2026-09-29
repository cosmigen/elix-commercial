import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runNativeCommand } from '@deepseek-ai/dsh-native-command'
import { FileSystemProvider, normalizeFileSystemPath } from '../src/file-system.ts'

describe('FileSystemProvider', () => {
  it('normalizes Windows file system paths consistently', () => {
    const p1 = normalizeFileSystemPath('c:\\path\\to\\dir')
    const p2 = normalizeFileSystemPath('C:/path/to/dir')
    expect(p1).toBe(p2)
    expect(p1.startsWith('C:')).toBe(true)
  })

  it('enumerates files, folders, and classification correctly', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'elix-fs-enum-'))
    try {
      await fs.writeFile(path.join(tmpDir, 'document.txt'), 'text', 'utf8')
      await fs.mkdir(path.join(tmpDir, 'ProjectsFolder'))

      const provider = new FileSystemProvider()
      const items = await provider.listDirectory(tmpDir)

      expect(items.length).toBe(2)

      const fileItem = items.find(i => i.displayName === 'document.txt')
      expect(fileItem).toBeDefined()
      expect(fileItem?.kind).toBe('file')
      expect(fileItem?.extension).toBe('.txt')
      expect(fileItem?.attributes.directory).toBe(false)
      expect(fileItem?.size).toBeGreaterThan(0)

      const folderItem = items.find(i => i.displayName === 'ProjectsFolder')
      expect(folderItem).toBeDefined()
      expect(folderItem?.kind).toBe('folder')
      expect(folderItem?.attributes.directory).toBe(true)
      expect(folderItem?.extension).toBeUndefined()
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('preserves Unicode filenames and emojis accurately', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'elix-unicode-'))
    try {
      const unicodeNames = [
        '日本語ドキュメント.txt',
        'Проект_2026.pdf',
        'Diseño_Español.docx',
        '🚀 RocketLaunch 📁.txt',
      ]

      for (const name of unicodeNames) {
        await fs.writeFile(path.join(tmpDir, name), 'sample', 'utf8')
      }

      const provider = new FileSystemProvider()
      const items = await provider.listDirectory(tmpDir)

      expect(items.length).toBe(unicodeNames.length)
      const foundNames = items.map(i => i.displayName)

      for (const expected of unicodeNames) {
        expect(foundNames).toContain(expected)
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('detects hidden, system, and read-only attributes without hiding them', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'elix-attribs-'))
    try {
      const dotFilePath = path.join(tmpDir, '.config-hidden.json')
      const regularFilePath = path.join(tmpDir, 'visible-normal.txt')
      const winHiddenPath = path.join(tmpDir, 'system-hidden.dat')
      const readOnlyPath = path.join(tmpDir, 'readonly.txt')

      await fs.writeFile(dotFilePath, '{}', 'utf8')
      await fs.writeFile(regularFilePath, 'visible content', 'utf8')
      await fs.writeFile(winHiddenPath, 'secret system data', 'utf8')
      await fs.writeFile(readOnlyPath, 'read only data', 'utf8')

      if (process.platform === 'win32') {
        try {
          await runNativeCommand('attrib.exe', ['+h', '+s', winHiddenPath], AbortSignal.timeout(5_000))
          await runNativeCommand('attrib.exe', ['+r', readOnlyPath], AbortSignal.timeout(5_000))
        } catch {
          // Attrib command fallback
        }
      }

      const provider = new FileSystemProvider()
      const items = await provider.listDirectory(tmpDir)

      // Provider must expose truth: ALL files must be included in listing
      expect(items.length).toBe(4)

      const dotItem = items.find(i => i.displayName === '.config-hidden.json')
      expect(dotItem).toBeDefined()
      expect(dotItem?.attributes.hidden).toBe(true)

      const regularItem = items.find(i => i.displayName === 'visible-normal.txt')
      expect(regularItem).toBeDefined()
      expect(regularItem?.attributes.hidden).toBe(false)
      expect(regularItem?.attributes.system).toBe(false)

      const winHiddenItem = items.find(i => i.displayName === 'system-hidden.dat')
      expect(winHiddenItem).toBeDefined()
      if (process.platform === 'win32') {
        expect(winHiddenItem?.attributes.hidden).toBe(true)
        expect(winHiddenItem?.attributes.system).toBe(true)
      }

      const roItem = items.find(i => i.displayName === 'readonly.txt')
      expect(roItem).toBeDefined()
      if (process.platform === 'win32') {
        expect(roItem?.attributes.readOnly).toBe(true)
      }
    } finally {
      if (process.platform === 'win32') {
        // Clear system/hidden/readonly flags so temp directory cleanup succeeds
        try {
          await runNativeCommand('attrib.exe', ['-h', '-s', '-r', path.join(tmpDir, '*')], AbortSignal.timeout(5_000))
        } catch {
          // Cleanup
        }
      }
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('handles long paths and extended-length path prefix safely', () => {
    const rawPath = 'C:\\Some\\Deeply\\Nested\\Directory\\Path'
    const extPath = `\\\\?\\${rawPath}`

    const norm1 = normalizeFileSystemPath(rawPath)
    const norm2 = normalizeFileSystemPath(extPath)

    expect(norm1).toBe(norm2)
    expect(norm2.startsWith('C:')).toBe(true)

    // Verify path exceeding 260 characters
    const longSegment = 'subfolder_level_segment_with_very_long_descriptive_name'
    const repeated = Array(6).fill(longSegment).join('\\')
    const veryLong = `C:\\${repeated}\\file.txt`
    expect(veryLong.length).toBeGreaterThan(260)

    const normalizedLong = normalizeFileSystemPath(veryLong)
    expect(normalizedLong.length).toBeGreaterThan(260)
    expect(normalizedLong.startsWith('C:')).toBe(true)
  })

  it('handles access-denied item gracefully during scan', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'elix-access-denied-'))
    try {
      await fs.writeFile(path.join(tmpDir, 'accessible.txt'), 'content')
      await fs.writeFile(path.join(tmpDir, 'denied.txt'), 'classified')

      const provider = new FileSystemProvider({
        lstat: async (filePath) => {
          if (filePath.includes('denied.txt')) {
            const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException
            err.code = 'EACCES'
            throw err
          }
          return fs.lstat(filePath)
        },
      })

      const items = await provider.listDirectory(tmpDir)

      // Accessible item is returned, denied item skipped cleanly without crashing
      expect(items.length).toBe(1)
      expect(items[0]?.displayName).toBe('accessible.txt')
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('handles file disappearing during scan without crashing', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'elix-race-disappear-'))
    try {
      await fs.writeFile(path.join(tmpDir, 'existing.txt'), 'persists')
      await fs.writeFile(path.join(tmpDir, 'ghost.txt'), 'will vanish')

      // Simulate file deletion right between readdir and lstat via injected lstat
      const provider = new FileSystemProvider({
        lstat: async (filePath) => {
          if (filePath.includes('ghost.txt')) {
            const err = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException
            err.code = 'ENOENT'
            throw err
          }
          return fs.lstat(filePath)
        },
      })

      const items = await provider.listDirectory(tmpDir)

      expect(items.length).toBe(1)
      expect(items[0]?.displayName).toBe('existing.txt')
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('handles symlinks safely without recursive traversal', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'elix-symlink-'))
    try {
      const targetDir = path.join(tmpDir, 'target')
      await fs.mkdir(targetDir)
      await fs.writeFile(path.join(targetDir, 'inner.txt'), 'nested content')

      const linkPath = path.join(tmpDir, 'symlink-target')
      try {
        await fs.symlink(targetDir, linkPath, 'junction')
      } catch {
        // Windows unprivileged symlink creation might fail in some test environments
        return
      }

      const provider = new FileSystemProvider()
      const items = await provider.listDirectory(tmpDir)

      const symlinkItem = items.find(i => i.displayName === 'symlink-target')
      expect(symlinkItem).toBeDefined()
      expect(symlinkItem?.attributes.reparsePoint).toBe(true)

      // Reparse point must NOT cause recursive expansion into the parent directory listing!
      expect(items.find(i => i.displayName === 'inner.txt')).toBeUndefined()
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('handles non-existent or inaccessible directories gracefully', async () => {
    const provider = new FileSystemProvider()
    const nonExistent = 'C:/Totally/Fake/Directory/Path'
    const items = await provider.listDirectory(nonExistent)
    expect(items).toEqual([])

    const item = await provider.getItem(path.join(nonExistent, 'file.txt'))
    expect(item).toBeUndefined()
  })
})
