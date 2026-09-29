export type HomeSafeZoneEdge = "top" | "bottom" | "left" | "right";

export type HomeSafeZoneContribution = {
  edge: HomeSafeZoneEdge;
  size: number;
};

export type HomeSafeZoneSnapshot = Record<HomeSafeZoneEdge, number>;

const changedEvent = "elix-home-safe-zone-changed";
const contributions = new Map<string, HomeSafeZoneContribution>();
let snapshot: HomeSafeZoneSnapshot = { top: 0, bottom: 0, left: 0, right: 0 };

const cleanSize = (value: number) => Math.max(0, Math.min(512, Math.round(Number.isFinite(value) ? value : 0)));

const sameSnapshot = (left: HomeSafeZoneSnapshot, right: HomeSafeZoneSnapshot) =>
  left.top === right.top
  && left.bottom === right.bottom
  && left.left === right.left
  && left.right === right.right;

const recompute = () => {
  const next: HomeSafeZoneSnapshot = { top: 0, bottom: 0, left: 0, right: 0 };
  contributions.forEach((contribution) => {
    next[contribution.edge] = Math.max(next[contribution.edge], cleanSize(contribution.size));
  });
  if (sameSnapshot(next, snapshot)) return;
  snapshot = next;

  document.documentElement.style.setProperty("--elix-home-safe-top", `${next.top}px`);
  document.documentElement.style.setProperty("--elix-home-safe-bottom", `${next.bottom}px`);
  document.documentElement.style.setProperty("--elix-home-safe-left", `${next.left}px`);
  document.documentElement.style.setProperty("--elix-home-safe-right", `${next.right}px`);
  window.dispatchEvent(new CustomEvent<HomeSafeZoneSnapshot>(changedEvent, { detail: { ...next } }));
};

export const homeSafeZoneManager = {
  report(id: string, contribution: HomeSafeZoneContribution) {
    const key = id.trim();
    if (!key) throw new Error("homeSafeZone: contribution id is required");
    const size = cleanSize(contribution.size);
    if (size <= 0) contributions.delete(key);
    else contributions.set(key, { edge: contribution.edge, size });
    recompute();
  },

  clear(id: string) {
    if (contributions.delete(id)) recompute();
  },

  clearPrefix(prefix: string) {
    let changed = false;
    for (const id of contributions.keys()) {
      if (!id.startsWith(prefix)) continue;
      contributions.delete(id);
      changed = true;
    }
    if (changed) recompute();
  },

  current(): HomeSafeZoneSnapshot {
    return { ...snapshot };
  },

  desktopBounds(inset = 12) {
    const safeInset = Math.max(0, cleanSize(inset));
    const left = safeInset + snapshot.left;
    const top = safeInset + snapshot.top;
    const right = Math.max(left + 1, window.innerWidth - safeInset - snapshot.right);
    const bottom = Math.max(top + 1, window.innerHeight - safeInset - snapshot.bottom);
    return { left, top, right, bottom };
  },

  subscribe(listener: (next: HomeSafeZoneSnapshot) => void) {
    const handle = (event: Event) => listener((event as CustomEvent<HomeSafeZoneSnapshot>).detail);
    window.addEventListener(changedEvent, handle);
    return () => window.removeEventListener(changedEvent, handle);
  },
};
