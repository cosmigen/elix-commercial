/**
 * @deepseek-ai/dsh-intent-router — ELIX OS Intent Router and File Operations Plugin.
 *
 * Implements an authoritative action coordination and intent routing service over Cordis.
 * Dispatches high-level user intents (OpenApp, OpenFile, OpenFolder, OpenShortcut,
 * RevealInFolder, Rename, Delete, Move, Copy, CreateFolder, ResolveTarget, GetAvailableActions)
 * to App Registry, Shell Namespace, Native Core, and File Operations.
 *
 * CRITICAL BOUNDARIES:
 * - Intent Router owns: interpretation, validation, routing, target resolution, action coordination, and typed results.
 * - Intent Router does NOT own: app discovery, filesystem enumeration, native process mechanics, HWNDs, or Home layout.
 * - Existing capability owners remain authoritative.
 *
 * @module @deepseek-ai/dsh-intent-router
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { AppId, AppLaunchOptions } from '@deepseek-ai/dsh-app-registry'
import type { ShellItemId } from '@deepseek-ai/dsh-shell-namespace'
import type {
  DesktopProjectorHomeHost,
  DesktopProjectorOptions,
  ProjectedHomeItem,
} from './desktop-projector.ts'
import { DesktopProjector } from './desktop-projector.ts'
import { IntentRouterEngine } from './engine.ts'
import type {
  CopyResult,
  CreateFolderResult,
  DeleteResult,
  GetAvailableActionsResult,
  HomeActivationItem,
  IntentRouterConfig,
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

export * from './types.ts'
export * from './validation.ts'
export * from './operations.ts'
export * from './shortcuts.ts'
export * from './desktop-projector.ts'
export * from './engine.ts'
export { makeAppId } from '@deepseek-ai/dsh-app-registry'
export { makeShellItemId } from '@deepseek-ai/dsh-shell-namespace'

declare module '@deepseek-ai/cordis' {
  interface Context {
    intentRouter: IntentRouterService
  }
  interface Events {
    /** Emitted when Intent Router finishes initialization and is ready. */
    'intent-router/ready'(service: IntentRouterService): void
    /** Emitted when a typed shell intent is dispatched. */
    'intent-router/intent-dispatched'(intent: ShellIntent): void
    /** Emitted when a typed shell intent completes successfully. */
    'intent-router/intent-completed'(intent: ShellIntent, result: ShellIntentResult): void
    /** Emitted when a typed shell intent fails. */
    'intent-router/intent-failed'(intent: ShellIntent, result: ShellIntentResult): void
    /** Emitted when a Home screen item activation is requested. */
    'home/item-activate-requested'?(item: HomeActivationItem): void
    /** Emitted when Home service is ready. */
    'home/ready'?(service?: unknown): void
  }
}

/** Configuration options for IntentRouterService. */
export interface Config extends IntentRouterConfig {
  /** Custom process launcher override for testing. */
  processLauncher?: ProcessLauncher | undefined
}

/**
 * The ELIX OS Intent Router Service.
 */
export class IntentRouterService extends Service {
  static Config = z.object({
    enabled: z.boolean().default(true),
    projectDesktopOnStartup: z.boolean().default(false),
    preferNative: z.boolean().default(true),
  })

  /** The underlying authoritative Intent Router engine instance. */
  readonly engine: IntentRouterEngine

  /** Desktop projection coordinator synchronizing Windows Desktop with Home Screen. */
  readonly desktopProjector: DesktopProjector
  private readonly config: Config
  private isInitialized = false

  constructor(ctx: Context, config?: Partial<Config>) {
    super(ctx, 'intentRouter')

    this.config = {
      enabled: config?.enabled ?? true,
      projectDesktopOnStartup: config?.projectDesktopOnStartup ?? false,
      preferNative: config?.preferNative ?? true,
      processLauncher: config?.processLauncher,
    }

    this.desktopProjector = new DesktopProjector()

    this.engine = new IntentRouterEngine({
      appRegistry: () => this.ctx.get('appRegistry'),
      shellNamespace: () => this.ctx.get('shellNamespace'),
      processLauncher: this.config.processLauncher,
      preferNative: this.config.preferNative,
    })
  }

  [Service.init](): void {
    if (!this.config.enabled) return

    // 1. Forward engine events to Cordis context
    const unbindDispatched = this.engine.on('intent-dispatched', (intent) => {
      this.ctx.emit('intent-router/intent-dispatched', intent)
    })
    const unbindCompleted = this.engine.on('intent-completed', (intent, result) => {
      this.ctx.emit('intent-router/intent-completed', intent, result)
    })
    const unbindFailed = this.engine.on('intent-failed', (intent, result) => {
      this.ctx.emit('intent-router/intent-failed', intent, result)
    })

    // 2. Wire Home desktop activation requests into Intent Router
    const unbindActivation = this.ctx.on('home/item-activate-requested', (item: HomeActivationItem) => {
      void this.engine.routeHomeActivation(item).catch((err: unknown) => {
        this.ctx.logger('intent-router').error('Error handling home item activation: %o', err)
      })
    })

    // 3. Desktop projection and reconciliation if enabled
    let unbindProjector: (() => void) | undefined
    const startDesktopProjection = () => {
      const home = this.ctx.get('home') as DesktopProjectorHomeHost | undefined
      const shellNamespace = this.ctx.get('shellNamespace')
      if (home && shellNamespace && !unbindProjector) {
        unbindProjector = this.desktopProjector.bindChangeObservation(home, shellNamespace)
        void this.desktopProjector.projectDesktop(home, shellNamespace).catch((err: unknown) => {
          this.ctx.logger('intent-router').warn('Initial desktop projection encountered error: %o', err)
        })
      }
    }

    if (this.config.projectDesktopOnStartup) {
      startDesktopProjection()
      this.ctx.on('home/ready', () => {
        startDesktopProjection()
      })
      this.ctx.on('shell-namespace/ready', () => {
        startDesktopProjection()
      })
    }

    // 4. Register Cordis lifecycle disposal effect
    this.ctx.effect(() => () => {
      unbindDispatched()
      unbindCompleted()
      unbindFailed()
      unbindActivation()
      unbindProjector?.()
      this.engine.dispose()
      this.isInitialized = false
    }, 'intentRouter.lifecycle')

    this.isInitialized = true
    this.ctx.emit('intent-router/ready', this)
  }

  /** Whether the Intent Router service is initialized and ready. */
  get ready(): boolean {
    return this.isInitialized
  }

  /**
   * Dispatches a typed shell intent.
   *
   * @param intent - The shell intent to dispatch.
   * @returns Typed ShellIntentResult.
   */
  async dispatch(intent: ShellIntent): Promise<ShellIntentResult> {
    return this.engine.dispatch(intent)
  }

  /**
   * Activates an application by AppId.
   *
   * @param appId - Target application identifier.
   * @param options - Optional launch arguments and display options.
   * @returns Typed OpenAppResult indicating launch outcome or error.
   */
  async openApp(appId: AppId, options?: AppLaunchOptions): Promise<OpenAppResult> {
    return this.engine.openApp(appId, options)
  }

  /**
   * Opens a file with its registered system handler.
   *
   * @param itemId - Shell item identifier of the target file.
   * @returns Typed OpenFileResult indicating launch outcome or error.
   */
  async openFile(itemId: ShellItemId): Promise<OpenFileResult> {
    return this.engine.openFile(itemId)
  }

  /**
   * Opens a folder in the system file explorer.
   *
   * @param itemId - Shell item identifier of the target folder.
   * @returns Typed OpenFolderResult indicating launch outcome or error.
   */
  async openFolder(itemId: ShellItemId): Promise<OpenFolderResult> {
    return this.engine.openFolder(itemId)
  }

  /**
   * Activates a shortcut, resolving its effective target.
   *
   * @param itemId - Shell item identifier of the shortcut.
   * @returns Typed OpenShortcutResult indicating activation outcome or error.
   */
  async openShortcut(itemId: ShellItemId): Promise<OpenShortcutResult> {
    return this.engine.openShortcut(itemId)
  }

  /**
   * Opens the containing folder and reveals the target item.
   *
   * @param itemId - Shell item identifier of the target item to reveal.
   * @returns Typed RevealInFolderResult indicating execution outcome or error.
   */
  async revealInFolder(itemId: ShellItemId): Promise<RevealInFolderResult> {
    return this.engine.revealInFolder(itemId)
  }

  /**
   * Renames a file or folder.
   *
   * @param itemId - Shell item identifier of the item to rename.
   * @param newName - Validated replacement name including extension.
   * @returns Typed RenameResult indicating mutation outcome or error.
   */
  async rename(itemId: ShellItemId, newName: string): Promise<RenameResult> {
    return this.engine.rename(itemId, newName)
  }

  /**
   * Deletes one or more items.
   *
   * @param itemIds - Shell item identifiers to delete.
   * @param permanent - Flag indicating whether permanent deletion is requested.
   * @returns Typed DeleteResult indicating deletion outcome or error.
   */
  async delete(itemIds: readonly ShellItemId[], permanent?: boolean): Promise<DeleteResult> {
    return this.engine.delete(itemIds, permanent)
  }

  /**
   * Moves items to a destination container.
   *
   * @param itemIds - Shell item identifiers to move.
   * @param destinationId - Shell item identifier of the destination folder.
   * @returns Typed MoveResult containing per-item outcomes.
   */
  async move(itemIds: readonly ShellItemId[], destinationId: ShellItemId): Promise<MoveResult> {
    return this.engine.move(itemIds, destinationId)
  }

  /**
   * Copies items to a destination container.
   *
   * @param itemIds - Shell item identifiers to copy.
   * @param destinationId - Shell item identifier of the destination folder.
   * @returns Typed CopyResult containing per-item outcomes.
   */
  async copy(itemIds: readonly ShellItemId[], destinationId: ShellItemId): Promise<CopyResult> {
    return this.engine.copy(itemIds, destinationId)
  }

  /**
   * Creates a new folder.
   *
   * @param destinationId - Shell item identifier of the parent container.
   * @param name - Name of the new directory to create.
   * @returns Typed CreateFolderResult indicating creation outcome or error.
   */
  async createFolder(destinationId: ShellItemId, name: string): Promise<CreateFolderResult> {
    return this.engine.createFolder(destinationId, name)
  }

  /**
   * Resolves effective target metadata for a shell item.
   *
   * @param itemId - Shell item identifier to inspect.
   * @returns Typed ResolveTargetResult containing resolved target metadata.
   */
  async resolveTarget(itemId: ShellItemId): Promise<ResolveTargetResult> {
    return this.engine.resolveTarget(itemId)
  }

  /**
   * Queries available actions on an item.
   *
   * @param itemId - Shell item identifier to inspect.
   * @returns Typed GetAvailableActionsResult containing the list of available actions.
   */
  async getAvailableActions(itemId: ShellItemId): Promise<GetAvailableActionsResult> {
    return this.engine.getAvailableActions(itemId)
  }

  /**
   * Manually projects desktop items into Home Screen.
   *
   * @param options - Optional desktop projection configuration.
   * @returns List of projected home items.
   */
  async projectDesktop(options?: DesktopProjectorOptions): Promise<readonly ProjectedHomeItem[]> {
    const home = this.ctx.get('home') as DesktopProjectorHomeHost | undefined
    const shellNamespace = this.ctx.get('shellNamespace')
    if (!home || !shellNamespace) {
      throw new Error('projectDesktop requires both ctx.home and ctx.shellNamespace to be mounted.')
    }
    return this.desktopProjector.projectDesktop(home, shellNamespace, options)
  }
}

export default IntentRouterService
