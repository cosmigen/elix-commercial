export type FolderOriginSnapshot = {
  folderId: string;
  rect: { left: number; top: number; width: number; height: number };
  capturedAt: number;
  surface?: string;
};

const origins = new Map<string, FolderOriginSnapshot>();

const fromRect = (folderId: string, rect: DOMRect, surface?: string): FolderOriginSnapshot => ({
  folderId,
  rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
  capturedAt: performance.now(),
  surface
});

export const folderOriginRegistry = {
  capture(folderId: string, element: Element | null, surface?: string) {
    if (!(element instanceof HTMLElement)) return null;
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const snapshot = fromRect(folderId, rect, surface ?? element.dataset.folderSurface);
    origins.set(folderId, snapshot);
    return snapshot;
  },
  captureRect(folderId: string, rect: DOMRect, surface?: string) {
    const snapshot = fromRect(folderId, rect, surface);
    origins.set(folderId, snapshot);
    return snapshot;
  },
  latest(folderId: string) {
    const value = origins.get(folderId);
    if (!value) return null;
    // Ignore stale coordinates after a long layout/session change.
    if (performance.now() - value.capturedAt > 12_000) return null;
    return value;
  },
  clear(folderId: string) { origins.delete(folderId); }
};
