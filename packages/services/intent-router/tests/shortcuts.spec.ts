import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppRegistryEngine } from '@deepseek-ai/dsh-app-registry'
import type { ShellLinkResolver, ShellNamespaceService } from '@deepseek-ai/dsh-shell-namespace'
import {
  IntentRouterEngine,
  makeAppId,
  makeShellItemId,
  ShortcutResolver,
} from '../src/index.ts'
import type {
  OpenShortcutResult,
  ProcessLauncher,
  ShellItem,
} from '../src/index.ts'
import { InvalidInputError } from '../src/validation.ts'

describe('ShortcutResolver & OpenShortcut Intent', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'elix-shortcuts-test-'))
  })

  afterEach(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true })
    } catch {
      // Best effort cleanup
    }
  })

  it('resolves an executable target as an application shortcut', async () => {
    const mockLinkResolver: ShellLinkResolver = {
      resolve: vi.fn().mockResolvedValue({
        target: 'C:\\Program Files\\Calculator\\calc.exe',
        arguments: ['--standard'],
        workingDirectory: 'C:\\Program Files\\Calculator',
        isBroken: false,
      }),
      resolveBatch: vi.fn(),
    }

    const appRegistry = {
      list: vi.fn().mockReturnValue([
        {
          id: makeAppId('app:win32:calc'),
          displayName: 'Calculator',
          launch: { kind: 'win32', executablePath: 'C:\\Program Files\\Calculator\\calc.exe' },
        },
      ]),
    } as unknown as AppRegistryEngine

    const resolver = new ShortcutResolver(mockLinkResolver)
    const target = await resolver.resolveEffectiveTarget('C:\\Desktop\\Calc.lnk', appRegistry)

    expect(target.kind).toBe('app')
    expect(target.pathOrUri).toBe('C:\\Program Files\\Calculator\\calc.exe')
    expect(target.appId).toBe('app:win32:calc')
    expect(target.arguments).toEqual(['--standard'])
  })

  it('resolves a URL protocol target as a URL shortcut', async () => {
    const mockLinkResolver: ShellLinkResolver = {
      resolve: vi.fn().mockResolvedValue({
        target: 'https://deepseek.com',
        isBroken: false,
      }),
      resolveBatch: vi.fn(),
    }

    const resolver = new ShortcutResolver(mockLinkResolver)
    const target = await resolver.resolveEffectiveTarget('C:\\Desktop\\Web.lnk')

    expect(target.kind).toBe('url')
    expect(target.pathOrUri).toBe('https://deepseek.com')
  })

  it('resolves a real directory target as a folder shortcut', async () => {
    const realFolder = path.join(tmpDir, 'Documents')
    await fs.mkdir(realFolder)

    const mockLinkResolver: ShellLinkResolver = {
      resolve: vi.fn().mockResolvedValue({
        target: realFolder,
        isBroken: false,
      }),
      resolveBatch: vi.fn(),
    }

    const resolver = new ShortcutResolver(mockLinkResolver)
    const target = await resolver.resolveEffectiveTarget('C:\\Desktop\\Docs.lnk')

    expect(target.kind).toBe('folder')
    expect(target.pathOrUri).toBe(realFolder)
  })

  it('resolves a real file target as a file shortcut', async () => {
    const realFile = path.join(tmpDir, 'notes.txt')
    await fs.writeFile(realFile, 'hello')

    const mockLinkResolver: ShellLinkResolver = {
      resolve: vi.fn().mockResolvedValue({
        target: realFile,
        isBroken: false,
      }),
      resolveBatch: vi.fn(),
    }

    const resolver = new ShortcutResolver(mockLinkResolver)
    const target = await resolver.resolveEffectiveTarget('C:\\Desktop\\Notes.lnk')

    expect(target.kind).toBe('file')
    expect(target.pathOrUri).toBe(realFile)
  })

  it('classifies missing or broken shortcut targets as unsupported with isBroken: true', async () => {
    const mockLinkResolver: ShellLinkResolver = {
      resolve: vi.fn().mockResolvedValue({
        target: 'C:\\NonExistent\\missing.doc',
        isBroken: true,
      }),
      resolveBatch: vi.fn(),
    }

    const resolver = new ShortcutResolver(mockLinkResolver)
    const target = await resolver.resolveEffectiveTarget('C:\\Desktop\\Broken.lnk')

    expect(target.kind).toBe('unsupported')
    expect(target.isBroken).toBe(true)
  })

  it('detects and halts infinite circular shortcut reference loops', async () => {
    const linkMap = new Map<string, string>([
      ['c:\\loop1.lnk', 'C:\\loop2.lnk'],
      ['c:\\loop2.lnk', 'C:\\loop3.lnk'],
      ['c:\\loop3.lnk', 'C:\\loop1.lnk'],
    ])

    const mockLinkResolver: ShellLinkResolver = {
      resolve: vi.fn().mockImplementation(async (filePath: string) => {
        const target = linkMap.get(filePath.toLowerCase())
        return target ? { target, isBroken: false } : undefined
      }),
      resolveBatch: vi.fn(),
    }

    const resolver = new ShortcutResolver(mockLinkResolver)
    await expect(resolver.resolveEffectiveTarget('C:\\loop1.lnk')).rejects.toThrow(InvalidInputError)
  })

  it('executes open-shortcut intent end-to-end via IntentRouterEngine', async () => {
    const launchWin32 = vi.fn().mockResolvedValue({ success: true, pid: 4004 })
    const launcher: ProcessLauncher = {
      launchWin32,
    }

    const mockShortcut: ShellItem = {
      id: makeShellItemId('shortcut:editor'),
      displayName: 'Editor.lnk',
      kind: 'shortcut',
      location: { path: 'C:\\Desktop\\Editor.lnk' },
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
      icon: { kind: 'fallback', defaultIconId: 'generic-shortcut' },
      identityQuality: 'filesystem-stable',
      size: 120,
      createdAt: Date.now(),
      modifiedAt: Date.now(),
      source: 'user-desktop',
    }

    const mockShellNamespace = {
      get: vi.fn().mockReturnValue(mockShortcut),
      resolveItem: vi.fn().mockResolvedValue({ status: 'available', item: mockShortcut }),
      engine: {
        linkResolver: {
          resolve: vi.fn().mockResolvedValue({
            target: 'https://example.com',
            isBroken: false,
          }),
          resolveBatch: vi.fn().mockResolvedValue(new Map()),
        },
        on: vi.fn().mockReturnValue(() => {}),
      },
    }

    const engine = new IntentRouterEngine({
      shellNamespace: mockShellNamespace as unknown as ShellNamespaceService,
      processLauncher: launcher,
      preferNative: false,
    })

    const result = (await engine.dispatch({
      type: 'open-shortcut',
      itemId: makeShellItemId('shortcut:editor'),
    })) as OpenShortcutResult

    expect(result.status).toBe('success')
    expect(result.resolvedKind).toBe('url')
    expect(result.target).toBe('https://example.com')
    expect(launchWin32).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'win32',
        executablePath: 'explorer.exe',
        arguments: ['https://example.com'],
      }),
    )
  })
})
