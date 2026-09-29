export type DesktopSelectionKind = "app" | "folder" | "module";
export type DesktopSelectionMode = "replace" | "add" | "toggle";

export type DesktopSelectionRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

export type DesktopSelectionSnapshot = {
  apps: Set<string>;
  folders: Set<string>;
  modules: Set<string>;
};

export type DesktopSelectionTarget = {
  kind: DesktopSelectionKind;
  id: string;
  rect: Pick<DOMRect, "left" | "top" | "right" | "bottom">;
};

type DesktopSelectionGesture = {
  pointerId: number;
  startX: number;
  startY: number;
  mode: DesktopSelectionMode;
  base: DesktopSelectionSnapshot;
  moved: boolean;
};

const cloneSet = (values: Set<string>) => new Set(values);

export const cloneDesktopSelection = (selection: DesktopSelectionSnapshot): DesktopSelectionSnapshot => ({
  apps: cloneSet(selection.apps),
  folders: cloneSet(selection.folders),
  modules: cloneSet(selection.modules)
});

export const emptyDesktopSelection = (): DesktopSelectionSnapshot => ({
  apps: new Set<string>(),
  folders: new Set<string>(),
  modules: new Set<string>()
});

export const selectionModeFromModifiers = (modifiers: {
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}): DesktopSelectionMode => {
  if (modifiers.ctrlKey || modifiers.metaKey) return "toggle";
  if (modifiers.shiftKey) return "add";
  return "replace";
};

export const selectionRectFromPoints = (
  startX: number,
  startY: number,
  currentX: number,
  currentY: number
): DesktopSelectionRect => {
  const left = Math.min(startX, currentX);
  const top = Math.min(startY, currentY);
  const right = Math.max(startX, currentX);
  const bottom = Math.max(startY, currentY);
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top
  };
};

export const selectionRectIntersects = (
  selection: Pick<DesktopSelectionRect, "left" | "top" | "right" | "bottom">,
  target: Pick<DOMRect, "left" | "top" | "right" | "bottom">
) => target.left < selection.right &&
  target.right > selection.left &&
  target.top < selection.bottom &&
  target.bottom > selection.top;

const bucketForKind = (selection: DesktopSelectionSnapshot, kind: DesktopSelectionKind) => {
  if (kind === "app") return selection.apps;
  if (kind === "folder") return selection.folders;
  return selection.modules;
};

export const applyDesktopSelection = (
  base: DesktopSelectionSnapshot,
  targets: DesktopSelectionTarget[],
  rect: DesktopSelectionRect,
  mode: DesktopSelectionMode
): DesktopSelectionSnapshot => {
  const next = mode === "replace" ? emptyDesktopSelection() : cloneDesktopSelection(base);
  for (const target of targets) {
    if (!selectionRectIntersects(rect, target.rect)) continue;
    const bucket = bucketForKind(next, target.kind);
    if (mode === "toggle") {
      if (bucket.has(target.id)) bucket.delete(target.id);
      else bucket.add(target.id);
    } else {
      bucket.add(target.id);
    }
  }
  return next;
};

/**
 * Owns desktop marquee-selection state. React remains responsible only for
 * rendering the rectangle and applying the returned immutable selection.
 * This keeps pointer capture, modifier semantics and cancellation consistent
 * across the Home app grid, app folders and movable Home modules.
 */
class DesktopSelectionManager {
  private gesture: DesktopSelectionGesture | null = null;

  begin(input: {
    pointerId: number;
    x: number;
    y: number;
    mode: DesktopSelectionMode;
    base: DesktopSelectionSnapshot;
  }) {
    this.gesture = {
      pointerId: input.pointerId,
      startX: input.x,
      startY: input.y,
      mode: input.mode,
      base: cloneDesktopSelection(input.base),
      moved: false
    };
    return selectionRectFromPoints(input.x, input.y, input.x, input.y);
  }

  update(pointerId: number, x: number, y: number, targets: DesktopSelectionTarget[]) {
    const active = this.gesture;
    if (!active || active.pointerId !== pointerId) return null;
    const rect = selectionRectFromPoints(active.startX, active.startY, x, y);
    active.moved ||= rect.width > 4 || rect.height > 4;
    return {
      rect,
      moved: active.moved,
      selection: active.moved
        ? applyDesktopSelection(active.base, targets, rect, active.mode)
        : cloneDesktopSelection(active.base)
    };
  }

  finish(pointerId: number, x: number, y: number, targets: DesktopSelectionTarget[]) {
    const active = this.gesture;
    if (!active || active.pointerId !== pointerId) return null;
    const result = this.update(pointerId, x, y, targets);
    this.gesture = null;
    return result;
  }

  cancel(pointerId?: number) {
    const active = this.gesture;
    if (!active || (pointerId !== undefined && active.pointerId !== pointerId)) return null;
    this.gesture = null;
    return cloneDesktopSelection(active.base);
  }

  activePointerId() {
    return this.gesture?.pointerId ?? null;
  }

  isActive() {
    return Boolean(this.gesture);
  }
}

export const desktopSelectionManager = new DesktopSelectionManager();
