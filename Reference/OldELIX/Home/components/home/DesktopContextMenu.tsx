import { AppWindow, FileArchive, Folder, FolderPlus, Grid2X2, LayoutGrid, Maximize2, Minimize2, Monitor, Palette, Plus, Settings, Sparkles, Trash2, X } from "../../icons";
import type { ShellApp } from "../../model";
import { notifyShell } from "../../model";
import type { AppFolder } from "../../managers/appFolderManager";
import { ContextMenu, type ContextMenuAction } from "../ContextMenu";
import type { HomeModuleId, HomeModuleState } from "./MovableHomeModule";
import { appLaunchManager } from "../../services/appLaunchManager";

export type DesktopContextMenuState = {
  x: number;
  y: number;
  kind: "shortcut" | "folder" | "module" | "desktop";
  appId?: string;
  folderId?: string;
  moduleId?: HomeModuleId;
};

type HomeModuleMap = Record<HomeModuleId, HomeModuleState>;

export function DesktopContextMenu({
  menu,
  desktopApps,
  folders,
  selectedAppCount,
  hasSelection,
  homeModules,
  isPinned,
  runningCount,
  close,
  openApp,
  togglePin,
  openFolder,
  distillFolder,
  renameFolder,
  compressFolder,
  deleteFolder,
  createFolder,
  createEmptyFolder,
  removeSelected,
  addWidgets,
  toggleHomeModule,
  createWorkspace,
  personalize,
  arrangeIcons,
  openDisplaySettings
}: {
  menu: DesktopContextMenuState;
  desktopApps: ShellApp[];
  folders: AppFolder[];
  selectedAppCount: number;
  hasSelection: boolean;
  homeModules: HomeModuleMap;
  isPinned(app: ShellApp): boolean;
  runningCount(app: ShellApp): number;
  close(): void;
  openApp(app: ShellApp): void;
  togglePin(app: ShellApp): void;
  openFolder(folder: AppFolder): void;
  distillFolder(folder: AppFolder): void;
  renameFolder(folder: AppFolder): void;
  compressFolder(folder: AppFolder): void;
  deleteFolder(folder: AppFolder): void;
  createFolder(): void;
  createEmptyFolder(): void;
  removeSelected(): void;
  addWidgets(): void;
  toggleHomeModule(id: HomeModuleId): void;
  createWorkspace(): void;
  personalize(): void;
  arrangeIcons(): void;
  openDisplaySettings(): void;
}) {
  // Phase 4 intentionally retires the old generic wallpaper menu. Right-click
  // remains available for real Home objects (apps, folders and modules), while
  // the empty desktop is no longer treated as a hardcoded Settings/Wallpaper
  // launcher. A richer shared shell interaction layer replaces it in Phase 7.
  if (menu.kind === "desktop") return null;

  const app = menu.appId ? desktopApps.find((candidate) => candidate.id === menu.appId) : undefined;
  const folder = menu.folderId ? folders.find((candidate) => candidate.id === menu.folderId) : undefined;
  const actions: ContextMenuAction[] = [];

  if (app) {
    const appWindows = appLaunchManager.windowsFor(app.id);
    const activeWindow = appWindows.find((windowRef) => windowRef.focused) ?? appWindows[0];
    actions.push(
      { id: "open", label: runningCount(app) > 0 ? "Bring to front" : "Open", icon: <Maximize2 />, onSelect: () => openApp(app) },
      ...(appWindows.length > 1 ? [{
        id: "windows", label: `${appWindows.length} open windows`, icon: <AppWindow />, children: appWindows.map((windowRef) => ({
          id: windowRef.id, label: windowRef.title || app.name, detail: windowRef.focused ? "Active" : windowRef.minimized ? "Minimized" : undefined, icon: <AppWindow />,
          onSelect: () => void appLaunchManager.activateWindow(windowRef).catch((error: Error) => notifyShell(error.message))
        }))
      }] : []),
      ...(activeWindow ? [
        { id: "minimize", label: "Minimize", icon: <Minimize2 />, onSelect: () => void appLaunchManager.minimizeWindow(activeWindow).catch((error: Error) => notifyShell(error.message)) },
        { id: "maximize", label: "Maximize", icon: <Maximize2 />, onSelect: () => void appLaunchManager.maximizeWindow(activeWindow).catch((error: Error) => notifyShell(error.message)) },
        { id: "close", label: appWindows.length > 1 ? "Close all windows" : "Close window", icon: <X />, danger: true, onSelect: () => void appLaunchManager.closeAllWindows(app.id) }
      ] : []),
      { id: "pin", label: isPinned(app) ? "Unpin from Dock" : "Pin to Dock", icon: <Plus />, onSelect: () => togglePin(app) }
    );
    if (selectedAppCount >= 2) actions.push({ id: "folder", label: "Create folder", icon: <Grid2X2 />, onSelect: createFolder });
    if (hasSelection) actions.push({ id: "remove", label: "Remove selected", icon: <Trash2 />, danger: true, separatorBefore: true, onSelect: removeSelected });
  } else if (folder) {
    actions.push(
      { id: "open-folder", label: "Open", icon: <Folder />, onSelect: () => openFolder(folder) },
      { id: "distill", label: "Distill", detail: "Ask ELIX AI to summarize folder contents", icon: <Sparkles />, onSelect: () => distillFolder(folder) },
      { id: "rename", label: "Rename", icon: <Settings />, onSelect: () => renameFolder(folder) },
      { id: "compress", label: "Compress to ZIP", icon: <FileArchive />, onSelect: () => compressFolder(folder) },
      { id: "delete-folder", label: "Move to Trash", icon: <Trash2 />, danger: true, separatorBefore: true, onSelect: () => deleteFolder(folder) }
    );
  } else {
    actions.push(
      { id: "new-folder", label: "New Folder", icon: <FolderPlus />, onSelect: createEmptyFolder },
      { id: "wallpaper", label: "Change Wallpaper", icon: <Palette />, onSelect: personalize },
      { id: "arrange", label: "Arrange Icons", icon: <LayoutGrid />, onSelect: arrangeIcons },
      { id: "display", label: "Display Settings", icon: <Monitor />, onSelect: openDisplaySettings },
      { id: "widgets", label: "Add Widgets", icon: <Plus />, separatorBefore: true, onSelect: addWidgets },
      ...(["clock", "search", "identity"] as HomeModuleId[]).map((module) => ({
        id: `module-${module}`,
        label: `${homeModules[module].visible ? "Remove" : "Add"} ${module === "identity" ? "workspace bar" : module}`,
        icon: <LayoutGrid />,
        onSelect: () => toggleHomeModule(module)
      })),
      { id: "workspace", label: "New Workspace", icon: <Grid2X2 />, onSelect: createWorkspace }
    );
  }

  return <ContextMenu x={menu.x} y={menu.y} label={`${menu.kind} options`} actions={actions} onClose={close} />;
}
