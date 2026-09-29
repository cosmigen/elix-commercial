import { Context } from '@deepseek-ai/cordis'
import type { ShellNamespaceService } from '@deepseek-ai/dsh-shell-namespace'
import { describe, expect, it, vi } from 'vitest'
import {
  IntentRouterEngine,
  IntentRouterService,
  makeAppId,
  makeShellItemId,
} from '../src/index.ts'
import type { ProcessLauncher, ShellItem } from '../src/index.ts'

describe('IntentRouter — Resilience, Recovery & Lifecycle', () => {
  it('handles transient native-bridge or launcher crashes and resumes operation', async () => {
    let callCount = 0
    const flakyLauncher: ProcessLauncher = {
      launchWin32: vi.fn().mockImplementation(async () => {
        callCount++
        if (callCount === 1) {
          throw new Error('Host process terminated unexpectedly (PIPE_ERROR)')
        }
        return { success: true, pid: 8888 }
      }),
    }

    const mockFile: ShellItem = {
      id: makeShellItemId('file:recoverable'),
      displayName: 'doc.txt',
      kind: 'file',
      location: { path: 'C:\\doc.txt' },
      attributes: {
        readOnly: false,
        hidden: false,
        system: false,
        directory: false,
        archive: false,
        reparsePoint: false,
        offline: false,
        temporary: false,
      },
      icon: { kind: 'fallback', defaultIconId: 'generic-file' },
      identityQuality: 'filesystem-stable',
      size: 10,
      createdAt: Date.now(),
      modifiedAt: Date.now(),
      source: 'user-desktop',
    }

    const shellNamespace = {
      get: vi.fn().mockReturnValue(mockFile),
      resolveItem: vi.fn().mockResolvedValue({ status: 'available', item: mockFile }),
      engine: {
        linkResolver: {
          resolve: vi.fn().mockResolvedValue(undefined),
          resolveBatch: vi.fn().mockResolvedValue(new Map()),
        },
        on: vi.fn().mockReturnValue(() => {}),
      },
    }

    const engine = new IntentRouterEngine({
      shellNamespace: shellNamespace as unknown as ShellNamespaceService,
      processLauncher: flakyLauncher,
      preferNative: false,
    })

    // First call: native failure caught and reported as typed status without crash
    const res1 = await engine.openFile(makeShellItemId('file:recoverable'))
    expect(res1.status).toBe('native-failure')
    expect(res1.error?.message).toContain('PIPE_ERROR')

    // Second call: recovers and succeeds
    const res2 = await engine.openFile(makeShellItemId('file:recoverable'))
    expect(res2.status).toBe('success')
    expect(res2.pid).toBe(8888)
  })

  it('cleans up resources and listeners on engine disposal', async () => {
    const engine = new IntentRouterEngine({ preferNative: false })

    const listener = vi.fn()
    engine.on('intent-dispatched', listener)

    await engine.dispatch({ type: 'open-app', appId: makeAppId('any:app') })
    expect(listener).toHaveBeenCalledTimes(1)

    // Dispose
    engine.dispose()

    // Subsequent actions do not trigger listeners
    await engine.dispatch({ type: 'open-app', appId: makeAppId('any:app') })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('integrates with Cordis service lifecycle and clean service disposal', async () => {
    const ctx = new Context()
    ctx.provide('shellNamespace')

    const mockShellNamespace = {
      get: vi.fn().mockReturnValue(undefined),
      resolveItem: vi.fn().mockResolvedValue({ status: 'missing', itemId: 'any' }),
      getDesktop: vi.fn().mockResolvedValue({ items: [], timestamp: Date.now() }),
      engine: {
        linkResolver: {
          resolve: vi.fn().mockResolvedValue(undefined),
          resolveBatch: vi.fn().mockResolvedValue(new Map()),
        },
        on: vi.fn().mockReturnValue(() => {}),
      },
    }

    ctx.shellNamespace = mockShellNamespace as unknown as ShellNamespaceService

    let readyEmitted = false
    ctx.on('intent-router/ready', (srv) => {
      readyEmitted = true
      expect(srv).toBeDefined()
    })

    ctx.plugin(IntentRouterService, {
      enabled: true,
      projectDesktopOnStartup: false,
    })

    await new Promise(resolve => setTimeout(resolve, 50))

    expect(ctx.intentRouter).toBeDefined()
    expect(ctx.intentRouter.ready).toBe(true)
    expect(readyEmitted).toBe(true)

    await ctx.fiber.dispose()
    expect(ctx.intentRouter).toBeUndefined()
  })

  it('resolves AppRegistry and ShellNamespace dynamically when mounted after IntentRouterService', async () => {
    const ctx = new Context()
    ctx.provide('appRegistry')
    ctx.provide('shellNamespace')

    // Mount IntentRouterService FIRST (before appRegistry or shellNamespace are provided)
    ctx.plugin(IntentRouterService, {
      enabled: true,
      projectDesktopOnStartup: false,
    })

    await new Promise(resolve => setTimeout(resolve, 20))
    expect(ctx.intentRouter).toBeDefined()

    // Initially, calling openApp returns unsupported because appRegistry is not yet mounted
    const resBefore = await ctx.intentRouter.openApp(makeAppId('app:test:123'))
    expect(resBefore.status).toBe('unsupported')
    expect(resBefore.error?.code).toBe('NO_APP_REGISTRY')

    // Now mount appRegistry AFTERWARDS
    const mockApp = {
      id: makeAppId('app:test:123'),
      displayName: 'Test App',
      launch: { kind: 'win32', executablePath: 'C:\\test.exe' },
    }
    const mockAppRegistry = {
      get: vi.fn().mockReturnValue(mockApp),
      resolve: vi.fn().mockReturnValue({ status: 'available', app: mockApp }),
      launch: vi.fn().mockResolvedValue({ success: true, pid: 9999 }),
    }
    ctx.appRegistry = mockAppRegistry as unknown as import('@deepseek-ai/dsh-app-registry').AppRegistryService

    // Now calling openApp resolves appRegistry dynamically and succeeds
    const resAfter = await ctx.intentRouter.openApp(makeAppId('app:test:123'))
    expect(resAfter.status).toBe('success')
    expect(resAfter.pid).toBe(9999)

    await ctx.fiber.dispose()
  })
})
