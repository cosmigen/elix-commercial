import { AppFolderPreview } from "../AppFolder";
import { AppGlyph } from "../AppGlyph";
import type { AppFolder } from "../../managers/appFolderManager";
import type { ShellApp } from "../../model";
import type { ShortcutPosition } from "./MovableHomeModule";
import { AttachedResizeHandle } from "../AttachedResizeHandle";


export function DesktopShortcutLayer({
  apps,
  positions,
  selectedApps,
  runningApps,
  beginAppGesture,
  updateAppGesture,
  finishAppGesture,
  cancelAppGesture,
  activateShortcut,
  folders,
  folderApps,
  selectedFolders,
  beginFolderGesture,
  updateFolderGesture,
  finishFolderGesture,
  openFolder,
  addAppToFolder,
  reportDropError,
  placementRef
}: {
  apps: ShellApp[];
  positions: Record<string, ShortcutPosition>;
  selectedApps: Set<string>;
  runningApps: Record<string, number>;
  beginAppGesture(event: React.PointerEvent<HTMLElement>, app: ShellApp): void;
  updateAppGesture(event: React.PointerEvent<HTMLElement>): void;
  finishAppGesture(event: React.PointerEvent<HTMLElement>): void;
  cancelAppGesture(event: React.PointerEvent<HTMLElement>): void;
  activateShortcut(event: React.MouseEvent<HTMLElement>, app: ShellApp): void;
  folders: AppFolder[];
  folderApps(folder: AppFolder): ShellApp[];
  selectedFolders: Set<string>;
  beginFolderGesture(event: React.PointerEvent<HTMLElement>, folder: AppFolder): void;
  updateFolderGesture(event: React.PointerEvent<HTMLElement>): void;
  finishFolderGesture(event: React.PointerEvent<HTMLElement>): void;
  openFolder(folder: AppFolder): void;
  addAppToFolder(folder: AppFolder, app: ShellApp): void;
  reportDropError(): void;
  placementRef: React.RefObject<HTMLDivElement | null>;
}) {
  return (
    <>
      <section className="shortcut-layer" aria-label="Desktop shortcuts">
        {apps.map((app, index) => {
          const position = positions[app.id] ?? { x: 58 + index * 148, y: Math.max(350, window.innerHeight - 300) };
          const runningCount = runningApps[app.id] ?? 0;
          return (
            <div
              className={`home-app home-shortcut ${selectedApps.has(app.id) ? "selected editing" : ""}`}
              key={app.id}
              data-home-app={app.id}
              data-desktop-layout-id={`app:${app.id}`}
              data-selection-kind="app"
              data-selection-id={app.id}
              data-running={runningCount ? "true" : "false"}
              style={{
                "--app-index": index,
                "--shortcut-icon-size": `${Math.max(44, Math.min(96, app.iconSize ?? 58))}px`,
                left: position.x,
                top: position.y
              } as React.CSSProperties}
              role="button"
              tabIndex={0}
              onPointerDown={(event) => beginAppGesture(event, app)}
              onPointerMove={updateAppGesture}
              onPointerUp={finishAppGesture}
              onPointerCancel={cancelAppGesture}
              onClick={(event) => activateShortcut(event, app)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  event.currentTarget.click();
                }
              }}
            >
              <span className={`app-icon ${app.iconClass} ${app.iconUrl ? "native-icon-image" : ""}`} aria-hidden="true"><AppGlyph app={app} /></span>
              <span className="shortcut-name">{app.name}</span>
              {runningCount > 1 && <i className="window-count">{runningCount}</i>}
              {selectedApps.has(app.id) && <>
                <AttachedResizeHandle className="shortcut-resize-handle" direction="se" aria-label={`Resize ${app.name}`} />
                <button className="shortcut-edge-resize" type="button" data-resize-direction="n" aria-label={`Resize ${app.name} north`} />
                <button className="shortcut-edge-resize" type="button" data-resize-direction="s" aria-label={`Resize ${app.name} south`} />
                <button className="shortcut-edge-resize" type="button" data-resize-direction="e" aria-label={`Resize ${app.name} east`} />
                <button className="shortcut-edge-resize" type="button" data-resize-direction="w" aria-label={`Resize ${app.name} west`} />
              </>}
            </div>
          );
        })}
        {folders.filter((folder) => folder.surfaces.desktop).map((folder, index) => {
          const appsInFolder = folderApps(folder);
          const runningCount = appsInFolder.reduce((total, app) => total + (runningApps[app.id] ?? 0), 0);
          const iconSize = Math.max(44, Math.min(96, folder.desktopIconSize ?? 64));
          return (
            <div
              className={`home-app home-folder-shortcut ${selectedFolders.has(folder.id) ? "selected editing" : ""}`}
              key={folder.id}
              data-folder-id={folder.id}
              data-desktop-layout-id={`folder:${folder.id}`}
              data-selection-kind="folder"
              data-selection-id={folder.id}
              style={{
                "--app-index": apps.length + index,
                "--folder-icon-size": `${iconSize}px`,
                width: Math.max(84, iconSize + 40),
                height: Math.max(94, iconSize + 50),
                left: folder.desktopPosition.x,
                top: folder.desktopPosition.y
              } as React.CSSProperties}
              role="button"
              tabIndex={0}
              aria-label={`Open ${folder.name} folder`}
              onPointerDown={(event) => beginFolderGesture(event, folder)}
              onPointerMove={updateFolderGesture}
              onPointerUp={finishFolderGesture}
              onPointerCancel={finishFolderGesture}
              onKeyDown={(event) => { if (event.key === "Enter") openFolder(folder); }}
              onDragOver={(event) => {
                if (event.dataTransfer.types.includes("application/x-elix-app")) event.preventDefault();
              }}
              onDrop={(event) => {
                const payload = event.dataTransfer.getData("application/x-elix-app");
                if (!payload) return;
                event.preventDefault();
                event.stopPropagation();
                try { addAppToFolder(folder, JSON.parse(payload) as ShellApp); }
                catch { reportDropError(); }
              }}
            >
              <AppFolderPreview folder={folder} apps={appsInFolder} />
              <span className="shortcut-name">{folder.name}</span>
              {runningCount > 0 && <i className="window-count">{runningCount}</i>}
              {selectedFolders.has(folder.id) && <>
                <AttachedResizeHandle className="shortcut-resize-handle" direction="se" aria-label={`Resize ${folder.name}`} />
                <button className="shortcut-edge-resize" type="button" data-resize-direction="n" aria-label={`Resize ${folder.name} north`} />
                <button className="shortcut-edge-resize" type="button" data-resize-direction="s" aria-label={`Resize ${folder.name} south`} />
                <button className="shortcut-edge-resize" type="button" data-resize-direction="e" aria-label={`Resize ${folder.name} east`} />
                <button className="shortcut-edge-resize" type="button" data-resize-direction="w" aria-label={`Resize ${folder.name} west`} />
              </>}
            </div>
          );
        })}
      </section>
      <div ref={placementRef} className="shortcut-placement-preview" aria-hidden="true" />
    </>
  );
}
