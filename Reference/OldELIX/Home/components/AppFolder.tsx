import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  FileArchive,
  Folder,
  Home,
  LayoutGrid,
  PanelBottom,
  Pencil,
  Sparkles,
  Trash2,
  X
} from "../icons";
import type { ShellApp } from "../model";
import { notifyShell, performAppPrimaryAction } from "../model";
import type { AppFolder, AppFolderSurface } from "../managers/appFolderManager";
import { resolveEboDropZone } from "../spatial/ebo";
import { AppGlyph } from "./AppGlyph";
import { ContextMenu } from "./ContextMenu";
import { folderDragSessionManager } from "../managers/folderDragSessionManager";
import { shellStorage } from "../managers/shellStorage";
import { uiResizeManager } from "../managers/uiResizeManager";
import { AttachedResizeHandle } from "./AttachedResizeHandle";
import { useScrollEdgeFade } from "../hooks/useScrollEdgeFade";
import { folderOriginRegistry } from "../managers/folderOriginRegistry";
import { prefersReducedElixMotion } from "../motion/elixMotion";

const PAGE_SIZE = 12;
const reducedMotion = prefersReducedElixMotion;
type FolderWindowSize = { width: number; height: number };
type FolderResizeSession = {
  owner: string;
  direction: "e" | "s" | "se";
  pointerId: number;
  startX: number;
  startY: number;
  width: number;
  height: number;
  latestX: number;
  latestY: number;
  proposed: FolderWindowSize;
  element: HTMLElement;
};
const folderSizeKey = (id: string) => `elix.app-folder-window-size.v30:${id}`;
const readFolderWindowSize = (id: string): FolderWindowSize | null => {
  try {
    const value = JSON.parse(shellStorage.getItem(folderSizeKey(id)) ?? "null") as Partial<FolderWindowSize> | null;
    if (!value || !Number.isFinite(value.width) || !Number.isFinite(value.height)) return null;
    return { width: Number(value.width), height: Number(value.height) };
  } catch {
    return null;
  }
};

const animateAppIntoFolder = (target: HTMLElement, appId: string, commit: () => void) => {
  if (reducedMotion()) {
    commit();
    return;
  }
  const escaped = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(appId) : appId.replace(/["\\]/g, "\\$&");
  const source = document.querySelector<HTMLElement>(
    `[data-app="${escaped}"], [data-start-app="${escaped}"], [data-home-app="${escaped}"], [data-shortcut-id="${escaped}"]`
  );
  const targetRect = target.getBoundingClientRect();
  const targetMotion = target.animate(
    [
      { transform: "translate3d(0, 0, 0) scale(1)" },
      { transform: "translate3d(0, 0, 0) scale(1.18)", offset: .56 },
      { transform: "translate3d(0, 0, 0) scale(1)" }
    ],
    { duration: 220, easing: "cubic-bezier(.18, .9, .24, 1)" }
  );
  targetMotion.id = "elix-folder-absorb-target";
  if (!source || target.contains(source)) {
    targetMotion.finished.catch(() => undefined).finally(() => { targetMotion.cancel(); commit(); });
    return;
  }
  const sourceRect = source.getBoundingClientRect();
  const dx = targetRect.left + targetRect.width / 2 - (sourceRect.left + sourceRect.width / 2);
  const dy = targetRect.top + targetRect.height / 2 - (sourceRect.top + sourceRect.height / 2) + 15;
  source.style.pointerEvents = "none";
  const motion = source.animate(
    [
      { opacity: 1, transform: "translate3d(0, 0, 0) scale(1)" },
      { opacity: .72, transform: `translate3d(${dx * .58}px, ${dy * .58}px, 0) scale(.58)`, offset: .58 },
      { opacity: 0, transform: `translate3d(${dx}px, ${dy}px, 0) scale(.1)` }
    ],
    { duration: 220, easing: "cubic-bezier(.3, 0, .35, 1)", fill: "forwards" }
  );
  motion.id = "elix-folder-absorb-source";
  motion.finished.catch(() => undefined).finally(() => {
    motion.cancel();
    targetMotion.cancel();
    source.style.pointerEvents = "";
    commit();
  });
};

export function AppFolderPreview({ folder, apps, compact = false, runningCounts = {} }: { folder: AppFolder; apps: ShellApp[]; compact?: boolean; runningCounts?: Record<string, number> }) {
  const preview = apps.slice(0, compact ? 4 : 9);
  return (
    <span className={`app-folder-preview app-folder-${folder.color} ${compact ? "is-compact" : ""}`} data-item-count={Math.min(preview.length, compact ? 4 : 9)} aria-hidden="true">
      {preview.map((app) => (
        <span className={`app-folder-mini-icon ${app.iconClass} ${app.iconUrl ? "native-icon-image" : ""} ${(runningCounts[app.id] ?? 0) > 0 ? "is-running" : ""}`} key={app.id}>
          <AppGlyph app={app} />
          {(runningCounts[app.id] ?? 0) > 0 && <i className="app-folder-mini-running" />}
        </span>
      ))}
      {preview.length === 0 && <Folder />}
    </span>
  );
}

export function AppFolderTile({
  folder,
  apps,
  surface,
  badge = 0,
  runningCounts = {},
  onOpen,
  onDropApp,
  onRename,
  onDistill,
  onCompress,
  onDelete,
  className = ""
}: {
  folder: AppFolder;
  apps: ShellApp[];
  surface: AppFolderSurface;
  badge?: number;
  runningCounts?: Record<string, number>;
  onOpen(folder: AppFolder): void;
  onDropApp?(folder: AppFolder, app: ShellApp): void;
  onRename?(folder: AppFolder): void;
  onDistill?(folder: AppFolder): void;
  onCompress?(folder: AppFolder): void;
  onDelete?(folder: AppFolder): void;
  className?: string;
}) {
  const [context, setContext] = useState<{ x: number; y: number } | null>(null);
  const [dropArmed, setDropArmed] = useState(false);
  const dropRect = useRef<DOMRect | null>(null);
  const clearHover = () => { dropRect.current = null; setDropArmed(false); };

  return (
    <>
      <button
        type="button"
        className={`app-folder-tile app-folder-tile-${surface} ${badge > 0 ? "has-running-apps" : ""} ${dropArmed ? "is-drop-target is-folder-intent" : ""} ${className}`}
        data-folder-id={folder.id}
        data-folder-surface={surface}
        onClick={(event) => {
          if (event.currentTarget.dataset.interactionSuppressClick === "true") return;
          event.stopPropagation();
          folderOriginRegistry.capture(folder.id, event.currentTarget, surface);
          onOpen(folder);
        }}
        onContextMenu={(event) => {
          if (!onRename && !onDistill && !onCompress && !onDelete) return;
          event.preventDefault();
          event.stopPropagation();
          setContext({ x: event.clientX, y: event.clientY });
        }}
        onDragEnter={(event) => {
          if (onDropApp && event.dataTransfer.types.includes("application/x-elix-app")) dropRect.current = event.currentTarget.getBoundingClientRect();
        }}
        onDragOver={(event) => {
          if (!onDropApp || !event.dataTransfer.types.includes("application/x-elix-app")) return;
          const bounds = dropRect.current ?? event.currentTarget.getBoundingClientRect();
          dropRect.current = bounds;
          const zone = resolveEboDropZone(bounds, { x: event.clientX, y: event.clientY });
          if (zone !== "center") {
            clearHover();
            return;
          }
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          if (!dropArmed) setDropArmed(true);
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          clearHover();
        }}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          const payload = event.dataTransfer.getData("application/x-elix-app");
          if (!payload || !onDropApp) return clearHover();
          try {
            const app = JSON.parse(payload) as ShellApp;
            const target = event.currentTarget;
            clearHover();
            animateAppIntoFolder(target, app.id, () => onDropApp(folder, app));
          } catch {
            clearHover();
            notifyShell("That application could not be added to the folder.");
          }
        }}
        aria-label={`Open ${folder.name} folder with ${apps.length} applications`}
      >
        <AppFolderPreview folder={folder} apps={apps} compact={surface === "dock"} runningCounts={runningCounts} />
        {surface !== "dock" && <span className="app-folder-name">{folder.name}</span>}
        {badge > 0 && <span className="app-folder-badge">{badge > 999 ? "999+" : badge}</span>}
        {surface === "dock" && <span className="tooltip">{folder.name}</span>}
      </button>
      {context && (
        <ContextMenu
          x={context.x}
          y={context.y}
          label={`${folder.name} folder options`}
          onClose={() => setContext(null)}
          actions={[
            { id: "open", label: "Open", icon: <Folder />, onSelect: () => onOpen(folder) },
            { id: "open-all", label: "Open all", icon: <LayoutGrid />, onSelect: () => { apps.forEach((app) => void performAppPrimaryAction(app, "activate-preferred", "folder")); } },
            ...(onDistill ? [{ id: "distill", label: "Distill", detail: "Ask ELIX to analyze these apps", icon: <Sparkles />, onSelect: () => onDistill(folder) }] : []),
            ...(onRename ? [{ id: "rename", label: "Rename", icon: <Pencil />, onSelect: () => onRename(folder) }] : []),
            ...(onCompress ? [{ id: "compress", label: "Compress to ZIP", detail: "Export this app-folder manifest", icon: <FileArchive />, onSelect: () => onCompress(folder) }] : []),
            ...(onDelete ? [{ id: "delete", label: "Move to Trash", icon: <Trash2 />, danger: true, separatorBefore: true, onSelect: () => onDelete(folder) }] : [])
          ]}
        />
      )}
    </>
  );
}

export function AppFolderOverlay({
  folder,
  apps,
  runningCounts,
  onClose,
  onRename,
  onRemoveApp,
  onDelete,
  onReorder,
  onDropApp,
  onToggleSurface,
  onDistill,
  onCompress,
  startEditing = false
}: {
  folder: AppFolder;
  apps: ShellApp[];
  runningCounts: Record<string, number>;
  onClose(): void;
  onRename(name: string): void;
  onRemoveApp(appId: string): void;
  onDelete(): void;
  onReorder(sourceId: string, targetId: string): void;
  onDropApp(app: ShellApp): void;
  onToggleSurface(surface: AppFolderSurface, visible: boolean): void;
  onDistill?(): void;
  onCompress?(): void;
  startEditing?: boolean;
}) {
  const [page, setPage] = useState(0);
  const [editing, setEditing] = useState(startEditing);
  const [managing, setManaging] = useState(false);
  const [name, setName] = useState(folder.name);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [context, setContext] = useState<{ x: number; y: number } | null>(null);
  const [folderWindowSize, setFolderWindowSize] = useState<FolderWindowSize | null>(() => readFolderWindowSize(folder.id));
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const windowRef = useRef<HTMLElement | null>(null);
  const pageFrameRef = useRef<HTMLDivElement | null>(null);
  useScrollEdgeFade(pageFrameRef);
  const closing = useRef(false);
  const resizeSession = useRef<FolderResizeSession | null>(null);
  const resizeFrame = useRef(0);
  const folderItemRects = useRef(new Map<string, DOMRect>());
  const pages = Math.max(1, Math.ceil(apps.length / PAGE_SIZE));
  const pageApps = apps.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  const running = useMemo(() => apps.reduce((total, app) => total + (runningCounts[app.id] ?? 0), 0), [apps, runningCounts]);

  const captureFolderLayout = () => {
    const root = windowRef.current;
    if (!root) return;
    folderItemRects.current = new Map(
      [...root.querySelectorAll<HTMLElement>(".app-folder-app[data-folder-app-id]")]
        .map((element) => [element.dataset.folderAppId ?? "", element.getBoundingClientRect()] as const)
        .filter(([id]) => Boolean(id))
    );
  };

  useLayoutEffect(() => {
    if (folderItemRects.current.size === 0) return;
    if (reducedMotion()) {
      folderItemRects.current = new Map();
      return;
    }
    const before = folderItemRects.current;
    folderItemRects.current = new Map();
    const root = windowRef.current;
    if (!root) return;
    for (const element of root.querySelectorAll<HTMLElement>(".app-folder-app[data-folder-app-id]")) {
      const previous = before.get(element.dataset.folderAppId ?? "");
      if (!previous) continue;
      const next = element.getBoundingClientRect();
      const dx = previous.left - next.left;
      const dy = previous.top - next.top;
      if (Math.abs(dx) < .5 && Math.abs(dy) < .5) continue;
      element.getAnimations().filter((animation) => animation.id === "elix-folder-reorder-settle").forEach((animation) => animation.cancel());
      const settle = element.animate(
        [
          { transform: `translate3d(${dx}px, ${dy}px, 0) scale(.985)` },
          { transform: "translate3d(0, 0, 0) scale(1.015)", offset: .72 },
          { transform: "translate3d(0, 0, 0) scale(1)" }
        ],
        { duration: 220, easing: "cubic-bezier(.2, .84, .26, 1)" }
      );
      settle.id = "elix-folder-reorder-settle";
    }
  }, [folder.appIds.join("|")]);

  useEffect(() => {
    setName(folder.name);
    setPage((current) => Math.min(current, Math.max(0, pages - 1)));
  }, [folder.name, pages]);

  useEffect(() => {
    setFolderWindowSize(readFolderWindowSize(folder.id));
  }, [folder.id]);

  useEffect(() => {
    if (startEditing) setEditing(true);
  }, [folder.id, startEditing]);

  useEffect(() => {
    const overlay = overlayRef.current;
    const windowElement = windowRef.current;
    if (!overlay || !windowElement || reducedMotion()) return;
    const origin = folderOriginRegistry.latest(folder.id);
    const finalRect = windowElement.getBoundingClientRect();
    const originRect = origin?.rect;
    const originCenterX = originRect ? originRect.left + originRect.width / 2 : finalRect.left + finalRect.width / 2;
    const originCenterY = originRect ? originRect.top + originRect.height / 2 : finalRect.top + finalRect.height / 2;
    const finalCenterX = finalRect.left + finalRect.width / 2;
    const finalCenterY = finalRect.top + finalRect.height / 2;
    const dx = originCenterX - finalCenterX;
    const dy = originCenterY - finalCenterY;
    const sx = originRect ? Math.max(.12, Math.min(1, originRect.width / Math.max(1, finalRect.width))) : .88;
    const sy = originRect ? Math.max(.12, Math.min(1, originRect.height / Math.max(1, finalRect.height))) : .88;

    const motions: Animation[] = [];
    motions.push(overlay.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150, easing: "linear" }));
    const surfaceMotion = windowElement.animate([
      { opacity: .45, transform: `translate3d(${dx}px, ${dy}px, 0) scale(${sx}, ${sy})`, borderRadius: "28px" },
      { opacity: 1, transform: "translate3d(0, 0, 0) scale(1, 1)", borderRadius: getComputedStyle(windowElement).borderRadius }
    ], { duration: 285, easing: "cubic-bezier(.18,.86,.24,1)", fill: "both" });
    surfaceMotion.id = "elix-folder-origin-morph-open";
    motions.push(surfaceMotion);

    const items = [...windowElement.querySelectorAll<HTMLElement>(".app-folder-app")];
    items.forEach((item, index) => {
      const rect = item.getBoundingClientRect();
      const itemCenterX = rect.left + rect.width / 2;
      const itemCenterY = rect.top + rect.height / 2;
      const itemDx = (originCenterX - itemCenterX) * .82;
      const itemDy = (originCenterY - itemCenterY) * .82;
      const motion = item.animate([
        { opacity: 0, transform: `translate3d(${itemDx}px, ${itemDy}px,0) scale(.34)` },
        { opacity: 1, transform: "translate3d(0,0,0) scale(1.018)", offset: .82 },
        { opacity: 1, transform: "translate3d(0,0,0) scale(1)" }
      ], { duration: 260, delay: Math.min(72, index * 12), easing: "cubic-bezier(.18,.86,.24,1)", fill: "both" });
      motion.id = "elix-folder-item-origin-open";
      motions.push(motion);
    });
    motions.forEach((motion) => void motion.finished.finally(() => motion.cancel()).catch(() => motion.cancel()));
    return () => motions.forEach((motion) => motion.cancel());
  }, [folder.id]);

  const applyFolderResizePreview = (session: FolderResizeSession) => {
    const maxWidth = Math.max(320, Math.min(760, window.innerWidth - 28));
    const maxHeight = Math.max(300, Math.min(760, window.innerHeight - 142));
    const nextWidth = session.direction.includes("e")
      ? Math.max(320, Math.min(maxWidth, Math.round(session.width + session.latestX - session.startX)))
      : session.width;
    const nextHeight = session.direction.includes("s")
      ? Math.max(300, Math.min(maxHeight, Math.round(session.height + session.latestY - session.startY)))
      : session.height;
    session.proposed = { width: nextWidth, height: nextHeight };
    session.element.style.setProperty("--folder-window-width", `${session.proposed.width}px`);
    session.element.style.setProperty("--folder-window-height", `${session.proposed.height}px`);
    session.element.style.setProperty("--folder-window-max-height", `${session.proposed.height}px`);
  };

  const scheduleFolderResize = (pointerId: number, clientX: number, clientY: number) => {
    const session = resizeSession.current;
    if (!session || session.pointerId !== pointerId) return;
    session.latestX = clientX;
    session.latestY = clientY;
    if (resizeFrame.current) return;
    resizeFrame.current = requestAnimationFrame(() => {
      resizeFrame.current = 0;
      if (resizeSession.current) applyFolderResizePreview(resizeSession.current);
    });
  };

  const beginFolderResize = (event: ReactPointerEvent<HTMLButtonElement>, direction: "e" | "s" | "se") => {
    if (event.button !== 0) return;
    const element = windowRef.current;
    const owner = `folder-window:${folder.id}`;
    if (!element || !uiResizeManager.claim(owner)) return;
    const bounds = element.getBoundingClientRect();
    resizeSession.current = {
      owner,
      direction,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      width: bounds.width,
      height: bounds.height,
      latestX: event.clientX,
      latestY: event.clientY,
      proposed: { width: bounds.width, height: bounds.height },
      element
    };
    element.classList.add("is-resizing");
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  };

  const completeFolderResize = (pointerId: number, cancelled = false) => {
    const session = resizeSession.current;
    if (!session || session.pointerId !== pointerId) return;
    if (resizeFrame.current) {
      cancelAnimationFrame(resizeFrame.current);
      resizeFrame.current = 0;
    }
    applyFolderResizePreview(session);
    session.element.classList.remove("is-resizing");
    if (cancelled) {
      if (folderWindowSize) {
        session.element.style.setProperty("--folder-window-width", `${folderWindowSize.width}px`);
        session.element.style.setProperty("--folder-window-height", `${folderWindowSize.height}px`);
        session.element.style.setProperty("--folder-window-max-height", `${folderWindowSize.height}px`);
      } else {
        session.element.style.removeProperty("--folder-window-width");
        session.element.style.removeProperty("--folder-window-height");
        session.element.style.removeProperty("--folder-window-max-height");
      }
    } else {
      setFolderWindowSize(session.proposed);
      shellStorage.setItem(folderSizeKey(folder.id), JSON.stringify(session.proposed));
    }
    uiResizeManager.release(session.owner);
    resizeSession.current = null;
  };

  useEffect(() => {
    const move = (event: PointerEvent) => scheduleFolderResize(event.pointerId, event.clientX, event.clientY);
    const up = (event: PointerEvent) => completeFolderResize(event.pointerId);
    const cancel = (event: PointerEvent) => completeFolderResize(event.pointerId, true);
    const blur = () => {
      const session = resizeSession.current;
      if (session) completeFolderResize(session.pointerId, true);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", blur);
    return () => {
      if (resizeFrame.current) cancelAnimationFrame(resizeFrame.current);
      const session = resizeSession.current;
      if (session) uiResizeManager.release(session.owner);
      resizeSession.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", blur);
    };
  }, [folder.id, folderWindowSize]);

  const requestClose = (afterClose?: () => void) => {
    if (closing.current) return;
    const overlay = overlayRef.current;
    const windowElement = windowRef.current;
    if (!overlay || !windowElement || reducedMotion()) {
      afterClose?.();
      onClose();
      return;
    }
    closing.current = true;
    windowElement.style.pointerEvents = "none";
    const origin = folderOriginRegistry.latest(folder.id);
    const finalRect = windowElement.getBoundingClientRect();
    const originRect = origin?.rect;
    const originCenterX = originRect ? originRect.left + originRect.width / 2 : finalRect.left + finalRect.width / 2;
    const originCenterY = originRect ? originRect.top + originRect.height / 2 : finalRect.top + finalRect.height / 2;
    const finalCenterX = finalRect.left + finalRect.width / 2;
    const finalCenterY = finalRect.top + finalRect.height / 2;
    const dx = originCenterX - finalCenterX;
    const dy = originCenterY - finalCenterY;
    const sx = originRect ? Math.max(.12, Math.min(1, originRect.width / Math.max(1, finalRect.width))) : .88;
    const sy = originRect ? Math.max(.12, Math.min(1, originRect.height / Math.max(1, finalRect.height))) : .88;

    const closingMotions: Animation[] = [];
    [...windowElement.querySelectorAll<HTMLElement>(".app-folder-app")].forEach((item, index) => {
      const rect = item.getBoundingClientRect();
      const itemDx = (originCenterX - (rect.left + rect.width / 2)) * .9;
      const itemDy = (originCenterY - (rect.top + rect.height / 2)) * .9;
      closingMotions.push(item.animate([
        { opacity: 1, transform: "translate3d(0,0,0) scale(1)" },
        { opacity: 0, transform: `translate3d(${itemDx}px, ${itemDy}px,0) scale(.28)` }
      ], { duration: 185, delay: Math.min(48, index * 6), easing: "cubic-bezier(.45,0,.72,.2)", fill: "forwards" }));
    });
    const windowMotion = windowElement.animate([
      { opacity: 1, transform: "translate3d(0, 0, 0) scale(1,1)" },
      { opacity: .2, transform: `translate3d(${dx}px, ${dy}px, 0) scale(${sx}, ${sy})`, borderRadius: "28px" }
    ], { duration: 230, easing: "cubic-bezier(.42,0,.72,.18)", fill: "forwards" });
    windowMotion.id = "elix-folder-origin-morph-close";
    closingMotions.push(windowMotion);
    closingMotions.push(overlay.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 210, easing: "linear", fill: "forwards" }));
    windowMotion.finished.catch(() => undefined).finally(() => {
      closingMotions.forEach((motion) => motion.cancel());
      folderOriginRegistry.clear(folder.id);
      afterClose?.();
      onClose();
    });
  };

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !editing) requestClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  });

  const saveName = () => {
    const next = name.trim() || "New Folder";
    onRename(next);
    setName(next);
    setEditing(false);
  };

  const launchFromFolder = (event: React.MouseEvent<HTMLButtonElement>, app: ShellApp) => {
    if (event.currentTarget.closest<HTMLElement>(".app-folder-app")?.dataset.folderDragSuppressClick === "true") return;
    const bounds = event.currentTarget.getBoundingClientRect();
    void performAppPrimaryAction(app, "activate-preferred", "folder", {
      sourceElementId: `folder:${folder.id}:${app.id}`,
      sourceBounds: { x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height }
    }).catch((error: Error) => notifyShell(error.message));
  };

  return createPortal((
    <div ref={overlayRef} className="app-folder-overlay" role="presentation" onPointerDown={(event) => {
      if (event.target === event.currentTarget) requestClose();
    }}>
      <section
        ref={windowRef}
        className={`app-folder-window app-folder-${folder.color} ${managing ? "is-managing" : ""}`}
        style={folderWindowSize ? {
          "--folder-window-width": `${folderWindowSize.width}px`,
          "--folder-window-height": `${folderWindowSize.height}px`,
          "--folder-window-max-height": `${folderWindowSize.height}px`
        } as CSSProperties : undefined}
        role="dialog"
        aria-modal="true"
        aria-label={`${folder.name} application folder`}
        onContextMenu={(event) => {
          event.preventDefault();
          setContext({ x: event.clientX, y: event.clientY });
        }}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes("application/x-elix-app")) event.preventDefault();
        }}
        onDrop={(event) => {
          const payload = event.dataTransfer.getData("application/x-elix-app");
          if (!payload) return;
          event.preventDefault();
          try { onDropApp(JSON.parse(payload) as ShellApp); }
          catch { notifyShell("That application could not be added to the folder."); }
        }}
      >
        <header className="app-folder-header">
          <div className="app-folder-title-row">
            {editing ? (
              <label className="app-folder-name-editor">
                <span className="sr-only">Folder name</span>
                <input value={name} maxLength={48} autoFocus onChange={(event) => setName(event.target.value)} onKeyDown={(event) => {
                  if (event.key === "Enter") saveName();
                  if (event.key === "Escape") { setName(folder.name); setEditing(false); }
                }} />
                <button type="button" onClick={saveName} aria-label="Save folder name"><Check /></button>
              </label>
            ) : (
              <button className="app-folder-title" type="button" onDoubleClick={() => setEditing(true)} title="Double-click to rename · right-click for options">
                <strong>{folder.name}</strong>
              </button>
            )}
            <button className="app-folder-manage" type="button" aria-label={managing ? "Finish editing folder" : "Edit folder"} aria-pressed={managing} title={managing ? "Finish editing" : "Edit folder"} onClick={() => setManaging((current) => !current)}>{managing ? <Check /> : <Pencil />}</button>
            <button className="app-folder-close" type="button" onClick={() => requestClose()} aria-label="Close folder"><X /></button>
          </div>
          <div className="app-folder-meta" aria-hidden={!managing}>
            <span>{apps.length} app{apps.length === 1 ? "" : "s"}</span>
            {running > 0 && <span>{running} running</span>}
          </div>
        </header>

        <div ref={pageFrameRef} className={`app-folder-page-frame ${pageApps.length === 0 ? "is-empty" : ""}`}>
          {page > 0 && <button className="app-folder-page-arrow previous" type="button" onClick={() => setPage((value) => Math.max(0, value - 1))}><ChevronLeft /></button>}
          <div className="app-folder-app-grid" data-page={page}>
            {pageApps.map((app) => (
              <div className={`app-folder-app ${draggedId === app.id ? "is-dragging" : ""}`} key={app.id} data-folder-app-id={app.id} draggable
                onPointerDown={(event) => {
                  if (event.button !== 0 || (event.target as HTMLElement).closest(".app-folder-remove-app")) return;
                  const root = windowRef.current;
                  if (!root) return;
                  const source = event.currentTarget;
                  const started = folderDragSessionManager.begin({
                    pointerId: event.pointerId,
                    startX: event.clientX,
                    startY: event.clientY,
                    sourceId: app.id,
                    sourceElement: source,
                    root,
                    onDrop: (targetId) => {
                      if (!targetId || targetId === app.id) return;
                      captureFolderLayout();
                      onReorder(app.id, targetId);
                    }
                  });
                  if (started) event.preventDefault();
                }}
                onDragStart={(event) => {
                captureFolderLayout();
                setDraggedId(app.id);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("application/x-elix-app", JSON.stringify(app));
                event.dataTransfer.setData("text/elix-folder-app", app.id);
                event.dataTransfer.setData("application/x-elix-drag-origin", "folder");
              }} onDragEnd={() => setDraggedId(null)} onDragOver={(event) => {
                if (draggedId && draggedId !== app.id) event.preventDefault();
              }} onDrop={(event) => {
                const sourceId = event.dataTransfer.getData("text/elix-folder-app");
                if (!sourceId || sourceId === app.id) return;
                event.preventDefault();
                event.stopPropagation();
                captureFolderLayout();
                onReorder(sourceId, app.id);
              }}>
                <button type="button" onClick={(event) => launchFromFolder(event, app)} aria-label={`Launch ${app.name}`}>
                  <span className={`app-icon app-folder-icon-ring ${app.iconClass} ${app.iconUrl ? "native-icon-image" : ""}`}><AppGlyph app={app} /></span>
                  <span className="app-folder-app-label" title={app.name}>{app.name}</span>
                  {(runningCounts[app.id] ?? 0) > 0 && <i className="app-folder-running-dot" />}
                </button>
                {managing && <button className="app-folder-remove-app" type="button" onClick={() => onRemoveApp(app.id)} aria-label={`Remove ${app.name} from folder`}><X /></button>}
              </div>
            ))}
            {pageApps.length === 0 && <div className="app-folder-empty"><Folder /><strong>Drop apps here</strong><span className="sr-only">Drag an application onto this folder.</span></div>}
          </div>
          {page + 1 < pages && <button className="app-folder-page-arrow next" type="button" onClick={() => setPage((value) => Math.min(pages - 1, value + 1))}><ChevronRight /></button>}
        </div>

        {pages > 1 && <div className="app-folder-pagination" aria-label="Folder pages">{Array.from({ length: pages }, (_, index) => <button key={index} type="button" aria-label={`Page ${index + 1}`} aria-current={index === page} onClick={() => setPage(index)} />)}</div>}

        <footer className="app-folder-footer" aria-hidden={!managing}>
          <div className="app-folder-surface-toggles" aria-label="Folder locations">
            <SurfaceToggle icon={<Home />} label="Home" active={folder.surfaces.desktop} onChange={(value) => onToggleSurface("desktop", value)} />
            <SurfaceToggle icon={<PanelBottom />} label="Dock" active={folder.surfaces.dock} onChange={(value) => onToggleSurface("dock", value)} />
            <SurfaceToggle icon={<LayoutGrid />} label="Start" active={folder.surfaces.start} onChange={(value) => onToggleSurface("start", value)} />
          </div>
          <button className="app-folder-delete" type="button" onClick={() => requestClose(onDelete)}><Trash2 />Delete folder</button>
        </footer>
        <AttachedResizeHandle
          className="elix-edge-resize-grip app-folder-resize-grip"
          direction="se"
          aria-label={`Resize ${folder.name} folder width and height`}
          onPointerDown={(event) => beginFolderResize(event, "se")}
          onLostPointerCapture={(event) => {
            if (resizeSession.current?.pointerId === event.pointerId) completeFolderResize(event.pointerId, true);
          }}
        />
        <button
          type="button"
          className="app-folder-resize-rail app-folder-resize-bottom"
          aria-label={`Resize ${folder.name} folder height`}
          onPointerDown={(event) => beginFolderResize(event, "s")}
        />
        <button
          type="button"
          className="app-folder-resize-rail app-folder-resize-corner"
          aria-label={`Resize ${folder.name} folder width and height`}
          onPointerDown={(event) => beginFolderResize(event, "se")}
        />
      </section>
      {context && <ContextMenu x={context.x} y={context.y} label={`${folder.name} folder options`} onClose={() => setContext(null)} actions={[
        { id: "open-all", label: "Open all", icon: <LayoutGrid />, onSelect: () => { apps.forEach((app) => void performAppPrimaryAction(app, "activate-preferred", "folder")); } },
        ...(onDistill ? [{ id: "distill", label: "Distill", detail: "Analyze folder contents with ELIX", icon: <Sparkles />, onSelect: onDistill }] : []),
        { id: "rename", label: "Rename", icon: <Pencil />, onSelect: () => { setManaging(true); setEditing(true); } },
        ...(onCompress ? [{ id: "compress", label: "Compress to ZIP", icon: <FileArchive />, onSelect: onCompress }] : []),
        { id: "delete", label: "Move to Trash", icon: <Trash2 />, danger: true, separatorBefore: true, onSelect: () => requestClose(onDelete) }
      ]} />}
    </div>
  ), document.body);
}

function SurfaceToggle({ icon, label, active, onChange }: { icon: React.ReactNode; label: string; active: boolean; onChange(value: boolean): void }) {
  return <button type="button" className={active ? "active" : ""} aria-pressed={active} onClick={() => onChange(!active)}>{icon}<span>{label}</span></button>;
}
