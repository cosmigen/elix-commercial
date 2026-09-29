import { useCallback, useEffect, useMemo, useState } from "react";
import { notifyShell } from "../model";
import { osService } from "../osService";
import { systemEvents } from "./systemEvents";

export interface Workspace {
  id: string;
  name: string;
  createdAt: number;
}

const fallback: Workspace[] = [{ id: "workspace-1", name: "Home", createdAt: 0 }];

export function useWorkspaceManager(_limit = 12) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>(fallback);
  const [activeId, setActiveId] = useState("workspace-1");

  const synchronize = useCallback(async () => {
    const state = await osService.workspaces();
    setWorkspaces(state.map((workspace) => ({ id: workspace.id, name: workspace.name, createdAt: 0 })));
    setActiveId(state.find((workspace) => workspace.isActive)?.id ?? state[0]?.id ?? "workspace-1");
  }, []);

  useEffect(() => {
    void synchronize().catch(() => undefined);
    return osService.connectPlatform((event) => {
      if (event.type.startsWith("workspace.")) void synchronize();
    });
  }, [synchronize]);

  return useMemo(() => ({
    workspaces,
    active: workspaces.find((workspace) => workspace.id === activeId) ?? workspaces[0] ?? fallback[0],
    activate(id: string) {
      if (!workspaces.some((workspace) => workspace.id === id)) return;
      setActiveId(id);
      void osService.activateWorkspace(id).then(() => systemEvents.emit("workspace-changed", { id })).catch((error: Error) => {
        notifyShell(error.message);
        void synchronize();
      });
    },
    next() {
      const index = workspaces.findIndex((workspace) => workspace.id === activeId);
      const next = workspaces[(index + 1) % workspaces.length];
      if (!next) return;
      setActiveId(next.id);
      void osService.activateWorkspace(next.id).then(() => systemEvents.emit("workspace-changed", { id: next.id })).catch(() => synchronize());
    },
    previous() {
      const index = workspaces.findIndex((workspace) => workspace.id === activeId);
      const previous = workspaces[(index - 1 + workspaces.length) % workspaces.length];
      if (!previous) return;
      setActiveId(previous.id);
      void osService.activateWorkspace(previous.id).then(() => systemEvents.emit("workspace-changed", { id: previous.id })).catch(() => synchronize());
    },
    create(name?: string) {
      const title = name?.trim() || `Workspace ${workspaces.length + 1}`;
      void osService.createWorkspace(title).then(() => synchronize()).catch((error: Error) => notifyShell(error.message));
      return { id: "pending", name: title, createdAt: Date.now() };
    },
    rename(id: string, name: string) {
      const nextName = name.trim();
      if (!nextName) return;
      setWorkspaces((current) => current.map((workspace) => workspace.id === id ? { ...workspace, name: nextName } : workspace));
      void osService.renameWorkspace(id, nextName).catch(() => synchronize());
    },
    remove(id: string) {
      void osService.removeWorkspace(id).then(() => synchronize()).catch((error: Error) => notifyShell(error.message));
    }
  }), [activeId, synchronize, workspaces]);
}
