import { homeModuleLimits, type HomeModuleId, type HomeModuleState } from "../components/home/MovableHomeModule";
import { shellStorage } from "./shellStorage";

export type HomeModuleMap = Record<HomeModuleId, HomeModuleState>;

export const defaultHomeModules = (): HomeModuleMap => ({
  identity: { visible: true, x: 52, y: 25, width: 300, height: 44 },
  clock: { visible: true, x: 76, y: 146, width: 470, height: 130 },
  search: { visible: true, x: 78, y: 312, width: 590, height: 52 }
});

export const loadHomeModules = (): HomeModuleMap => {
  const defaults = defaultHomeModules();
  try {
    const stored = JSON.parse(shellStorage.getItem("elix.home-modules") ?? "{}") as
      Partial<Record<HomeModuleId, Partial<HomeModuleState>>>;
    return (Object.keys(defaults) as HomeModuleId[]).reduce((result, id) => {
      const merged = { ...defaults[id], ...stored[id] };
      const limits = homeModuleLimits[id];
      result[id] = {
        visible: merged.visible !== false,
        x: Number.isFinite(merged.x) ? Number(merged.x) : defaults[id].x,
        y: Number.isFinite(merged.y) ? Number(merged.y) : defaults[id].y,
        width: Math.max(limits.minWidth, Math.min(limits.maxWidth, Number(merged.width) || defaults[id].width)),
        height: Math.max(limits.minHeight, Math.min(limits.maxHeight, Number(merged.height) || defaults[id].height))
      };
      return result;
    }, {} as HomeModuleMap);
  } catch {
    return defaults;
  }
};
