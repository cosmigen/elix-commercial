/**
 * Multi-monitor topology and display tracking for ELIX Home surfaces.
 *
 * @module @deepseek-ai/dsh-home/monitor
 */

import type { Rect } from './types.ts'

/** Home projection of an authoritative monitor or an explicit test fixture. */
export interface MonitorInfo {
  /** Stable/best-effort Windows Context monitor identifier. */
  readonly id: string
  /** Human-readable display name. */
  readonly name: string
  /** Full monitor resolution and virtual position bounds. */
  readonly bounds: Rect
  /** Usable work area bounds (excluding native taskbar if any). */
  readonly workArea: Rect
  /** Device pixel ratio / DPI scale factor (1.0 = 100%, 1.25 = 125%, 1.5 = 150%). */
  readonly scaleFactor: number
  /** Whether this display is designated as the primary Windows display. */
  readonly isPrimary: boolean
}

/** Monitor change event types. */
export type MonitorEventType = 'added' | 'removed' | 'changed'

/** Callback signature for monitor topology changes. */
export type MonitorChangeListener = (type: MonitorEventType, monitor: MonitorInfo) => void

/**
 * Registry and coordinator for physical displays.
 */
export class MonitorManager {
  private readonly monitors = new Map<string, MonitorInfo>()
  private readonly listeners = new Set<MonitorChangeListener>()

  constructor(initialMonitors?: readonly MonitorInfo[]) {
    if (initialMonitors !== undefined) {
      for (const m of initialMonitors) {
        this.monitors.set(m.id, { ...m })
      }
    }
  }

  /** Atomically replaces the projected topology before notifying Home consumers. */
  replaceTopology(nextMonitors: readonly MonitorInfo[]): void {
    if (nextMonitors.length === 0) {
      throw new Error('Home monitor projection requires at least one monitor.')
    }
    if (nextMonitors.filter(monitor => monitor.isPrimary).length !== 1) {
      throw new Error('Home monitor projection requires exactly one primary monitor.')
    }
    const previous = new Map(this.monitors)
    const replacement = new Map(nextMonitors.map(monitor => [monitor.id, { ...monitor }]))
    this.monitors.clear()
    for (const [id, monitor] of replacement) this.monitors.set(id, monitor)
    for (const [id, monitor] of previous) {
      if (!replacement.has(id)) this.notify('removed', monitor)
    }
    for (const [id, monitor] of replacement) {
      this.notify(previous.has(id) ? 'changed' : 'added', monitor)
    }
  }

  /** Retrieve all currently connected monitors. */
  getMonitors(): readonly MonitorInfo[] {
    return Array.from(this.monitors.values())
  }

  /** Get monitor by identifier. */
  getMonitor(id: string): MonitorInfo | undefined {
    return this.monitors.get(id)
  }

  /** Find the primary monitor, falling back to the first available display. */
  getPrimaryMonitor(): MonitorInfo {
    for (const monitor of this.monitors.values()) {
      if (monitor.isPrimary) return monitor
    }
    const first = this.monitors.values().next().value
    if (first !== undefined) return first
    throw new Error('No monitors configured in MonitorManager.')
  }

  /** Subscribe to display topology changes. */
  onChange(listener: MonitorChangeListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Register or update a monitor. */
  addOrUpdateMonitor(info: MonitorInfo): void {
    const existing = this.monitors.get(info.id)
    this.monitors.set(info.id, { ...info })
    const type: MonitorEventType = existing === undefined ? 'added' : 'changed'
    this.notify(type, info)
  }

  /** Remove a disconnected monitor. */
  removeMonitor(id: string): boolean {
    const existing = this.monitors.get(id)
    if (existing === undefined) return false
    // Never remove the only monitor without a replacement
    if (this.monitors.size <= 1) {
      return false
    }
    this.monitors.delete(id)
    this.notify('removed', existing)
    return true
  }

  private notify(type: MonitorEventType, monitor: MonitorInfo): void {
    for (const listener of this.listeners) {
      try {
        listener(type, monitor)
      } catch (err) {
        console.error('Error in monitor change listener:', err)
      }
    }
  }
}
