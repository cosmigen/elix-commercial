import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { AppRegistryService } from '@deepseek-ai/dsh-app-registry'
import type { AppDiscoveryProvider } from '@deepseek-ai/dsh-app-registry'
import {
  disposeSharedNativeBridge,
  getSharedNativeBridge,
} from '@deepseek-ai/dsh-native-core'
import { ShellNamespaceService } from '@deepseek-ai/dsh-shell-namespace'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  IntentRouterEngine,
  IntentRouterService,
  makeShellItemId,
} from '../src/index.ts'
import type {
  CopyResult,
  CreateFolderResult,
  DeleteResult,
  MoveResult,
  OpenAppResult,
  OpenFolderResult,
  ProcessLauncher,
  RenameResult,
  ShellIntentResult,
  ShellItem,
} from '../src/index.ts'

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition in live Windows acceptance test.')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

describe('Intent Router — Windows Live Acceptance', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'elix-intent-live-'))
  })

  afterEach(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true })
    } catch {
      // Best effort cleanup
    }
  })

  it('executes real file mutation lifecycle (create-folder, rename, copy, move, delete) on live filesystem', async () => {
    // 1. Setup real files in temp directory
    const initialFile = path.join(tmpDir, 'document.txt')
    await fs.writeFile(initialFile, 'Live Windows Acceptance Test Content', 'utf-8')

    // Mock shell namespace that maps ShellItemIds to real files in tmpDir
    const itemsMap = new Map<string, ShellItem>()

    function registerItem(id: string, diskPath: string, kind: 'file' | 'folder'): ShellItem {
      const item: ShellItem = {
        id: makeShellItemId(id),
        displayName: path.basename(diskPath),
        kind,
        location: { path: diskPath },
        attributes: {
          readOnly: false,
          hidden: false,
          system: false,
          directory: kind === 'folder',
          archive: false,
          reparsePoint: false,
          offline: false,
          temporary: false,
        },
        icon: {
          kind: 'fallback',
          defaultIconId: kind === 'folder' ? 'generic-folder' : 'generic-file',
        },
        identityQuality: 'filesystem-stable',
        size: 100,
        createdAt: Date.now(),
        modifiedAt: Date.now(),
        source: 'user-desktop',
      }
      itemsMap.set(id, item)
      itemsMap.set(diskPath, item)
      return item
    }

    registerItem('folder:root', tmpDir, 'folder')
    registerItem('file:doc', initialFile, 'file')

    const mockShellNamespace = {
      get: vi.fn((id: string) => itemsMap.get(id)),
      resolveItem: vi.fn().mockImplementation(async (id: string) => {
        const item = itemsMap.get(id)
        return item ? { status: 'available', item } : { status: 'missing', itemId: id }
      }),
      resolve: vi.fn().mockImplementation(async (filePath: string) => {
        return itemsMap.get(filePath)
      }),
      engine: {
        linkResolver: {
          resolve: vi.fn().mockResolvedValue(undefined),
          resolveBatch: vi.fn().mockResolvedValue(new Map()),
        },
        on: vi.fn().mockReturnValue(() => {}),
      },
    }

    const mockLauncher: ProcessLauncher = {
      launchWin32: vi.fn().mockResolvedValue({ success: true, pid: 9999 }),
    }

    const engine = new IntentRouterEngine({
      shellNamespace: mockShellNamespace as unknown as ShellNamespaceService,
      processLauncher: mockLauncher,
      preferNative: false,
    })

    // 2. Create Folder Intent
    const createResult = (await engine.dispatch({
      type: 'create-folder',
      destinationId: makeShellItemId('folder:root'),
      name: 'Archive',
    })) as CreateFolderResult

    expect(createResult.status).toBe('success')
    const archivePath = path.join(tmpDir, 'Archive')
    const archiveStat = await fs.stat(archivePath)
    expect(archiveStat.isDirectory()).toBe(true)

    registerItem('folder:archive', archivePath, 'folder')

    // 3. Rename Intent
    const renameResult = (await engine.dispatch({
      type: 'rename',
      itemId: makeShellItemId('file:doc'),
      newName: 'renamed-doc.txt',
    })) as RenameResult

    expect(renameResult.status).toBe('success')
    expect(renameResult.newName).toBe('renamed-doc.txt')
    const renamedPath = path.join(tmpDir, 'renamed-doc.txt')
    expect(await fs.readFile(renamedPath, 'utf-8')).toBe('Live Windows Acceptance Test Content')
    await expect(fs.stat(initialFile)).rejects.toThrow()

    registerItem('file:doc-renamed', renamedPath, 'file')

    // 4. Copy Intent
    const copyResult = (await engine.dispatch({
      type: 'copy',
      itemIds: [makeShellItemId('file:doc-renamed')],
      destinationId: makeShellItemId('folder:archive'),
    })) as CopyResult

    expect(copyResult.status).toBe('success')
    const copiedPath = path.join(archivePath, 'renamed-doc.txt')
    expect(await fs.readFile(copiedPath, 'utf-8')).toBe('Live Windows Acceptance Test Content')
    // Original still exists
    expect(await fs.readFile(renamedPath, 'utf-8')).toBe('Live Windows Acceptance Test Content')

    // 5. Move Intent
    const moveResult = (await engine.dispatch({
      type: 'move',
      itemIds: [makeShellItemId('file:doc-renamed')],
      destinationId: makeShellItemId('folder:archive'),
    })) as MoveResult

    // Conflict expected because file with that name was copied there in step 4
    expect(moveResult.status).toBe('conflict')

    // Move to a separate subfolder
    const subfolder = path.join(tmpDir, 'TargetFolder')
    await fs.mkdir(subfolder)
    registerItem('folder:target', subfolder, 'folder')

    const moveResult2 = (await engine.dispatch({
      type: 'move',
      itemIds: [makeShellItemId('file:doc-renamed')],
      destinationId: makeShellItemId('folder:target'),
    })) as MoveResult

    expect(moveResult2.status).toBe('success')
    const movedPath = path.join(subfolder, 'renamed-doc.txt')
    expect(await fs.readFile(movedPath, 'utf-8')).toBe('Live Windows Acceptance Test Content')
    await expect(fs.stat(renamedPath)).rejects.toThrow()

    registerItem('file:doc-moved', movedPath, 'file')

    // 6. Permanent Delete Intent
    const deleteResult = (await engine.dispatch({
      type: 'delete',
      itemIds: [makeShellItemId('file:doc-moved'), makeShellItemId('folder:archive')],
      permanent: true,
    })) as DeleteResult

    expect(deleteResult.status).toBe('success')
    expect(deleteResult.mode).toBe('permanent')

    await expect(fs.stat(movedPath)).rejects.toThrow()
    await expect(fs.stat(archivePath)).rejects.toThrow()
  })

  it.skipIf(process.platform !== 'win32')(
    'executes genuine Phase 9 authority chain against live Windows, native core, and shell namespace',
    async () => {
      // 1. Start actual native bridge with supervisor autoRestart
      await disposeSharedNativeBridge()
      const bridge = getSharedNativeBridge({
        supervisor: { autoRestart: true, initialBackoffMs: 20, maxBackoffMs: 100 },
      })
      await bridge.connect()
      expect(bridge.getStatus()).toBe('ready')

      // 4. Isolated temporary directory for mutations
      const e2eDir = await fs.mkdtemp(path.join(os.tmpdir(), 'elix-intent-live-e2e-'))
      const registryCachePath = path.join(e2eDir, 'registry-cache.json')
      const workDir = path.join(e2eDir, 'work')
      await fs.mkdir(workDir, { recursive: true })

      // Harmless Windows test fixture process: executes cmd.exe /c exit 0 directly
      const safeTestProvider: AppDiscoveryProvider = {
        id: 'safe-test-fixture-provider',
        discover: async () => [
          {
            source: 'start-menu-user',
            kind: 'win32',
            rawId: 'safe-cmd-fixture',
            displayName: 'Safe CMD Fixture',
            executablePath: 'cmd.exe',
            arguments: ['/c', 'exit 0'],
          },
        ],
      }

      const context = new Context()
      try {
        // 2. Start real App Registry and real Shell Namespace services
        await context.plugin(AppRegistryService, {
          enabled: true,
          cachePath: registryCachePath,
          autoRefreshOnStartup: false,
          preferNative: true,
          customProviders: [safeTestProvider],
        })
        await context.appRegistry.refresh()
        expect(context.appRegistry.ready).toBe(true)
        expect(context.appRegistry.activeLaunchBackend).toBe('rust-native')

        await context.plugin(ShellNamespaceService, {
          enabled: true,
          preferNative: true,
          debounceMs: 40,
        })
        expect(context.shellNamespace.ready).toBe(true)
        expect(context.shellNamespace.activeBackend).toBe('rust-native')

        // 3. Start real Intent Router service
        await context.plugin(IntentRouterService, {
          enabled: true,
          preferNative: true,
        })
        expect(context.intentRouter.ready).toBe(true)
        expect(context.intentRouter.engine.activeBackend).toBe('rust-native')

        // 5. Create real files and resolve through real Shell Namespace
        const initialDocPath = path.join(workDir, 'live-document.txt')
        await fs.writeFile(initialDocPath, 'Phase 9 Live Windows Authority Payload', 'utf-8')

        const initialFolderPath = path.join(workDir, 'live-folder')
        await fs.mkdir(initialFolderPath)

        const resolvedFile = await context.shellNamespace.resolve(initialDocPath)
        const resolvedFolder = await context.shellNamespace.resolve(initialFolderPath)

        expect(resolvedFile).toBeDefined()
        expect(resolvedFile?.kind).toBe('file')
        expect(resolvedFile?.id).toBeDefined()
        expect(resolvedFile?.location.path).toBe(initialDocPath)
        expect(resolvedFile?.identityQuality).toBe('native-stable')

        expect(resolvedFolder).toBeDefined()
        expect(resolvedFolder?.kind).toBe('folder')
        expect(resolvedFolder?.id).toBeDefined()
        expect(resolvedFolder?.location.path).toBe(initialFolderPath)
        expect(resolvedFolder?.identityQuality).toBe('native-stable')

        // Exercise Home semantic activation -> Intent Router -> App Registry -> Native Core -> Windows
        const apps = context.appRegistry.list()
        expect(apps.length).toBeGreaterThan(0)
        const safeApp = apps[0]
        if (!safeApp) throw new Error('Safe app fixture not found in app registry.')

        const appLaunchCompleted = new Promise<ShellIntentResult>((resolve) => {
          const unbind = context.on('intent-router/intent-completed', (intent, result) => {
            if (intent.type === 'open-app') {
              unbind()
              resolve(result)
            }
          })
        })

        context.emit('home/item-activate-requested', {
          id: 'home-app-fixture',
          type: 'app shortcut',
          metadata: { appId: safeApp.id },
        })

        const appResult = (await appLaunchCompleted) as OpenAppResult
        expect(appResult.status).toBe('success')
        expect(appResult.pid).toBeDefined()
        expect(appResult.pid!).toBeGreaterThan(0)
        if (appResult.pid) {
          try {
            process.kill(appResult.pid)
          } catch {
            // Process terminated cleanly as expected
          }
        }

        // Exercise Home semantic activation -> Intent Router -> Shell Namespace -> Native Core -> Windows
        // Route folder activation with physical path only so Intent Router dynamically resolves through Shell Namespace
        const folderOpenCompleted = new Promise<ShellIntentResult>((resolve) => {
          const unbind = context.on('intent-router/intent-completed', (intent, result) => {
            if (intent.type === 'open-folder') {
              unbind()
              resolve(result)
            }
          })
        })

        context.emit('home/item-activate-requested', {
          id: 'home-folder-path-activation',
          type: 'folder',
          metadata: { path: initialFolderPath },
        })

        const folderResult = (await folderOpenCompleted) as OpenFolderResult
        expect(folderResult.status).toBe('success')
        expect(folderResult.itemId).toBe(resolvedFolder!.id)
        if (folderResult.pid) {
          try {
            process.kill(folderResult.pid)
          } catch {
            // Already delegated/exited
          }
        }

        // 6. Open a folder through actual native launch path
        const directFolderOpen = await context.intentRouter.openFolder(resolvedFolder!.id)
        expect(directFolderOpen.status).toBe('success')
        if (directFolderOpen.pid) {
          try {
            process.kill(directFolderOpen.pid)
          } catch {
            // Process closed
          }
        }

        // 7. Reveal/select a temporary file through actual native launch path
        const revealResult = await context.intentRouter.revealInFolder(resolvedFile!.id)
        expect(revealResult.status).toBe('success')
        expect(revealResult.pid).toBeDefined()
        if (revealResult.pid) {
          try {
            process.kill(revealResult.pid)
          } catch {
            // Process closed
          }
        }

        // 8. Exercise rename/create/copy/move using authoritative Shell Namespace identities
        // 8a. Create folder
        const createRes = await context.intentRouter.createFolder(resolvedFolder!.id, 'NestedSubfolder')
        expect(createRes.status).toBe('success')
        expect(createRes.name).toBe('NestedSubfolder')
        expect(createRes.item).toBeDefined()
        const nestedSubfolderPath = path.join(initialFolderPath, 'NestedSubfolder')
        expect((await fs.stat(nestedSubfolderPath)).isDirectory()).toBe(true)
        const nestedFolderItem = createRes.item!

        // 8b. Rename: verify LOCATION != IDENTITY invariant on NTFS (identity preserved across rename)
        const renameRes = await context.intentRouter.rename(resolvedFile!.id, 'renamed-doc.txt')
        expect(renameRes.status).toBe('success')
        expect(renameRes.newName).toBe('renamed-doc.txt')
        const renamedPath = path.join(workDir, 'renamed-doc.txt')
        expect(await fs.readFile(renamedPath, 'utf-8')).toBe('Phase 9 Live Windows Authority Payload')
        await expect(fs.stat(initialDocPath)).rejects.toThrow()
        const renamedItem = renameRes.item!
        expect(renamedItem.id).toBe(resolvedFile!.id)

        // 8c. Copy: verify distinct identity on newly created file and conflict detection
        const copyRes = await context.intentRouter.copy([renamedItem.id], resolvedFolder!.id)
        expect(copyRes.status).toBe('success')
        const copiedPath = path.join(initialFolderPath, 'renamed-doc.txt')
        expect(await fs.readFile(copiedPath, 'utf-8')).toBe('Phase 9 Live Windows Authority Payload')
        expect(await fs.readFile(renamedPath, 'utf-8')).toBe('Phase 9 Live Windows Authority Payload')
        const copiedItem = copyRes.items[0]?.destinationItem
        expect(copiedItem).toBeDefined()
        expect(copiedItem!.id).not.toBe(renamedItem.id)

        // Conflict check: copying again to same destination detects existing collision
        const conflictCopyRes = await context.intentRouter.copy([renamedItem.id], resolvedFolder!.id)
        expect(conflictCopyRes.status).toBe('conflict')

        // 8d. Move: verify file identity preserved on same NTFS volume
        const moveRes = await context.intentRouter.move([renamedItem.id], nestedFolderItem.id)
        expect(moveRes.status).toBe('success')
        const movedPath = path.join(nestedSubfolderPath, 'renamed-doc.txt')
        expect(await fs.readFile(movedPath, 'utf-8')).toBe('Phase 9 Live Windows Authority Payload')
        await expect(fs.stat(renamedPath)).rejects.toThrow()
        const movedItem = moveRes.items[0]?.destinationItem
        if (!movedItem) throw new Error('Moved item not found in move result.')
        expect(movedItem.id).toBe(renamedItem.id)

        // 8e. Delete: verify permanent removal and Shell Namespace resolution status missing
        const deleteRes = await context.intentRouter.delete([movedItem.id], true)
        expect(deleteRes.status).toBe('success')
        expect(deleteRes.mode).toBe('permanent')
        await expect(fs.stat(movedPath)).rejects.toThrow()

        const missingRes = await context.shellNamespace.resolveItem(movedItem.id)
        expect(missingRes.status).toBe('missing')

        // 9. Verify namespace reconciliation after mutation via native watcher event pipeline
        const addedItems: ShellItem[] = []
        const unbindAdded = context.shellNamespace.engine.on('item-added', (item) => {
          addedItems.push(item)
        })
        const watchSub = context.shellNamespace.watch(workDir)
        // Allow native watcher subscription to establish on host
        await new Promise(r => setTimeout(r, 150))

        const reconcileFile = path.join(workDir, 'reconcile-target.txt')
        await fs.writeFile(reconcileFile, 'reconciliation payload', 'utf-8')

        await waitUntil(() => addedItems.some(i => i.displayName === 'reconcile-target.txt'), 10_000)

        const reconciledItem = addedItems.find(i => i.displayName === 'reconcile-target.txt')
        expect(reconciledItem).toBeDefined()
        expect(reconciledItem?.kind).toBe('file')

        // Verify the Shell Namespace catalog cached the item from the watcher notification without manual listing
        const catalogItem = context.shellNamespace.get(reconciledItem!.id)
        expect(catalogItem).toBeDefined()
        expect(catalogItem?.displayName).toBe('reconcile-target.txt')

        unbindAdded()
        watchSub.dispose()

        // 10. Verify subsequent action still works after native-host restart/recovery
        const preCrashGen = bridge.getHostGeneration()
        await bridge.crashHost()
        await waitUntil(
          () => bridge.getStatus() === 'ready' && bridge.getHostGeneration() > preCrashGen,
          15_000,
        )
        expect(bridge.getHostGeneration()).toBeGreaterThan(preCrashGen)

        // Action 1 through recovered host: openApp
        const postRecoveryAppRes = await context.intentRouter.openApp(safeApp.id)
        expect(postRecoveryAppRes.status).toBe('success')
        expect(postRecoveryAppRes.pid).toBeDefined()
        if (postRecoveryAppRes.pid) {
          try {
            process.kill(postRecoveryAppRes.pid)
          } catch {
            // Clean exit
          }
        }

        // Action 2 through recovered host: openFolder
        const postRecoveryFolderRes = await context.intentRouter.openFolder(resolvedFolder!.id)
        expect(postRecoveryFolderRes.status).toBe('success')
        if (postRecoveryFolderRes.pid) {
          try {
            process.kill(postRecoveryFolderRes.pid)
          } catch {
            // Clean exit
          }
        }

        // Action 3 through recovered host: Shell Namespace resolve still produces native-stable identity
        const postRecoveryFileRes = await context.shellNamespace.resolve(reconcileFile)
        expect(postRecoveryFileRes).toBeDefined()
        expect(postRecoveryFileRes?.identityQuality).toBe('native-stable')

        // Action 4 through recovered host: resolveTarget
        const targetRes = await context.intentRouter.resolveTarget(resolvedFolder!.id)
        expect(targetRes.status).toBe('success')
        expect(targetRes.target?.kind).toBe('folder')
      } finally {
        try {
          await context.fiber.dispose()
        } catch {
          // Best effort
        }
        try {
          await disposeSharedNativeBridge()
        } catch {
          // Best effort
        }
        try {
          await fs.rm(e2eDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
        } catch {
          // Best effort cleanup
        }
        expect(bridge.getStatus()).toBe('closed')
      }
    },
    60_000,
  )
})
