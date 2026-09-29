import { useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { DesktopShortcutLayer } from "../components/home/DesktopShortcutLayer";
import type { ShortcutPosition } from "../components/home/MovableHomeModule";
import { WidgetBoard } from "../components/WidgetBoard";
import { useServiceBootstrap } from "../hooks/useServiceBootstrap";
import { useSystemTelemetry } from "../hooks/useSystemTelemetry";
import { dedupeApps } from "../dockManager";
import { appFolderManager, type AppFolder, useAppFolders } from "../managers/appFolderManager";
import { desktopLayoutManager, type DesktopLayoutResolution, type DesktopLayoutSessionHandle } from "../managers/desktopLayoutManager";
import { shellPanelManager } from "../managers/shellPanelManager";
import { shellStorage } from "../managers/shellStorage";
import { wallpaperManager, type WallpaperPreferences } from "../managers/wallpaperManager";
import { useWindowRuntimeRunningCounts } from "../managers/windowManager";
import { notifyShell, performAppPrimaryAction, pinnedApps, type ShellApp } from "../model";
import type { IntegrationStatus, SystemSummary, WidgetManifest } from "../osService";
import { startupPhase } from "../startup/startupPhase";
import { installElixCoreToolBridge } from "../services/elixCoreTools";
import { installSemanticUiBindings } from "../services/semanticUiBindings";
// MIGRATION ADAPTER — implementation belongs to new ELIX runtime
const openDockFolderSurface = async (..._args: any[]): Promise<any> => undefined;
// MIGRATION ADAPTER — implementation belongs to new ELIX runtime
const openShellContextSurface = async (..._args: any[]): Promise<any> => undefined;
const HOME_LAYOUT_SOURCE = "surface-v2-home";

type RuntimeSettings = {
  dockIconLimit: number;
  workspaceLimit: number;
  recentAppsEnabled: boolean;
};

type AppGesture = {
  appId: string;
  pointerId: number;
  mode: "move" | "resize";
  startX: number;
  startY: number;
  origin: ShortcutPosition;
  startIconSize: number;
  proposedPosition: ShortcutPosition;
  proposedIconSize: number;
  moved: boolean;
  element: HTMLElement;
  session: DesktopLayoutSessionHandle;
  resolution: DesktopLayoutResolution | null;
};

type FolderGesture = {
  folderId: string;
  pointerId: number;
  mode: "move" | "resize";
  startX: number;
  startY: number;
  origin: ShortcutPosition;
  startIconSize: number;
  proposedPosition: ShortcutPosition;
  proposedIconSize: number;
  moved: boolean;
  element: HTMLElement;
  session: DesktopLayoutSessionHandle;
  resolution: DesktopLayoutResolution | null;
};

const appFootprint = (app?: ShellApp) => {
  const iconSize = Math.max(44, Math.min(96, app?.iconSize ?? 58));
  return { width: Math.max(82, iconSize + 42), height: Math.max(92, iconSize + 52) };
};

const folderFootprint = (folder?: AppFolder) => {
  const iconSize = Math.max(44, Math.min(96, folder?.desktopIconSize ?? 64));
  return { width: Math.max(84, iconSize + 40), height: Math.max(94, iconSize + 50) };
};

const defaultShortcutPosition = (index: number): ShortcutPosition => ({
  x: 58 + index * 148,
  y: Math.max(350, window.innerHeight - 300),
});

function useWallpaperBackground() {
  const [preferences, setPreferences] = useState<WallpaperPreferences>(() => wallpaperManager.current());

  useEffect(() => {
    const changed = (event: Event) => setPreferences((event as CustomEvent<WallpaperPreferences>).detail);
    window.addEventListener("elix-wallpaper-changed", changed);
    void wallpaperManager.syncFromService();
    return () => window.removeEventListener("elix-wallpaper-changed", changed);
  }, []);

  const active = preferences.items.find((item) => item.id === preferences.activeId) ?? preferences.items[0];
  const fit = preferences.fit === "stretch"
    ? "100% 100%"
    : preferences.fit === "tile" || preferences.fit === "center"
      ? "auto"
      : preferences.fit;
  const source = active?.kind === "gradient"
    ? active.source
    : active?.kind === "image"
      ? `url("${active.source}")`
      : "url(\"/wallpaper/current.jpg\")";

  return {
    "--home-v2-wallpaper": source,
    "--home-v2-wallpaper-size": fit,
    "--home-v2-wallpaper-repeat": preferences.fit === "tile" ? "repeat" : "no-repeat",
    "--home-v2-wallpaper-blur": `${preferences.blur}px`,
    "--home-v2-wallpaper-saturation": `${preferences.saturation}%`,
    "--home-v2-wallpaper-dim": String(preferences.dim / 100),
  } as React.CSSProperties;
}

export function HomeV2() {
  const wallpaperStyle = useWallpaperBackground();
  const [dockApps, setDockApps] = useState<ShellApp[]>(pinnedApps);
  const hadSavedDockPins = useRef(Boolean(shellStorage.getItem("elix.dock-pins") ?? shellStorage.getItem("elix.pinned-apps")));
  const [desktopShortcuts, setDesktopShortcuts] = useState<ShellApp[]>(() => {
    try {
      const saved = shellStorage.getItem("elix.desktop-shortcuts");
      if (saved) return (JSON.parse(saved) as ShellApp[]).map((app) => ({ ...app, size: app.size ?? "medium" }));
    } catch {}
    return pinnedApps.slice(0, 4).map((app) => ({ ...app, size: "medium" }));
  });
  const [catalogApps, setCatalogApps] = useState<ShellApp[]>(pinnedApps);
  const folders = useAppFolders();
  const [widgets, setWidgets] = useState<WidgetManifest[]>([]);
  const [visibleWidgetIds, setVisibleWidgetIds] = useState<Set<string>>(() => {
    try {
      const saved = shellStorage.getItem("elix.visible-widgets");
      return new Set(saved ? JSON.parse(saved) as string[] : ["clock", "system"]);
    } catch {
      return new Set(["clock", "system"]);
    }
  });
  const [integrations, setIntegrations] = useState<IntegrationStatus | null>(null);
  const [system, setSystem] = useState<SystemSummary | null>(null);
  const [, setRuntimeSettings] = useState<RuntimeSettings>(() => ({
    dockIconLimit: Math.max(2, Math.min(12, Number(shellStorage.getItem("elix.dockIconLimit") ?? 7))),
    workspaceLimit: Math.max(1, Math.min(32, Number(shellStorage.getItem("elix.workspaceLimit") ?? 12))),
    recentAppsEnabled: shellStorage.getItem("elix.recentAppsEnabled") !== "false",
  }));
  const [shortcutPositions, setShortcutPositions] = useState<Record<string, ShortcutPosition>>(() => {
    try {
      const saved = shellStorage.getItem("elix.shortcut-positions");
      return saved ? JSON.parse(saved) as Record<string, ShortcutPosition> : {};
    } catch {
      return {};
    }
  });
  const [selectedApps, setSelectedApps] = useState<Set<string>>(() => new Set());
  const [selectedFolders, setSelectedFolders] = useState<Set<string>>(() => new Set());
  const appGesture = useRef<AppGesture | null>(null);
  const folderGesture = useRef<FolderGesture | null>(null);
  const placementRef = useRef<HTMLDivElement | null>(null);
  const suppressAppActivation = useRef<string | null>(null);
  const lastHealthAdvisory = useRef("");
  const runningCounts = useWindowRuntimeRunningCounts();

  useServiceBootstrap({
    hadSavedDockPins,
    setApps: setDockApps,
    setDesktopShortcuts,
    setCatalogApps,
    setWidgets,
    setIntegrations,
    setSystem,
    setRuntimeSettings,
  });
  useSystemTelemetry({ lastHealthAdvisory });

  useEffect(() => {
    const releaseBindings = startupPhase.installInteractiveBindings({ installSemanticUiBindings, installElixCoreToolBridge });
    const frame = window.requestAnimationFrame(() => {
      void startupPhase.signalInteractiveReady().catch((error) => console.error("ELIX V2 Home handoff failed", error));
    });
    return () => {
      window.cancelAnimationFrame(frame);
      releaseBindings();
    };
  }, []);

  useEffect(() => {
    shellStorage.setItem("elix.desktop-shortcuts", JSON.stringify(desktopShortcuts));
  }, [desktopShortcuts]);

  useEffect(() => {
    shellStorage.setItem("elix.shortcut-positions", JSON.stringify(shortcutPositions));
  }, [shortcutPositions]);

  useEffect(() => {
    shellStorage.setItem("elix.visible-widgets", JSON.stringify([...visibleWidgetIds]));
  }, [visibleWidgetIds]);

  useEffect(() => {
    const changed = (event: Event) => {
      const ids = (event as CustomEvent<unknown>).detail;
      if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) return;
      setVisibleWidgetIds(new Set(ids));
    };
    window.addEventListener("elix-visible-widgets-changed", changed);
    return () => window.removeEventListener("elix-visible-widgets-changed", changed);
  }, []);

  const knownApps = useMemo(() => dedupeApps([...catalogApps, ...dockApps, ...desktopShortcuts]), [catalogApps, dockApps, desktopShortcuts]);
  const appById = useMemo(() => new Map(knownApps.map((app) => [app.id, app])), [knownApps]);
  const appsForFolder = (folder: AppFolder) => folder.appIds.map((id) => appById.get(id)).filter((app): app is ShellApp => Boolean(app));

  useEffect(() => {
    const items = [
      ...desktopShortcuts.map((app, index) => ({
        id: `app:${app.id}`,
        type: "app" as const,
        source: HOME_LAYOUT_SOURCE,
        ...(shortcutPositions[app.id] ?? defaultShortcutPosition(index)),
        ...appFootprint(app),
        gap: 10,
        snapX: 24,
        snapY: 24,
      })),
      ...folders.filter((folder) => folder.surfaces.desktop).map((folder) => ({
        id: `folder:${folder.id}`,
        type: "folder" as const,
        source: HOME_LAYOUT_SOURCE,
        ...folder.desktopPosition,
        ...folderFootprint(folder),
        gap: 10,
        snapX: 24,
        snapY: 24,
      })),
    ];
    desktopLayoutManager.replaceSource(HOME_LAYOUT_SOURCE, items);
  }, [desktopShortcuts, shortcutPositions, folders]);

  useEffect(() => desktopLayoutManager.subscribe((commit) => {
    const appPositions = Object.fromEntries(commit.items
      .filter((item) => item.type === "app")
      .map((item) => [item.id.slice("app:".length), { x: item.x, y: item.y }]));
    if (Object.keys(appPositions).length) setShortcutPositions((current) => ({ ...current, ...appPositions }));

    const folderPositions = Object.fromEntries(commit.items
      .filter((item) => item.type === "folder")
      .map((item) => [item.id.slice("folder:".length), { x: item.x, y: item.y }]));
    if (Object.keys(folderPositions).length) appFolderManager.setDesktopPositions(folderPositions);
  }), []);

  useEffect(() => {
    const reflow = () => desktopLayoutManager.requestReflow();
    window.addEventListener("resize", reflow);
    return () => window.removeEventListener("resize", reflow);
  }, []);

  const openFolder = (folder: AppFolder) => {
    const anchor = document.querySelector<HTMLElement>(`[data-folder-id="${CSS.escape(folder.id)}"]`)?.getBoundingClientRect() ?? null;
    void openDockFolderSurface(folder, appsForFolder(folder), runningCounts, anchor, {
      onAction(action: string, data?: unknown) {
        if (action === "folder-rename" && typeof data === "string") appFolderManager.rename(folder.id, data);
        else if (action === "folder-remove-app" && typeof data === "string") appFolderManager.removeApp(folder.id, data);
        else if (action === "folder-delete") appFolderManager.delete(folder.id);
        else if (action === "folder-reorder" && data && typeof data === "object") {
          const payload = data as { sourceId?: string; targetId?: string };
          if (payload.sourceId && payload.targetId) appFolderManager.reorderApps(folder.id, payload.sourceId, payload.targetId);
        } else if (action === "folder-drop-app" && data && typeof data === "object") {
          const app = data as ShellApp;
          if (app.id) appFolderManager.addApp(folder.id, app.id);
        } else if (action === "folder-toggle-surface" && data && typeof data === "object") {
          const payload = data as { surface?: "desktop" | "dock" | "start"; visible?: boolean };
          if (payload.surface && typeof payload.visible === "boolean") appFolderManager.setSurface(folder.id, payload.surface, payload.visible);
        } else if (action === "folder-distill") {
          notifyShell(`AI folder distillation is not connected yet. ${folder.name} was not changed.`);
        } else if (action === "folder-compress") {
          notifyShell(`${folder.name} compression remains available from the legacy rollback path until the native dialog migration phase.`);
        }
      },
      onClose() {},
    }).catch((error) => notifyShell(error instanceof Error ? error.message : "Folder surface could not open."));
  };

  const addAppToFolder = (folder: AppFolder, app: ShellApp) => {
    appFolderManager.addApp(folder.id, app.id);
    setDesktopShortcuts((current) => current.filter((candidate) => candidate.id !== app.id));
    setShortcutPositions((current) => {
      const next = { ...current };
      delete next[app.id];
      return next;
    });
  };

  const activateShortcut = (event: React.MouseEvent<HTMLElement>, app: ShellApp) => {
    event.stopPropagation();
    if (suppressAppActivation.current === app.id) {
      suppressAppActivation.current = null;
      return;
    }
    if (event.ctrlKey || event.metaKey || event.shiftKey) {
      setSelectedApps((current) => {
        const next = new Set(current);
        if ((event.ctrlKey || event.metaKey) && next.has(app.id)) next.delete(app.id);
        else next.add(app.id);
        return next;
      });
      return;
    }
    setSelectedApps(new Set());
    setSelectedFolders(new Set());
    const bounds = event.currentTarget.getBoundingClientRect();
    void performAppPrimaryAction(app, "activate-preferred", "desktop", {
      sourceElementId: `desktop:${app.id}`,
      sourceBounds: { x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height },
    }).catch((error: Error) => notifyShell(error.message));
  };

  const beginAppGesture = (event: React.PointerEvent<HTMLElement>, app: ShellApp) => {
    if (event.button !== 0) return;
    const resize = Boolean((event.target as HTMLElement).closest("[data-resize-direction], .shortcut-resize-handle"));
    const index = desktopShortcuts.findIndex((candidate) => candidate.id === app.id);
    const origin = shortcutPositions[app.id] ?? defaultShortcutPosition(Math.max(0, index));
    appGesture.current = {
      appId: app.id,
      pointerId: event.pointerId,
      mode: resize ? "resize" : "move",
      startX: event.clientX,
      startY: event.clientY,
      origin,
      startIconSize: Math.max(44, Math.min(96, app.iconSize ?? 58)),
      proposedPosition: origin,
      proposedIconSize: Math.max(44, Math.min(96, app.iconSize ?? 58)),
      moved: false,
      element: event.currentTarget,
      session: desktopLayoutManager.createSession(`app:${app.id}`),
      resolution: null,
    };
    setSelectedApps(new Set([app.id]));
    setSelectedFolders(new Set());
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch {}
  };

  const updateAppGesture = (event: React.PointerEvent<HTMLElement>) => {
    const active = appGesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const dx = event.clientX - active.startX;
    const dy = event.clientY - active.startY;
    if (!active.moved && Math.hypot(dx, dy) < (active.mode === "resize" ? 4 : 8)) return;
    if (!active.moved) {
      active.moved = true;
      suppressAppActivation.current = active.appId;
      active.element.classList.add("is-grabbed", active.mode === "resize" ? "is-resizing" : "is-moving");
      if (placementRef.current) placementRef.current.style.display = "block";
    }

    const app = desktopShortcuts.find((candidate) => candidate.id === active.appId);
    if (active.mode === "resize") {
      active.proposedIconSize = Math.max(44, Math.min(96, Math.round((active.startIconSize + Math.max(dx, dy)) / 4) * 4));
      const footprint = appFootprint(app ? { ...app, iconSize: active.proposedIconSize } : undefined);
      active.resolution = active.session.resolve({ x: active.origin.x, y: active.origin.y, ...footprint });
      const resolved = active.resolution?.items.get(`app:${active.appId}`);
      active.proposedPosition = resolved ? { x: resolved.x, y: resolved.y } : active.origin;
      active.element.style.setProperty("--shortcut-icon-size", `${active.proposedIconSize}px`);
      active.element.style.width = `${footprint.width}px`;
      active.element.style.height = `${footprint.height}px`;
    } else {
      const footprint = appFootprint(app);
      active.resolution = active.session.resolve({ x: active.origin.x + dx, y: active.origin.y + dy, ...footprint });
      const resolved = active.resolution?.items.get(`app:${active.appId}`);
      active.proposedPosition = resolved ? { x: resolved.x, y: resolved.y } : { x: active.origin.x + dx, y: active.origin.y + dy };
      active.element.style.left = `${active.proposedPosition.x}px`;
      active.element.style.top = `${active.proposedPosition.y}px`;
    }
  };

  const finishAppGesture = (event: React.PointerEvent<HTMLElement>) => {
    const active = appGesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    appGesture.current = null;
    if (active.moved) {
      if (active.mode === "resize") {
        setDesktopShortcuts((current) => current.map((app) => app.id === active.appId ? { ...app, iconSize: active.proposedIconSize } : app));
      }
      setShortcutPositions((current) => ({ ...current, [active.appId]: active.proposedPosition }));
      if (active.resolution) desktopLayoutManager.commit(active.resolution, active.mode === "resize" ? "resize" : "drag");
    }
    active.element.classList.remove("is-grabbed", "is-moving", "is-resizing");
    active.element.style.left = "";
    active.element.style.top = "";
    active.element.style.width = "";
    active.element.style.height = "";
    active.element.style.removeProperty("--shortcut-icon-size");
    if (placementRef.current) placementRef.current.style.display = "none";
    try { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); } catch {}
  };

  const cancelAppGesture = (event: React.PointerEvent<HTMLElement>) => {
    const active = appGesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    appGesture.current = null;
    active.element.classList.remove("is-grabbed", "is-moving", "is-resizing");
    active.element.style.left = "";
    active.element.style.top = "";
    active.element.style.width = "";
    active.element.style.height = "";
    active.element.style.removeProperty("--shortcut-icon-size");
    if (placementRef.current) placementRef.current.style.display = "none";
  };

  const beginFolderGesture = (event: React.PointerEvent<HTMLElement>, folder: AppFolder) => {
    if (event.button !== 0) return;
    const resize = Boolean((event.target as HTMLElement).closest("[data-resize-direction], .shortcut-resize-handle"));
    folderGesture.current = {
      folderId: folder.id,
      pointerId: event.pointerId,
      mode: resize ? "resize" : "move",
      startX: event.clientX,
      startY: event.clientY,
      origin: folder.desktopPosition,
      startIconSize: Math.max(44, Math.min(96, folder.desktopIconSize ?? 64)),
      proposedPosition: folder.desktopPosition,
      proposedIconSize: Math.max(44, Math.min(96, folder.desktopIconSize ?? 64)),
      moved: false,
      element: event.currentTarget,
      session: desktopLayoutManager.createSession(`folder:${folder.id}`),
      resolution: null,
    };
    setSelectedApps(new Set());
    setSelectedFolders(new Set([folder.id]));
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch {}
  };

  const updateFolderGesture = (event: React.PointerEvent<HTMLElement>) => {
    const active = folderGesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const dx = event.clientX - active.startX;
    const dy = event.clientY - active.startY;
    if (!active.moved && Math.hypot(dx, dy) < (active.mode === "resize" ? 4 : 8)) return;
    if (!active.moved) {
      active.moved = true;
      active.element.classList.add("is-grabbed", active.mode === "resize" ? "is-resizing" : "is-moving");
    }
    const folder = folders.find((candidate) => candidate.id === active.folderId);
    if (active.mode === "resize") {
      active.proposedIconSize = Math.max(44, Math.min(96, Math.round((active.startIconSize + Math.max(dx, dy)) / 4) * 4));
      const footprint = folderFootprint(folder ? { ...folder, desktopIconSize: active.proposedIconSize } : undefined);
      active.resolution = active.session.resolve({ x: active.origin.x, y: active.origin.y, ...footprint });
      const resolved = active.resolution?.items.get(`folder:${active.folderId}`);
      active.proposedPosition = resolved ? { x: resolved.x, y: resolved.y } : active.origin;
      active.element.style.setProperty("--folder-icon-size", `${active.proposedIconSize}px`);
      active.element.style.width = `${footprint.width}px`;
      active.element.style.height = `${footprint.height}px`;
    } else {
      const footprint = folderFootprint(folder);
      active.resolution = active.session.resolve({ x: active.origin.x + dx, y: active.origin.y + dy, ...footprint });
      const resolved = active.resolution?.items.get(`folder:${active.folderId}`);
      active.proposedPosition = resolved ? { x: resolved.x, y: resolved.y } : { x: active.origin.x + dx, y: active.origin.y + dy };
      active.element.style.left = `${active.proposedPosition.x}px`;
      active.element.style.top = `${active.proposedPosition.y}px`;
    }
  };

  const finishFolderGesture = (event: React.PointerEvent<HTMLElement>) => {
    const active = folderGesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const cancelled = event.type === "pointercancel";
    folderGesture.current = null;
    const folder = folders.find((candidate) => candidate.id === active.folderId);
    if (!cancelled && active.moved) {
      if (active.mode === "resize") appFolderManager.update(active.folderId, { desktopIconSize: active.proposedIconSize, desktopPosition: active.proposedPosition });
      else appFolderManager.setDesktopPosition(active.folderId, active.proposedPosition);
      if (active.resolution) desktopLayoutManager.commit(active.resolution, active.mode === "resize" ? "resize" : "drag");
    } else if (!cancelled && folder) {
      openFolder(folder);
    }
    active.element.classList.remove("is-grabbed", "is-moving", "is-resizing");
    active.element.style.left = "";
    active.element.style.top = "";
    active.element.style.width = "";
    active.element.style.height = "";
    active.element.style.removeProperty("--folder-icon-size");
    try { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); } catch {}
  };

  const openContextMenu = (event: React.MouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const target = event.target as HTMLElement;
    const appId = target.closest<HTMLElement>("[data-home-app]")?.dataset.homeApp;
    const folderId = target.closest<HTMLElement>("[data-folder-id]")?.dataset.folderId;

    if (appId) {
      const app = desktopShortcuts.find((candidate) => candidate.id === appId);
      if (!app) return;
      setSelectedApps(new Set([appId]));
      setSelectedFolders(new Set());
      void openShellContextSurface({
        label: app.name,
        width: 244,
        actions: [
          { key: "open", id: "open", label: "Open" },
          { key: "remove", id: "remove", label: "Remove from Home", danger: true, separatorBefore: true },
        ],
      }, { x: event.clientX, y: event.clientY }, {
        onAction(key: string) {
          if (key === "open") void performAppPrimaryAction(app, "activate-preferred", "desktop").catch((error: Error) => notifyShell(error.message));
          if (key === "remove") {
            setDesktopShortcuts((current) => current.filter((candidate) => candidate.id !== app.id));
            setShortcutPositions((current) => {
              const next = { ...current };
              delete next[app.id];
              return next;
            });
          }
        },
        onClose() {},
      }).catch((error) => notifyShell(error instanceof Error ? error.message : "Context menu could not open."));
      return;
    }

    if (folderId) {
      const folder = folders.find((candidate) => candidate.id === folderId);
      if (!folder) return;
      setSelectedApps(new Set());
      setSelectedFolders(new Set([folderId]));
      void openShellContextSurface({
        label: folder.name,
        width: 244,
        actions: [
          { key: "open", id: "open", label: "Open folder" },
          { key: "delete", id: "delete", label: "Delete folder", danger: true, separatorBefore: true },
        ],
      }, { x: event.clientX, y: event.clientY }, {
        onAction(key: string) {
          if (key === "open") openFolder(folder);
          if (key === "delete") appFolderManager.delete(folder.id);
        },
        onClose() {},
      }).catch((error) => notifyShell(error instanceof Error ? error.message : "Context menu could not open."));
      return;
    }

    setSelectedApps(new Set());
    setSelectedFolders(new Set());
    void openShellContextSurface({
      label: "Home",
      width: 252,
      actions: [
        { key: "new-folder", id: "new-folder", label: "New folder" },
        { key: "widgets", id: "widgets", label: "Widgets" },
        { key: "personalize", id: "personalize", label: "Personalize", separatorBefore: true },
      ],
    }, { x: event.clientX, y: event.clientY }, {
      onAction(key: string) {
        if (key === "new-folder") {
          const folder = appFolderManager.create([], {
            name: "New Folder",
            surfaces: { desktop: true, dock: true, start: true },
            desktopPosition: { x: event.clientX, y: event.clientY },
          });
          openFolder(folder);
        } else if (key === "widgets") {
          shellPanelManager.open("widgets");
        } else if (key === "personalize") {
          window.dispatchEvent(new CustomEvent("elix-open-settings-section", { detail: "personalization" }));
        }
      },
      onClose() {},
    }).catch((error) => notifyShell(error instanceof Error ? error.message : "Context menu could not open."));
  };

  return (
    <main
      className="desktop elix-shell home-v2-root"
      data-material="ios"
      data-surface-role="home"
      style={wallpaperStyle}
      onContextMenu={openContextMenu}
      onPointerDown={(event) => {
        const target = event.target as HTMLElement;
        if (target.closest("[data-home-app], [data-folder-id], .home-widget")) return;
        setSelectedApps(new Set());
        setSelectedFolders(new Set());
      }}
    >
      <DesktopShortcutLayer
        apps={desktopShortcuts}
        positions={shortcutPositions}
        selectedApps={selectedApps}
        runningApps={runningCounts}
        beginAppGesture={beginAppGesture}
        updateAppGesture={updateAppGesture}
        finishAppGesture={finishAppGesture}
        cancelAppGesture={cancelAppGesture}
        activateShortcut={activateShortcut}
        folders={folders}
        folderApps={appsForFolder}
        selectedFolders={selectedFolders}
        beginFolderGesture={beginFolderGesture}
        updateFolderGesture={updateFolderGesture}
        finishFolderGesture={finishFolderGesture}
        openFolder={openFolder}
        addAppToFolder={addAppToFolder}
        reportDropError={() => notifyShell("That application could not be added to the folder.")}
        placementRef={placementRef}
      />
      <WidgetBoard
        manifests={widgets}
        visibleIds={visibleWidgetIds}
        integrations={integrations}
        system={system}
        appCount={catalogApps.length}
        runningWindowCount={Object.values(runningCounts).reduce((total, count) => total + count, 0)}
        remove={(id) => setVisibleWidgetIds((current) => {
          const next = new Set(current);
          next.delete(id);
          return next;
        })}
      />
    </main>
  );
}

export default HomeV2;
