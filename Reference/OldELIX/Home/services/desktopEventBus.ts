import type { ShellApp } from "../model";
import type { NativeWindowDescriptor } from "../osService";

export interface OptimisticManagedWindowEvent {
  app: ShellApp;
  windowId: string;
  instanceId?: string;
  surfaceUrl: string;
}

export interface DesktopEventMap {
  "managed-window:sync": { appId?: string };
  "managed-window:focus-app": { appId: string };
  "managed-window:focus-window": { windowId: string };
  "managed-window:minimize-window": { windowId: string };
  "managed-window:optimistic": OptimisticManagedWindowEvent;
  "native-window:snapshot": { windows: NativeWindowDescriptor[]; revision: number };
  "native-window:upsert": { window: NativeWindowDescriptor; kind: "added" | "updated"; revision: number };
  "native-window:batch": { windows: NativeWindowDescriptor[]; removedHandles: number[]; revision: number };
  "native-window:remove": { handle: number; revision: number };
}

type DesktopEventName = keyof DesktopEventMap;
type DesktopEventListener<K extends DesktopEventName> = (payload: DesktopEventMap[K]) => void;

/**
 * ELIX-local renderer event bus.
 *
 * Native Windows events enter once through NativeDesktopManager and are adapted
 * into typed snapshot/upsert/remove events here. Managed ELIX windows use their
 * own event names. This keeps native HWND state and renderer-owned window state
 * separate while giving Dock/WindowRuntime one deterministic subscription bus.
 */
class DesktopEventBus {
  private listeners = new Map<DesktopEventName, Set<(payload: unknown) => void>>();

  emit<K extends DesktopEventName>(name: K, payload: DesktopEventMap[K]): void {
    const listeners = this.listeners.get(name);
    if (!listeners?.size) return;
    for (const listener of [...listeners]) listener(payload);
  }

  subscribe<K extends DesktopEventName>(name: K, listener: DesktopEventListener<K>): () => void {
    const current = this.listeners.get(name) ?? new Set<(payload: unknown) => void>();
    current.add(listener as (payload: unknown) => void);
    this.listeners.set(name, current);
    return () => {
      current.delete(listener as (payload: unknown) => void);
      if (!current.size) this.listeners.delete(name);
    };
  }

  listenerCount(name?: DesktopEventName): number {
    if (name) return this.listeners.get(name)?.size ?? 0;
    let total = 0;
    for (const listeners of this.listeners.values()) total += listeners.size;
    return total;
  }
}

export const desktopEventBus = new DesktopEventBus();

// Legacy DOM-event adapter. Older ELIX plugins and QA automation may still
// publish the pre-V29 CustomEvent names. Adapt them once at the boundary; the
// typed bus remains the only renderer state path.
const installLegacyDesktopEventAdapter = () => {
  if (typeof window === "undefined") return;
  const marker = "__elixDesktopEventAdapterInstalled";
  const tagged = window as typeof window & Record<string, unknown>;
  if (tagged[marker]) return;
  tagged[marker] = true;
  window.addEventListener("elix-platform-window-sync", () => desktopEventBus.emit("managed-window:sync", {}));
  window.addEventListener("elix-platform-window-focus", (event) => {
    const appId = (event as CustomEvent<string>).detail;
    if (appId) desktopEventBus.emit("managed-window:focus-app", { appId });
  });
  window.addEventListener("elix-managed-window-optimistic", (event) => {
    const detail = (event as CustomEvent<OptimisticManagedWindowEvent>).detail;
    if (detail) desktopEventBus.emit("managed-window:optimistic", detail);
  });
};

installLegacyDesktopEventAdapter();
