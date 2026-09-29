/**
 * Filesystem change observation and event debouncing for ELIX Shell Namespace.
 *
 * Implements a contained watcher abstraction over Node `fs.watch`, with
 * event coalescing, debouncing, and clean lifecycle disposal.
 *
 * Phase 5 Rust Native Core will provide native ReadDirectoryChangesW behind
 * this same contract.
 *
 * @module @deepseek-ai/dsh-shell-namespace/watcher
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { NamespaceSubscription } from './types.ts'

/** Callback invoked when container contents change. */
export type ContainerChangeListener = (containerPath: string) => void | Promise<void>

/**
 * Adapter contract for observing directory filesystem changes.
 */
export interface NamespaceWatcher {
  /**
   * Starts watching a directory container for changes.
   *
   * @param containerPath - Absolute directory path to watch.
   * @param listener - Callback invoked on coalesced changes.
   * @returns Subscription handle for disposal.
   */
  watch(
    containerPath: string,
    listener: ContainerChangeListener,
  ): NamespaceSubscription

  /** Disposes all active watchers and releases system file handles. */
  dispose(): void
}

interface ActiveContainerWatch {
  watcher: fs.FSWatcher
  listeners: Set<ContainerChangeListener>
  debounceTimer: ReturnType<typeof setTimeout> | null
}

/**
 * Standard filesystem watcher using Node fs.watch with per-container debouncing.
 */
export class DefaultNamespaceWatcher implements NamespaceWatcher {
  private readonly debounceMs: number
  private readonly watches = new Map<string, ActiveContainerWatch>()
  private isDisposed = false

  constructor(options?: { debounceMs?: number }) {
    this.debounceMs = options?.debounceMs ?? 100
  }

  watch(
    containerPath: string,
    listener: ContainerChangeListener,
  ): NamespaceSubscription {
    if (this.isDisposed) {
      return { path: containerPath, dispose: () => {} }
    }

    const normPath = path.resolve(containerPath)
    let watchEntry = this.watches.get(normPath)

    if (!watchEntry) {
      try {
        const watcher = fs.watch(normPath, { persistent: false }, () => {
          this.triggerDebouncedChange(normPath)
        })

        watcher.on('error', () => {
          // On watcher error (e.g. watched directory deleted), trigger final notification and clean up
          this.triggerDebouncedChange(normPath)
        })

        watchEntry = {
          watcher,
          listeners: new Set([listener]),
          debounceTimer: null,
        }
        this.watches.set(normPath, watchEntry)
      } catch {
        // If fs.watch fails (e.g. invalid directory), return noop subscription
        return {
          path: normPath,
          dispose: () => {},
        }
      }
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

  private triggerDebouncedChange(containerPath: string): void {
    if (this.isDisposed) return
    const entry = this.watches.get(containerPath)
    if (!entry) return

    if (entry.debounceTimer !== null) {
      clearTimeout(entry.debounceTimer)
    }

    entry.debounceTimer = setTimeout(() => {
      entry.debounceTimer = null
      for (const listener of entry.listeners) {
        void Promise.resolve()
          .then(() => listener(containerPath))
          .catch(() => {})
      }
    }, this.debounceMs)
  }

  private unsubscribe(
    containerPath: string,
    listener: ContainerChangeListener,
  ): void {
    const entry = this.watches.get(containerPath)
    if (!entry) return

    entry.listeners.delete(listener)
    if (entry.listeners.size === 0) {
      if (entry.debounceTimer !== null) {
        clearTimeout(entry.debounceTimer)
      }
      try {
        entry.watcher.close()
      } catch {
        // Ignore close error on already disposed watcher
      }
      this.watches.delete(containerPath)
    }
  }

  dispose(): void {
    this.isDisposed = true
    for (const entry of this.watches.values()) {
      if (entry.debounceTimer !== null) {
        clearTimeout(entry.debounceTimer)
      }
      try {
        entry.watcher.close()
      } catch {
        // Ignore close errors
      }
    }
    this.watches.clear()
  }
}

/**
 * Mock namespace watcher for unit tests to programmatically fire events.
 */
export class MockNamespaceWatcher implements NamespaceWatcher {
  private readonly listeners = new Map<string, Set<ContainerChangeListener>>()

  watch(
    containerPath: string,
    listener: ContainerChangeListener,
  ): NamespaceSubscription {
    const norm = path.resolve(containerPath)
    let set = this.listeners.get(norm)
    if (!set) {
      set = new Set()
      this.listeners.set(norm, set)
    }
    set.add(listener)

    return {
      path: norm,
      dispose: () => {
        set.delete(listener)
        if (set.size === 0) {
          this.listeners.delete(norm)
        }
      },
    }
  }

  emitChange(containerPath: string): void {
    const norm = path.resolve(containerPath)
    const set = this.listeners.get(norm)
    if (set) {
      for (const fn of set) {
        void Promise.resolve(fn(norm)).catch(() => {})
      }
    }
  }

  dispose(): void {
    this.listeners.clear()
  }
}
