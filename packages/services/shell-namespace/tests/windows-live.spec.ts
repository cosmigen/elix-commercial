import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { WindowsKnownFolderResolver } from '../src/known-folders.ts'
import { ShellNamespaceEngine } from '../src/engine.ts'
import { ShellNamespaceService } from '../src/index.ts'

describe('Live Windows Acceptance Check', () => {
  it('resolves actual configured User Desktop and Public Desktop on host', async () => {
    if (process.platform !== 'win32') {
      return
    }

    const resolver = new WindowsKnownFolderResolver()
    const userDesk = await resolver.resolve('Desktop')
    const pubDesk = await resolver.resolve('PublicDesktop')

    expect(userDesk.available).toBe(true)
    expect(userDesk.path).toBeDefined()
    expect(typeof userDesk.path).toBe('string')

    expect(pubDesk.available).toBe(true)
    expect(pubDesk.path).toBeDefined()
    expect(typeof pubDesk.path).toBe('string')
  })

  it('enumerates real host desktop items without modifying user data', async () => {
    if (process.platform !== 'win32') {
      return
    }

    const engine = new ShellNamespaceEngine()
    const desktopSnapshot = await engine.getDesktop()

    expect(desktopSnapshot.items).toBeDefined()
    expect(Array.isArray(desktopSnapshot.items)).toBe(true)

    for (const item of desktopSnapshot.items) {
      expect(item.id).toBeDefined()
      expect(['user-desktop', 'public-desktop']).toContain(item.source)
      expect(['file', 'folder', 'shortcut']).toContain(item.kind)
      expect(item.location.path).toBeDefined()
      expect(item.attributes).toBeDefined()
      expect(item.icon).toBeDefined()
    }

    engine.dispose()
  })

  it('runs complete lifecycle mutations (create, modify, rename, delete) in temporary acceptance folder', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'elix-acceptance-'))
    try {
      const engine = new ShellNamespaceEngine({ debounceMs: 40 })

      // 1. Create initial items
      const docPath = path.join(tmpDir, 'acceptance-doc.txt')
      const folderPath = path.join(tmpDir, 'acceptance-folder')
      await fs.writeFile(docPath, 'acceptance data', 'utf8')
      await fs.mkdir(folderPath)

      // 2. Discover initial items
      const initialItems = await engine.listPath(tmpDir)
      expect(initialItems.length).toBe(2)

      const docItem = initialItems.find(i => i.displayName === 'acceptance-doc.txt')
      const folderItem = initialItems.find(i => i.displayName === 'acceptance-folder')
      expect(docItem).toBeDefined()
      expect(docItem?.kind).toBe('file')
      expect(folderItem).toBeDefined()
      expect(folderItem?.kind).toBe('folder')

      // 3. Watch container and test live events
      const detectedRenames: unknown[] = []
      const detectedRemovals: unknown[] = []

      engine.on('item-renamed', (item, prev) => {
        detectedRenames.push({ item, prev })
      })
      engine.on('item-removed', (id) => {
        detectedRemovals.push(id)
      })

      const sub = engine.watch(tmpDir)

      // 4. Rename file
      const renamedDocPath = path.join(tmpDir, 'acceptance-doc-renamed.txt')
      await fs.rename(docPath, renamedDocPath)

      // Wait for debounce and reconciliation
      await new Promise(resolve => setTimeout(resolve, 150))

      // Verify item renamed
      const afterRenameItems = await engine.listPath(tmpDir)
      const renamedItem = afterRenameItems.find(
        i => i.displayName === 'acceptance-doc-renamed.txt',
      )
      expect(renamedItem).toBeDefined()

      // If filesystem-stable identity is supported, verify identity was preserved!
      if (docItem?.identityQuality === 'filesystem-stable') {
        expect(renamedItem?.id).toBe(docItem.id)
      }

      // 5. Delete file
      await fs.unlink(renamedDocPath)
      await new Promise(resolve => setTimeout(resolve, 150))

      const afterDeleteItems = await engine.listPath(tmpDir)
      expect(
        afterDeleteItems.find(i => i.displayName === 'acceptance-doc-renamed.txt'),
      ).toBeUndefined()

      // 6. Clean disposal
      sub.dispose()
      engine.dispose()
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('integrates seamlessly with Cordis plugin lifecycle on real machine', async () => {
    const ctx = new Context()
    ctx.plugin(ShellNamespaceService)

    await new Promise(resolve => setTimeout(resolve, 50))
    expect(ctx.shellNamespace.ready).toBe(true)

    const desktop = await ctx.shellNamespace.getDesktop()
    expect(desktop).toBeDefined()

    await ctx.fiber.dispose()
    expect(ctx.shellNamespace).toBeUndefined()
  })
})
