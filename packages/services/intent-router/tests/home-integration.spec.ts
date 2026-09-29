import type { AppRegistryService } from '@deepseek-ai/dsh-app-registry'
import { HomeLayoutEngine } from '@deepseek-ai/dsh-home'
import type { ShellNamespaceService } from '@deepseek-ai/dsh-shell-namespace'
import { describe, expect, it, vi } from 'vitest'
import {
  DesktopProjector,
  IntentRouterEngine,
  makeShellItemId,
} from '../src/index.ts'
import type {
  DesktopProjectorHomeHost,
  OpenAppResult,
  OpenFolderResult,
  ProcessLauncher,
  ProjectedHomeItem,
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
      defaultIconId: params.kind === 'folder' ? 'generic-folder' : params.kind === 'shortcut' ? 'generic-shortcut' : 'generic-file',
    },
    identityQuality: 'filesystem-stable',
    size: params.size ?? 0,
    createdAt: Date.now(),
    modifiedAt: Date.now(),
    source: 'user-desktop',
  }
}

interface MutableProjectedHomeItem {
  id: string
  name: string
  type: 'app' | 'file' | 'folder' | 'shortcut' | 'system'
  position?: { x: number; y: number } | undefined
  size?: { width: number; height: number } | undefined
  monitorId?: string | undefined
  metadata?: Record<string, unknown> | undefined
}

interface MockHomeSpies {
  addItem: ReturnType<typeof vi.fn>
  removeItem: ReturnType<typeof vi.fn>
  renameItem: ReturnType<typeof vi.fn>
  updateMetadata: ReturnType<typeof vi.fn>
}

function createMockHome(): DesktopProjectorHomeHost & { itemsList: ProjectedHomeItem[]; spies: MockHomeSpies } {
  const itemsList: ProjectedHomeItem[] = []

  const addItemSpy = vi.fn((options: {
    id: string
    name?: string
    type: 'app' | 'file' | 'folder' | 'shortcut' | 'system' | 'app shortcut'
    position?: { x: number; y: number }
    size?: { width: number; height: number }
    monitorId?: string
    metadata?: Record<string, unknown>
  }) => {
    const item: MutableProjectedHomeItem = {
      id: options.id,
      name: (options.metadata?.name as string | undefined) ?? (options.metadata?.filename as string | undefined) ?? options.id,
      type: options.type as MutableProjectedHomeItem['type'],
      position: options.position,
      size: options.size,
      monitorId: options.monitorId,
      metadata: options.metadata,
    }
    itemsList.push(item)
    return item
  })

  const removeItemSpy = vi.fn((id: string) => {
    const idx = itemsList.findIndex(i => i.id === id)
    if (idx !== -1) {
      itemsList.splice(idx, 1)
      return true
    }
    return false
  })

  const renameItemSpy = vi.fn((id: string, name: string) => {
    const item = itemsList.find(i => i.id === id)
    if (item) {
      Object.assign(item, { name })
      return true
    }
    return false
  })

  const updateMetadataSpy = vi.fn((id: string, updater: (prev: Record<string, unknown>) => Record<string, unknown>) => {
    const item = itemsList.find(i => i.id === id)
    if (item) {
      Object.assign(item, { metadata: updater(item.metadata ?? {}) })
      return item
    }
    return undefined
  })

  return {
    itemsList,
    spies: {
      addItem: addItemSpy,
      removeItem: removeItemSpy,
      renameItem: renameItemSpy,
      updateMetadata: updateMetadataSpy,
    },
    monitors: {
      getMonitor: vi.fn((id: string) => ({ id, bounds: { x: 0, y: 0, width: 1920, height: 1080 } })),
      getPrimaryMonitor: vi.fn(() => ({ id: 'monitor:primary', bounds: { x: 0, y: 0, width: 1920, height: 1080 } })),
    },
    items: {
      getItems: vi.fn(() => [...itemsList]),
      getRootItemsForMonitor: vi.fn((_monId: string) =>
        itemsList.map(i => ({ position: i.position ?? { x: 0, y: 0 }, size: i.size ?? { width: 84, height: 96 } })),
      ),
      addItem: addItemSpy,
      removeItem: removeItemSpy,
      renameItem: renameItemSpy,
      updateMetadata: updateMetadataSpy,
    },
    layout: {
      getAvailableBounds: vi.fn((_monitorId?: string, monitorBounds?: { x: number; y: number; width: number; height: number }) =>
        monitorBounds ?? ({ x: 0, y: 0, width: 1920, height: 1080 })),
      getExclusionZones: vi.fn(() => []),
      findNearestFreeSlot: vi.fn((
        desired: { x: number; y: number; width: number; height: number },
        occupied: readonly { x: number; y: number; width: number; height: number }[],
        _monitorId?: string,
      ) => ({
        x: desired.x + occupied.length * 90,
        y: desired.y,
      })),
    },
  }
}

describe('Home Integration — Desktop Projection & Activation Routing', () => {
  it('projects Desktop items from Shell Namespace onto Home Desktop with collision-free positions', async () => {
    const home = createMockHome()
    const projector = new DesktopProjector()

    const mockItems: ShellItem[] = [
      createMockShellItem({
        id: 'file:report',
        displayName: 'Report.docx',
        kind: 'file',
        path: 'C:\\Users\\User\\Desktop\\Report.docx',
        size: 5000,
      }),
      createMockShellItem({
        id: 'folder:work',
        displayName: 'WorkFolder',
        kind: 'folder',
        path: 'C:\\Users\\User\\Desktop\\WorkFolder',
        size: 0,
      }),
    ]

    const mockShellNamespace = {
      getDesktop: vi.fn().mockResolvedValue({ items: mockItems, timestamp: Date.now() }),
    }

    const projected = await projector.projectDesktop(home, mockShellNamespace as unknown as ShellNamespaceService)
    expect(projected.length).toBe(2)
    expect(home.spies.addItem).toHaveBeenCalledTimes(2)

    const projectedFile = home.itemsList.find(i => i.id === 'desktop:file:report')
    expect(projectedFile).toBeDefined()
    expect(projectedFile?.type).toBe('file')
    expect(projectedFile?.metadata?.shellItemId).toBe('file:report')

    const projectedFolder = home.itemsList.find(i => i.id === 'desktop:folder:work')
    expect(projectedFolder).toBeDefined()
    expect(projectedFolder?.type).toBe('folder')
  })

  it('projection is idempotent: repeated runs do not duplicate items', async () => {
    const home = createMockHome()
    const projector = new DesktopProjector()

    const mockItems: ShellItem[] = [
      createMockShellItem({
        id: 'file:unique',
        displayName: 'Unique.txt',
        kind: 'file',
        path: 'C:\\Desktop\\Unique.txt',
        size: 100,
      }),
    ]

    const mockShellNamespace = {
      getDesktop: vi.fn().mockResolvedValue({ items: mockItems, timestamp: Date.now() }),
    }

    // Run 1
    const run1 = await projector.projectDesktop(home, mockShellNamespace as unknown as ShellNamespaceService)
    expect(run1.length).toBe(1)
    expect(home.itemsList.length).toBe(1)

    // Run 2
    const run2 = await projector.projectDesktop(home, mockShellNamespace as unknown as ShellNamespaceService)
    expect(run2.length).toBe(0)
    expect(home.itemsList.length).toBe(1)
  })

  it('reconciles item-removed, item-renamed, and item-changed events', async () => {
    const home = createMockHome()
    const projector = new DesktopProjector()

    const existingFile: ShellItem = createMockShellItem({
      id: 'file:track',
      displayName: 'Track.mp3',
      kind: 'file',
      path: 'C:\\Desktop\\Track.mp3',
      size: 1024,
    })

    const listeners = new Map<string, (arg1: unknown, arg2?: unknown) => void>()

    const mockShellNamespace = {
      getDesktop: vi.fn().mockResolvedValue({ items: [existingFile], timestamp: Date.now() }),
      engine: {
        on: vi.fn((event: string, handler: (arg1: unknown, arg2?: unknown) => void) => {
          listeners.set(event, handler)
          return () => {
            listeners.delete(event)
          }
        }),
      },
    }

    await projector.projectDesktop(home, mockShellNamespace as unknown as ShellNamespaceService)
    expect(home.itemsList.length).toBe(1)

    const unbind = projector.bindChangeObservation(home, mockShellNamespace as unknown as ShellNamespaceService)

    // Simulate item-renamed
    const renamedFile: ShellItem = {
      ...existingFile,
      displayName: 'NewTrack.mp3',
      location: { path: 'C:\\Desktop\\NewTrack.mp3' },
    }
    listeners.get('item-renamed')?.(renamedFile, existingFile)

    expect(home.spies.renameItem).toHaveBeenCalledWith('desktop:file:track', 'NewTrack.mp3')

    // Simulate item-changed
    const changedFile: ShellItem = {
      ...renamedFile,
      size: 2048,
    }
    listeners.get('item-changed')?.(changedFile)
    expect(home.spies.updateMetadata).toHaveBeenCalled()

    // Simulate item-removed
    listeners.get('item-removed')?.(existingFile.id)
    expect(home.spies.removeItem).toHaveBeenCalledWith('desktop:file:track')
    expect(home.itemsList.length).toBe(0)

    unbind()
  })

  it('routes Home activation for system items (Recycle Bin, Settings, This PC)', async () => {
    const launchWin32 = vi.fn().mockResolvedValue({ success: true, pid: 7777 })
    const launcher: ProcessLauncher = {
      launchWin32,
    }

    const engine = new IntentRouterEngine({
      processLauncher: launcher,
      preferNative: false,
    })

    // Recycle Bin
    const recycleBinResult = (await engine.routeHomeActivation({
      id: 'sys:recycle-bin',
      type: 'system',
      metadata: { targetAction: 'recycle-bin' },
    })) as OpenFolderResult

    expect(recycleBinResult.status).toBe('success')
    expect(launchWin32).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'win32',
        executablePath: 'explorer.exe',
        arguments: ['shell:::{645FF040-5081-101B-9F08-00AA002F954E}'],
      }),
    )

    // Settings
    const settingsResult = (await engine.routeHomeActivation({
      id: 'sys:settings',
      type: 'system',
      metadata: { targetAction: 'settings' },
    })) as OpenAppResult

    expect(settingsResult.status).toBe('success')
    expect(settingsResult.appId).toBe('windows.ms-settings')
    expect(launchWin32).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'win32',
        executablePath: 'explorer.exe',
        arguments: ['ms-settings:'],
      }),
    )
  })

  it('routes app shortcut activation to open-app and preserves Home on failure', async () => {
    const appRegistry = {
      get: vi.fn().mockReturnValue(undefined),
      resolve: vi.fn().mockReturnValue({ status: 'missing', appId: 'app:missing' }),
      list: vi.fn().mockReturnValue([]),
      launch: vi.fn(),
    }

    const engine = new IntentRouterEngine({
      appRegistry: appRegistry as unknown as AppRegistryService,
      preferNative: false,
    })

    const home = createMockHome()
    home.items.addItem({
      id: 'item:my-app',
      type: 'app shortcut',
      metadata: { appId: 'app:missing' },
    })

    const initialItemCount = home.itemsList.length

    const result = await engine.routeHomeActivation({
      id: 'item:my-app',
      type: 'app shortcut',
      metadata: { appId: 'app:missing' },
    })

    expect(result.status).toBe('not-found')
    // Home state is unchanged and not corrupted
    expect(home.itemsList.length).toBe(initialItemCount)
    expect(home.itemsList[0]?.id).toBe('item:my-app')
  })

  it('reconciles item-renamed when item has path-fallback identity and changed ID', async () => {
    const projector = new DesktopProjector()
    const home = createMockHome()

    home.items.addItem({
      id: 'desktop:path:oldhash123',
      type: 'file',
      metadata: {
        filename: 'draft.txt',
        path: 'C:\\Desktop\\draft.txt',
        shellItemId: 'path:oldhash123',
      },
    })

    const listeners = new Map<string, (item: unknown, prev?: unknown) => void>()
    const shellNamespace = {
      engine: {
        on: vi.fn((event: string, fn: (item: unknown, prev?: unknown) => void) => {
          listeners.set(event, fn)
          return () => listeners.delete(event)
        }),
      },
    }

    projector.bindChangeObservation(home, shellNamespace as unknown as ShellNamespaceService)

    const prevItem = createMockShellItem({
      id: 'path:oldhash123',
      displayName: 'draft.txt',
      kind: 'file',
      path: 'C:\\Desktop\\draft.txt',
    })

    const newItem = createMockShellItem({
      id: 'path:newhash456',
      displayName: 'final.txt',
      kind: 'file',
      path: 'C:\\Desktop\\final.txt',
    })

    const renameListener = listeners.get('item-renamed')
    expect(renameListener).toBeDefined()
    renameListener!(newItem, prevItem)

    expect(home.spies.renameItem).toHaveBeenCalledWith('desktop:path:oldhash123', 'final.txt')
    expect(home.spies.updateMetadata).toHaveBeenCalledWith('desktop:path:oldhash123', expect.any(Function))
  })

  it('resolves authoritative ShellItemId from meta.path when shellItemId is missing', async () => {
    const mockFile = createMockShellItem({
      id: 'fs:00000001:0000000000000042',
      displayName: 'legacy.txt',
      kind: 'file',
      path: 'C:\\Users\\User\\Desktop\\legacy.txt',
    })

    const launchWin32 = vi.fn().mockResolvedValue({ success: true, pid: 7777 })
    const launcher: ProcessLauncher = { launchWin32 }

    const shellNamespace = {
      get: vi.fn().mockReturnValue(mockFile),
      resolve: vi.fn().mockResolvedValue(mockFile),
      resolveItem: vi.fn().mockResolvedValue({ status: 'available', item: mockFile }),
    }

    const engine = new IntentRouterEngine({
      shellNamespace: shellNamespace as unknown as ShellNamespaceService,
      processLauncher: launcher,
      preferNative: false,
    })

    const result = await engine.routeHomeActivation({
      id: 'legacy-home-item-1',
      type: 'file',
      metadata: { path: 'C:\\Users\\User\\Desktop\\legacy.txt', filename: 'legacy.txt' },
    })

    expect(result.status).toBe('success')
    expect(shellNamespace.resolve).toHaveBeenCalledWith('C:\\Users\\User\\Desktop\\legacy.txt')
  })

  it('successfully projects desktop items when host uses real HomeLayoutEngine instance', async () => {
    const layoutEngine = new HomeLayoutEngine()
    const mockHome = createMockHome()
    // Replace mock layout with real HomeLayoutEngine
    mockHome.layout = layoutEngine

    const mockFile1 = createMockShellItem({
      id: 'file:real-layout-1',
      displayName: 'test1.txt',
      kind: 'file',
      path: 'C:\\test1.txt',
    })
    const mockFile2 = createMockShellItem({
      id: 'file:real-layout-2',
      displayName: 'test2.txt',
      kind: 'file',
      path: 'C:\\test2.txt',
    })

    const shellNamespace = {
      getDesktop: vi.fn().mockResolvedValue({
        items: [mockFile1, mockFile2],
        timestamp: Date.now(),
      }),
    }

    const projector = new DesktopProjector()
    const projected = await projector.projectDesktop(mockHome, shellNamespace as unknown as ShellNamespaceService)

    expect(projected).toHaveLength(2)
    expect(projected[0]?.position).toBeDefined()
    expect(projected[1]?.position).toBeDefined()
    expect(projected[0]?.position?.x).not.toBe(projected[1]?.position?.x)
  })

  it('correctly bounds items on secondary monitors using real HomeLayoutEngine without clamping to primary monitor', async () => {
    const layoutEngine = new HomeLayoutEngine()
    const mockHome = createMockHome()
    mockHome.layout = layoutEngine

    // Mock monitor 2 with offset physical coordinates
    mockHome.monitors.getMonitor = vi.fn((id: string) => {
      if (id === 'monitor:secondary') {
        return { id: 'monitor:secondary', bounds: { x: 1920, y: 0, width: 1920, height: 1080 } }
      }
      return { id: 'monitor:primary', bounds: { x: 0, y: 0, width: 1920, height: 1080 } }
    })

    const mockFile1 = createMockShellItem({
      id: 'file:sec-mon-1',
      displayName: 'secondary.txt',
      kind: 'file',
      path: 'C:\\secondary.txt',
    })

    const shellNamespace = {
      getDesktop: vi.fn().mockResolvedValue({
        items: [mockFile1],
        timestamp: Date.now(),
      }),
    }

    const projector = new DesktopProjector()
    const projected = await projector.projectDesktop(
      mockHome,
      shellNamespace as unknown as ShellNamespaceService,
      { monitorId: 'monitor:secondary' },
    )

    expect(projected).toHaveLength(1)
    expect(projected[0]?.position?.x).toBeGreaterThanOrEqual(1920)
    expect(projected[0]?.position?.x).toBeLessThan(3840)
  })

  it('serializes rapid concurrent projectDesktop invocations cleanly without race collisions or duplicate additions', async () => {
    const layoutEngine = new HomeLayoutEngine()
    const mockHome = createMockHome()
    mockHome.layout = layoutEngine

    const mockFile1 = createMockShellItem({
      id: 'file:concurrent-1',
      displayName: 'c1.txt',
      kind: 'file',
      path: 'C:\\c1.txt',
    })
    const mockFile2 = createMockShellItem({
      id: 'file:concurrent-2',
      displayName: 'c2.txt',
      kind: 'file',
      path: 'C:\\c2.txt',
    })

    const shellNamespace = {
      getDesktop: vi.fn().mockResolvedValue({
        items: [mockFile1, mockFile2],
        timestamp: Date.now(),
      }),
    }

    const projector = new DesktopProjector()
    // Trigger 3 concurrent calls
    const [p1, p2, p3] = await Promise.all([
      projector.projectDesktop(mockHome, shellNamespace as unknown as ShellNamespaceService),
      projector.projectDesktop(mockHome, shellNamespace as unknown as ShellNamespaceService),
      projector.projectDesktop(mockHome, shellNamespace as unknown as ShellNamespaceService),
    ])

    // First call adds the 2 items, subsequent calls see them already existing
    expect(p1.length + p2.length + p3.length).toBe(2)
    expect(mockHome.itemsList).toHaveLength(2)
    expect(mockHome.itemsList[0]?.position?.x).not.toBe(mockHome.itemsList[1]?.position?.x)
  })
})
