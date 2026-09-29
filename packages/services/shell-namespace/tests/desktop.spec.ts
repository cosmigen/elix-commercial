import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DesktopAggregator } from '../src/desktop.ts'
import { FileSystemProvider } from '../src/file-system.ts'
import { InMemoryKnownFolderResolver } from '../src/known-folders.ts'

describe('DesktopAggregator', () => {
  it('aggregates User Desktop and Public Desktop into unified snapshot', async () => {
    const rootTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'elix-desktop-test-'))
    try {
      const userDesk = path.join(rootTmp, 'UserDesktop')
      const pubDesk = path.join(rootTmp, 'PublicDesktop')
      await fs.mkdir(userDesk)
      await fs.mkdir(pubDesk)

      // Create files in user desktop
      await fs.writeFile(path.join(userDesk, 'UserDoc.txt'), 'user doc')
      // Create files in public desktop
      await fs.writeFile(path.join(pubDesk, 'PublicApp.txt'), 'public app')

      const knownFolders = new InMemoryKnownFolderResolver({
        Desktop: userDesk,
        PublicDesktop: pubDesk,
      })

      const fsProvider = new FileSystemProvider()
      const aggregator = new DesktopAggregator({
        knownFolderResolver: knownFolders,
        fileSystemProvider: fsProvider,
      })

      const snapshot = await aggregator.getSnapshot()

      expect(snapshot.userDesktopPath).toBe(userDesk)
      expect(snapshot.publicDesktopPath).toBe(pubDesk)
      expect(snapshot.items.length).toBe(2)

      const userItem = snapshot.items.find(i => i.displayName === 'UserDoc.txt')
      expect(userItem).toBeDefined()
      expect(userItem?.source).toBe('user-desktop')

      const pubItem = snapshot.items.find(i => i.displayName === 'PublicApp.txt')
      expect(pubItem).toBeDefined()
      expect(pubItem?.source).toBe('public-desktop')
    } finally {
      await fs.rm(rootTmp, { recursive: true, force: true })
    }
  })

  it('preserves distinct items when same display name appears in both sources', async () => {
    const rootTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'elix-desktop-collision-'))
    try {
      const userDesk = path.join(rootTmp, 'UserDesktop')
      const pubDesk = path.join(rootTmp, 'PublicDesktop')
      await fs.mkdir(userDesk)
      await fs.mkdir(pubDesk)

      // Both directories have a file named 'Notes.txt' with different content
      await fs.writeFile(path.join(userDesk, 'Notes.txt'), 'User private notes')
      await fs.writeFile(path.join(pubDesk, 'Notes.txt'), 'Public common notes')

      const knownFolders = new InMemoryKnownFolderResolver({
        Desktop: userDesk,
        PublicDesktop: pubDesk,
      })

      const fsProvider = new FileSystemProvider()
      const aggregator = new DesktopAggregator({
        knownFolderResolver: knownFolders,
        fileSystemProvider: fsProvider,
      })

      const snapshot = await aggregator.getSnapshot()

      // CRITICAL RULE: They must NOT be merged merely because their names match!
      const matching = snapshot.items.filter(i => i.displayName === 'Notes.txt')
      expect(matching.length).toBe(2)

      const sources = matching.map(i => i.source)
      expect(sources).toContain('user-desktop')
      expect(sources).toContain('public-desktop')

      // Their identities and paths must be different
      expect(matching[0]?.id).not.toBe(matching[1]?.id)
      expect(matching[0]?.location.path).not.toBe(matching[1]?.location.path)
    } finally {
      await fs.rm(rootTmp, { recursive: true, force: true })
    }
  })

  it('handles empty or missing desktop folders gracefully', async () => {
    const knownFolders = new InMemoryKnownFolderResolver({
      Desktop: {
        id: 'Desktop',
        path: 'C:/NonExistent/EmptyDesktop',
        available: false,
        isVirtual: false,
        displayName: 'Desktop',
      },
      PublicDesktop: {
        id: 'PublicDesktop',
        path: 'C:/NonExistent/EmptyPublicDesktop',
        available: false,
        isVirtual: false,
        displayName: 'PublicDesktop',
      },
    })

    const fsProvider = new FileSystemProvider()
    const aggregator = new DesktopAggregator({
      knownFolderResolver: knownFolders,
      fileSystemProvider: fsProvider,
    })

    const snapshot = await aggregator.getSnapshot()
    expect(snapshot.items).toEqual([])
  })
})
