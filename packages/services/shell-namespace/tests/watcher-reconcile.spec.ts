import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { reconcileContainer } from '../src/reconcile.ts'
import { MockNamespaceWatcher, DefaultNamespaceWatcher } from '../src/watcher.ts'
import { ShellNamespaceEngine } from '../src/engine.ts'
import { makeShellItemId, type ShellItem } from '../src/types.ts'

describe('Watcher & Reconciliation', () => {
  it('detects added and removed items correctly in reconcileContainer', () => {
    const id1 = makeShellItemId('fs:dev:100')
    const id2 = makeShellItemId('fs:dev:200')

    const item1: ShellItem = {
      id: id1,
      kind: 'file',
      displayName: 'file1.txt',
      location: { path: 'C:/dir/file1.txt' },
      source: 'filesystem',
      attributes: {
        hidden: false,
        system: false,
        readOnly: false,
        archive: true,
        directory: false,
        reparsePoint: false,
        offline: false,
        temporary: false,
      },
      icon: { kind: 'fallback', defaultIconId: 'generic-file' },
      identityQuality: 'filesystem-stable',
    }

    const item2: ShellItem = {
      ...item1,
      id: id2,
      displayName: 'file2.txt',
      location: { path: 'C:/dir/file2.txt' },
    }

    const prevMap = new Map([[id1, item1]])
    const currentItems = [item2]

    const diff = reconcileContainer(prevMap, currentItems)

    expect(diff.added.length).toBe(1)
    expect(diff.added[0]?.id).toBe(id2)

    expect(diff.removed.length).toBe(1)
    expect(diff.removed[0]).toBe(id1)

    expect(diff.renamed.length).toBe(0)
    expect(diff.modified.length).toBe(0)
  })

  it('detects rename correlation when identity is preserved across name/path change', () => {
    const id1 = makeShellItemId('fs:dev:100')

    const before: ShellItem = {
      id: id1,
      kind: 'file',
      displayName: 'draft.txt',
      location: { path: 'C:/dir/draft.txt' },
      source: 'filesystem',
      attributes: {
        hidden: false,
        system: false,
        readOnly: false,
        archive: true,
        directory: false,
        reparsePoint: false,
        offline: false,
        temporary: false,
      },
      icon: { kind: 'fallback', defaultIconId: 'generic-file' },
      identityQuality: 'filesystem-stable',
      modifiedAt: 1000,
    }

    const after: ShellItem = {
      ...before,
      displayName: 'published.txt',
      location: { path: 'C:/dir/published.txt' },
    }

    const prevMap = new Map([[id1, before]])
    const currentItems = [after]

    const diff = reconcileContainer(prevMap, currentItems)

    // CRITICAL: Must be classified as rename, NOT remove + add!
    expect(diff.renamed.length).toBe(1)
    expect(diff.renamed[0]?.item.displayName).toBe('published.txt')
    expect(diff.renamed[0]?.previousItem.displayName).toBe('draft.txt')
    expect(diff.added.length).toBe(0)
    expect(diff.removed.length).toBe(0)
  })

  it('detects modification when timestamps or size change', () => {
    const id1 = makeShellItemId('fs:dev:100')

    const before: ShellItem = {
      id: id1,
      kind: 'file',
      displayName: 'doc.txt',
      location: { path: 'C:/dir/doc.txt' },
      source: 'filesystem',
      attributes: {
        hidden: false,
        system: false,
        readOnly: false,
        archive: true,
        directory: false,
        reparsePoint: false,
        offline: false,
        temporary: false,
      },
      icon: { kind: 'fallback', defaultIconId: 'generic-file' },
      identityQuality: 'filesystem-stable',
      modifiedAt: 1000,
      size: 10,
    }

    const after: ShellItem = {
      ...before,
      modifiedAt: 2000,
      size: 25,
    }

    const prevMap = new Map([[id1, before]])
    const currentItems = [after]

    const diff = reconcileContainer(prevMap, currentItems)

    expect(diff.modified.length).toBe(1)
    expect(diff.modified[0]?.id).toBe(id1)
    expect(diff.renamed.length).toBe(0)
  })

  it('coalesces rapid filesystem events through DefaultNamespaceWatcher debounce', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'elix-watch-coalesce-'))
    try {
      const watcher = new DefaultNamespaceWatcher({ debounceMs: 50 })
      let triggerCount = 0

      const sub = watcher.watch(tmpDir, () => {
        triggerCount++
      })

      // Trigger multiple rapid writes
      await fs.writeFile(path.join(tmpDir, 'file1.txt'), '1')
      await fs.writeFile(path.join(tmpDir, 'file2.txt'), '2')
      await fs.writeFile(path.join(tmpDir, 'file3.txt'), '3')

      // Wait past debounce
      await new Promise(resolve => setTimeout(resolve, 150))

      sub.dispose()
      watcher.dispose()

      // The rapid events should be coalesced into 1 or very few triggers instead of 6+
      expect(triggerCount).toBeGreaterThanOrEqual(1)
      expect(triggerCount).toBeLessThan(4)
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('engine emits normalized events during change watcher notification', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'elix-engine-events-'))
    try {
      const mockWatcher = new MockNamespaceWatcher()
      const engine = new ShellNamespaceEngine({
        watcher: mockWatcher,
      })

      // Initial list
      const filePath = path.join(tmpDir, 'alpha.txt')
      await fs.writeFile(filePath, 'init')
      await engine.listPath(tmpDir)

      const addedEvents: ShellItem[] = []
      const removedEvents: unknown[] = []
      const renamedEvents: unknown[] = []

      engine.on('item-added', item => addedEvents.push(item))
      engine.on('item-removed', id => removedEvents.push(id))
      engine.on('item-renamed', (item, prev) => renamedEvents.push({ item, prev }))

      // Start watch
      engine.watch(tmpDir)

      // Add a new file
      await fs.writeFile(path.join(tmpDir, 'beta.txt'), 'new')
      mockWatcher.emitChange(tmpDir)

      // Deterministically wait for async directory re-enumeration
      for (let i = 0; i < 40; i++) {
        if (addedEvents.length > 0) break
        await new Promise(resolve => setTimeout(resolve, 25))
      }

      expect(addedEvents.length).toBe(1)
      expect(addedEvents[0]?.displayName).toBe('beta.txt')

      engine.dispose()
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })
})
