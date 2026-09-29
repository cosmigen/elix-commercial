import { homeSafeZoneManager } from "../managers/homeSafeZoneManager";
import { statusBarManager, type StatusBarPreferences } from "../managers/statusBarManager";
import { runtimeConfig } from "../runtimeConfig";
import { openSurfaceBus, type SurfaceBusMessage } from "../surfaces/surfaceBus";

const BOOTSTRAP_DOCK_DEPTH = 148;
const DOCK_SCREEN_GAP = 8;
const DOCK_SHADOW_BREATHING_BAND = 28;
const MIN_DOCK_SAFE_DEPTH = 128;
const MAX_DOCK_SAFE_DEPTH = 260;

const dockDepthFromHostHeight = (reportedHeight: number) => {
  const visualHeight = Number.isFinite(reportedHeight)
    ? Math.max(72, Math.round(reportedHeight) - 92)
    : 112;
  return Math.max(
    MIN_DOCK_SAFE_DEPTH,
    Math.min(MAX_DOCK_SAFE_DEPTH, DOCK_SCREEN_GAP + visualHeight + DOCK_SHADOW_BREATHING_BAND),
  );
};

const statusDepth = (preferences: StatusBarPreferences) => Math.max(
  0,
  Math.min(180, Math.round(preferences.height + preferences.margin + 18)),
);

const reportStatus = (instanceId: string, preferences: StatusBarPreferences) => {
  homeSafeZoneManager.report(`status:${instanceId}`, {
    edge: preferences.position,
    size: statusDepth(preferences),
  });
};

/**
 * Surface Runtime V2 Home-only collision bridge.
 *
 * This is deliberately NOT a Windows work-area/AppBar reservation. It only
 * publishes safe bands to the Home desktop layout engine so icons, folders,
 * widgets and modules cannot be dropped beneath native Dock/Status chrome.
 */
export function installHomeSafeZoneBridge(): () => void {
  if (!runtimeConfig.surfaceRuntimeV2 || runtimeConfig.surfaceId) return () => undefined;

  let disposed = false;
  homeSafeZoneManager.report("dock:bootstrap", { edge: "bottom", size: BOOTSTRAP_DOCK_DEPTH });
  reportStatus("bootstrap", statusBarManager.current());

  const bus = openSurfaceBus((message: SurfaceBusMessage) => {
    if (disposed) return;
    if (message.type === "dock-resize-request") {
      homeSafeZoneManager.report(`dock:${message.instanceId}`, {
        edge: "bottom",
        size: dockDepthFromHostHeight(message.height),
      });
      return;
    }
    if (message.type === "statusbar-preferences") {
      reportStatus(message.instanceId, message.preferences);
    }
  });

  const statusChanged = (event: Event) => {
    const preferences = (event as CustomEvent<StatusBarPreferences>).detail ?? statusBarManager.current();
    reportStatus("bootstrap", preferences);
  };
  window.addEventListener("elix-statusbar-changed", statusChanged);

  const release = () => {
    homeSafeZoneManager.clearPrefix("dock:");
    homeSafeZoneManager.clearPrefix("status:");
  };
  window.addEventListener("pagehide", release);

  return () => {
    disposed = true;
    bus.close();
    window.removeEventListener("elix-statusbar-changed", statusChanged);
    window.removeEventListener("pagehide", release);
    release();
  };
}
