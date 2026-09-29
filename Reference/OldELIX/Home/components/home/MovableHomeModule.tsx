import { useEffect, useRef } from "react";
import { Maximize2, Move, Trash2 } from "../../icons";
import { clearDesktopLayoutPreview, renderDesktopLayoutPreview } from "../../interactions/desktopLayoutPreview";
import {
  desktopLayoutManager,
  type DesktopLayoutResolution,
  type DesktopLayoutSessionHandle
} from "../../managers/desktopLayoutManager";
import { uiResizeManager } from "../../managers/uiResizeManager";

export type HomeModuleId = "identity" | "clock" | "search";
export type ShortcutPosition = { x: number; y: number };
export type HomeModuleState = {
  visible: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
};

export const homeModuleLimits: Record<HomeModuleId, {
  minWidth: number;
  minHeight: number;
  maxWidth: number;
  maxHeight: number;
}> = {
  identity: { minWidth: 238, minHeight: 40, maxWidth: 560, maxHeight: 76 },
  clock: { minWidth: 260, minHeight: 88, maxWidth: 760, maxHeight: 230 },
  search: { minWidth: 300, minHeight: 44, maxWidth: 860, maxHeight: 82 }
};

type Gesture = {
  mode: "move" | "resize";
  pointerId: number;
  startX: number;
  startY: number;
  origin: ShortcutPosition;
  originWidth: number;
  originHeight: number;
  elementWidth: number;
  elementHeight: number;
  element: HTMLElement;
  desktopSession: DesktopLayoutSessionHandle;
  layoutResolution: DesktopLayoutResolution | null;
};

export function MovableHomeModule({
  id,
  value,
  className,
  selected,
  select,
  remove,
  move,
  resize,
  children
}: {
  id: HomeModuleId;
  value: HomeModuleState;
  className: string;
  selected: boolean;
  select(event: React.MouseEvent<HTMLElement>): void;
  remove(): void;
  move(position: ShortcutPosition): void;
  resize(size: Pick<HomeModuleState, "width" | "height">): void;
  children: React.ReactNode;
}) {
  const gesture = useRef<Gesture | null>(null);
  const gestureFrame = useRef(0);
  const pendingPointer = useRef<{ pointerId: number; clientX: number; clientY: number } | null>(null);

  const begin = (event: React.PointerEvent<HTMLButtonElement>, mode: Gesture["mode"]) => {
    const element = event.currentTarget.closest<HTMLElement>(".home-module");
    if (!element) return;
    if (mode === "resize" && !uiResizeManager.claim(`home-module:${id}`)) return;
    const bounds = element.getBoundingClientRect();
    gesture.current = {
      mode,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: { x: value.x, y: value.y },
      originWidth: value.width,
      originHeight: value.height,
      elementWidth: bounds.width,
      elementHeight: bounds.height,
      element,
      desktopSession: desktopLayoutManager.createSession(`module:${id}`),
      layoutResolution: null
    };
    element.classList.add(mode === "move" ? "is-moving" : "is-resizing");
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  };

  const updateGesture = (pointerId: number, clientX: number, clientY: number) => {
    const active = gesture.current;
    if (!active || active.pointerId !== pointerId) return;
    const dx = clientX - active.startX;
    const dy = clientY - active.startY;
    if (active.mode === "move") {
      const x = Math.max(12, Math.min(window.innerWidth - active.elementWidth - 12, active.origin.x + dx));
      const y = Math.max(12, Math.min(window.innerHeight - active.elementHeight - 118, active.origin.y + dy));
      active.element.style.transform = `translate3d(${x - active.origin.x}px, ${y - active.origin.y}px, 0)`;
      active.element.dataset.previewX = String(Math.round(x));
      active.element.dataset.previewY = String(Math.round(y));
      active.layoutResolution = active.desktopSession.resolve({
        x,
        y,
        width: active.originWidth,
        height: active.originHeight
      });
      renderDesktopLayoutPreview(active.layoutResolution);
      return;
    }
    const limits = homeModuleLimits[id];
    const maxWidth = Math.max(limits.minWidth, Math.min(limits.maxWidth, window.innerWidth - active.origin.x - 12));
    const maxHeight = Math.max(limits.minHeight, Math.min(limits.maxHeight, window.innerHeight - active.origin.y - 118));
    const width = Math.max(limits.minWidth, Math.min(maxWidth, active.originWidth + dx));
    const height = Math.max(limits.minHeight, Math.min(maxHeight, active.originHeight + dy));
    active.element.style.width = `${Math.round(width)}px`;
    active.element.style.height = `${Math.round(height)}px`;
    active.element.dataset.previewWidth = String(Math.round(width));
    active.element.dataset.previewHeight = String(Math.round(height));
    // Neighbor layout changes only when the logical resize step changes. The
    // selected module itself still tracks every rendered pointer frame.
    active.layoutResolution = active.desktopSession.resolve({
      x: active.origin.x,
      y: active.origin.y,
      width: Math.round(width / 12) * 12,
      height: Math.round(height / 12) * 12
    });
    renderDesktopLayoutPreview(active.layoutResolution);
  };


  const flushGesture = () => {
    const point = pendingPointer.current;
    pendingPointer.current = null;
    gestureFrame.current = 0;
    if (point) updateGesture(point.pointerId, point.clientX, point.clientY);
  };

  const scheduleGesture = (pointerId: number, clientX: number, clientY: number) => {
    pendingPointer.current = { pointerId, clientX, clientY };
    if (!gestureFrame.current) gestureFrame.current = requestAnimationFrame(flushGesture);
  };

  const completeGesture = (pointerId: number) => {
    if (pendingPointer.current?.pointerId === pointerId) {
      if (gestureFrame.current) cancelAnimationFrame(gestureFrame.current);
      flushGesture();
    }
    const active = gesture.current;
    if (!active || active.pointerId !== pointerId) return;
    const x = Number(active.element.dataset.previewX ?? active.origin.x);
    const y = Number(active.element.dataset.previewY ?? active.origin.y);
    const width = Number(active.element.dataset.previewWidth ?? active.originWidth);
    const height = Number(active.element.dataset.previewHeight ?? active.originHeight);
    active.element.style.transform = "";
    if (active.mode === "resize") {
      active.element.style.width = "";
      active.element.style.height = "";
    }
    active.element.classList.remove("is-moving", "is-resizing");
    delete active.element.dataset.previewX;
    delete active.element.dataset.previewY;
    delete active.element.dataset.previewWidth;
    delete active.element.dataset.previewHeight;
    if (active.mode === "resize") uiResizeManager.release(`home-module:${id}`);
    gesture.current = null;
    clearDesktopLayoutPreview();
    const resolution = active.layoutResolution ?? active.desktopSession.resolve({ x, y, width, height });
    if (resolution) desktopLayoutManager.commit(resolution, active.mode === "move" ? "drag" : "resize");
    else if (active.mode === "move") move({ x, y });
    else resize({ width, height });
  };

  useEffect(() => {
    const update = (event: PointerEvent) => scheduleGesture(event.pointerId, event.clientX, event.clientY);
    const finish = (event: PointerEvent) => completeGesture(event.pointerId);
    window.addEventListener("pointermove", update);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    return () => {
      window.removeEventListener("pointermove", update);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      if (gestureFrame.current) cancelAnimationFrame(gestureFrame.current);
      pendingPointer.current = null;
      clearDesktopLayoutPreview();
      if (gesture.current?.mode === "resize") uiResizeManager.release(`home-module:${id}`);
    };
  }, [id, move, resize, value.height, value.width, value.x, value.y]);

  if (!value.visible) return null;
  const update = (event: React.PointerEvent<HTMLButtonElement>) => scheduleGesture(event.pointerId, event.clientX, event.clientY);
  const end = (event: React.PointerEvent<HTMLButtonElement>) => {
    completeGesture(event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return (
    <section
      className={`home-module ${className} ${selected ? "selected editing" : ""}`}
      data-home-module={id}
      data-desktop-layout-id={`module:${id}`}
      data-selection-kind="module"
      data-selection-id={id}
      style={{ left: value.x, top: value.y, width: value.width, height: value.height }}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        select(event);
      }}
    >
      <div className="home-module-tools">
        <button className="home-module-move" type="button" aria-label={`Move ${id}`} onPointerDown={(event) => begin(event, "move")} onPointerMove={update} onPointerUp={end} onPointerCancel={end}>
          <Move />
        </button>
        <button type="button" aria-label={`Remove ${id}`} onClick={remove}><Trash2 /></button>
      </div>
      {children}
      <button className="home-module-resize" type="button" aria-label={`Resize ${id}`} onPointerDown={(event) => begin(event, "resize")} onPointerMove={update} onPointerUp={end} onPointerCancel={end}>
        <Maximize2 />
      </button>
    </section>
  );
}
