import { createId } from "../utils/id";
import { useEffect, useMemo, useState } from "react";
import { osService, type AppFolderRecord } from "../osService";
import { shellStorage } from "./shellStorage";

export type AppFolderSurface = "desktop" | "dock" | "start";
export type AppFolderColor = "mint" | "sky" | "violet" | "amber" | "rose" | "graphite";

export interface AppFolder {
  id: string;
  name: string;
  appIds: string[];
  color: AppFolderColor;
  surfaces: Record<AppFolderSurface, boolean>;
  order: Record<AppFolderSurface, number>;
  desktopPosition: { x: number; y: number };
  desktopIconSize: number;
  createdAt: string;
  updatedAt: string;
}

const STORAGE_KEY = "elix.app-folders.v1";
export const APP_FOLDER_EVENT_NAME = "elix-app-folders-changed";
const COLORS: AppFolderColor[] = ["mint", "sky", "violet", "amber", "rose", "graphite"];

const now = () => new Date().toISOString();
const unique = (values: string[]) => [...new Set(values.filter(Boolean))];
const safeName = (value: string) => value.trim().slice(0, 48) || "New Folder";
const defaultFolderPattern = /^New Folder(?: \(\d+\))?$/;

const normalize = (input: Partial<AppFolder> & Pick<AppFolder, "id">, index = 0): AppFolder => ({
  id: input.id,
  name: safeName(input.name ?? "New Folder"),
  appIds: unique(input.appIds ?? []),
  color: COLORS.includes(input.color as AppFolderColor) ? input.color as AppFolderColor : COLORS[index % COLORS.length],
  surfaces: {
    desktop: input.surfaces?.desktop !== false,
    dock: input.surfaces?.dock !== false,
    start: input.surfaces?.start !== false
  },
  order: {
    desktop: Number.isFinite(input.order?.desktop) ? Number(input.order?.desktop) : index,
    dock: Number.isFinite(input.order?.dock) ? Number(input.order?.dock) : index,
    start: Number.isFinite(input.order?.start) ? Number(input.order?.start) : index
  },
  desktopPosition: {
    x: Number.isFinite(input.desktopPosition?.x) ? Number(input.desktopPosition?.x) : 84 + (index % 5) * 118,
    y: Number.isFinite(input.desktopPosition?.y) ? Number(input.desktopPosition?.y) : 420 + Math.floor(index / 5) * 126
  },
  desktopIconSize: Number.isFinite(input.desktopIconSize)
    ? Math.max(44, Math.min(96, Number(input.desktopIconSize)))
    : 64,
  createdAt: input.createdAt ?? now(),
  updatedAt: input.updatedAt ?? now()
});

const fromRecord = (record: AppFolderRecord, index: number): AppFolder => normalize({
  id: record.id,
  name: record.name,
  appIds: record.appIds,
  color: record.color as AppFolderColor,
  surfaces: record.surfaces,
  order: record.order,
  desktopPosition: record.desktopPosition,
  desktopIconSize: record.desktopIconSize,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt
}, index);

const toRecord = (folder: AppFolder): AppFolderRecord => ({ ...folder });

const normalizeDefaultFolderNames = (folders: AppFolder[]) => {
  let sequence = 0;
  return folders.map((folder) => {
    if (!defaultFolderPattern.test(folder.name)) return folder;
    sequence += 1;
    const name = sequence === 1 ? "New Folder" : `New Folder (${sequence})`;
    return name === folder.name ? folder : { ...folder, name };
  });
};

class AppFolderManager {
  private folders: AppFolder[] = this.readLocal();
  private hydrated = false;
  private hydrationRequest: Promise<AppFolder[]> | null = null;

  current() {
    return this.folders.map((folder) => ({
      ...folder,
      appIds: [...folder.appIds],
      surfaces: { ...folder.surfaces },
      order: { ...folder.order },
      desktopPosition: { ...folder.desktopPosition }
    }));
  }

  async hydrate() {
    if (this.hydrated) return this.current();
    if (this.hydrationRequest) return this.hydrationRequest;
    this.hydrationRequest = (async () => {
      try {
        const remote = await osService.appFolders();
        if (remote.length > 0) {
          this.commit(remote.map(fromRecord), false);
        } else if (this.folders.length > 0) {
          await Promise.all(this.folders.map((folder) => osService.saveAppFolder(toRecord(folder))));
        }
      } catch {
        // Local-first by design. The Windows service syncs when available.
      } finally {
        this.hydrated = true;
      }
      return this.current();
    })();
    try {
      return await this.hydrationRequest;
    } finally {
      this.hydrationRequest = null;
    }
  }

  isHydrated() {
    return this.hydrated;
  }

  /** Apply an authoritative snapshot arriving from another external window/surface WebView. */
  replaceExternal(next: AppFolder[]) {
    const normalized = normalizeDefaultFolderNames(next.map(normalize));
    if (JSON.stringify(normalized) === JSON.stringify(this.folders)) return this.current();
    this.commit(normalized, false);
    return this.current();
  }

  create(appIds: string[], options: Partial<Omit<AppFolder, "id" | "appIds" | "createdAt" | "updatedAt">> = {}) {
    const index = this.folders.length;
    const requestedName = options.name?.trim();
    const defaultName = (() => {
      const taken = new Set(this.folders.map((candidate) => candidate.name));
      if (!taken.has("New Folder")) return "New Folder";
      let number = 2;
      while (taken.has(`New Folder (${number})`)) number += 1;
      return `New Folder (${number})`;
    })();
    const folder = normalize({
      id: createId("folder"),
      appIds,
      name: !requestedName || defaultFolderPattern.test(requestedName) ? defaultName : requestedName,
      color: options.color ?? COLORS[index % COLORS.length],
      surfaces: options.surfaces,
      order: options.order,
      desktopPosition: options.desktopPosition,
      createdAt: now(),
      updatedAt: now()
    }, index);
    this.commit([...this.folders, folder]);
    void osService.saveAppFolder(toRecord(folder)).catch(() => undefined);
    return folder;
  }

  update(id: string, patch: Partial<Omit<AppFolder, "id" | "createdAt">>) {
    let changed: AppFolder | undefined;
    const next = this.folders.map((folder, index) => {
      if (folder.id !== id) return folder;
      changed = normalize({
        ...folder,
        ...patch,
        id: folder.id,
        appIds: patch.appIds ?? folder.appIds,
        surfaces: { ...folder.surfaces, ...patch.surfaces },
        order: { ...folder.order, ...patch.order },
        desktopPosition: { ...folder.desktopPosition, ...patch.desktopPosition },
        createdAt: folder.createdAt,
        updatedAt: now()
      }, index);
      return changed;
    });
    if (!changed) return undefined;
    this.commit(next);
    void osService.saveAppFolder(toRecord(changed)).catch(() => undefined);
    return changed;
  }

  rename(id: string, name: string) { return this.update(id, { name: safeName(name) }); }

  addApp(id: string, appId: string) {
    const folder = this.folders.find((candidate) => candidate.id === id);
    if (!folder || folder.appIds.includes(appId)) return folder;
    return this.update(id, { appIds: [...folder.appIds, appId] });
  }

  removeApp(id: string, appId: string) {
    const folder = this.folders.find((candidate) => candidate.id === id);
    if (!folder) return undefined;
    const appIds = folder.appIds.filter((candidate) => candidate !== appId);
    if (appIds.length === 0) { this.delete(id); return undefined; }
    return this.update(id, { appIds });
  }

  reorderApps(id: string, sourceId: string, targetId: string) {
    const folder = this.folders.find((candidate) => candidate.id === id);
    if (!folder || sourceId === targetId) return folder;
    const source = folder.appIds.indexOf(sourceId);
    const target = folder.appIds.indexOf(targetId);
    if (source < 0 || target < 0) return folder;
    const appIds = [...folder.appIds];
    appIds.splice(source, 1);
    appIds.splice(target, 0, sourceId);
    return this.update(id, { appIds });
  }

  reorderFolders(surface: AppFolderSurface, sourceId: string, targetId: string, placement: "before" | "after" = "before") {
    if (sourceId === targetId) return this.current();
    const ordered = this.forSurface(surface);
    const sourceIndex = ordered.findIndex((folder) => folder.id === sourceId);
    const targetIndex = ordered.findIndex((folder) => folder.id === targetId);
    if (sourceIndex < 0 || targetIndex < 0) return this.current();
    const ids = ordered.map((folder) => folder.id).filter((id) => id !== sourceId);
    const anchorIndex = ids.indexOf(targetId);
    ids.splice(anchorIndex + (placement === "after" ? 1 : 0), 0, sourceId);
    const rank = new Map(ids.map((id, index) => [id, index]));
    const changed: AppFolder[] = [];
    const next = this.folders.map((folder, index) => {
      const order = rank.get(folder.id);
      if (order === undefined || folder.order[surface] === order) return folder;
      const updated = normalize({
        ...folder,
        id: folder.id,
        order: { ...folder.order, [surface]: order },
        createdAt: folder.createdAt,
        updatedAt: now()
      }, index);
      changed.push(updated);
      return updated;
    });
    if (!changed.length) return this.current();
    this.commit(next);
    void Promise.all(changed.map((folder) => osService.saveAppFolder(toRecord(folder)))).catch(() => undefined);
    return this.current();
  }

  setSurface(id: string, surface: AppFolderSurface, visible: boolean) {
    return this.update(id, { surfaces: { [surface]: visible } as Partial<Record<AppFolderSurface, boolean>> as Record<AppFolderSurface, boolean> });
  }

  setDesktopPosition(id: string, position: { x: number; y: number }) { return this.update(id, { desktopPosition: position }); }

  setDesktopPositions(positions: Readonly<Record<string, { x: number; y: number }>>) {
    const changed: AppFolder[] = [];
    const next = this.folders.map((folder, index) => {
      const position = positions[folder.id];
      if (!position || (folder.desktopPosition.x === position.x && folder.desktopPosition.y === position.y)) return folder;
      const updated = normalize({ ...folder, id: folder.id, desktopPosition: position, createdAt: folder.createdAt, updatedAt: now() }, index);
      changed.push(updated);
      return updated;
    });
    if (!changed.length) return this.current();
    this.commit(next);
    void Promise.all(changed.map((folder) => osService.saveAppFolder(toRecord(folder)))).catch(() => undefined);
    return this.current();
  }

  delete(id: string) {
    if (!this.folders.some((folder) => folder.id === id)) return false;
    this.commit(this.folders.filter((folder) => folder.id !== id));
    void osService.deleteAppFolder(id).catch(() => undefined);
    return true;
  }

  folderContaining(appId: string, surface?: AppFolderSurface) {
    return this.folders.find((folder) => folder.appIds.includes(appId) && (!surface || folder.surfaces[surface]));
  }

  forSurface(surface: AppFolderSurface) {
    return this.current().filter((folder) => folder.surfaces[surface]).sort((a, b) => a.order[surface] - b.order[surface] || a.name.localeCompare(b.name));
  }

  private commit(next: AppFolder[], _syncEvent = true) {
    this.folders = normalizeDefaultFolderNames(next.map(normalize));
    shellStorage.setItem(STORAGE_KEY, JSON.stringify(this.folders));
    window.dispatchEvent(new CustomEvent(APP_FOLDER_EVENT_NAME, { detail: this.current() }));
  }

  private readLocal() {
    try {
      const parsed = JSON.parse(shellStorage.getItem(STORAGE_KEY) ?? "[]") as Array<Partial<AppFolder> & Pick<AppFolder, "id">>;
      return normalizeDefaultFolderNames(parsed.map(normalize));
    } catch { return []; }
  }
}

export const appFolderManager = new AppFolderManager();

export function useAppFolders() {
  const [folders, setFolders] = useState(() => appFolderManager.current());
  useEffect(() => {
    const receive = (event: Event) => setFolders((event as CustomEvent<AppFolder[]>).detail ?? appFolderManager.current());
    window.addEventListener(APP_FOLDER_EVENT_NAME, receive);
    void appFolderManager.hydrate().then(setFolders);
    return () => window.removeEventListener(APP_FOLDER_EVENT_NAME, receive);
  }, []);
  return useMemo(() => folders, [folders]);
}
