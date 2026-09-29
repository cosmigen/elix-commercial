import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DefaultFileIdentityAdapter,
  normalizeCanonicalPath,
  computePathFallbackId,
} from '../src/identity.ts'

describe('FileIdentityAdapter', () => {
  it('normalizes canonical paths consistently', () => {
    const p1 = normalizeCanonicalPath('c:\\Users\\foo\\bar')
    const p2 = normalizeCanonicalPath('C:/Users/foo/bar')
    expect(p1).toBe(p2)
    expect(p1.startsWith('C:/')).toBe(true)
  })

  it('computes deterministic path fallback id', () => {
    const id1 = computePathFallbackId('C:/Test/path.txt')
    const id2 = computePathFallbackId('c:/test/path.txt')
    expect(id1).toBe(id2)
    expect(id1.startsWith('path:')).toBe(true)
  })

  it('generates stable identity across repeated scans', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'elix-ident-test-'))
    try {
      const filePath = path.join(tmpDir, 'test-file.txt')
      await fs.writeFile(filePath, 'hello world', 'utf8')

      const adapter = new DefaultFileIdentityAdapter()
      const id1 = await adapter.identify(filePath)
      const id2 = await adapter.identify(filePath)

      expect(id1.id).toBe(id2.id)
      expect(id1.canonicalPath).toBe(id2.canonicalPath)
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('preserves file identity across rename on Windows NTFS / filesystem', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'elix-rename-test-'))
    try {
      const origPath = path.join(tmpDir, 'report.txt')
      const renamedPath = path.join(tmpDir, 'final-report.txt')
      await fs.writeFile(origPath, 'data content', 'utf8')

      const adapter = new DefaultFileIdentityAdapter()
      const before = await adapter.identify(origPath)

      // Rename the file on disk
      await fs.rename(origPath, renamedPath)

      const after = await adapter.identify(renamedPath)

      if (before.quality === 'filesystem-stable') {
        // Identity ID MUST be identical across rename!
        expect(after.id).toBe(before.id)
        expect(after.fileId).toBe(before.fileId)
        expect(after.volumeSerialNumber).toBe(before.volumeSerialNumber)
        // Path should update
        expect(after.canonicalPath).not.toBe(before.canonicalPath)
      } else {
        // Fallback quality marks path change
        expect(before.quality).toBe('path-fallback')
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('preserves file identity across same-volume folder move', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'elix-move-test-'))
    try {
      const subDir = path.join(tmpDir, 'subdir')
      await fs.mkdir(subDir)
      const origPath = path.join(tmpDir, 'item.txt')
      const movedPath = path.join(subDir, 'item.txt')
      await fs.writeFile(origPath, 'moving data', 'utf8')

      const adapter = new DefaultFileIdentityAdapter()
      const before = await adapter.identify(origPath)

      await fs.rename(origPath, movedPath)

      const after = await adapter.identify(movedPath)

      if (before.quality === 'filesystem-stable') {
        expect(after.id).toBe(before.id)
        expect(after.fileId).toBe(before.fileId)
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('reports path-fallback quality when file does not exist', async () => {
    const adapter = new DefaultFileIdentityAdapter()
    const nonExistent = 'C:/NonExistentPath/ghost-file.bin'
    const identity = await adapter.identify(nonExistent)

    expect(identity.quality).toBe('path-fallback')
    expect(identity.id.startsWith('path:')).toBe(true)
  })

  it('reports explicit path-fallback quality when filesystem provides no inode or device', async () => {
    const adapter = new DefaultFileIdentityAdapter()
    const mockStat = {
      dev: 0,
      ino: 0,
    } as unknown as import('node:fs').Stats

    const identity = await adapter.identify('C:/Virtual/file.txt', mockStat)
    expect(identity.quality).toBe('path-fallback')
    expect(identity.id.startsWith('path:')).toBe(true)
    expect(identity.volumeSerialNumber).toBeUndefined()
    expect(identity.fileId).toBeUndefined()
  })

  it('formats unsigned 32-bit volume serial numbers and 64-bit NTFS file indexes accurately', async () => {
    const adapter = new DefaultFileIdentityAdapter()
    // Simulated volume with high bit set (-1674272334 signed = 0x9c34a1b2 unsigned)
    const mockStat = {
      dev: -1674272334,
      ino: 281474979496429n,
    } as unknown as import('node:fs').BigIntStats

    const identity = await adapter.identify('C:/Files/test.txt', mockStat)
    expect(identity.quality).toBe('filesystem-stable')
    expect(identity.volumeSerialNumber).toBe('9c34a1b2')
    expect(identity.fileId).toBe('00010000002a81ed')
    expect(identity.id).toBe('fs:9c34a1b2:00010000002a81ed')
  })
})
