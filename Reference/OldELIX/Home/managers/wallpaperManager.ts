import { osService, type WindowsWallpaperSnapshot } from "../osService";
import { shellStorage } from "./shellStorage";

export type WallpaperFit = "cover" | "contain" | "stretch" | "center" | "tile";
export type WallpaperKind = "image" | "video" | "gradient";

export type WallpaperItem = {
  id: string;
  name: string;
  kind: WallpaperKind;
  source: string;
  thumbnail?: string;
  muted?: boolean;
  playbackRate?: number;
};

export type WallpaperPreferences = {
  activeId: string;
  fit: WallpaperFit;
  dim: number;
  blur: number;
  saturation: number;
  randomizeOnLaunch: boolean;
  randomizeIntervalMinutes: number;
  pauseVideoOnBattery: boolean;
  pauseVideoWhenHidden: boolean;
  items: WallpaperItem[];
};

const storageKey = "elix.wallpaper.preferences.v2";
const defaultItems: WallpaperItem[] = [
  { id: "elix-itachi-crimson", name: "Itachi · Crimson Moon", kind: "image", source: "/wallpapers/elix-itachi-crimson.png" },
  { id: "elix-orange-desktop", name: "Make Your Desktop You", kind: "image", source: "/wallpapers/elix-orange-desktop-v2.png" },
  { id: "elix-current", name: "Paris Night Architecture", kind: "image", source: "/wallpaper/current.jpg" },
  { id: "aurora-flow", name: "Aurora Flow", kind: "gradient", source: "radial-gradient(circle at 25% 20%, #2d786b 0, transparent 34%), radial-gradient(circle at 75% 70%, #5c2f57 0, transparent 38%), linear-gradient(145deg, #07110f, #101015 58%, #170d13)" },
  { id: "graphite-wave", name: "Graphite Wave", kind: "gradient", source: "radial-gradient(ellipse at 50% 110%, #29433c 0, #101412 40%, #050606 72%)" },
  { id: "midnight-orbit", name: "Midnight Orbit", kind: "gradient", source: "radial-gradient(circle at 50% 42%, #24252a 0 15%, #0e0e11 38%, #020203 70%)" },
  { id: "solar-drift", name: "Solar Drift", kind: "gradient", source: "radial-gradient(circle at 78% 18%, rgba(255,183,92,.48), transparent 28%), radial-gradient(circle at 18% 78%, rgba(68,115,160,.46), transparent 36%), linear-gradient(145deg,#080b10,#17130f 54%,#050607)" }
];

export const defaultWallpaperPreferences = (): WallpaperPreferences => ({
  activeId: "elix-itachi-crimson",
  fit: "cover",
  dim: 18,
  blur: 0,
  saturation: 100,
  randomizeOnLaunch: false,
  randomizeIntervalMinutes: 60,
  pauseVideoOnBattery: true,
  pauseVideoWhenHidden: true,
  items: defaultItems
});

const clamp = (value: unknown, min: number, max: number, fallback: number) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
};

const normalize = (value: Partial<WallpaperPreferences> | null | undefined): WallpaperPreferences => {
  const fallback = defaultWallpaperPreferences();
  const storedItems = Array.isArray(value?.items)
    ? value!.items.filter((item): item is WallpaperItem => Boolean(item && typeof item.id === "string" && typeof item.source === "string" && ["image", "video", "gradient"].includes(item.kind)))
    : [];
  const hasStoredItachi = storedItems.some((item) => item.id === "elix-itachi-crimson");
  const safeItems = storedItems.length
    ? [...fallback.items.filter((defaultItem) => !storedItems.some((item) => item.id === defaultItem.id)), ...storedItems]
    : fallback.items;
  const activeId = safeItems.some((item) => item.id === value?.activeId) ? String(value?.activeId) : safeItems[0].id;
  // Existing installs used the generated current.jpg/Windows wallpaper as their
  // default. Migrate those installs to the bundled Itachi wallpaper once, while
  // preserving an explicit choice after the new item has been persisted.
  const migratedActiveId = !hasStoredItachi && (activeId === "elix-current" || activeId === "windows-current")
    ? fallback.activeId
    : activeId;
  return {
    activeId: migratedActiveId,
    fit: ["cover", "contain", "stretch", "center", "tile"].includes(String(value?.fit)) ? value!.fit! : fallback.fit,
    dim: clamp(value?.dim, 0, 80, fallback.dim),
    blur: clamp(value?.blur, 0, 30, fallback.blur),
    saturation: clamp(value?.saturation, 0, 180, fallback.saturation),
    randomizeOnLaunch: Boolean(value?.randomizeOnLaunch),
    randomizeIntervalMinutes: clamp(value?.randomizeIntervalMinutes, 1, 1440, fallback.randomizeIntervalMinutes),
    pauseVideoOnBattery: typeof value?.pauseVideoOnBattery === "boolean" ? value.pauseVideoOnBattery : fallback.pauseVideoOnBattery,
    pauseVideoWhenHidden: typeof value?.pauseVideoWhenHidden === "boolean" ? value.pauseVideoWhenHidden : fallback.pauseVideoWhenHidden,
    items: safeItems
  };
};

class WallpaperManager {
  private preferences = this.load();
  private disconnect?: () => void;

  private load() {
    try {
      return normalize(JSON.parse(shellStorage.getItem(storageKey) ?? "null") as Partial<WallpaperPreferences> | null);
    } catch {
      return defaultWallpaperPreferences();
    }
  }

  hydrate() {
    this.preferences = this.load();
    window.dispatchEvent(new CustomEvent("elix-wallpaper-changed", { detail: this.current() }));
    return this.current();
  }

  async syncFromService() {
    let native: WindowsWallpaperSnapshot | null = null;
    try {
      const [remote, windows] = await Promise.all([osService.wallpaperPreferences(), osService.systemWallpaper()]);
      native = windows;
      if (remote && Object.keys(remote).length) {
        this.preferences = normalize(remote as Partial<WallpaperPreferences>);
        shellStorage.setItem(storageKey, JSON.stringify(this.preferences));
        this.emit();
      }
    } catch {}
    if (native) this.applyNative(native);
    if (!this.disconnect) this.disconnect = osService.connectPlatform((event) => {
      if (!event.payload || typeof event.payload !== "object") return;
      if (event.type === "customization.wallpaper.changed") {
        this.preferences = normalize(event.payload as Partial<WallpaperPreferences>);
        shellStorage.setItem(storageKey, JSON.stringify(this.preferences));
        this.emit();
      } else if (event.type === "system.wallpaper.changed") {
        this.applyNative(event.payload as WindowsWallpaperSnapshot);
      }
    });
  }

  current() {
    return structuredClone(this.preferences);
  }

  save(patch: Partial<WallpaperPreferences>) {
    this.preferences = normalize({ ...this.preferences, ...patch });
    shellStorage.setItem(storageKey, JSON.stringify(this.preferences));
    void osService.saveWallpaperPreferences(this.preferences as unknown as Record<string, unknown>).catch(() => {});
    const selected = this.preferences.items.find((item) => item.id === (patch.activeId ?? this.preferences.activeId));
    if ((patch.activeId || patch.fit) && selected?.kind === "image" && selected.id !== "windows-current") {
      void osService.applySystemWallpaper(selected.source, this.preferences.fit)
        .then((snapshot) => this.applyNative(snapshot))
        .catch(() => undefined);
    }
    this.emit();
    return this.current();
  }

  select(id: string) {
    if (!this.preferences.items.some((item) => item.id === id)) return this.current();
    return this.save({ activeId: id });
  }

  randomize() {
    if (this.preferences.items.length < 2) return this.current();
    const candidates = this.preferences.items.filter((item) => item.id !== this.preferences.activeId);
    return this.select(candidates[Math.floor(Math.random() * candidates.length)].id);
  }

  add(item: WallpaperItem) {
    return this.save({ items: [...this.preferences.items.filter((candidate) => candidate.id !== item.id), item], activeId: item.id });
  }

  remove(id: string) {
    const items = this.preferences.items.filter((item) => item.id !== id || defaultItems.some((defaultItem) => defaultItem.id === id));
    return this.save({ items, activeId: this.preferences.activeId === id ? items[0]?.id ?? "elix-current" : this.preferences.activeId });
  }

  private emit() {
    window.dispatchEvent(new CustomEvent("elix-wallpaper-changed", { detail: this.current() }));
  }

  private applyNative(snapshot: WindowsWallpaperSnapshot) {
    if (!snapshot.available || !snapshot.sourceUrl) return;
    const item: WallpaperItem = {
      id: "windows-current",
      name: snapshot.fileName ? `Windows · ${snapshot.fileName}` : "Windows wallpaper",
      kind: "image",
      source: osService.assetUrl(snapshot.sourceUrl)
    };
    this.preferences = normalize({
      ...this.preferences,
      // Keep the selected ELIX wallpaper active. Windows wallpaper changes are
      // still represented as an item, but must not unexpectedly replace the
      // user-facing desktop selection on every service refresh.
      activeId: this.preferences.activeId === "windows-current" ? item.id : this.preferences.activeId,
      fit: snapshot.fit,
      items: [...this.preferences.items.filter((candidate) => candidate.id !== item.id), item]
    });
    shellStorage.setItem(storageKey, JSON.stringify(this.preferences));
    this.emit();
  }
}

export const wallpaperManager = new WallpaperManager();
