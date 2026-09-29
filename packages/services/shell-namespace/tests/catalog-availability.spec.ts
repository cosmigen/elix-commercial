import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ShellNamespaceEngine } from '../src/engine.ts'
import { makeShellItemId } from '../src/types.ts'

describe('Catalog & Availability Resolution', () => {
  it('resolves item as available when file exists on disk', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'elix-avail-test-'))
    try {
      const filePath = path.join(tmpDir, 'present.txt')
      await fs.writeFile(filePath, 'present', 'utf8')

      const engine = new ShellNamespaceEngine()
      const items = await engine.listPath(tmpDir)
      expect(items.length).toBe(1)

      const item = items[0]!
      const resolution = await engine.resolveItem(item.id)

      expect(resolution.status).toBe('available')
      if (resolution.status === 'available') {
        expect(resolution.item.id).toBe(item.id)
      }

      const exists = await engine.exists(item.id)
      expect(exists).toBe(true)

      engine.dispose()
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('resolves item as missing when file is deleted from disk', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'elix-missing-test-'))
    try {
      const filePath = path.join(tmpDir, 'to-delete.txt')
      await fs.writeFile(filePath, 'will be deleted', 'utf8')

      const engine = new ShellNamespaceEngine()
      const items = await engine.listPath(tmpDir)
      const item = items[0]!

      // Delete file behind catalog's back
      await fs.unlink(filePath)

      const resolution = await engine.resolveItem(item.id)
      expect(resolution.status).toBe('missing')

      const exists = await engine.exists(item.id)
      expect(exists).toBe(false)

      engine.dispose()
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('resolves unknown item id as missing', async () => {
    const engine = new ShellNamespaceEngine()
    const unknownId = makeShellItemId('path:nonexistent123')
    const resolution = await engine.resolveItem(unknownId)

    expect(resolution.status).toBe('missing')
    engine.dispose()
  })

  it('retrieves children of a folder item', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'elix-children-test-'))
    try {
      const subFolder = path.join(tmpDir, 'SubFolder')
      await fs.mkdir(subFolder)
      await fs.writeFile(path.join(subFolder, 'child1.txt'), 'c1')
      await fs.writeFile(path.join(subFolder, 'child2.txt'), 'c2')

      const engine = new ShellNamespaceEngine()
      const rootItems = await engine.listPath(tmpDir)
      const folderItem = rootItems.find(i => i.displayName === 'SubFolder')
      expect(folderItem).toBeDefined()
      if (!folderItem) return

      const children = await engine.getChildren(folderItem.id)
      expect(children.length).toBe(2)
      const names = children.map(c => c.displayName)
      expect(names).toContain('child1.txt')
      expect(names).toContain('child2.txt')

      engine.dispose()
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('handles unavailable container resolution cleanly', async () => {
    const engine = new ShellNamespaceEngine()
    const nonExistentPath = 'C:/Totally/Fake/Container/Dir'

    // Listing unavailable container path returns empty list safely
    const pathItems = await engine.listPath(nonExistentPath)
    expect(pathItems).toEqual([])

    // Listing unavailable container id returns empty list
    const fakeId = makeShellItemId('path:ghostcontainer')
    const idItems = await engine.list(fakeId)
    expect(idItems).toEqual([])

    // Resolving unavailable container id returns missing
    const res = await engine.resolveItem(fakeId)
    expect(res.status).toBe('missing')

    engine.dispose()
  })

  it('cleans up old path in secondary index after item rename', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'elix-rename-index-'))
    try {
      const origPath = path.join(tmpDir, 'source.txt')
      const renamedPath = path.join(tmpDir, 'dest.txt')
      await fs.writeFile(origPath, 'test content')

      const engine = new ShellNamespaceEngine()
      await engine.listPath(tmpDir)

      // Verify original path is indexed
      const itemBefore = engine.catalog.getByPath(origPath)
      expect(itemBefore).toBeDefined()
      expect(itemBefore?.displayName).toBe('source.txt')

      // Rename on disk
      await fs.rename(origPath, renamedPath)

      // Re-scan container
      await engine.listPath(tmpDir)

      // CRITICAL BUG VERIFICATION: Old path MUST be deleted from secondary index
      expect(engine.catalog.getByPath(origPath)).toBeUndefined()

      // New path must be indexed
      const itemAfter = engine.catalog.getByPath(renamedPath)
      expect(itemAfter).toBeDefined()
      expect(itemAfter?.displayName).toBe('dest.txt')

      engine.dispose()
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })
})
