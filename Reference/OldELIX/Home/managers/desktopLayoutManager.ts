import { homeSafeZoneManager } from "./homeSafeZoneManager";

export type DesktopItemType = "app" | "folder" | "widget" | "module";

export type DesktopItemGeometry = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type DesktopLayoutItem = DesktopItemGeometry & {
  id: string;
  type: DesktopItemType;
  source: string;
  gap?: number;
  snapX?: number;
  snapY?: number;
  locked?: boolean;
};

export type DesktopLayoutResolution = {
  activeId: string;
  items: ReadonlyMap<string, DesktopLayoutItem>;
  changedIds: readonly string[];
  displacedIds: readonly string[];
};

export type DesktopLayoutCommit = {
  reason: "reflow" | "drag" | "resize" | "create";
  items: DesktopLayoutItem[];
};

type DesktopBounds = { left: number; top: number; right: number; bottom: number };

const commitEvent = "elix-desktop-layout-commit";
const sourcePriority: Record<DesktopItemType, number> = {
  module: 0,
  widget: 1,
  app: 2,
  folder: 2
};

const finite = (value: number, fallback = 0) => Number.isFinite(value) ? value : fallback;
const sameGeometry = (a: DesktopItemGeometry, b: DesktopItemGeometry) =>
  Math.abs(a.x - b.x) < .5 && Math.abs(a.y - b.y) < .5 &&
  Math.abs(a.width - b.width) < .5 && Math.abs(a.height - b.height) < .5;

const readDesktopBounds = (): DesktopBounds => {
  const bounds = homeSafeZoneManager.desktopBounds(12);
  if (bounds.bottom - bounds.top >= 180 && bounds.right - bounds.left >= 180) return bounds;

  // Extremely small displays still need a usable drag target. Keep the safe
  // edge that fits and relax only the opposite side rather than silently
  // discarding all chrome collision protection.
  return {
    left: Math.min(bounds.left, Math.max(0, window.innerWidth - 180)),
    top: Math.min(bounds.top, Math.max(0, window.innerHeight - 180)),
    right: Math.max(bounds.right, Math.min(window.innerWidth, bounds.left + 180)),
    bottom: Math.max(bounds.bottom, Math.min(window.innerHeight, bounds.top + 180)),
  };
};

const clampToBounds = (item: DesktopLayoutItem, bounds: DesktopBounds): DesktopLayoutItem => {
  const width = Math.min(Math.max(1, finite(item.width, 1)), Math.max(1, bounds.right - bounds.left));
  const height = Math.min(Math.max(1, finite(item.height, 1)), Math.max(1, bounds.bottom - bounds.top));
  return {
    ...item,
    width,
    height,
    x: Math.max(bounds.left, Math.min(bounds.right - width, finite(item.x, bounds.left))),
    y: Math.max(bounds.top, Math.min(bounds.bottom - height, finite(item.y, bounds.top)))
  };
};

const intersects = (a: DesktopLayoutItem, b: DesktopLayoutItem) => {
  const gap = Math.max(a.gap ?? 8, b.gap ?? 8);
  return a.x - gap < b.x + b.width &&
    a.x + a.width + gap > b.x &&
    a.y - gap < b.y + b.height &&
    a.y + a.height + gap > b.y;
};

const candidateKey = (candidate: DesktopLayoutItem) => `${Math.round(candidate.x * 10)}:${Math.round(candidate.y * 10)}`;

const nearestFree = (
  desired: DesktopLayoutItem,
  occupied: Iterable<DesktopLayoutItem>,
  bounds: DesktopBounds
) => {
  const blockers = [...occupied].filter((item) => item.id !== desired.id);
  const start = clampToBounds(desired, bounds);
  if (!blockers.some((item) => intersects(start, item))) return start;
  const stepX = Math.max(12, desired.snapX ?? 24);
  const stepY = Math.max(12, desired.snapY ?? 24);
  const maxRadius = Math.ceil(Math.max(bounds.right - bounds.left, bounds.bottom - bounds.top) / Math.min(stepX, stepY)) + 2;
  const visited = new Set<string>([candidateKey(start)]);
  for (let radius = 1; radius <= maxRadius; radius += 1) {
    const offsets: Array<[number, number]> = [];
    for (let cross = -radius + 1; cross < radius; cross += 1) {
      offsets.push([radius, cross], [-radius, cross]);
    }
    for (let cross = -radius; cross <= radius; cross += 1) {
      offsets.push([cross, -radius], [cross, radius]);
    }
    for (const [offsetX, offsetY] of offsets) {
      const candidate = clampToBounds({
        ...desired,
        x: start.x + offsetX * stepX,
        y: start.y + offsetY * stepY
      }, bounds);
      const key = candidateKey(candidate);
      if (visited.has(key)) continue;
      visited.add(key);
      if (!blockers.some((item) => intersects(candidate, item))) return candidate;
    }
  }
  return start;
};

class DesktopLayoutSession {
  private lastKey = "";
  private lastResolution: DesktopLayoutResolution | null = null;

  constructor(
    private readonly activeId: string,
    private readonly initial: ReadonlyMap<string, DesktopLayoutItem>,
    private readonly bounds: DesktopBounds
  ) {}

  resolve(desired: DesktopItemGeometry) {
    const active = this.initial.get(this.activeId);
    if (!active) return null;
    const requested = clampToBounds({ ...active, ...desired }, this.bounds);
    const key = `${candidateKey(requested)}:${Math.round(requested.width)}:${Math.round(requested.height)}`;
    if (this.lastResolution && key === this.lastKey) return this.lastResolution;
    this.lastKey = key;
    const layout = new Map(this.initial);
    layout.set(active.id, requested);
    const displaced: string[] = [];
    const conflicts = [...layout.values()]
      .filter((item) => item.id !== active.id && intersects(requested, item))
      .sort((a, b) => a.id.localeCompare(b.id));
    let activePlacement = requested;
    for (const conflict of conflicts) {
      if (conflict.locked) {
        activePlacement = nearestFree(activePlacement, layout.values(), this.bounds);
        layout.set(active.id, activePlacement);
        continue;
      }
      const moved = nearestFree(conflict, layout.values(), this.bounds);
      if (!sameGeometry(moved, conflict)) {
        layout.set(conflict.id, moved);
        displaced.push(conflict.id);
      } else {
        activePlacement = nearestFree(activePlacement, layout.values(), this.bounds);
        layout.set(active.id, activePlacement);
      }
    }
    const changedIds = [...layout].filter(([id, item]) => {
      const prior = this.initial.get(id);
      return !prior || !sameGeometry(prior, item);
    }).map(([id]) => id);
    this.lastResolution = {
      activeId: active.id,
      items: layout,
      changedIds,
      displacedIds: displaced
    };
    return this.lastResolution;
  }
}

class DesktopLayoutManager {
  private items = new Map<string, DesktopLayoutItem>();
  private reflowFrame = 0;
  private releaseSafeZone: (() => void) | null = null;

  constructor() {
    this.releaseSafeZone = homeSafeZoneManager.subscribe(() => this.requestReflow());
  }

  replaceSource(source: string, items: DesktopLayoutItem[]) {
    let changed = false;
    for (const [id, current] of this.items) {
      if (current.source === source && !items.some((item) => item.id === id)) {
        this.items.delete(id);
        changed = true;
      }
    }
    for (const item of items) {
      const normalized = { ...item, source };
      const prior = this.items.get(item.id);
      if (!prior || !sameGeometry(prior, normalized) || prior.type !== normalized.type) changed = true;
      this.items.set(item.id, normalized);
    }
    if (changed) this.requestReflow();
  }

  upsertItems(items: DesktopLayoutItem[]) {
    let changed = false;
    for (const item of items) {
      const prior = this.items.get(item.id);
      if (!prior || !sameGeometry(prior, item) || prior.type !== item.type || prior.source !== item.source) changed = true;
      this.items.set(item.id, { ...item });
    }
    if (changed) this.requestReflow();
  }

  createSession(activeId: string) {
    return new DesktopLayoutSession(activeId, new Map(this.items), readDesktopBounds());
  }

  current(id: string) {
    const item = this.items.get(id);
    return item ? { ...item } : undefined;
  }

  snapshot() {
    return new Map([...this.items].map(([id, item]) => [id, { ...item }]));
  }

  commit(resolution: DesktopLayoutResolution, reason: DesktopLayoutCommit["reason"]) {
    const changed: DesktopLayoutItem[] = [];
    for (const id of resolution.changedIds) {
      const item = resolution.items.get(id);
      if (!item) continue;
      const prior = this.items.get(id);
      if (prior && sameGeometry(prior, item)) continue;
      this.items.set(id, item);
      changed.push(item);
    }
    if (!changed.length) return;
    window.dispatchEvent(new CustomEvent<DesktopLayoutCommit>(commitEvent, {
      detail: { reason, items: changed }
    }));
  }

  subscribe(listener: (commit: DesktopLayoutCommit) => void) {
    const handle = (event: Event) => listener((event as CustomEvent<DesktopLayoutCommit>).detail);
    window.addEventListener(commitEvent, handle);
    return () => window.removeEventListener(commitEvent, handle);
  }

  requestReflow() {
    if (this.reflowFrame) return;
    this.reflowFrame = window.requestAnimationFrame(() => {
      this.reflowFrame = 0;
      this.reflow();
    });
  }

  private reflow() {
    const bounds = readDesktopBounds();
    const placed: DesktopLayoutItem[] = [];
    const next = new Map<string, DesktopLayoutItem>();
    const ordered = [...this.items.values()].sort((a, b) =>
      sourcePriority[a.type] - sourcePriority[b.type] || a.id.localeCompare(b.id));
    const changedIds: string[] = [];
    for (const item of ordered) {
      const resolved = nearestFree(item, placed, bounds);
      placed.push(resolved);
      next.set(resolved.id, resolved);
      if (!sameGeometry(item, resolved)) changedIds.push(item.id);
    }
    if (!changedIds.length) return;
    this.commit({ activeId: "reflow", items: next, changedIds, displacedIds: changedIds }, "reflow");
  }
}

export const desktopLayoutManager = new DesktopLayoutManager();
export type DesktopLayoutSessionHandle = ReturnType<DesktopLayoutManager["createSession"]>;
