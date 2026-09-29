import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { ShellNamespaceService } from '../src/index.ts'
import { ShellNamespaceEngine } from '../src/engine.ts'
import { InMemoryKnownFolderResolver } from '../src/known-folders.ts'
import { MockNamespaceWatcher } from '../src/watcher.ts'
import type { ProviderFault } from '../src/types.ts'

describe('ShellNamespaceService Lifecycle & Cordis Integration', () => {
  it('initializes cleanly on Cordis context and emits ready event', async () => {
    const ctx = new Context()
    let readyEmitted = false

    ctx.on('shell-namespace/ready', (service) => {
      readyEmitted = true
      expect(service).toBeDefined()
    })

    ctx.plugin(ShellNamespaceService, {
      knownFolderResolver: new InMemoryKnownFolderResolver({
        Desktop: 'C:/MockDesktop',
        PublicDesktop: 'C:/MockPublicDesktop',
      }),
    })

    await new Promise(resolve => setTimeout(resolve, 50))

    expect(ctx.shellNamespace).toBeDefined()
    expect(ctx.shellNamespace.ready).toBe(true)
    expect(readyEmitted).toBe(true)

    await ctx.fiber.dispose()
    expect(ctx.shellNamespace).toBeUndefined()
  })

  it('respects enabled: false configuration without activating engine', async () => {
    const ctx = new Context()
    let readyEmitted = false

    ctx.on('shell-namespace/ready', () => {
      readyEmitted = true
    })

    ctx.plugin(ShellNamespaceService, {
      enabled: false,
    })

    await new Promise(resolve => setTimeout(resolve, 50))

    expect(ctx.shellNamespace.ready).toBe(false)
    expect(readyEmitted).toBe(false)

    await ctx.fiber.dispose()
  })

  it('cleans up watchers, subscriptions and resources on context stop / dispose', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'elix-lifecycle-'))
    try {
      const ctx = new Context()
      const mockWatcher = new MockNamespaceWatcher()

      ctx.plugin(ShellNamespaceService, {
        watcher: mockWatcher,
        knownFolderResolver: new InMemoryKnownFolderResolver({
          Desktop: tmpDir,
          PublicDesktop: tmpDir,
        }),
      })

      await new Promise(resolve => setTimeout(resolve, 50))

      const sub = ctx.shellNamespace.watch(tmpDir)
      expect(sub.path).toBeDefined()

      await ctx.fiber.dispose()

      expect(ctx.shellNamespace).toBeUndefined()
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('handles provider faults gracefully without crashing host', async () => {
    const ctx = new Context()
    const faults: ProviderFault[] = []

    ctx.on('shell-namespace/provider-fault', (fault) => {
      faults.push(fault)
    })

    // Resolver that throws an error
    const faultyResolver = {
      resolve: () => Promise.reject(new Error('Drive disconnected')),
      resolveAll: () => Promise.reject(new Error('Drive disconnected')),
    }

    ctx.plugin(ShellNamespaceService, {
      knownFolderResolver: faultyResolver,
    })

    await new Promise(resolve => setTimeout(resolve, 50))

    // Calling getDesktop with faulty resolver should not crash, but emit provider-fault
    const snapshot = await ctx.shellNamespace.getDesktop()
    expect(snapshot.items).toEqual([])
    expect(faults.length).toBeGreaterThan(0)
    expect(faults[0]?.provider).toBe('DesktopAggregator')

    await ctx.fiber.dispose()
  })

  it('supports restart by re-registering on context', async () => {
    const ctx = new Context()

    const fork = ctx.plugin(ShellNamespaceService, {
      knownFolderResolver: new InMemoryKnownFolderResolver({
        Desktop: 'C:/Desktop1',
      }),
    })

    await new Promise(resolve => setTimeout(resolve, 50))
    expect(ctx.shellNamespace.ready).toBe(true)

    // Dispose plugin fork
    await fork.dispose()
    expect(ctx.shellNamespace).toBeUndefined()

    // Re-mount plugin
    ctx.plugin(ShellNamespaceService, {
      knownFolderResolver: new InMemoryKnownFolderResolver({
        Desktop: 'C:/Desktop2',
      }),
    })

    await new Promise(resolve => setTimeout(resolve, 50))
    expect(ctx.shellNamespace.ready).toBe(true)

    await ctx.fiber.dispose()
  })

  it('handles immediate disposal of watchDesktop subscription without leaking watchers', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'elix-watch-desktop-leak-'))
    try {
      const mockWatcher = new MockNamespaceWatcher()
      const engine = new ShellNamespaceEngine({
        watcher: mockWatcher,
        knownFolderResolver: new InMemoryKnownFolderResolver({
          Desktop: tmpDir,
          PublicDesktop: tmpDir,
        }),
      })

      // Immediately dispose returned subscription before async resolve completes
      const sub = engine.watchDesktop()
      sub.dispose()

      // Allow any async promises to settle
      await new Promise(resolve => setTimeout(resolve, 100))

      // Emit change on mock watcher; should NOT trigger any error or call disposed subs
      expect(() => {
        mockWatcher.emitChange(tmpDir)
      }).not.toThrow()

      engine.dispose()
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })
})
