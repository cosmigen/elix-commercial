import { shellNotificationManager } from "../managers/shellNotificationManager";
import { shellPanelManager } from "../managers/shellPanelManager";
import { shellShortcutManager } from "../managers/shellShortcutManager";
import { shellStorage } from "../managers/shellStorage";
import type { Panel } from "../model";
import { osService } from "../osService";
import { platformNotificationMessage } from "./platformNotificationMessage";

const settingsRequestStorageKey = "elix.settings.requested-section";
const settingsSectionRoutes: Record<string, string> = {
  personalization: "Personalization",
  "status bar": "Status Bar",
  statusbar: "Status Bar",
  toolbar: "Status Bar",
  "home & morphdock": "Home & MorphDock",
  dock: "Home & MorphDock",
  applications: "Applications",
  "tasks & automations": "Tasks & automations",
  "models & apis": "Models & APIs",
  "skills & mcp": "Skills & MCP",
  memory: "Memory",
  voice: "Voice",
  "notifications & permissions": "Notifications & permissions",
  notifications: "Notifications & permissions",
  permissions: "Notifications & permissions",
  "agent control": "Agent control",
  performance: "Performance",
  recovery: "Recovery",
  developer: "Developer",
};

const validPanels = new Set<Exclude<Panel, null>>(["start", "controls", "notifications", "widgets", "tasks", "settings"]);

const resolveSettingsSection = (value: unknown) => {
  if (typeof value !== "string") return null;
  const requested = value.trim().toLocaleLowerCase();
  return requested ? settingsSectionRoutes[requested] ?? null : null;
};

/**
 * V2 Home is intentionally a renderer only. This coordinator owns global shell
 * commands that used to be hidden inside App.tsx React effects. Keyboard input
 * installation remains startupPhase-owned; this module only routes its events.
 */
export function installSurfaceV2HomeCoordinator(): () => void {
  const releaseShortcutRouting = shellShortcutManager.subscribe((action) => {
    if (action === "start.toggle") shellPanelManager.toggle("start");
    else if (action === "control-center.toggle") shellPanelManager.toggle("controls");
    else if (action === "notifications.toggle") shellPanelManager.toggle("notifications");
    else if (action === "ai.toggle") shellPanelManager.toggle("tasks");
  });

  const openWidgets = () => shellPanelManager.open("widgets");
  const openPanel = (event: Event) => {
    const target = (event as CustomEvent<Exclude<Panel, null>>).detail;
    if (target && validPanels.has(target)) shellPanelManager.open(target);
  };
  const openSettingsSection = (event: Event) => {
    const target = resolveSettingsSection((event as CustomEvent<unknown>).detail);
    if (!target) return;
    shellStorage.setItem(settingsRequestStorageKey, target);
    shellPanelManager.open("settings");
  };

  window.addEventListener("elix-open-widgets", openWidgets);
  window.addEventListener("elix-open-panel", openPanel);
  window.addEventListener("elix-open-settings-section", openSettingsSection);

  const releasePlatformNotifications = osService.connectPlatform((event) => {
    const message = platformNotificationMessage(event);
    if (!message) return;
    shellNotificationManager.push(message, {
      id: event.id || undefined,
      createdAt: Date.parse(event.timestamp) || Date.now(),
      dedupeMs: 30_000,
    });
  });

  return () => {
    releasePlatformNotifications();
    releaseShortcutRouting();
    window.removeEventListener("elix-open-widgets", openWidgets);
    window.removeEventListener("elix-open-panel", openPanel);
    window.removeEventListener("elix-open-settings-section", openSettingsSection);
  };
}
