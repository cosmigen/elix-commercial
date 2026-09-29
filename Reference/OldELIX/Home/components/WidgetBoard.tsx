import { Grip, Minus } from "../icons";
import { useEffect, useRef, useState } from "react";
import type { IntegrationStatus, SystemSummary, WidgetManifest } from "../osService";
import { notifyShell, openNative } from "../model";
import { WidgetContent } from "./widgets/WidgetContent";
import { shellStorage } from "../managers/shellStorage";
import { layoutManager } from "../layouts/layoutManager";
import { uiResizeManager } from "../managers/uiResizeManager";
import { useSystemTelemetrySnapshot } from "../managers/systemTelemetryManager";
import { DragSession } from "../interactions/dragSession";
import { desktopLayoutManager, type DesktopLayoutResolution, type DesktopLayoutSessionHandle } from "../managers/desktopLayoutManager";
import { clearDesktopLayoutPreview, renderDesktopLayoutPreview } from "../interactions/desktopLayoutPreview";
import { AttachedResizeHandle } from "./AttachedResizeHandle";

type WidgetGeometry = { x: number; y: number; w: number; h: number };
type Gesture = {
  id: string;
  mode: "move" | "resize";
  pointerId: number;
  startX: number;
  startY: number;
  geometry: WidgetGeometry;
  proposed: WidgetGeometry;
  element: HTMLElement;
  startedAt: number;
  activated: boolean;
  moved: boolean;
  preview: Record<string, WidgetGeometry>;
  dragSession: DragSession | null;
  desktopSession: DesktopLayoutSessionHandle;
  layoutResolution: DesktopLayoutResolution | null;
};

interface WidgetBoardProps {
  manifests: WidgetManifest[];
  visibleIds: Set<string>;
  integrations: IntegrationStatus | null;
  system: SystemSummary | null;
  appCount: number;
  runningWindowCount: number;
  remove(id: string): void;
}

const unitX = 86;
const unitY = 72;
const finiteGeometryValue = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;
const normalizeWidgetGeometry = (manifest: WidgetManifest, value?: Partial<WidgetGeometry> | null): WidgetGeometry => ({
  x: finiteGeometryValue(value?.x, manifest.defaultLayout.x),
  y: finiteGeometryValue(value?.y, manifest.defaultLayout.y),
  w: Math.max(manifest.minimumSize.w, finiteGeometryValue(value?.w, manifest.defaultLayout.w)),
  h: Math.max(manifest.minimumSize.h, finiteGeometryValue(value?.h, manifest.defaultLayout.h))
});

export function WidgetBoard({
  manifests,
  visibleIds,
  integrations,
  system,
  appCount,
  runningWindowCount,
  remove
}: WidgetBoardProps) {
  const battery = useSystemTelemetrySnapshot().battery;
  const [geometry, setGeometry] = useState<Record<string, WidgetGeometry>>(() => {
    try {
      const saved = JSON.parse(shellStorage.getItem("elix.widget-layout") ?? "{}") as Record<string, WidgetGeometry>;
      const migrationKey = "elix.widget.desktop-composition.v4";
      if (shellStorage.getItem(migrationKey) !== "true") {
        // Align the two right-side widgets into one calm column. The shared
        // desktop manager remains authoritative and can reflow these logical
        // cells when the work area is narrower.
        saved["anime-clock"] = { x: 8, y: 3, w: 2, h: 4 };
        saved.search = { x: 7, y: 7, w: 3, h: 1 };
        shellStorage.setItem(migrationKey, "true");
      }
      return saved;
    } catch {
      return {};
    }
  });
  const [aliases, setAliases] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(shellStorage.getItem("elix.widget-aliases") ?? "{}") as Record<string, string>;
    } catch {
      return {};
    }
  });
  const gesture = useRef<Gesture | null>(null);
  const gestureFrame = useRef(0);
  const pendingPointer = useRef<{ pointerId: number; clientX: number; clientY: number } | null>(null);
  const placementPreview = useRef<HTMLDivElement | null>(null);
  const suppressAction = useRef(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [customizing, setCustomizing] = useState(false);
  const externalVisibilityAuthority = useRef(false);
  const [effectiveVisibleIds, setEffectiveVisibleIds] = useState<Set<string>>(() => new Set(visibleIds));

  useEffect(() => {
    if (!externalVisibilityAuthority.current) setEffectiveVisibleIds(new Set(visibleIds));
  }, [visibleIds]);

  useEffect(() => {
    const receiveVisibleWidgets = (event: Event) => {
      const ids = (event as CustomEvent<string[]>).detail;
      if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) return;
      externalVisibilityAuthority.current = true;
      const next = new Set(ids);
      setEffectiveVisibleIds(next);
      shellStorage.setItem("elix.visible-widgets", JSON.stringify([...next]));
    };
    window.addEventListener("elix-visible-widgets-changed", receiveVisibleWidgets);
    return () => window.removeEventListener("elix-visible-widgets-changed", receiveVisibleWidgets);
  }, []);

  const removeVisibleWidget = (id: string) => {
    if (externalVisibilityAuthority.current) {
      setEffectiveVisibleIds((current) => {
        const next = new Set(current);
        next.delete(id);
        shellStorage.setItem("elix.visible-widgets", JSON.stringify([...next]));
        return next;
      });
    }
    remove(id);
  };

  useEffect(() => {
    // Compatibility mirror only; LayoutManager owns canonical final widget geometry.
    shellStorage.setItem("elix.widget-layout", JSON.stringify(geometry));
  }, [geometry]);

  useEffect(() => {
    shellStorage.setItem("elix.widget-aliases", JSON.stringify(aliases));
  }, [aliases]);

  useEffect(() => {
    const syncLayout = () => {
      const instances = layoutManager.getInstances("desktop.widgets");
      if (!Object.keys(instances).length) return;
      setGeometry((current) => {
        const next = { ...current };
        for (const [id, value] of Object.entries(instances)) {
          const widgetId = id.slice("desktop.widgets.".length);
          const manifest = manifests.find((item) => item.id === widgetId);
          if (manifest) next[widgetId] = normalizeWidgetGeometry(manifest, value as Partial<WidgetGeometry>);
        }
        return next;
      });
    };
    window.addEventListener("elix-layout-config-applied", syncLayout);
    syncLayout();
    return () => window.removeEventListener("elix-layout-config-applied", syncLayout);
  }, [manifests]);

  useEffect(() => {
    const updateCustomization = (event: Event) => {
      const requested = (event as CustomEvent<boolean | undefined>).detail;
      setCustomizing((current) => typeof requested === "boolean" ? requested : !current);
      setEditingId(null);
    };
    window.addEventListener("elix-widgets-customize", updateCustomization);
    return () => window.removeEventListener("elix-widgets-customize", updateCustomization);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.widgetCustomizing = String(customizing);
    document.body.classList.toggle("widget-customizing-active", customizing);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setCustomizing(false);
      setEditingId(null);
      gesture.current = null;
      placementPreview.current?.classList.remove("visible");
      notifyShell("Widget arrangement cancelled.");
    };

    if (customizing) window.addEventListener("keydown", handleKeyDown);
    return () => {
      delete document.documentElement.dataset.widgetCustomizing;
      document.body.classList.remove("widget-customizing-active");
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [customizing]);

  useEffect(() => {
    const clearEditing = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".home-widget") || customizing) return;
      setEditingId(null);
    };
    window.addEventListener("pointerdown", clearEditing, true);
    return () => window.removeEventListener("pointerdown", clearEditing, true);
  }, [customizing]);

  useEffect(() => {
    if (shellStorage.getItem("elix.widget-layout-version") === "3") return;
    const columns = Math.max(3, Math.floor(window.innerWidth / unitX));
    setGeometry((current) => {
      const next = { ...current };
      const clock = manifests.find((manifest) => manifest.id === "clock");
      const systemWidget = manifests.find((manifest) => manifest.id === "system");
      if (clock) next.clock = { ...clock.defaultLayout, x: Math.max(0, columns - clock.defaultLayout.w), y: 2 };
      if (systemWidget) next.system = {
        ...systemWidget.defaultLayout,
        x: Math.max(0, columns - systemWidget.defaultLayout.w),
        y: 4
      };
      return next;
    });
    shellStorage.setItem("elix.widget-layout-version", "3");
  }, [manifests]);

  useEffect(() => {
    const items = manifests.filter((manifest) => effectiveVisibleIds.has(manifest.id)).map((manifest) => {
      const value = normalizeWidgetGeometry(manifest, geometry[manifest.id]);
      return {
        id: `widget:${manifest.id}`,
        type: "widget" as const,
        source: "widget-board",
        x: value.x * unitX,
        y: value.y * unitY,
        width: value.w * unitX - 12,
        height: value.h * unitY - 12,
        gap: 12,
        snapX: unitX,
        snapY: unitY
      };
    });
    desktopLayoutManager.replaceSource("widget-board", items);
  }, [geometry, manifests, effectiveVisibleIds]);

  useEffect(() => desktopLayoutManager.subscribe((commit) => {
    const changed = commit.items.filter((item) => item.type === "widget");
    if (!changed.length) return;
    setGeometry((current) => {
      let dirty = false;
      const next = { ...current };
      for (const item of changed) {
        const id = item.id.slice("widget:".length);
        const manifest = manifests.find((candidate) => candidate.id === id);
        if (!manifest) continue;
        const value = normalizeWidgetGeometry(manifest, current[id]);
        const resolved = {
          x: Math.round(item.x / unitX),
          y: Math.round(item.y / unitY),
          w: Math.max(manifest.minimumSize.w, Math.round((item.width + 12) / unitX)),
          h: Math.max(manifest.minimumSize.h, Math.round((item.height + 12) / unitY))
        };
        if (value.x === resolved.x && value.y === resolved.y && value.w === resolved.w && value.h === resolved.h) continue;
        next[id] = resolved;
        dirty = true;
      }
      return dirty ? next : current;
    });
  }), [manifests]);

  const currentGeometry = (manifest: WidgetManifest) => {
    const value = normalizeWidgetGeometry(manifest, geometry[manifest.id]);
    return {
      ...value,
      x: Math.max(0, Math.min(Math.floor((window.innerWidth - value.w * unitX) / unitX), value.x)),
      y: Math.max(0, Math.min(Math.floor((window.innerHeight - 126 - value.h * unitY) / unitY), value.y))
    };
  };


  const clearEboPreview = (active: Gesture) => {
    active.preview = { [active.id]: active.proposed };
    clearDesktopLayoutPreview();
  };

  const updateEboPreview = (active: Gesture) => {
    active.layoutResolution = active.desktopSession.resolve({
      x: active.proposed.x * unitX,
      y: active.proposed.y * unitY,
      width: active.proposed.w * unitX - 12,
      height: active.proposed.h * unitY - 12
    });
    renderDesktopLayoutPreview(active.layoutResolution);
  };

  const begin = (event: React.PointerEvent<HTMLElement>, manifest: WidgetManifest, mode: Gesture["mode"]) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const value = currentGeometry(manifest);
    const element = event.currentTarget.closest<HTMLElement>(".home-widget");
    if (!element) return;
    if (mode === "resize" && !uiResizeManager.claim(`widget:${manifest.id}`)) return;
    gesture.current = {
      id: manifest.id,
      mode,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      geometry: value,
      proposed: value,
      element,
      startedAt: performance.now(),
      activated: false,
      moved: false,
      preview: { [manifest.id]: value },
      dragSession: null,
      desktopSession: desktopLayoutManager.createSession(`widget:${manifest.id}`),
      layoutResolution: null
    };
    // Capture immediately so a hold-drag can leave the header without losing the
    // gesture. Visual drag state is intentionally delayed until the movement/hold
    // threshold is crossed, so a quick click still activates the widget.
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch {}
  };

  const updateGesture = (pointerId: number, clientX: number, clientY: number) => {
    const active = gesture.current;
    if (!active || active.pointerId !== pointerId) return;
    const dx = clientX - active.startX;
    const dy = clientY - active.startY;
    const distance = Math.hypot(dx, dy);
    if (!active.activated) {
      // Mirror desktop shortcuts: fast pointer motion needs a larger threshold so
      // normal clicks do not become accidental drags; after a deliberate hold, a
      // much smaller movement arms the compositor drag proxy.
      const elapsed = performance.now() - active.startedAt;
      const threshold = active.mode === "resize" ? 4 : elapsed >= 150 ? 5 : 12;
      if (distance < threshold) return;
      active.activated = true;
      active.moved = true;
      active.element.classList.add("is-grabbed", active.mode === "move" ? "is-moving" : "is-resizing");
      if (active.mode === "move") {
        active.dragSession = new DragSession(
          active.element,
          { x: active.startX, y: active.startY },
          "widget",
          "desktop"
        ).start();
      }
      if (placementPreview.current) {
        Object.assign(placementPreview.current.style, {
          display: "block",
          left: `${active.geometry.x * unitX}px`,
          top: `${active.geometry.y * unitY}px`,
          width: `${active.geometry.w * unitX - 12}px`,
          height: `${active.geometry.h * unitY - 12}px`
        });
      }
    }
    if (active.mode === "move") {
      const exactX = Math.max(
        0,
        Math.min(window.innerWidth - active.geometry.w * unitX, active.geometry.x * unitX + dx)
      );
      const exactY = Math.max(
        0,
        Math.min(window.innerHeight - active.geometry.h * unitY - 126, active.geometry.y * unitY + dy)
      );
      active.proposed = {
        ...active.geometry,
        x: Math.round(exactX / unitX),
        y: Math.round(exactY / unitY)
      };
      active.dragSession?.move(clientX, clientY, 1.025);
    } else {
      const manifest = manifests.find((candidate) => candidate.id === active.id);
      if (!manifest) return;
      active.proposed = {
        ...active.geometry,
        w: Math.max(manifest.minimumSize.w, Math.min(7, active.geometry.w + Math.round(dx / unitX))),
        h: Math.max(manifest.minimumSize.h, Math.min(6, active.geometry.h + Math.round(dy / unitY)))
      };
      active.element.style.width = `${active.proposed.w * unitX - 12}px`;
      active.element.style.height = `${active.proposed.h * unitY - 12}px`;
    }
    updateEboPreview(active);
    if (placementPreview.current) {
      Object.assign(placementPreview.current.style, {
        left: `${active.proposed.x * unitX}px`,
        top: `${active.proposed.y * unitY}px`,
        width: `${active.proposed.w * unitX - 12}px`,
        height: `${active.proposed.h * unitY - 12}px`
      });
    }
  };

  const flushGestureFrame = () => {
    const pending = pendingPointer.current;
    pendingPointer.current = null;
    gestureFrame.current = 0;
    if (pending) updateGesture(pending.pointerId, pending.clientX, pending.clientY);
  };

  const scheduleGesture = (pointerId: number, clientX: number, clientY: number) => {
    pendingPointer.current = { pointerId, clientX, clientY };
    if (!gestureFrame.current) gestureFrame.current = requestAnimationFrame(flushGestureFrame);
  };

  const update = (event: React.PointerEvent<HTMLElement>) => {
    scheduleGesture(event.pointerId, event.clientX, event.clientY);
  };

  const completeGesture = (pointerId: number, captureTarget?: HTMLElement, cancelled = false) => {
    if (pendingPointer.current?.pointerId === pointerId) {
      if (gestureFrame.current) cancelAnimationFrame(gestureFrame.current);
      flushGestureFrame();
    }
    const active = gesture.current;
    if (!active || active.pointerId !== pointerId) return;
    const clearVisuals = () => {
      clearEboPreview(active);
      active.element.style.transform = "";
      if (active.mode === "resize") {
        active.element.style.width = "";
        active.element.style.height = "";
      }
      active.element.classList.remove("is-grabbed", "is-moving", "is-resizing");
      if (placementPreview.current) placementPreview.current.style.display = "none";
    };
    const commitGeometry = () => {
      const resolution = active.layoutResolution ?? active.desktopSession.resolve({
        x: active.proposed.x * unitX,
        y: active.proposed.y * unitY,
        width: active.proposed.w * unitX - 12,
        height: active.proposed.h * unitY - 12
      });
      const resolved = resolution?.items.get(`widget:${active.id}`);
      const committed = resolved ? {
        x: Math.round(resolved.x / unitX),
        y: Math.round(resolved.y / unitY),
        w: Math.max(active.proposed.w, Math.round((resolved.width + 12) / unitX)),
        h: Math.max(active.proposed.h, Math.round((resolved.height + 12) / unitY))
      } : active.proposed;
      if (resolution) desktopLayoutManager.commit(resolution, active.mode === "resize" ? "resize" : "drag");
      layoutManager.updateInstances({
        [`desktop.widgets.${active.id}`]: {
          x: committed.x, y: committed.y, w: committed.w, h: committed.h
        }
      }, active.mode === "resize" ? "Resize widget" : "Move widget");
      clearVisuals();
    };
    if (cancelled && active.dragSession) {
      void active.dragSession.cancel(clearVisuals);
    } else if (!cancelled && active.moved && active.mode === "move" && active.dragSession) {
      const target = active.layoutResolution?.items.get(`widget:${active.id}`);
      void active.dragSession.settleTo({
        left: target?.x ?? active.proposed.x * unitX,
        top: target?.y ?? active.proposed.y * unitY,
        width: target?.width ?? active.proposed.w * unitX - 12,
        height: target?.height ?? active.proposed.h * unitY - 12
      }, commitGeometry);
    } else if (!cancelled && active.moved) {
      commitGeometry();
    } else {
      clearVisuals();
    }
    if (active.moved) suppressAction.current = true;
    if (active.mode === "resize") uiResizeManager.release(`widget:${active.id}`);
    gesture.current = null;
    const target = captureTarget ?? active.element;
    if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
  };

  const end = (event: React.PointerEvent<HTMLElement>) => {
    completeGesture(event.pointerId, event.currentTarget);
  };

  const cancel = (event: React.PointerEvent<HTMLElement>) => {
    completeGesture(event.pointerId, event.currentTarget, true);
  };

  useEffect(() => {
    const recoverMove = (event: PointerEvent) => {
      const active = gesture.current;
      if (!active || active.pointerId !== event.pointerId) return;
      scheduleGesture(event.pointerId, event.clientX, event.clientY);
    };
    const recoverEnd = (event: PointerEvent) => completeGesture(event.pointerId);
    const recoverCancel = (event: PointerEvent) => completeGesture(event.pointerId, undefined, true);
    const recoverBlur = () => {
      const active = gesture.current;
      if (active) completeGesture(active.pointerId, undefined, true);
    };
    window.addEventListener("pointermove", recoverMove);
    window.addEventListener("pointerup", recoverEnd);
    window.addEventListener("pointercancel", recoverCancel);
    window.addEventListener("blur", recoverBlur);
    return () => {
      if (gestureFrame.current) cancelAnimationFrame(gestureFrame.current);
      pendingPointer.current = null;
      window.removeEventListener("pointermove", recoverMove);
      window.removeEventListener("pointerup", recoverEnd);
      window.removeEventListener("pointercancel", recoverCancel);
      window.removeEventListener("blur", recoverBlur);
    };
  }, [manifests, effectiveVisibleIds]);

  const performWidgetAction = (manifest: WidgetManifest) => {
    const configured = manifest.interactions?.leftClick ?? manifest.interactions?.rightClick;
    if (configured?.type === "open-panel") {
      window.dispatchEvent(new CustomEvent("elix-open-panel", { detail: configured.target }));
      return;
    }
    if (configured?.type === "open-system") {
      openNative(configured.target);
      return;
    }
    if (configured?.type === "emit-event") {
      window.dispatchEvent(new CustomEvent(configured.target, {
        detail: { widgetId: manifest.id, entrypoint: manifest.entrypoint, trigger: "left-click" }
      }));
      return;
    }
    const defaultPanel = new Map<string, string>([
      ["builtin:search", "start"],
      ["builtin:shortcuts", "start"],
      ["builtin:quick-settings", "controls"],
      ["builtin:network", "controls"],
      ["builtin:connectivity", "controls"],
      ["builtin:power", "controls"],
      ["builtin:processes", "tasks"],
      ["builtin:performance", "tasks"],
      ["builtin:system", "tasks"],
      ["builtin:backend", "tasks"]
    ]).get(manifest.entrypoint);
    if (defaultPanel) {
      window.dispatchEvent(new CustomEvent("elix-open-panel", { detail: defaultPanel }));
      return;
    }
    const nativeAction = new Map<string, string>([
      ["builtin:clock", "ms-clock:"],
      ["builtin:world-clock", "ms-clock:"],
      ["builtin:date", "ms-clock:"],
      ["builtin:calendar", "outlookcal:"],
      ["builtin:device", "ms-settings:about"],
      ["builtin:drives", "explorer.exe"],
      ["builtin:storage", "ms-settings:storagesense"],
      ["builtin:privacy", "ms-settings:privacy"],
      ["builtin:recent", "explorer.exe shell:Recent"],
      ["builtin:session", "taskmgr.exe"]
    ]).get(manifest.entrypoint);
    if (nativeAction) {
      openNative(nativeAction);
      return;
    }
    notifyShell(`${manifest.name} does not expose a runnable action in this build.`);
  };

  return (
    <section data-layout-element-id="desktop.widgets" className={`widget-board ${customizing ? "is-customizing" : ""}`} aria-label="Home widgets" data-customizing={customizing}>
      {customizing && (
        <div className="widget-customize-toolbar" role="toolbar" aria-label="Widget arrangement controls">
          <span><Grip /><span><strong>Arrange widgets</strong><small>Drag from any widget header. Nearby widgets move out of the way automatically.</small></span></span>
          <button type="button" onClick={() => {
            gesture.current = null;
            placementPreview.current?.classList.remove("visible");
            setCustomizing(false);
            setEditingId(null);
            notifyShell("Widget layout saved.");
          }}>Done</button>
        </div>
      )}
      {manifests.filter((manifest) => effectiveVisibleIds.has(manifest.id)).map((manifest) => {
        const frame = currentGeometry(manifest);
        const displayName = aliases[manifest.id] ?? manifest.name;
        return (
          <article
            key={manifest.id}
            className={`home-widget ${editingId === manifest.id || customizing ? "editing" : ""}`}
            data-widget={manifest.id}
            data-desktop-layout-id={`widget:${manifest.id}`}
            style={{
              left: frame.x * unitX,
              top: frame.y * unitY,
              width: frame.w * unitX - 12,
              height: frame.h * unitY - 12
            }}
            aria-selected={editingId === manifest.id}
            onClick={(event) => {
              event.stopPropagation();
              if (suppressAction.current) {
                suppressAction.current = false;
                return;
              }
              if (customizing) {
                setEditingId(manifest.id);
                return;
              }
              setEditingId(null);
              performWidgetAction(manifest);
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setCustomizing(true);
              setEditingId(manifest.id);
            }}
          >
            <header
              onPointerDown={(event) => {
                // Normal left-click remains an activation. A deliberate hold-drag
                // crosses the gesture threshold and moves the widget directly;
                // customize/edit mode is no longer a prerequisite for movement.
                begin(event, manifest, "move");
              }}
              onPointerMove={update}
              onPointerUp={end}
              onPointerCancel={cancel}
            >
              <Grip />
              {editingId === manifest.id ? (
                <input
                  aria-label={`Rename ${manifest.name}`}
                  value={displayName}
                  onPointerDown={(event) => event.stopPropagation()}
                  onChange={(event) => setAliases((current) => ({
                    ...current,
                    [manifest.id]: event.target.value.slice(0, 32)
                  }))}
                  onBlur={() => setAliases((current) => {
                    const value = current[manifest.id]?.trim();
                    if (value) return { ...current, [manifest.id]: value };
                    const next = { ...current };
                    delete next[manifest.id];
                    return next;
                  })}
                />
              ) : <span>{displayName}</span>}
              <button type="button" aria-label={`Remove ${displayName}`} onPointerDown={(event) => event.stopPropagation()} onClick={() => removeVisibleWidget(manifest.id)}>
                <Minus />
              </button>
            </header>
            <div className="home-widget-visual-host">
              <WidgetContent
                manifest={manifest}
                integrations={integrations}
                system={system}
                battery={battery}
                appCount={appCount}
                runningWindowCount={runningWindowCount}
              />
              {(customizing || editingId === manifest.id) && (
                <AttachedResizeHandle
                  className="widget-resize"
                  direction="se"
                  aria-label={`Resize ${displayName}`}
                  onPointerDown={(event) => begin(event, manifest, "resize")}
                  onPointerMove={update}
                  onPointerUp={end}
                  onPointerCancel={cancel}
                />
              )}
            </div>
          </article>
        );
      })}
      <div ref={placementPreview} className="widget-placement-preview" aria-hidden="true" />
    </section>
  );
}