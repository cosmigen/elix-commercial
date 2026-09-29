/**
 * Desktop interaction and intent dispatch subsystem for ELIX Home Screen.
 * Emits user interaction intents (e.g. right-click context menus) while keeping
 * visual presentation decoupled and owned by future overlay/dialog plugins.
 *
 * @module @deepseek-ai/dsh-home/interaction
 */

import type { ContextMenuRequest } from './types.ts'
import type { HomeItem } from './items.ts'

/** Callback listener for context menu requests. */
export type ContextMenuRequestListener = (request: ContextMenuRequest) => void

/** Callback listener for item activation intents. */
export type ItemActivationRequestListener = (item: HomeItem) => void

/**
 * Coordinates user interaction intents on the Home desktop surface.
 */
export class HomeInteractionManager {
  private readonly contextMenuListeners = new Set<ContextMenuRequestListener>()
  private readonly activationListeners = new Set<ItemActivationRequestListener>()

  /**
   * Request opening a context menu at the specified coordinate.
   * Emits an intent for future context-menu / overlay surfaces to render.
   */
  requestContextMenu(request: ContextMenuRequest): void {
    for (const listener of this.contextMenuListeners) {
      try {
        listener(request)
      } catch (err) {
        console.error('Error in context menu request listener:', err)
      }
    }
  }

  /** Subscribe to context menu request intents. */
  onContextMenuRequest(listener: ContextMenuRequestListener): () => void {
    this.contextMenuListeners.add(listener)
    return () => {
      this.contextMenuListeners.delete(listener)
    }
  }

  /**
   * Publish an item activation intent without executing its target.
   * @param item - Desktop item to activate.
   */
  requestItemActivation(item: HomeItem): void {
    for (const listener of this.activationListeners) {
      try {
        listener(item)
      } catch (err) {
        console.error('Error in item activation request listener:', err)
      }
    }
  }

  /**
   * Subscribe to item activation intents.
   * @param listener - Callback receiving activated desktop items.
   * @returns Disposer function that unregisters the listener.
   */
  onItemActivationRequest(listener: ItemActivationRequestListener): () => void {
    this.activationListeners.add(listener)
    return () => {
      this.activationListeners.delete(listener)
    }
  }
}
