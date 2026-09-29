import { createContext, useContext, useMemo, useSyncExternalStore, type PropsWithChildren } from "react";
import { layoutManager } from "./layoutManager";

const LayoutContext = createContext(layoutManager);

export function LayoutProvider({ children }: PropsWithChildren) {
  return <LayoutContext.Provider value={layoutManager}>{children}</LayoutContext.Provider>;
}

export function useActiveLayout() {
  const manager = useContext(LayoutContext);
  const state = useSyncExternalStore(manager.subscribe, manager.current, manager.current);
  return { manager, state, layoutId: manager.resolveId(), configuration: manager.configuration() };
}

export function useLayoutElement(id: string) {
  const { manager, state } = useActiveLayout();
  return useMemo(() => ({
    id,
    config: manager.getElement(id),
    properties: manager.getEditableProperties(id),
    editMode: state.editMode,
    patch: (property: string, value: import("./types").LayoutConfigValue) =>
      manager.patch({ target: id, property, value })
  }), [manager, id, state.revision, state.editMode]);
}
