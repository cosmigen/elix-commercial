import { useSyncExternalStore } from "react";
import {
  osService,
  type MonitorDescriptor,
  type NativeTilingLayout,
  type NativeTilingResult,
  type NativeWindowDescriptor,
  type PlatformEvent
} from "../osService";
import { desktopEventBus } from "../services/desktopEventBus";

export interface NativeDesktopSnapshot {
  windows: NativeWindowDescriptor[];
  monitors: MonitorDescriptor[];
  revision: number;
  updatedAt: number;
}

type NativeDesktopSubscriber = (snapshot: NativeDesktopSnapshot) => void;

type NativeWindowPayload = { window?: NativeWindowDescriptor; reason?: string };
type NativeWindowRemovedPayload = { handle?: number; reason?: string };
type NativeWindowFocusPayload = { windows?: NativeWindowDescriptor[]; removedHandles?: number[]; reason?: string };

const sameMonitor = (left: MonitorDescriptor, right: MonitorDescriptor) =>
  left.id === right.id
  && left.deviceName === right.deviceName
  && left.x === right.x
  && left.y === right.y
  && left.width === right.width
  && left.height === right.height
  && left.workX === right.workX
  && left.workY === right.workY
  && left.workWidth === right.workWidth
  && left.workHeight === right.workHeight
  && left.isPrimary === right.isPrimary
  && left.scalePercent === right.scalePercent;

const sameNativeWindow = (left: NativeWindowDescriptor, right: NativeWindowDescriptor) =>
  left.handle === right.handle
  && left.processId === right.processId
  && left.processName === right.processName
  && left.title === right.title
  && left.isForeground === right.isForeground
  && left.isMinimized === right.isMinimized
  && left.isMaximized === right.isMaximized
  && left.x === right.x
  && left.y === right.y
  && left.width === right.width
  && left.height === right.height
  && left.workspaceId === right.workspaceId
  && left.executablePath === right.executablePath
  && left.appUserModelId === right.appUserModelId
  && left.windowClass === right.windowClass
  && left.isCloaked === right.isCloaked
  && left.isFullscreen === right.isFullscreen
  && left.monitorId === right.monitorId
  && left.lastForegroundAt === right.lastForegroundAt
  && left.ownerHandle === right.ownerHandle
  && left.parentHandle === right.parentHandle
  && left.isVisible === right.isVisible
  && left.dpi === right.dpi
  && left.zOrder === right.zOrder
  && left.createdAt === right.createdAt;

const sortWindows = (windows: NativeWindowDescriptor[]) => [...windows].sort((left, right) => {
  if (left.isForeground !== right.isForeground) return left.isForeground ? -1 : 1;
  const foregroundOrder = (right.lastForegroundAt ?? 0) - (left.lastForegroundAt ?? 0);
  if (foregroundOrder !== 0) return foregroundOrder;
  return left.handle - right.handle;
});

/**
 * Frontend mirror of the native canonical HWND store.
 *
 * Startup and slow safety resync use /windows/native. Normal native lifecycle
 * events patch one record in-place from native-window.added/updated/removed.
 * Legacy raw WinEvent notifications no longer trigger a renderer HTTP refresh.
 */
export class NativeDesktopManager {
  private snapshotValue: NativeDesktopSnapshot = {
    windows: [],
    monitors: [],
    revision: 0,
    updatedAt: 0
  };
  private readonly windowsByHandle = new Map<number, NativeWindowDescriptor>();
  private readonly subscribers = new Set<NativeDesktopSubscriber>();
  private disconnectPlatform?: () => void;
  private reconcileTimer = 0;
  private refreshTimer = 0;
  private generation = 0;
  private active = false;

  snapshot(): NativeDesktopSnapshot {
    return this.snapshotValue;
  }

  subscribe(subscriber: NativeDesktopSubscriber): () => void {
    this.subscribers.add(subscriber);
    subscriber(this.snapshotValue);
    this.start();
    return () => {
      this.subscribers.delete(subscriber);
      if (this.subscribers.size === 0) this.stop();
    };
  }

  async refresh(force = false): Promise<NativeDesktopSnapshot> {
    const generation = ++this.generation;
    const [windows, monitors] = await Promise.all([
      force ? osService.refreshNativeWindows() : osService.nativeWindows(),
      osService.monitors().catch(() => this.snapshotValue.monitors)
    ]);
    if (generation !== this.generation) return this.snapshotValue;

    this.windowsByHandle.clear();
    windows.forEach((windowState) => this.windowsByHandle.set(windowState.handle, windowState));
    const nextWindows = sortWindows([...this.windowsByHandle.values()]);
    const windowsChanged = nextWindows.length !== this.snapshotValue.windows.length
      || nextWindows.some((windowState, index) => !sameNativeWindow(windowState, this.snapshotValue.windows[index]));
    const monitorsChanged = monitors.length !== this.snapshotValue.monitors.length
      || monitors.some((monitor, index) => !sameMonitor(monitor, this.snapshotValue.monitors[index]));

    if (windowsChanged || monitorsChanged || this.snapshotValue.updatedAt === 0) {
      this.commit(nextWindows, monitors);
      desktopEventBus.emit("native-window:snapshot", {
        windows: this.snapshotValue.windows,
        revision: this.snapshotValue.revision
      });
    }
    return this.snapshotValue;
  }

  async activate(handle: number): Promise<void> {
    await osService.activateNativeWindow(handle);
    this.patchCommandState(handle, { isForeground: true, isMinimized: false }, true);
  }

  async minimize(handle: number, transition?: { x: number; y: number; width: number; height: number; durationMs: number; style: string; enabled: boolean }): Promise<void> {
    await osService.minimizeNativeWindow(handle, transition);
    this.patchCommandState(handle, { isForeground: false, isMinimized: true });
  }

  async maximize(handle: number): Promise<void> {
    await osService.maximizeNativeWindow(handle);
    this.patchCommandState(handle, { isForeground: true, isMinimized: false, isMaximized: true }, true);
  }

  async restore(handle: number, transition?: { x: number; y: number; width: number; height: number; durationMs: number; style: string; enabled: boolean }): Promise<void> {
    await osService.restoreNativeWindow(handle, transition);
    this.patchCommandState(handle, { isForeground: true, isMinimized: false, isMaximized: false }, true);
  }

  async setBounds(handle: number, bounds: { x: number; y: number; width: number; height: number }, durationMs = 150): Promise<void> {
    await osService.animateNativeWindow(handle, bounds, durationMs);
  }

  close(handle: number): Promise<void> {
    return osService.closeNativeWindow(handle);
  }

  tile(
    handles: number[],
    layout: NativeTilingLayout = "columns",
    gap = 10,
    anchorHandle?: number
  ): Promise<NativeTilingResult> {
    return osService.tileNativeWindows(handles, layout, gap, anchorHandle);
  }

  moveToWorkspace(handle: number, workspaceId: string): Promise<void> {
    return osService.assignWindowToWorkspace(workspaceId, `hwnd:${handle.toString(16)}`, "windows");
  }

  private start(): void {
    if (this.active) return;
    this.active = true;
    this.disconnectPlatform = osService.connectPlatform((event) => this.handlePlatformEvent(event));
    void this.refresh(true).catch((error) => console.warn("[NativeDesktop] Initial synchronization failed", error));
    this.reconcileTimer = window.setInterval(() => {
      if (!document.hidden) void this.refresh(true).catch(() => undefined);
    }, 45_000);
  }

  /**
   * A successful HWND command already proves that Windows accepted the exact
   * handle. Patch only those semantic flags immediately, then let WinEvents
   * reconcile geometry/title. This removes the visible command-to-event gap
   * without re-enumerating windows or guessing process identity.
   */
  private patchCommandState(
    handle: number,
    patch: Partial<Pick<NativeWindowDescriptor, "isForeground" | "isMinimized" | "isMaximized">>,
    clearOtherForeground = false
  ): void {
    const changed = this.snapshotValue.windows.flatMap((windowState) => {
      if (windowState.handle === handle) return [{ ...windowState, ...patch }];
      if (clearOtherForeground && windowState.isForeground) return [{ ...windowState, isForeground: false }];
      return [];
    });
    if (changed.length) this.applyWindowBatch(changed, []);
  }

  private stop(): void {
    if (!this.active) return;
    this.active = false;
    this.disconnectPlatform?.();
    this.disconnectPlatform = undefined;
    window.clearInterval(this.reconcileTimer);
    window.clearTimeout(this.refreshTimer);
    this.reconcileTimer = 0;
    this.refreshTimer = 0;
  }

  private handlePlatformEvent(event: PlatformEvent): void {
    if (event.type === "native-window.added" || event.type === "native-window.updated") {
      const payload = event.payload as NativeWindowPayload | null;
      const windowState = payload?.window;
      if (!windowState || typeof windowState.handle !== "number") return;
      this.upsertWindow(windowState, event.type === "native-window.added" ? "added" : "updated");
      return;
    }

    if (event.type === "native-window.removed") {
      const payload = event.payload as NativeWindowRemovedPayload | null;
      if (typeof payload?.handle !== "number") return;
      this.removeWindow(payload.handle);
      return;
    }

    if (event.type === "native-window.focus-changed") {
      const payload = event.payload as NativeWindowFocusPayload | null;
      this.applyWindowBatch(payload?.windows ?? [], payload?.removedHandles ?? []);
      return;
    }

    // Monitor/workspace metadata changes are low-frequency and may alter window
    // work-area/workspace fields. Resync from the native cache, not Win32.
    if (event.type === "monitors.changed" || event.type.startsWith("workspace.")) {
      this.scheduleRefresh();
    }
  }

  private upsertWindow(windowState: NativeWindowDescriptor, kind: "added" | "updated"): void {
    const previous = this.windowsByHandle.get(windowState.handle);
    if (previous && sameNativeWindow(previous, windowState)) return;
    this.windowsByHandle.set(windowState.handle, windowState);
    this.commit(sortWindows([...this.windowsByHandle.values()]), this.snapshotValue.monitors);
    desktopEventBus.emit("native-window:upsert", {
      window: windowState,
      kind: previous ? "updated" : kind,
      revision: this.snapshotValue.revision
    });
  }

  private applyWindowBatch(windows: NativeWindowDescriptor[], removedHandles: number[]): void {
    let changed = false;
    for (const handle of removedHandles) {
      if (this.windowsByHandle.delete(handle)) changed = true;
    }
    for (const windowState of windows) {
      const previous = this.windowsByHandle.get(windowState.handle);
      if (previous && sameNativeWindow(previous, windowState)) continue;
      this.windowsByHandle.set(windowState.handle, windowState);
      changed = true;
    }
    if (!changed) return;
    this.commit(sortWindows([...this.windowsByHandle.values()]), this.snapshotValue.monitors);
    desktopEventBus.emit("native-window:batch", {
      windows,
      removedHandles,
      revision: this.snapshotValue.revision
    });
  }

  private removeWindow(handle: number): void {
    if (!this.windowsByHandle.delete(handle)) return;
    this.commit(sortWindows([...this.windowsByHandle.values()]), this.snapshotValue.monitors);
    desktopEventBus.emit("native-window:remove", { handle, revision: this.snapshotValue.revision });
  }

  private commit(windows: NativeWindowDescriptor[], monitors: MonitorDescriptor[]): void {
    this.snapshotValue = {
      windows,
      monitors,
      revision: this.snapshotValue.revision + 1,
      updatedAt: Date.now()
    };
    this.subscribers.forEach((subscriber) => subscriber(this.snapshotValue));
  }

  private scheduleRefresh(): void {
    window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = 0;
      void this.refresh(true).catch(() => undefined);
    }, 120);
  }
}

export const nativeDesktopManager = new NativeDesktopManager();

export function useNativeDesktopSnapshot(): NativeDesktopSnapshot {
  return useSyncExternalStore(
    (notify) => nativeDesktopManager.subscribe(() => notify()),
    () => nativeDesktopManager.snapshot(),
    () => nativeDesktopManager.snapshot()
  );
}
