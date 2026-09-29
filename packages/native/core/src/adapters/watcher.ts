/**
 * Native Directory Change Watcher adapter backed by the Rust Native Core.
 *
 * Implements the NamespaceWatcher contract using native ReadDirectoryChangesW
 * over the typed bridge with debouncing and safe disposal.
 *
 * @module @deepseek-ai/dsh-native-core/adapters/watcher
 */

import * as path from 'node:path'
import type { NativeBridgeClient } from '../client.ts'

export interface NamespaceSubscription {
  readonly path: string
  dispose(): void
}

export type ContainerChangeListener = (containerPath: string) => void | Promise<void>

export interface NamespaceWatcher {
  watch(containerPath: string, listener: ContainerChangeListener): NamespaceSubscription
  dispose(): void
}

interface ActiveContainerWatch {
  readonly normPath: string
  readonly listeners: Set<ContainerChangeListener>
  watchPromise?: Promise<{ unwatch: () => Promise<boolean> }> | undefined
  unwatchHandle?: (() => Promise<boolean>) | undefined
  debounceTimer: ReturnType<typeof setTimeout> | null
  isDisposed: boolean
}

/**
 * Directory watcher delegating to the Rust Native Core.
 */
export class NativeNamespaceWatcherAdapter implements NamespaceWatcher {
  private readonly client: NativeBridgeClient
  private readonly debounceMs: number
  private readonly watches = new Map<string, ActiveContainerWatch>()
  private isDisposed = false

  constructor(client: NativeBridgeClient, options?: { debounceMs?: number }) {
    this.client = client
    this.debounceMs = options?.debounceMs ?? 100
  }

  watch(containerPath: string, listener: ContainerChangeListener): NamespaceSubscription {
    if (this.isDisposed) {
      return { path: containerPath, dispose: () => {} }
    }

    const normPath = path.resolve(containerPath)
    let watchEntry = this.watches.get(normPath)

    if (!watchEntry) {
      const watchPromise = this.client.watcher
        .watch(normPath, (ev) => {
          if (ev.changeType === 'container-invalidated' || ev.changeType === 'buffer-overflow') {
            void this.reconcileAndRearm(normPath, ev.subscriptionId)
          } else {
            this.triggerDebouncedChange(normPath)
          }
        })

      const entryRef: ActiveContainerWatch = {
        normPath,
        listeners: new Set([listener]),
        watchPromise,
        debounceTimer: null,
        isDisposed: false,
      }
      watchEntry = entryRef
      this.watches.set(normPath, watchEntry)

      watchPromise
        .then((res) => {
          entryRef.unwatchHandle = res.unwatch
          if (entryRef.isDisposed || this.isDisposed) {
            void res.unwatch().catch(() => {})
          }
        })
        .catch(() => {
          // Native watch failed or bridge disconnected; listeners remain intact
        })
    } else {
      watchEntry.listeners.add(listener)
    }

    return {
      path: normPath,
      dispose: () => {
        this.unsubscribe(normPath, listener)
      },
    }
  }

  private async reconcileAndRearm(normPath: string, subscriptionId: number): Promise<void> {
    const entry = this.watches.get(normPath)
    if (!entry) return

    if (entry.debounceTimer) {
      clearTimeout(entry.debounceTimer)
      entry.debounceTimer = null
    }

    const results = await Promise.allSettled(
      Array.from(entry.listeners, listener => Promise.resolve().then(() => listener(normPath))),
    )
    if (
      !entry.isDisposed &&
      !this.isDisposed &&
      results.every(result => result.status === 'fulfilled')
    ) {
      await this.client.watcher.rearm(subscriptionId).catch(() => false)
    }
  }

  private triggerDebouncedChange(normPath: string): void {
    const entry = this.watches.get(normPath)
    if (!entry) return

    if (entry.debounceTimer) {
      clearTimeout(entry.debounceTimer)
    }

    entry.debounceTimer = setTimeout(() => {
      entry.debounceTimer = null
      for (const listener of entry.listeners) {
        void Promise.resolve()
          .then(() => listener(normPath))
          .catch(() => {})
      }
    }, this.debounceMs)
  }

  private unsubscribe(normPath: string, listener: ContainerChangeListener): void {
    const entry = this.watches.get(normPath)
    if (!entry) return

    entry.listeners.delete(listener)
    if (entry.listeners.size === 0) {
      entry.isDisposed = true
      if (entry.debounceTimer) {
        clearTimeout(entry.debounceTimer)
        entry.debounceTimer = null
      }
      this.watches.delete(normPath)

      if (entry.unwatchHandle) {
        void entry.unwatchHandle().catch(() => {})
      } else if (entry.watchPromise) {
        entry.watchPromise
          .then(res => res.unwatch())
          .catch(() => {})
      }
    }
  }

  dispose(): void {
    if (this.isDisposed) return
    this.isDisposed = true

    for (const entry of this.watches.values()) {
      entry.isDisposed = true
      if (entry.debounceTimer) {
        clearTimeout(entry.debounceTimer)
        entry.debounceTimer = null
      }
      if (entry.unwatchHandle) {
        void entry.unwatchHandle().catch(() => {})
      } else if (entry.watchPromise) {
        entry.watchPromise
          .then(res => res.unwatch())
          .catch(() => {})
      }
    }
    this.watches.clear()
  }
}
