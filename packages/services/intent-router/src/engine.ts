/**
 * Authoritative Intent Router Engine for ELIX.
 * Coordinates user intent interpretation, strict validation, target resolution,
 * and dispatching to App Registry, Shell Namespace, Native Core, and File Operations.
 *
 * @module @deepseek-ai/dsh-intent-router/engine
 */

import type { AppRegistryEngine, AppRegistryService } from '@deepseek-ai/dsh-app-registry'
import {
  DefaultAppLaunchAdapter,
  makeAppId,
} from '@deepseek-ai/dsh-app-registry'
import type { NativeBridgeClient } from '@deepseek-ai/dsh-native-core'
import {
  NativeAppLaunchAdapter,
  getSharedNativeBridge,
} from '@deepseek-ai/dsh-native-core'
import type {
  ShellItem,
  ShellItemId,
  ShellNamespaceEngine,
  ShellNamespaceService,
} from '@deepseek-ai/dsh-shell-namespace'
import { makeShellItemId } from '@deepseek-ai/dsh-shell-namespace'
import { FileOperationsCoordinator, PartialDeletionError } from './operations.ts'
import { ShortcutResolver } from './shortcuts.ts'
import type {
  AppId,
  AppLaunchOptions,
  AvailableAction,
  CopyResult,
  CreateFolderResult,
  DeleteResult,
  GetAvailableActionsResult,
  HomeActivationItem,
  IntentError,
  IntentStatus,
  MoveResult,
  OpenAppResult,
  OpenFileResult,
  OpenFolderResult,
  OpenShortcutResult,
  ProcessLauncher,
  RenameResult,
  ResolveTargetResult,
  RevealInFolderResult,
  ShellIntent,
  ShellIntentResult,
} from './types.ts'
import {
  InvalidInputError,
  validateAppId,
  validateIntent,
  validateItemName,
  validateShellItemId,
} from './validation.ts'

/** Event callback map for IntentRouterEngine. */
export interface IntentRouterEngineEvents {
  'intent-dispatched': (intent: ShellIntent) => void
  'intent-completed': (intent: ShellIntent, result: ShellIntentResult) => void
  'intent-failed': (intent: ShellIntent, result: ShellIntentResult) => void
}

/** A direct value, factory accessor, or undefined reference. */
export type Resolvable<T> = T | (() => T | undefined) | undefined

/** Options for instantiating the IntentRouterEngine. */
export interface IntentRouterEngineOptions {
  appRegistry?: Resolvable<AppRegistryService | AppRegistryEngine>
  shellNamespace?: Resolvable<ShellNamespaceService | ShellNamespaceEngine>
  bridgeClient?: NativeBridgeClient | undefined
  processLauncher?: ProcessLauncher | undefined
  preferNative?: boolean | undefined
}

/**
 * Authoritative Intent Router Engine.
 */
export class IntentRouterEngine {
  private readonly appRegistrySource?: Resolvable<AppRegistryService | AppRegistryEngine>
  private readonly shellNamespaceSource?: Resolvable<ShellNamespaceService | ShellNamespaceEngine>

  /** The resolved App Registry service or engine instance, if available. */
  get appRegistry(): AppRegistryService | AppRegistryEngine | undefined {
    return typeof this.appRegistrySource === 'function' ? this.appRegistrySource() : this.appRegistrySource
  }

  /** The resolved Shell Namespace service or engine instance, if available. */
  get shellNamespace(): ShellNamespaceService | ShellNamespaceEngine | undefined {
    return typeof this.shellNamespaceSource === 'function' ? this.shellNamespaceSource() : this.shellNamespaceSource
  }

  /** Authoritative process launcher executing native host or fallback commands. */
  readonly launcher: ProcessLauncher

  /** Authoritative file operations coordinator executing filesystem mutations. */
  readonly fileOps: FileOperationsCoordinator

  /** Authoritative shortcut resolver parsing .lnk targets and effective destinations. */
  readonly shortcutResolver: ShortcutResolver

  /** Active process launcher backend mechanism. */
  readonly activeBackend: 'rust-native' | 'typescript-fallback'

  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  private isDisposed = false

  constructor(options?: IntentRouterEngineOptions) {
    this.appRegistrySource = options?.appRegistry
    this.shellNamespaceSource = options?.shellNamespace
    this.fileOps = new FileOperationsCoordinator()

    // Determine launcher backend
    const preferNative = options?.preferNative ?? true
    let bridge = options?.bridgeClient

    if (preferNative && !bridge) {
      try {
        bridge = getSharedNativeBridge()
      } catch {
        // Fallback cleanly if native bridge is not available
      }
    }

    if (options?.processLauncher) {
      this.launcher = options.processLauncher
      this.activeBackend = 'typescript-fallback'
    } else if (bridge) {
      this.launcher = new NativeAppLaunchAdapter(bridge)
      this.activeBackend = 'rust-native'
    } else {
      this.launcher = new DefaultAppLaunchAdapter()
      this.activeBackend = 'typescript-fallback'
    }

    // Shortcut resolver dynamically accesses active linkResolver from shellNamespace
    this.shortcutResolver = new ShortcutResolver(() => {
      const ns = this.shellNamespace
      if (!ns) return undefined
      return 'engine' in ns
        ? ns.engine.linkResolver
        : (ns as { linkResolver?: import('@deepseek-ai/dsh-shell-namespace').ShellLinkResolver }).linkResolver
    })
  }

  /**
   * Subscribe to engine lifecycle and execution events.
   *
   * @param event - The event name to observe.
   * @param listener - Callback invoked when the event is emitted.
   * @returns Disposer function unsubscribing the listener.
   */
  on<K extends keyof IntentRouterEngineEvents>(
    event: K,
    listener: IntentRouterEngineEvents[K],
  ): () => void {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    const genericFn = listener as (...args: unknown[]) => void
    set.add(genericFn)
    return () => {
      set.delete(genericFn)
    }
  }

  private emit<K extends keyof IntentRouterEngineEvents>(
    event: K,
    ...args: Parameters<IntentRouterEngineEvents[K]>
  ): void {
    const set = this.listeners.get(event)
    if (set) {
      for (const fn of set) {
        try {
          Reflect.apply(fn, undefined, args)
        } catch {
          // Fault resilience
        }
      }
    }
  }

  /**
   * Dispatches a typed shell intent to its authoritative domain owner.
   *
   * @param rawIntent - Raw or untrusted intent input.
   * @returns Typed ShellIntentResult.
   */
  async dispatch(rawIntent: unknown): Promise<ShellIntentResult> {
    let intent: ShellIntent
    try {
      intent = validateIntent(rawIntent)
    } catch (err: unknown) {
      const error = this.formatError(err, 'INVALID_REQUEST')
      return {
        status: 'invalid-request',
        itemId: makeShellItemId('unknown'),
        error,
      }
    }

    this.emit('intent-dispatched', intent)

    let result: ShellIntentResult

    try {
      switch (intent.type) {
        case 'open-app':
          result = await this.openApp(intent.appId, intent.options)
          break
        case 'open-file':
          result = await this.openFile(intent.itemId)
          break
        case 'open-folder':
          result = await this.openFolder(intent.itemId)
          break
        case 'open-shortcut':
          result = await this.openShortcut(intent.itemId)
          break
        case 'reveal-in-folder':
          result = await this.revealInFolder(intent.itemId)
          break
        case 'rename':
          result = await this.rename(intent.itemId, intent.newName)
          break
        case 'delete':
          result = await this.delete(intent.itemIds, intent.permanent)
          break
        case 'move':
          result = await this.move(intent.itemIds, intent.destinationId)
          break
        case 'copy':
          result = await this.copy(intent.itemIds, intent.destinationId)
          break
        case 'create-folder':
          result = await this.createFolder(intent.destinationId, intent.name)
          break
        case 'resolve-target':
          result = await this.resolveTarget(intent.itemId)
          break
        case 'get-available-actions':
          result = await this.getAvailableActions(intent.itemId)
          break
        default:
          result = {
            status: 'unsupported',
            itemId: makeShellItemId('unknown'),
            error: { code: 'UNSUPPORTED_INTENT', message: `Unhandled intent: ${(intent as { type: string }).type}` },
          }
      }
    } catch (err: unknown) {
      const error = this.formatError(err, 'NATIVE_FAILURE')
      result = {
        status: 'native-failure',
        itemId: (intent as { itemId?: ShellItemId }).itemId ?? makeShellItemId('unknown'),
        error,
      }
    }

    if (result.status === 'success') {
      this.emit('intent-completed', intent, result)
    } else {
      this.emit('intent-failed', intent, result)
    }

    return result
  }

  /**
   * Activates a registered application by its AppId.
   *
   * @param appId - Target application identifier.
   * @param options - Optional launch arguments and display flags.
   * @returns Typed OpenAppResult indicating launch outcome or error.
   */
  async openApp(appId: AppId, options?: AppLaunchOptions): Promise<OpenAppResult> {
    const validAppId = validateAppId(appId)

    if (!this.appRegistry) {
      return {
        status: 'unsupported',
        appId: validAppId,
        error: { code: 'NO_APP_REGISTRY', message: 'App Registry service is not available.' },
      }
    }

    const app = this.appRegistry.get(validAppId)
    if (!app) {
      return {
        status: 'not-found',
        appId: validAppId,
        error: { code: 'APP_NOT_FOUND', message: `Application with ID "${validAppId}" was not found in catalog.` },
      }
    }

    const resolution = typeof this.appRegistry.resolve === 'function'
      ? this.appRegistry.resolve(validAppId)
      : { status: 'available' as const, app }
    if (resolution.status !== 'available') {
      return {
        status: 'not-found',
        appId: validAppId,
        error: { code: 'APP_UNAVAILABLE', message: `Application "${app.displayName}" is unavailable: ${resolution.status}.` },
      }
    }

    try {
      const launchResult = await this.appRegistry.launch(validAppId, options)
      if (launchResult.success) {
        return {
          status: 'success',
          appId: validAppId,
          pid: launchResult.pid,
        }
      }
      return {
        status: 'native-failure',
        appId: validAppId,
        error: { code: 'LAUNCH_FAILED', message: launchResult.error ?? 'Launch failed.' },
      }
    } catch (err: unknown) {
      return {
        status: 'native-failure',
        appId: validAppId,
        error: this.formatError(err, 'LAUNCH_FAILED'),
      }
    }
  }

  /**
   * Opens a regular file with its registered system handler.
   *
   * @param itemId - Shell item identifier of the target file.
   * @returns Typed OpenFileResult indicating launch outcome or error.
   */
  async openFile(itemId: ShellItemId): Promise<OpenFileResult> {
    const validId = validateShellItemId(itemId)
    const item = await this.resolveItem(validId)

    if (!item) {
      return {
        status: 'not-found',
        itemId: validId,
        error: { code: 'NOT_FOUND', message: `File with ID "${validId}" not found.` },
      }
    }

    if (item.kind === 'folder' || item.attributes.directory) {
      return {
        status: 'invalid-request',
        itemId: validId,
        error: { code: 'ITEM_IS_FOLDER', message: 'Target is a directory; use open-folder intent instead.' },
      }
    }

    if (item.kind === 'shortcut') {
      return this.openShortcut(validId)
    }

    // Windows Shell standard invocation for files: explorer.exe <filePath>
    try {
      const res = await this.launcher.launchWin32({
        kind: 'win32',
        executablePath: 'explorer.exe',
        arguments: [item.location.path],
      })
      if (res.success) {
        return { status: 'success', itemId: validId, pid: res.pid }
      }
      return {
        status: 'native-failure',
        itemId: validId,
        error: { code: 'LAUNCH_FAILED', message: res.error ?? 'Failed to launch file.' },
      }
    } catch (err: unknown) {
      return {
        status: 'native-failure',
        itemId: validId,
        error: this.formatError(err, 'LAUNCH_FAILED'),
      }
    }
  }

  /**
   * Opens a directory container in the system file explorer.
   *
   * @param itemId - Shell item identifier of the target folder.
   * @returns Typed OpenFolderResult indicating launch outcome or error.
   */
  async openFolder(itemId: ShellItemId): Promise<OpenFolderResult> {
    const validId = validateShellItemId(itemId)
    const item = await this.resolveItem(validId)

    if (!item) {
      return {
        status: 'not-found',
        itemId: validId,
        error: { code: 'NOT_FOUND', message: `Folder with ID "${validId}" not found.` },
      }
    }

    if (item.kind !== 'folder' && !item.attributes.directory) {
      return {
        status: 'invalid-request',
        itemId: validId,
        error: { code: 'ITEM_NOT_FOLDER', message: 'Target is not a folder container.' },
      }
    }

    try {
      const res = await this.launcher.launchWin32({
        kind: 'win32',
        executablePath: 'explorer.exe',
        arguments: [item.location.path],
      })
      if (res.success) {
        return { status: 'success', itemId: validId, pid: res.pid }
      }
      return {
        status: 'native-failure',
        itemId: validId,
        error: { code: 'LAUNCH_FAILED', message: res.error ?? 'Failed to open folder.' },
      }
    } catch (err: unknown) {
      return {
        status: 'native-failure',
        itemId: validId,
        error: this.formatError(err, 'LAUNCH_FAILED'),
      }
    }
  }

  /**
   * Activates a Windows shortcut (.lnk), resolving its effective target safely.
   *
   * @param itemId - Shell item identifier of the shortcut.
   * @returns Typed OpenShortcutResult indicating activation outcome or error.
   */
  async openShortcut(itemId: ShellItemId): Promise<OpenShortcutResult> {
    const validId = validateShellItemId(itemId)
    const item = await this.resolveItem(validId)

    if (!item) {
      return {
        status: 'not-found',
        itemId: validId,
        error: { code: 'NOT_FOUND', message: `Shortcut with ID "${validId}" not found.` },
      }
    }

    try {
      const target = await this.shortcutResolver.resolveEffectiveTarget(
        item.location.path,
        this.appRegistry,
      )

      if (target.isBroken) {
        return {
          status: 'not-found',
          itemId: validId,
          resolvedKind: target.kind,
          target: target.pathOrUri,
          error: { code: 'BROKEN_SHORTCUT', message: 'Shortcut target is missing or broken.' },
        }
      }

      switch (target.kind) {
        case 'app': {
          if (target.appId && this.appRegistry) {
            const appRes = await this.openApp(
              target.appId,
              target.arguments ? { additionalArgs: [...target.arguments] } : undefined,
            )
            return {
              status: appRes.status,
              itemId: validId,
              resolvedKind: 'app',
              target: target.pathOrUri,
              pid: appRes.pid,
              error: appRes.error,
            }
          }

          const res = await this.launcher.launchWin32({
            kind: 'win32',
            executablePath: target.pathOrUri,
            arguments: target.arguments ? [...target.arguments] : undefined,
            workingDirectory: target.workingDirectory,
          })
          return {
            status: res.success ? 'success' : 'native-failure',
            itemId: validId,
            resolvedKind: 'app',
            target: target.pathOrUri,
            pid: res.pid,
            error: res.error ? { code: 'LAUNCH_FAILED', message: res.error } : undefined,
          }
        }
        case 'folder':
        case 'file':
        case 'url': {
          const res = await this.launcher.launchWin32({
            kind: 'win32',
            executablePath: 'explorer.exe',
            arguments: [target.pathOrUri],
          })
          return {
            status: res.success ? 'success' : 'native-failure',
            itemId: validId,
            resolvedKind: target.kind,
            target: target.pathOrUri,
            pid: res.pid,
            error: res.error ? { code: 'LAUNCH_FAILED', message: res.error } : undefined,
          }
        }
        default:
          return {
            status: 'unsupported',
            itemId: validId,
            resolvedKind: 'unsupported',
            target: target.pathOrUri,
            error: { code: 'UNSUPPORTED_TARGET', message: `Target "${target.pathOrUri}" is not supported.` },
          }
      }
    } catch (err: unknown) {
      const code = err instanceof InvalidInputError ? err.code : 'LAUNCH_FAILED'
      const status: IntentStatus = code === 'CONFLICT' ? 'conflict' : 'native-failure'
      return {
        status,
        itemId: validId,
        error: this.formatError(err, code),
      }
    }
  }

  /**
   * Highlights or selects a file or folder in the system file explorer.
   *
   * @param itemId - Shell item identifier of the target item to reveal.
   * @returns Typed RevealInFolderResult indicating execution outcome or error.
   */
  async revealInFolder(itemId: ShellItemId): Promise<RevealInFolderResult> {
    const validId = validateShellItemId(itemId)
    const item = await this.resolveItem(validId)

    if (!item) {
      return {
        status: 'not-found',
        itemId: validId,
        error: { code: 'NOT_FOUND', message: `Item with ID "${validId}" not found.` },
      }
    }

    try {
      const res = await this.launcher.launchWin32({
        kind: 'win32',
        executablePath: 'explorer.exe',
        arguments: [`/select,${item.location.path}`],
      })
      return {
        status: res.success ? 'success' : 'native-failure',
        itemId: validId,
        pid: res.pid,
        error: res.error ? { code: 'LAUNCH_FAILED', message: res.error } : undefined,
      }
    } catch (err: unknown) {
      return {
        status: 'native-failure',
        itemId: validId,
        error: this.formatError(err, 'LAUNCH_FAILED'),
      }
    }
  }

  /**
   * Renames a file, folder, or shortcut within its current container.
   *
   * @param itemId - Shell item identifier of the item to rename.
   * @param newName - Validated replacement name including extension.
   * @returns Typed RenameResult indicating mutation outcome or error.
   */
  async rename(itemId: ShellItemId, newName: string): Promise<RenameResult> {
    const validId = validateShellItemId(itemId)
    const validName = validateItemName(newName, 'newName')
    const item = await this.resolveItem(validId)

    if (!item) {
      return {
        status: 'not-found',
        itemId: validId,
        error: { code: 'NOT_FOUND', message: `Item with ID "${validId}" not found.` },
      }
    }

    try {
      const newPath = await this.fileOps.rename(item.location.path, validName)
      let updatedItem: ShellItem | undefined

      if (this.shellNamespace) {
        updatedItem = await this.shellNamespace.resolve(newPath)
      }

      return {
        status: 'success',
        itemId: validId,
        previousName: item.displayName,
        newName: validName,
        item: updatedItem ?? {
          ...item,
          displayName: validName,
          location: { path: newPath, uri: `file:///${newPath.replace(/\\/g, '/')}` },
        },
      }
    } catch (err: unknown) {
      const code = err instanceof InvalidInputError ? err.code : 'NATIVE_FAILURE'
      let status: IntentStatus = 'native-failure'
      if (code === 'CONFLICT') status = 'conflict'
      else if (code === 'NOT_FOUND') status = 'not-found'
      else if (code === 'INVALID_NAME' || code === 'INVALID_NAME_CHARACTERS' || code === 'RESERVED_DEVICE_NAME') {
        status = 'invalid-request'
      }

      return {
        status,
        itemId: validId,
        previousName: item.displayName,
        newName: validName,
        error: this.formatError(err, code),
      }
    }
  }

  /**
   * Deletes items from disk.
   *
   * @param itemIds - Shell item identifiers to delete.
   * @param permanent - Flag indicating whether permanent deletion is requested.
   * @returns Typed DeleteResult indicating deletion outcome or error.
   */
  async delete(itemIds: readonly ShellItemId[], permanent?: boolean): Promise<DeleteResult> {
    const validIds = Array.from(new Set(itemIds.map(id => validateShellItemId(id))))

    if (!permanent) {
      return {
        status: 'unsupported',
        itemIds: validIds,
        error: {
          code: 'RECYCLE_BIN_UNSUPPORTED',
          message: 'Recycle Bin deletion is not supported by the current provider. To delete permanently, specify permanent: true.',
        },
      }
    }

    const paths: string[] = []
    for (const id of validIds) {
      const item = await this.resolveItem(id)
      if (!item) {
        return {
          status: 'not-found',
          itemIds: validIds,
          error: { code: 'NOT_FOUND', message: `Item with ID "${id}" does not exist.` },
        }
      }
      paths.push(item.location.path)
    }

    try {
      await this.fileOps.delete(paths, true)
      return {
        status: 'success',
        itemIds: validIds,
        deletedIds: validIds,
        mode: 'permanent',
      }
    } catch (err: unknown) {
      if (err instanceof PartialDeletionError) {
        const deletedIds = validIds.filter((_, idx) => {
          const p = paths[idx]
          return p !== undefined && err.deletedPaths.includes(p)
        })
        const code = err.code
        let status: IntentStatus = 'permission-denied'
        if (code === 'NOT_FOUND') status = 'not-found'
        else if (code === 'PERMISSION_DENIED') status = 'permission-denied'
        else if (
          code === 'PATH_NOT_ABSOLUTE' ||
          code === 'PATH_TRAVERSAL' ||
          code === 'ROOT_DRIVE_OPERATION_FORBIDDEN' ||
          code === 'INVALID_PATH'
        ) {
          status = 'invalid-request'
        } else {
          status = 'native-failure'
        }
        return {
          status,
          itemIds: validIds,
          deletedIds: deletedIds.length > 0 ? deletedIds : undefined,
          mode: 'permanent',
          error: this.formatError(err, err.code),
        }
      }
      const code = err instanceof InvalidInputError ? err.code : 'PERMISSION_DENIED'
      let status: IntentStatus = 'permission-denied'
      if (code === 'NOT_FOUND') status = 'not-found'
      else if (code === 'PERMISSION_DENIED') status = 'permission-denied'
      else if (
        code === 'PATH_NOT_ABSOLUTE' ||
        code === 'PATH_TRAVERSAL' ||
        code === 'ROOT_DRIVE_OPERATION_FORBIDDEN' ||
        code === 'INVALID_PATH'
      ) {
        status = 'invalid-request'
      } else {
        status = 'native-failure'
      }
      return {
        status,
        itemIds: validIds,
        error: this.formatError(err, code),
      }
    }
  }

  /**
   * Moves one or more items to a destination directory container.
   *
   * @param itemIds - Shell item identifiers to move.
   * @param destinationId - Shell item identifier of the destination folder.
   * @returns Typed MoveResult containing per-item outcomes.
   */
  async move(itemIds: readonly ShellItemId[], destinationId: ShellItemId): Promise<MoveResult> {
    const validIds = Array.from(new Set(itemIds.map(id => validateShellItemId(id))))
    const validDestId = validateShellItemId(destinationId)

    const destContainer = await this.resolveItem(validDestId)
    if (!destContainer) {
      return {
        status: 'not-found',
        destinationId: validDestId,
        items: [],
        error: { code: 'NOT_FOUND', message: `Destination container "${validDestId}" not found.` },
      }
    }

    if (destContainer.kind !== 'folder' && !destContainer.attributes.directory) {
      return {
        status: 'invalid-request',
        destinationId: validDestId,
        items: [],
        error: { code: 'INVALID_REQUEST', message: 'Destination must be a folder container.' },
      }
    }

    const itemsResults = []
    const sourceMap = new Map<string, ShellItemId[]>()

    for (const srcId of validIds) {
      const srcItem = await this.resolveItem(srcId)
      if (!srcItem) {
        itemsResults.push({
          sourceId: srcId,
          status: 'not-found' as IntentStatus,
          error: { code: 'NOT_FOUND', message: `Source item "${srcId}" not found.` },
        })
      } else {
        const existing = sourceMap.get(srcItem.location.path)
        if (existing) {
          existing.push(srcId)
        } else {
          sourceMap.set(srcItem.location.path, [srcId])
        }
      }
    }

    const pathsToMove = Array.from(sourceMap.keys())
    const outcomes = await this.fileOps.move(pathsToMove, destContainer.location.path)

    for (const [srcPath, outcome] of outcomes.entries()) {
      const srcIds = sourceMap.get(srcPath) ?? [makeShellItemId('unknown')]
      for (const srcId of srcIds) {
        if (outcome.success && outcome.value) {
          let destItem: ShellItem | undefined
          if (this.shellNamespace) {
            destItem = await this.shellNamespace.resolve(outcome.value)
          }
          itemsResults.push({
            sourceId: srcId,
            status: 'success' as IntentStatus,
            destinationItem: destItem,
          })
        } else {
          const code = outcome.code ?? 'NATIVE_FAILURE'
          let status: IntentStatus = 'native-failure'
          if (code === 'CONFLICT') status = 'conflict'
          else if (code === 'NOT_FOUND') status = 'not-found'
          else if (code === 'PERMISSION_DENIED') status = 'permission-denied'
          else if (
            code === 'ILLEGAL_RECURSIVE_OPERATION' ||
            code === 'PATH_NOT_ABSOLUTE' ||
            code === 'PATH_TRAVERSAL' ||
            code === 'ROOT_DRIVE_OPERATION_FORBIDDEN' ||
            code === 'INVALID_PATH'
          ) {
            status = 'invalid-request'
          }

          itemsResults.push({
            sourceId: srcId,
            status,
            error: { code, message: outcome.error ?? 'Move failed.' },
          })
        }
      }
    }

    const allSucceeded = itemsResults.every(r => r.status === 'success')
    const anyConflict = itemsResults.some(r => r.status === 'conflict')
    const anyInvalid = itemsResults.some(r => r.status === 'invalid-request')
    const anyPermission = itemsResults.some(r => r.status === 'permission-denied')
    const anyNotFound = itemsResults.some(r => r.status === 'not-found')

    const status: IntentStatus = allSucceeded
      ? 'success'
      : anyInvalid
        ? 'invalid-request'
        : anyConflict
          ? 'conflict'
          : anyPermission
            ? 'permission-denied'
            : anyNotFound
              ? 'not-found'
              : 'native-failure'

    return {
      status,
      destinationId: validDestId,
      items: itemsResults,
    }
  }

  /**
   * Copies one or more items to a destination directory container.
   *
   * @param itemIds - Shell item identifiers to copy.
   * @param destinationId - Shell item identifier of the destination folder.
   * @returns Typed CopyResult containing per-item outcomes.
   */
  async copy(itemIds: readonly ShellItemId[], destinationId: ShellItemId): Promise<CopyResult> {
    const validIds = Array.from(new Set(itemIds.map(id => validateShellItemId(id))))
    const validDestId = validateShellItemId(destinationId)

    const destContainer = await this.resolveItem(validDestId)
    if (!destContainer) {
      return {
        status: 'not-found',
        destinationId: validDestId,
        items: [],
        error: { code: 'NOT_FOUND', message: `Destination container "${validDestId}" not found.` },
      }
    }

    if (destContainer.kind !== 'folder' && !destContainer.attributes.directory) {
      return {
        status: 'invalid-request',
        destinationId: validDestId,
        items: [],
        error: { code: 'INVALID_REQUEST', message: 'Destination must be a folder container.' },
      }
    }

    const itemsResults = []
    const sourceMap = new Map<string, ShellItemId[]>()

    for (const srcId of validIds) {
      const srcItem = await this.resolveItem(srcId)
      if (!srcItem) {
        itemsResults.push({
          sourceId: srcId,
          status: 'not-found' as IntentStatus,
          error: { code: 'NOT_FOUND', message: `Source item "${srcId}" not found.` },
        })
      } else {
        const existing = sourceMap.get(srcItem.location.path)
        if (existing) {
          existing.push(srcId)
        } else {
          sourceMap.set(srcItem.location.path, [srcId])
        }
      }
    }

    const pathsToCopy = Array.from(sourceMap.keys())
    const outcomes = await this.fileOps.copy(pathsToCopy, destContainer.location.path)

    for (const [srcPath, outcome] of outcomes.entries()) {
      const srcIds = sourceMap.get(srcPath) ?? [makeShellItemId('unknown')]
      for (const srcId of srcIds) {
        if (outcome.success && outcome.value) {
          let destItem: ShellItem | undefined
          if (this.shellNamespace) {
            destItem = await this.shellNamespace.resolve(outcome.value)
          }
          itemsResults.push({
            sourceId: srcId,
            status: 'success' as IntentStatus,
            destinationItem: destItem,
          })
        } else {
          const code = outcome.code ?? 'NATIVE_FAILURE'
          let status: IntentStatus = 'native-failure'
          if (code === 'CONFLICT') status = 'conflict'
          else if (code === 'NOT_FOUND') status = 'not-found'
          else if (code === 'PERMISSION_DENIED') status = 'permission-denied'
          else if (
            code === 'ILLEGAL_RECURSIVE_OPERATION' ||
            code === 'PATH_NOT_ABSOLUTE' ||
            code === 'PATH_TRAVERSAL' ||
            code === 'ROOT_DRIVE_OPERATION_FORBIDDEN' ||
            code === 'INVALID_PATH'
          ) {
            status = 'invalid-request'
          }

          itemsResults.push({
            sourceId: srcId,
            status,
            error: { code, message: outcome.error ?? 'Copy failed.' },
          })
        }
      }
    }

    const allSucceeded = itemsResults.every(r => r.status === 'success')
    const anyConflict = itemsResults.some(r => r.status === 'conflict')
    const anyInvalid = itemsResults.some(r => r.status === 'invalid-request')
    const anyPermission = itemsResults.some(r => r.status === 'permission-denied')
    const anyNotFound = itemsResults.some(r => r.status === 'not-found')

    const status: IntentStatus = allSucceeded
      ? 'success'
      : anyInvalid
        ? 'invalid-request'
        : anyConflict
          ? 'conflict'
          : anyPermission
            ? 'permission-denied'
            : anyNotFound
              ? 'not-found'
              : 'native-failure'

    return {
      status,
      destinationId: validDestId,
      items: itemsResults,
    }
  }

  /**
   * Creates a new directory inside an existing container.
   *
   * @param destinationId - Shell item identifier of the parent container.
   * @param name - Name of the new directory to create.
   * @returns Typed CreateFolderResult indicating creation outcome or error.
   */
  async createFolder(destinationId: ShellItemId, name: string): Promise<CreateFolderResult> {
    let validDestId: ShellItemId = typeof destinationId === 'string' ? destinationId : makeShellItemId('unknown')
    let validName = typeof name === 'string' ? name : ''

    try {
      validDestId = validateShellItemId(destinationId)
      validName = validateItemName(name, 'name')

      const destContainer = await this.resolveItem(validDestId)
      if (!destContainer) {
        return {
          status: 'not-found',
          destinationId: validDestId,
          name: validName,
          error: { code: 'NOT_FOUND', message: `Destination container "${validDestId}" not found.` },
        }
      }

      if (destContainer.kind !== 'folder' && !destContainer.attributes.directory) {
        return {
          status: 'invalid-request',
          destinationId: validDestId,
          name: validName,
          error: { code: 'INVALID_REQUEST', message: 'Destination must be a folder container.' },
        }
      }

      const newFolderPath = await this.fileOps.createFolder(destContainer.location.path, validName)
      let newFolderItem: ShellItem | undefined

      if (this.shellNamespace) {
        newFolderItem = await this.shellNamespace.resolve(newFolderPath)
      }

      return {
        status: 'success',
        destinationId: validDestId,
        name: validName,
        item: newFolderItem,
      }
    } catch (err: unknown) {
      const code = err instanceof InvalidInputError ? err.code : 'NATIVE_FAILURE'
      let status: IntentStatus = 'native-failure'
      if (code === 'CONFLICT') status = 'conflict'
      else if (code === 'NOT_FOUND') status = 'not-found'
      else if (code === 'PERMISSION_DENIED') status = 'permission-denied'
      else if (
        code === 'INVALID_NAME' ||
        code === 'INVALID_NAME_CHARACTERS' ||
        code === 'RESERVED_DEVICE_NAME' ||
        code === 'PATH_NOT_ABSOLUTE' ||
        code === 'PATH_TRAVERSAL' ||
        code === 'ROOT_DRIVE_OPERATION_FORBIDDEN' ||
        code === 'INVALID_PATH' ||
        code === 'INVALID_ITEM_ID'
      ) {
        status = 'invalid-request'
      }
      return {
        status,
        destinationId: validDestId,
        name: validName,
        error: this.formatError(err, code),
      }
    }
  }

  /**
   * Resolves effective target metadata for a shell item.
   *
   * @param itemId - Shell item identifier to inspect.
   * @returns Typed ResolveTargetResult containing resolved target metadata.
   */
  async resolveTarget(itemId: ShellItemId): Promise<ResolveTargetResult> {
    const validId = validateShellItemId(itemId)
    const item = await this.resolveItem(validId)

    if (!item) {
      return {
        status: 'not-found',
        itemId: validId,
        error: { code: 'NOT_FOUND', message: `Item "${validId}" not found.` },
      }
    }

    if (item.kind === 'shortcut') {
      try {
        const target = await this.shortcutResolver.resolveEffectiveTarget(
          item.location.path,
          this.appRegistry,
        )
        return {
          status: 'success',
          itemId: validId,
          target,
        }
      } catch (err: unknown) {
        const code = err instanceof InvalidInputError ? err.code : 'RESOLUTION_FAILED'
        const status: IntentStatus = code === 'CONFLICT' ? 'conflict' : 'native-failure'
        return {
          status,
          itemId: validId,
          error: this.formatError(err, code),
        }
      }
    }

    if (item.kind === 'folder' || item.attributes.directory) {
      return {
        status: 'success',
        itemId: validId,
        target: {
          kind: 'folder',
          pathOrUri: item.location.path,
          shellItemId: item.id,
        },
      }
    }

    return {
      status: 'success',
      itemId: validId,
      target: {
        kind: 'file',
        pathOrUri: item.location.path,
        shellItemId: item.id,
      },
    }
  }

  /**
   * Queries permissible user actions for a given shell item.
   *
   * @param itemId - Shell item identifier to inspect.
   * @returns Typed GetAvailableActionsResult containing the list of available actions.
   */
  async getAvailableActions(itemId: ShellItemId): Promise<GetAvailableActionsResult> {
    const validId = validateShellItemId(itemId)
    const item = await this.resolveItem(validId)

    if (!item) {
      return {
        status: 'not-found',
        itemId: validId,
        actions: [],
        error: { code: 'NOT_FOUND', message: `Item "${validId}" not found.` },
      }
    }

    const actions: AvailableAction[] = ['open', 'reveal-in-folder', 'copy']

    if (!item.attributes.readOnly) {
      actions.push('rename', 'move', 'delete')
    }

    if (item.kind === 'folder' || item.attributes.directory) {
      actions.push('create-folder')
    }

    if (item.kind === 'shortcut') {
      actions.push('resolve-target')
    }

    return {
      status: 'success',
      itemId: validId,
      actions,
    }
  }

  /**
   * Routes a high-level Home desktop item activation intent.
   *
   * @param homeItem - Desktop item emitting activation.
   * @returns Dispatched intent outcome.
   */
  async routeHomeActivation(homeItem: HomeActivationItem): Promise<ShellIntentResult> {
    const meta = homeItem.metadata ?? {}
    let cleanId = typeof meta.shellItemId === 'string' ? meta.shellItemId : homeItem.id
    if (cleanId.startsWith('desktop:')) {
      cleanId = cleanId.slice(8)
    }

    // If item has a physical path in metadata but no shellItemId (e.g. from Phase 8 Home state),
    // authoritative Intent Router resolves it into an authoritative ShellItemId
    if (!meta.shellItemId && typeof meta.path === 'string') {
      const resolved = await this.shellNamespace?.resolve(meta.path)
      if (resolved) {
        cleanId = resolved.id
      }
    }

    const appIdMeta = typeof meta.appId === 'string' ? meta.appId : undefined
    if (homeItem.type === 'app shortcut' || appIdMeta) {
      const appId = appIdMeta ?? cleanId
      return this.dispatch({
        type: 'open-app',
        appId: makeAppId(appId),
      })
    }

    if (homeItem.type === 'folder') {
      // If it has a physical path or shellItemId, open as folder
      if (meta.path || meta.shellItemId) {
        return this.dispatch({
          type: 'open-folder',
          itemId: makeShellItemId(cleanId),
        })
      }
      // Pure Home container folder: handled by Home overlay
      return {
        status: 'success',
        itemId: makeShellItemId(cleanId),
      }
    }

    if (homeItem.type === 'shortcut') {
      return this.dispatch({
        type: 'open-shortcut',
        itemId: makeShellItemId(cleanId),
      })
    }

    if (homeItem.type === 'system' || homeItem.type === 'system shortcut') {
      const targetAction = typeof meta.targetAction === 'string' ? meta.targetAction.toLowerCase() : ''
      if (targetAction === 'recycle-bin') {
        const res = await this.launcher.launchWin32({
          kind: 'win32',
          executablePath: 'explorer.exe',
          arguments: ['shell:::{645FF040-5081-101B-9F08-00AA002F954E}'],
        })
        return {
          status: res.success ? 'success' : 'native-failure',
          itemId: makeShellItemId(cleanId),
          pid: res.pid,
        }
      }
      if (targetAction === 'this-pc') {
        const res = await this.launcher.launchWin32({
          kind: 'win32',
          executablePath: 'explorer.exe',
          arguments: ['shell:::{20D04FE0-3AEA-1069-A2D8-08002B30309D}'],
        })
        return {
          status: res.success ? 'success' : 'native-failure',
          itemId: makeShellItemId(cleanId),
          pid: res.pid,
        }
      }
      if (targetAction === 'settings') {
        const res = await this.launcher.launchWin32({
          kind: 'win32',
          executablePath: 'explorer.exe',
          arguments: ['ms-settings:'],
        })
        return {
          status: res.success ? 'success' : 'native-failure',
          appId: makeAppId('windows.ms-settings'),
          pid: res.pid,
        }
      }
    }

    // Default: treat as regular file
    return this.dispatch({
      type: 'open-file',
      itemId: makeShellItemId(cleanId),
    })
  }

  /**
   * Resolves a ShellItem by ShellItemId.
   */
  private async resolveItem(itemId: ShellItemId): Promise<ShellItem | undefined> {
    if (!this.shellNamespace) return undefined

    // Strip "desktop:" prefix if present
    const cleanId = itemId.startsWith('desktop:')
      ? makeShellItemId(itemId.slice(8))
      : itemId

    const cached = this.shellNamespace.get(cleanId)
    if (cached) {
      return cached
    }

    // Attempt resolving availability
    const res = await this.shellNamespace.resolveItem(cleanId)
    if (res.status === 'available') {
      return res.item
    }

    return undefined
  }

  private formatError(err: unknown, defaultCode: string): IntentError {
    if (err instanceof InvalidInputError) {
      return {
        code: err.code,
        message: err.message,
      }
    }
    return {
      code: defaultCode,
      message: err instanceof Error ? err.message : String(err),
      cause: err,
    }
  }

  /** Disposes engine resources. */
  dispose(): void {
    if (this.isDisposed) return
    this.isDisposed = true
    this.listeners.clear()
  }
}
