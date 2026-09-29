import type { AppRegistryService } from '@deepseek-ai/dsh-app-registry'
import type { ShellNamespaceService } from '@deepseek-ai/dsh-shell-namespace'
import { describe, expect, it, vi } from 'vitest'
import {
  IntentRouterEngine,
  InvalidInputError,
  makeAppId,
  makeShellItemId,
} from '../src/index.ts'
import type {
  OpenAppResult,
  OpenFileResult,
  OpenFolderResult,
  ProcessLauncher,
  ShellItem,
} from '../src/index.ts'

function createMockShellItem(params: {
  id: string
  displayName: string
  kind: 'file' | 'folder' | 'shortcut'
  path: string
  size?: number
}): ShellItem {
  return {
    id: makeShellItemId(params.id),
    displayName: params.displayName,
    kind: params.kind,
    location: { path: params.path },
    attributes: {
      readOnly: false,
      hidden: false,
      system: false,
      directory: params.kind === 'folder',
      archive: false,
      reparsePoint: false,
      offline: false,
      temporary: false,
    },
    icon: {
      kind: 'fallback',
      defaultIconId: params.kind === 'folder'
        ? 'generic-folder'
        : params.kind === 'shortcut'
          ? 'generic-shortcut'
          : 'generic-file',
    },
    identityQuality: 'filesystem-stable',
    size: params.size ?? 0,
    createdAt: Date.now(),
    modifiedAt: Date.now(),
    source: 'user-desktop',
  }
}

function createMockLauncher(): {
  launcher: ProcessLauncher
  launchWin32: ReturnType<typeof vi.fn>
  launchPackaged: ReturnType<typeof vi.fn>
} {
  const launchWin32 = vi.fn().mockResolvedValue({ success: true, pid: 1001 })
  const launchPackaged = vi.fn().mockResolvedValue({ success: true, pid: 1002 })
  return {
    launcher: {
      launchWin32,
      launchPackaged,
    },
    launchWin32,
    launchPackaged,
  }
}

function createMockAppRegistry(apps: { id: string; name: string }[] = []) {
  const appList = apps.map(a => ({
    id: makeAppId(a.id),
    displayName: a.name,
    kind: 'win32' as const,
    launch: { kind: 'win32' as const, executablePath: `C:\\Program Files\\${a.name}\\app.exe` },
  }))

  return {
    get: vi.fn((id: string) => appList.find(a => a.id === id)),
    resolve: vi.fn((id: string) => {
      const found = appList.find(a => a.id === id)
      return found ? { status: 'available' as const, app: found } : { status: 'missing' as const, appId: id }
    }),
    list: vi.fn(() => appList),
    launch: vi.fn().mockImplementation(async (id: string) => {
      const found = appList.find(a => a.id === id)
      if (!found) {
        return { success: false, error: 'App not found' }
      }
      return { success: true, pid: 2002 }
    }),
  }
}

function createMockShellNamespace(items: ShellItem[] = []) {
  return {
    get: vi.fn((id: string) => items.find(i => i.id === id)),
    resolveItem: vi.fn().mockImplementation(async (id: string) => {
      const found = items.find(i => i.id === id)
      if (found) {
        return { status: 'available', item: found }
      }
      return { status: 'missing', itemId: id }
    }),
    resolve: vi.fn().mockImplementation(async (pathOrLoc: string) => {
      return items.find(i => i.location.path === pathOrLoc)
    }),
    engine: {
      linkResolver: {
        resolve: vi.fn().mockResolvedValue(undefined),
        resolveBatch: vi.fn().mockResolvedValue(new Map()),
      },
      on: vi.fn().mockReturnValue(() => {}),
    },
  }
}

describe('IntentRouterEngine — Core Intent Routing', () => {
  it('successfully opens an app registered in App Registry', async () => {
    const { launcher } = createMockLauncher()
    const appRegistry = createMockAppRegistry([{ id: 'app:win32:calc', name: 'Calculator' }])
    const engine = new IntentRouterEngine({
      appRegistry: appRegistry as unknown as AppRegistryService,
      processLauncher: launcher,
      preferNative: false,
    })

    const result = (await engine.dispatch({
      type: 'open-app',
      appId: makeAppId('app:win32:calc'),
    })) as OpenAppResult

    expect(result.status).toBe('success')
    expect(result.appId).toBe('app:win32:calc')
    expect(result.pid).toBe(2002)
    expect(appRegistry.launch).toHaveBeenCalledWith('app:win32:calc', undefined)
  })

  it('returns not-found when attempting to open an unregistered app', async () => {
    const appRegistry = createMockAppRegistry([])
    const engine = new IntentRouterEngine({
      appRegistry: appRegistry as unknown as AppRegistryService,
      preferNative: false,
    })

    const result = (await engine.dispatch({
      type: 'open-app',
      appId: makeAppId('app:win32:nonexistent'),
    })) as OpenAppResult

    expect(result.status).toBe('not-found')
    expect(result.error?.code).toBe('APP_NOT_FOUND')
  })

  it('propagates launch failure when process launcher fails', async () => {
    const launcher: ProcessLauncher = {
      launchWin32: vi.fn().mockResolvedValue({ success: false, error: 'Access is denied' }),
    }
    const appRegistry = {
      get: vi.fn().mockReturnValue({
        id: makeAppId('app:win32:failing'),
        displayName: 'Failing App',
        kind: 'win32',
        launch: { kind: 'win32', executablePath: 'C:\\app.exe' },
      }),
      resolve: vi.fn().mockReturnValue({
        status: 'available',
        app: { id: makeAppId('app:win32:failing'), displayName: 'Failing App' },
      }),
      list: vi.fn().mockReturnValue([]),
      launch: vi.fn().mockResolvedValue({ success: false, error: 'Access is denied' }),
    }

    const engine = new IntentRouterEngine({
      appRegistry: appRegistry as unknown as AppRegistryService,
      processLauncher: launcher,
      preferNative: false,
    })

    const result = (await engine.dispatch({
      type: 'open-app',
      appId: makeAppId('app:win32:failing'),
    })) as OpenAppResult

    expect(result.status).toBe('native-failure')
    expect(result.error?.message).toContain('Access is denied')
  })

  it('successfully opens an existing file through shell launcher', async () => {
    const { launcher, launchWin32 } = createMockLauncher()
    const mockFile: ShellItem = createMockShellItem({
      id: 'file:doc1',
      displayName: 'report.pdf',
      kind: 'file',
      path: 'C:\\Users\\User\\Documents\\report.pdf',
      size: 1024,
    })

    const shellNamespace = createMockShellNamespace([mockFile])
    const engine = new IntentRouterEngine({
      shellNamespace: shellNamespace as unknown as ShellNamespaceService,
      processLauncher: launcher,
      preferNative: false,
    })

    const result = (await engine.dispatch({
      type: 'open-file',
      itemId: makeShellItemId('file:doc1'),
    })) as OpenFileResult

    expect(result.status).toBe('success')
    expect(result.itemId).toBe('file:doc1')
    expect(launchWin32).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'win32',
        executablePath: 'explorer.exe',
        arguments: ['C:\\Users\\User\\Documents\\report.pdf'],
      }),
    )
  })

  it('returns not-found when opening a missing file', async () => {
    const shellNamespace = createMockShellNamespace([])
    const engine = new IntentRouterEngine({
      shellNamespace: shellNamespace as unknown as ShellNamespaceService,
      preferNative: false,
    })

    const result = (await engine.dispatch({
      type: 'open-file',
      itemId: makeShellItemId('file:missing'),
    })) as OpenFileResult

    expect(result.status).toBe('not-found')
    expect(result.error?.code).toBe('NOT_FOUND')
  })

  it('successfully opens a folder through file explorer', async () => {
    const { launcher, launchWin32 } = createMockLauncher()
    const mockFolder: ShellItem = createMockShellItem({
      id: 'folder:proj',
      displayName: 'Projects',
      kind: 'folder',
      path: 'C:\\Projects',
      size: 0,
    })

    const shellNamespace = createMockShellNamespace([mockFolder])
    const engine = new IntentRouterEngine({
      shellNamespace: shellNamespace as unknown as ShellNamespaceService,
      processLauncher: launcher,
      preferNative: false,
    })

    const result = (await engine.dispatch({
      type: 'open-folder',
      itemId: makeShellItemId('folder:proj'),
    })) as OpenFolderResult

    expect(result.status).toBe('success')
    expect(result.itemId).toBe('folder:proj')
    expect(launchWin32).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'win32',
        executablePath: 'explorer.exe',
        arguments: ['C:\\Projects'],
      }),
    )
  })

  it('rejects open-folder when target item is a file', async () => {
    const mockFile: ShellItem = createMockShellItem({
      id: 'file:note',
      displayName: 'notes.txt',
      kind: 'file',
      path: 'C:\\notes.txt',
      size: 50,
    })

    const shellNamespace = createMockShellNamespace([mockFile])
    const engine = new IntentRouterEngine({
      shellNamespace: shellNamespace as unknown as ShellNamespaceService,
      preferNative: false,
    })

    const result = (await engine.dispatch({
      type: 'open-folder',
      itemId: makeShellItemId('file:note'),
    })) as OpenFolderResult

    expect(result.status).toBe('invalid-request')
    expect(result.error?.code).toBe('ITEM_NOT_FOLDER')
  })

  it('successfully executes reveal-in-folder using explorer /select', async () => {
    const { launcher, launchWin32 } = createMockLauncher()
    const mockItem: ShellItem = createMockShellItem({
      id: 'file:photo',
      displayName: 'sunset.jpg',
      kind: 'file',
      path: 'C:\\Photos\\sunset.jpg',
      size: 2048,
    })

    const shellNamespace = createMockShellNamespace([mockItem])
    const engine = new IntentRouterEngine({
      shellNamespace: shellNamespace as unknown as ShellNamespaceService,
      processLauncher: launcher,
      preferNative: false,
    })

    const result = await engine.revealInFolder(makeShellItemId('file:photo'))
    expect(result.status).toBe('success')
    expect(launchWin32).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'win32',
        executablePath: 'explorer.exe',
        arguments: ['/select,C:\\Photos\\sunset.jpg'],
      }),
    )
  })

  it('determines accurate available actions per item kind', async () => {
    const mockFolder: ShellItem = createMockShellItem({
      id: 'folder:work',
      displayName: 'Work',
      kind: 'folder',
      path: 'C:\\Work',
      size: 0,
    })

    const mockShortcut: ShellItem = createMockShellItem({
      id: 'shortcut:app',
      displayName: 'App.lnk',
      kind: 'shortcut',
      path: 'C:\\Desktop\\App.lnk',
      size: 100,
    })

    const shellNamespace = createMockShellNamespace([mockFolder, mockShortcut])
    const engine = new IntentRouterEngine({
      shellNamespace: shellNamespace as unknown as ShellNamespaceService,
      preferNative: false,
    })

    const folderActions = await engine.getAvailableActions(makeShellItemId('folder:work'))
    expect(folderActions.status).toBe('success')
    expect(folderActions.actions).toContain('create-folder')
    expect(folderActions.actions).toContain('move')

    const shortcutActions = await engine.getAvailableActions(makeShellItemId('shortcut:app'))
    expect(shortcutActions.status).toBe('success')
    expect(shortcutActions.actions).toContain('resolve-target')
  })

  it('rejects malformed and unsupported intents cleanly', async () => {
    const engine = new IntentRouterEngine({ preferNative: false })

    const resultNull = await engine.dispatch(null)
    expect(resultNull.status).toBe('invalid-request')

    const resultMissingType = await engine.dispatch({ foo: 'bar' })
    expect(resultMissingType.status).toBe('invalid-request')

    const resultUnsupported = await engine.dispatch({ type: 'fake-intent-type' })
    expect(resultUnsupported.status).toBe('invalid-request')
  })

  it('broadcasts lifecycle events for dispatched intents', async () => {
    const { launcher } = createMockLauncher()
    const appRegistry = createMockAppRegistry([{ id: 'app:win32:editor', name: 'Editor' }])
    const engine = new IntentRouterEngine({
      appRegistry: appRegistry as unknown as AppRegistryService,
      processLauncher: launcher,
      preferNative: false,
    })

    const dispatchedSpy = vi.fn()
    const completedSpy = vi.fn()
    const failedSpy = vi.fn()

    engine.on('intent-dispatched', dispatchedSpy)
    engine.on('intent-completed', completedSpy)
    engine.on('intent-failed', failedSpy)

    await engine.dispatch({
      type: 'open-app',
      appId: makeAppId('app:win32:editor'),
    })

    expect(dispatchedSpy).toHaveBeenCalledTimes(1)
    expect(completedSpy).toHaveBeenCalledTimes(1)
    expect(failedSpy).not.toHaveBeenCalled()

    await engine.dispatch({
      type: 'open-app',
      appId: makeAppId('app:win32:missing'),
    })

    expect(failedSpy).toHaveBeenCalledTimes(1)
  })

  it('deduplicates duplicate itemIds in delete intent to prevent false NOT_FOUND', async () => {
    const mockFile = createMockShellItem({
      id: 'file:dedup-del',
      displayName: 'test.txt',
      kind: 'file',
      path: 'C:\\test.txt',
    })
    const shellNamespace = createMockShellNamespace([mockFile])
    const engine = new IntentRouterEngine({
      shellNamespace: shellNamespace as unknown as ShellNamespaceService,
      preferNative: false,
    })

    const deleteSpy = vi.spyOn(engine.fileOps, 'delete').mockResolvedValue(['C:\\test.txt'])

    const result = await engine.delete([makeShellItemId('file:dedup-del'), makeShellItemId('file:dedup-del')], true)
    expect(result.status).toBe('success')
    expect(result.itemIds).toEqual([makeShellItemId('file:dedup-del')])
    expect(deleteSpy).toHaveBeenCalledWith(['C:\\test.txt'], true)
  })

  it('deduplicates duplicate itemIds in move intent', async () => {
    const mockFile = createMockShellItem({
      id: 'file:dedup-move',
      displayName: 'test.txt',
      kind: 'file',
      path: 'C:\\test.txt',
    })
    const mockFolder = createMockShellItem({
      id: 'folder:dest',
      displayName: 'Dest',
      kind: 'folder',
      path: 'C:\\Dest',
    })
    const shellNamespace = createMockShellNamespace([mockFile, mockFolder])
    const engine = new IntentRouterEngine({
      shellNamespace: shellNamespace as unknown as ShellNamespaceService,
      preferNative: false,
    })

    const moveSpy = vi.spyOn(engine.fileOps, 'move').mockResolvedValue(new Map([['C:\\test.txt', { success: true, value: 'C:\\Dest\\test.txt' }]]))

    const result = await engine.move([makeShellItemId('file:dedup-move'), makeShellItemId('file:dedup-move')], makeShellItemId('folder:dest'))
    expect(result.status).toBe('success')
    expect(result.items).toHaveLength(1)
    expect(moveSpy).toHaveBeenCalledWith(['C:\\test.txt'], 'C:\\Dest')
  })

  it('deduplicates duplicate itemIds in copy intent', async () => {
    const mockFile = createMockShellItem({
      id: 'file:dedup-copy',
      displayName: 'test.txt',
      kind: 'file',
      path: 'C:\\test.txt',
    })
    const mockFolder = createMockShellItem({
      id: 'folder:dest',
      displayName: 'Dest',
      kind: 'folder',
      path: 'C:\\Dest',
    })
    const shellNamespace = createMockShellNamespace([mockFile, mockFolder])
    const engine = new IntentRouterEngine({
      shellNamespace: shellNamespace as unknown as ShellNamespaceService,
      preferNative: false,
    })

    const copySpy = vi.spyOn(engine.fileOps, 'copy').mockResolvedValue(new Map([['C:\\test.txt', { success: true, value: 'C:\\Dest\\test.txt' }]]))

    const result = await engine.copy([makeShellItemId('file:dedup-copy'), makeShellItemId('file:dedup-copy')], makeShellItemId('folder:dest'))
    expect(result.status).toBe('success')
    expect(result.items).toHaveLength(1)
    expect(copySpy).toHaveBeenCalledWith(['C:\\test.txt'], 'C:\\Dest')
  })

  it('maps invalid path and path traversal errors in delete to invalid-request status', async () => {
    const mockFile = createMockShellItem({
      id: 'file:bad-path',
      displayName: 'test.txt',
      kind: 'file',
      path: 'C:\\test.txt',
    })
    const shellNamespace = createMockShellNamespace([mockFile])
    const engine = new IntentRouterEngine({
      shellNamespace: shellNamespace as unknown as ShellNamespaceService,
      preferNative: false,
    })

    vi.spyOn(engine.fileOps, 'delete').mockRejectedValue(
      new InvalidInputError("Path traversal sequences ('..') are forbidden", 'PATH_TRAVERSAL'),
    )

    const result = await engine.delete([makeShellItemId('file:bad-path')], true)
    expect(result.status).toBe('invalid-request')
    expect(result.error?.code).toBe('PATH_TRAVERSAL')
  })

  it('accurately maps createFolder error codes to distinct IntentStatus values', async () => {
    const mockFolder = createMockShellItem({
      id: 'folder:dest',
      displayName: 'Dest',
      kind: 'folder',
      path: 'C:\\Dest',
    })
    const shellNamespace = createMockShellNamespace([mockFolder])
    const engine = new IntentRouterEngine({
      shellNamespace: shellNamespace as unknown as ShellNamespaceService,
      preferNative: false,
    })

    vi.spyOn(engine.fileOps, 'createFolder').mockRejectedValueOnce(
      new InvalidInputError('Permission denied', 'PERMISSION_DENIED'),
    )
    const permResult = await engine.createFolder(makeShellItemId('folder:dest'), 'Sub1')
    expect(permResult.status).toBe('permission-denied')

    vi.spyOn(engine.fileOps, 'createFolder').mockRejectedValueOnce(
      new InvalidInputError('Already exists', 'CONFLICT'),
    )
    const conflictResult = await engine.createFolder(makeShellItemId('folder:dest'), 'Sub2')
    expect(conflictResult.status).toBe('conflict')

    vi.spyOn(engine.fileOps, 'createFolder').mockRejectedValueOnce(
      new InvalidInputError('Device name', 'RESERVED_DEVICE_NAME'),
    )
    const devResult = await engine.createFolder(makeShellItemId('folder:dest'), 'CON')
    expect(devResult.status).toBe('invalid-request')
  })

  it('preserves all distinct item IDs in move outcomes when multiple IDs resolve to the same path', async () => {
    const mockFile1 = createMockShellItem({
      id: 'file:same-path-1',
      displayName: 'file.txt',
      kind: 'file',
      path: 'C:\\file.txt',
    })
    const mockFile2 = createMockShellItem({
      id: 'file:same-path-2',
      displayName: 'file.txt',
      kind: 'file',
      path: 'C:\\file.txt',
    })
    const mockFolder = createMockShellItem({
      id: 'folder:dest',
      displayName: 'Dest',
      kind: 'folder',
      path: 'C:\\Dest',
    })
    const shellNamespace = createMockShellNamespace([mockFile1, mockFile2, mockFolder])
    const engine = new IntentRouterEngine({
      shellNamespace: shellNamespace as unknown as ShellNamespaceService,
      preferNative: false,
    })

    vi.spyOn(engine.fileOps, 'move').mockResolvedValue(
      new Map([['C:\\file.txt', { success: true, value: 'C:\\Dest\\file.txt' }]]),
    )

    const result = await engine.move(
      [makeShellItemId('file:same-path-1'), makeShellItemId('file:same-path-2')],
      makeShellItemId('folder:dest'),
    )

    expect(result.status).toBe('success')
    expect(result.items).toHaveLength(2)
    expect(result.items.map(i => i.sourceId)).toEqual([
      makeShellItemId('file:same-path-1'),
      makeShellItemId('file:same-path-2'),
    ])
  })

  it('forwards arguments from shortcut targets to openApp', async () => {
    const mockShortcut = createMockShellItem({
      id: 'shortcut:app-args',
      displayName: 'Editor.lnk',
      kind: 'shortcut',
      path: 'C:\\Editor.lnk',
    })
    const shellNamespace = createMockShellNamespace([mockShortcut])
    const engine = new IntentRouterEngine({
      shellNamespace: shellNamespace as unknown as ShellNamespaceService,
      appRegistry: {} as unknown as AppRegistryService,
      preferNative: false,
    })

    vi.spyOn(engine.shortcutResolver, 'resolveEffectiveTarget').mockResolvedValue({
      kind: 'app',
      pathOrUri: 'C:\\App.exe',
      appId: makeAppId('com.example.editor'),
      arguments: ['--profile', 'developer'],
      isBroken: false,
    })

    const openAppSpy = vi.spyOn(engine, 'openApp').mockResolvedValue({
      status: 'success',
      appId: makeAppId('com.example.editor'),
      pid: 1234,
    })

    const res = await engine.openShortcut(makeShellItemId('shortcut:app-args'))
    expect(res.status).toBe('success')
    expect(openAppSpy).toHaveBeenCalledWith(makeAppId('com.example.editor'), {
      additionalArgs: ['--profile', 'developer'],
    })
  })
})
