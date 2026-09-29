import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { AppRegistryService } from '../src/index.ts'
import type {
  AppDiscoveryProvider,
  AppId,
  AppLaunchAdapter,
  AppRecord,
  DiscoveredApplication,
  ProviderFault,
} from '../src/types.ts'

describe('AppRegistryService Cordis Plugin Lifecycle & Catalog Integration', () => {
  let tempDir: string
  let testCachePath: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'elix-app-reg-'))
    testCachePath = join(tempDir, 'cache.json')
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  it('initializes, mounts onto ctx.appRegistry, and emits app-registry/ready', async () => {
    const ctx = new Context()
    const readyListener = vi.fn()
    ctx.on('app-registry/ready', readyListener)

    ctx.plugin(AppRegistryService, {
      cachePath: testCachePath,
      autoRefreshOnStartup: false,
      customProviders: [],
    })

    // Allow [Service.init] to run
    await new Promise(resolve => setTimeout(resolve, 50))

    const service = ctx.appRegistry
    expect(service).toBeInstanceOf(AppRegistryService)
    expect(service.ready).toBe(true)
    expect(readyListener).toHaveBeenCalledWith(service)

    await ctx.fiber.dispose()
    expect(service.ready).toBe(false)
    expect(ctx.appRegistry).toBeUndefined()
  })

  it('performs transactional refresh, emitting app-added, app-updated, and app-removed events', async () => {
    const ctx = new Context()
    const addedEvents: AppRecord[] = []
    const updatedEvents: AppRecord[] = []
    const removedEvents: AppId[] = []

    ctx.on('app-registry/app-added', app => addedEvents.push(app))
    ctx.on('app-registry/app-updated', app => updatedEvents.push(app))
    ctx.on('app-registry/app-removed', appId => removedEvents.push(appId))

    let currentDiscoveries: DiscoveredApplication[] = [
      {
        source: 'start-menu-system',
        kind: 'win32',
        displayName: 'App One',
        executablePath: 'C:\\App1\\app.exe',
      },
      {
        source: 'start-menu-system',
        kind: 'win32',
        displayName: 'App Two',
        executablePath: 'C:\\App2\\app.exe',
      },
    ]

    const testProvider: AppDiscoveryProvider = {
      id: 'mock-provider',
      discover: async () => currentDiscoveries,
    }

    ctx.plugin(AppRegistryService, {
      cachePath: testCachePath,
      autoRefreshOnStartup: false,
      customProviders: [testProvider],
    })

    await new Promise(resolve => setTimeout(resolve, 50))
    const service = ctx.appRegistry

    // 1. Initial Refresh: both apps added
    const res1 = await service.refresh()
    expect(res1.totalApps).toBe(2)
    expect(res1.addedCount).toBe(2)
    expect(addedEvents.length).toBe(2)

    // 2. Second Refresh with App One modified (new publisher) and App Two removed, App Three added
    const appOneId = service.search('App One')[0]?.id
    expect(appOneId).toBeDefined()

    currentDiscoveries = [
      {
        source: 'start-menu-system',
        kind: 'win32',
        displayName: 'App One',
        executablePath: 'C:\\App1\\app.exe',
        publisher: 'Updated Publisher Corp',
      },
      {
        source: 'start-menu-system',
        kind: 'win32',
        displayName: 'App Three',
        executablePath: 'C:\\App3\\app.exe',
      },
    ]

    const res2 = await service.refresh()
    expect(res2.totalApps).toBe(2)
    expect(res2.addedCount).toBe(1) // App Three
    expect(res2.updatedCount).toBe(1) // App One
    expect(res2.removedCount).toBe(1) // App Two removed

    expect(updatedEvents.length).toBe(1)
    expect(updatedEvents[0]?.publisher).toBe('Updated Publisher Corp')
    expect(removedEvents.length).toBe(1)

    await ctx.fiber.dispose()
  })

  it('isolates provider faults during transactional refresh without crashing the host', async () => {
    const ctx = new Context()
    const faults: ProviderFault[] = []
    ctx.on('app-registry/provider-fault', f => faults.push(f))

    const goodProvider: AppDiscoveryProvider = {
      id: 'good-provider',
      discover: async () => [
        {
          source: 'start-menu-system',
          kind: 'win32',
          displayName: 'Reliable App',
          executablePath: 'C:\\Reliable\\app.exe',
        },
      ],
    }

    const failingProvider: AppDiscoveryProvider = {
      id: 'failing-provider',
      discover: async () => {
        throw new Error('OS Access Denied in provider')
      },
    }

    ctx.plugin(AppRegistryService, {
      cachePath: testCachePath,
      autoRefreshOnStartup: false,
      customProviders: [goodProvider, failingProvider],
    })

    await new Promise(resolve => setTimeout(resolve, 50))
    const service = ctx.appRegistry

    const refreshResult = await service.refresh()

    // Host did not crash; good provider results are retained; fault recorded
    expect(refreshResult.totalApps).toBe(1)
    expect(refreshResult.faults.length).toBe(1)
    expect(refreshResult.faults[0]?.providerId).toBe('failing-provider')
    expect(faults.length).toBe(1)
    expect(service.list().length).toBe(1)
    expect(service.list()[0]?.displayName).toBe('Reliable App')

    await ctx.fiber.dispose()
  })

  it('resolves available vs missing applications accurately', async () => {
    const ctx = new Context()
    const provider: AppDiscoveryProvider = {
      id: 'test-provider',
      discover: async () => [
        {
          source: 'start-menu-system',
          kind: 'win32',
          displayName: 'Available App',
          executablePath: 'C:\\Installed\\app.exe',
        },
      ],
    }

    ctx.plugin(AppRegistryService, {
      cachePath: testCachePath,
      autoRefreshOnStartup: false,
      customProviders: [provider],
    })

    await new Promise(resolve => setTimeout(resolve, 50))
    const service = ctx.appRegistry
    await service.refresh()

    const availableApp = service.list()[0]
    expect(availableApp).toBeDefined()

    // Resolve available app
    const resAvailable = service.resolve(availableApp!.id)
    expect(resAvailable.status).toBe('available')
    if (resAvailable.status === 'available') {
      expect(resAvailable.app.displayName).toBe('Available App')
    }

    // Resolve missing app
    const fakeId = 'app:win32:0000000000000000' as AppId
    const resMissing = service.resolve(fakeId)
    expect(resMissing.status).toBe('missing')
    if (resMissing.status === 'missing') {
      expect(resMissing.appId).toBe(fakeId)
    }

    await ctx.fiber.dispose()
  })

  it('launches applications and emits launch lifecycle events', async () => {
    const ctx = new Context()
    const launchReqs: AppId[] = []
    const launchSucc: AppId[] = []
    const launchFail: AppId[] = []

    ctx.on('app-registry/launch-requested', id => launchReqs.push(id))
    ctx.on('app-registry/launch-succeeded', id => launchSucc.push(id))
    ctx.on('app-registry/launch-failed', id => launchFail.push(id))

    const mockAdapter: AppLaunchAdapter = {
      launchWin32: vi.fn().mockResolvedValue({ success: true, pid: 4321 }),
      launchPackaged: vi.fn().mockResolvedValue({ success: true, pid: 8765 }),
      launchShortcut: vi.fn().mockResolvedValue({ success: true, pid: 9876 }),
    }

    const provider: AppDiscoveryProvider = {
      id: 'test-provider',
      discover: async () => [
        {
          source: 'start-menu-system',
          kind: 'win32',
          displayName: 'Launchable App',
          executablePath: 'C:\\App\\app.exe',
        },
      ],
    }

    ctx.plugin(AppRegistryService, {
      cachePath: testCachePath,
      autoRefreshOnStartup: false,
      launchAdapter: mockAdapter,
      customProviders: [provider],
    })

    await new Promise(resolve => setTimeout(resolve, 50))
    const service = ctx.appRegistry
    await service.refresh()

    const app = service.list()[0]!
    const result = await service.launch(app.id)

    expect(result.success).toBe(true)
    expect(result.pid).toBe(4321)
    expect(launchReqs).toContain(app.id)
    expect(launchSucc).toContain(app.id)

    // Launch non-existent app fails gracefully
    const fakeId = 'app:win32:nonexistent' as AppId
    const failResult = await service.launch(fakeId)
    expect(failResult.success).toBe(false)
    expect(launchFail).toContain(fakeId)

    await ctx.fiber.dispose()
  })

  it('host remains fully operational when App Registry is disabled in config', async () => {
    const ctx = new Context()
    ctx.plugin(AppRegistryService, {
      enabled: false,
      cachePath: testCachePath,
    })

    await new Promise(resolve => setTimeout(resolve, 50))
    expect(ctx.appRegistry).toBeInstanceOf(AppRegistryService)
    expect(ctx.appRegistry.ready).toBe(false)
    expect(ctx.appRegistry.list()).toEqual([])

    await ctx.fiber.dispose()
  })

  it('suppresses event spam on rescans when application metadata is unchanged', async () => {
    const ctx = new Context()
    const addedEvents: AppRecord[] = []
    const updatedEvents: AppRecord[] = []

    ctx.on('app-registry/app-added', app => addedEvents.push(app))
    ctx.on('app-registry/app-updated', app => updatedEvents.push(app))

    const testProvider: AppDiscoveryProvider = {
      id: 'static-provider',
      discover: async () => [
        {
          source: 'start-menu-system',
          kind: 'win32',
          displayName: 'Stable App',
          executablePath: 'C:\\Apps\\stable.exe',
          publisher: 'Stable Corp',
        },
      ],
    }

    ctx.plugin(AppRegistryService, {
      cachePath: testCachePath,
      autoRefreshOnStartup: false,
      customProviders: [testProvider],
    })

    await new Promise(resolve => setTimeout(resolve, 50))
    const service = ctx.appRegistry

    // First scan: adds the app
    const res1 = await service.refresh()
    expect(res1.addedCount).toBe(1)
    expect(res1.updatedCount).toBe(0)
    expect(addedEvents.length).toBe(1)
    expect(updatedEvents.length).toBe(0)

    // Second scan with identical data: must NOT emit app-updated or count as updated
    const res2 = await service.refresh()
    expect(res2.addedCount).toBe(0)
    expect(res2.updatedCount).toBe(0)
    expect(res2.removedCount).toBe(0)
    expect(addedEvents.length).toBe(1)
    expect(updatedEvents.length).toBe(0)

    await ctx.fiber.dispose()
  })

  it('handles provider timeout gracefully and records fault without crashing host', async () => {
    const ctx = new Context()
    const faults: ProviderFault[] = []
    ctx.on('app-registry/provider-fault', f => faults.push(f))

    const fastProvider: AppDiscoveryProvider = {
      id: 'fast-provider',
      discover: async () => [
        {
          source: 'start-menu-system',
          kind: 'win32',
          displayName: 'Fast App',
          executablePath: 'C:\\Fast\\fast.exe',
        },
      ],
    }

    const hangingProvider: AppDiscoveryProvider = {
      id: 'hanging-provider',
      discover: async (signal?: AbortSignal) => {
        return new Promise((_, reject) => {
          if (signal?.aborted) {
            reject(new Error('Aborted'))
            return
          }
          signal?.addEventListener('abort', () => {
            reject(new Error('Provider "hanging-provider" timed out'))
          })
        })
      },
    }

    ctx.plugin(AppRegistryService, {
      cachePath: testCachePath,
      autoRefreshOnStartup: false,
      providerTimeoutMs: 50,
      customProviders: [fastProvider, hangingProvider],
    })

    await new Promise(resolve => setTimeout(resolve, 50))
    const service = ctx.appRegistry

    const res = await service.refresh()

    expect(res.totalApps).toBe(1)
    expect(res.faults.length).toBe(1)
    expect(res.faults[0]?.providerId).toBe('hanging-provider')
    expect(faults.length).toBe(1)
    expect(service.list().length).toBe(1)
    expect(service.list()[0]?.displayName).toBe('Fast App')

    await ctx.fiber.dispose()
  })

  it('coalesces concurrent refresh calls onto a single in-flight operation', async () => {
    const ctx = new Context()
    let discoveryCallCount = 0

    const slowProvider: AppDiscoveryProvider = {
      id: 'slow-provider',
      discover: async () => {
        discoveryCallCount++
        await new Promise(resolve => setTimeout(resolve, 60))
        return [
          {
            source: 'start-menu-system',
            kind: 'win32',
            displayName: 'Concurrent App',
            executablePath: 'C:\\App\\app.exe',
          },
        ]
      },
    }

    ctx.plugin(AppRegistryService, {
      cachePath: testCachePath,
      autoRefreshOnStartup: false,
      customProviders: [slowProvider],
    })

    await new Promise(resolve => setTimeout(resolve, 50))
    const service = ctx.appRegistry

    // Launch two refreshes simultaneously
    const [p1, p2] = await Promise.all([
      service.refresh(),
      service.refresh(),
    ])

    expect(p1).toBe(p2)
    expect(discoveryCallCount).toBe(1)
    expect(service.list().length).toBe(1)

    await ctx.fiber.dispose()
  })

  it('aborts refresh when cancellation signal is triggered without corrupting catalog', async () => {
    const ctx = new Context()

    const slowProvider: AppDiscoveryProvider = {
      id: 'slow-provider',
      discover: async (signal?: AbortSignal) => {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 100)
          signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(new Error('Discovery cancelled'))
          })
        })
        return [
          {
            source: 'start-menu-system',
            kind: 'win32',
            displayName: 'Should Not Be Added',
            executablePath: 'C:\\Uncommitted\\app.exe',
          },
        ]
      },
    }

    ctx.plugin(AppRegistryService, {
      cachePath: testCachePath,
      autoRefreshOnStartup: false,
      customProviders: [slowProvider],
    })

    await new Promise(resolve => setTimeout(resolve, 50))
    const service = ctx.appRegistry

    const abortController = new AbortController()
    setTimeout(() => {
      abortController.abort()
    }, 20)

    const result = await service.engine.refresh(abortController.signal)

    expect(result.addedCount).toBe(0)
    expect(service.list().length).toBe(0)

    await ctx.fiber.dispose()
  })

  it('disposal during active refresh clears state and prevents zombie catalog replacement', async () => {
    const ctx = new Context()

    const slowProvider: AppDiscoveryProvider = {
      id: 'slow-provider',
      discover: async () => {
        await new Promise(resolve => setTimeout(resolve, 80))
        return [
          {
            source: 'start-menu-system',
            kind: 'win32',
            displayName: 'Zombie App',
            executablePath: 'C:\\Zombie\\app.exe',
          },
        ]
      },
    }

    ctx.plugin(AppRegistryService, {
      cachePath: testCachePath,
      autoRefreshOnStartup: false,
      customProviders: [slowProvider],
    })

    await new Promise(resolve => setTimeout(resolve, 50))
    const service = ctx.appRegistry

    const refreshPromise = service.refresh()

    await ctx.fiber.dispose()

    await refreshPromise

    expect(service.list().length).toBe(0)
  })
})
