import { useEffect, useMemo, useRef, useState } from "react";
import { wallpaperManager, type WallpaperPreferences } from "../managers/wallpaperManager";
import { useSystemTelemetrySnapshot } from "../managers/systemTelemetryManager";

export function WallpaperLayer() {
  const onAcPower = useSystemTelemetrySnapshot().onAcPower;
  const [preferences, setPreferences] = useState<WallpaperPreferences>(() => wallpaperManager.current());
  const video = useRef<HTMLVideoElement | null>(null);
  const active = useMemo(
    () => preferences.items.find((item) => item.id === preferences.activeId) ?? preferences.items[0],
    [preferences]
  );

  useEffect(() => {
    const changed = (event: Event) => setPreferences((event as CustomEvent<WallpaperPreferences>).detail);
    window.addEventListener("elix-wallpaper-changed", changed);
    return () => window.removeEventListener("elix-wallpaper-changed", changed);
  }, []);

  useEffect(() => {
    if (preferences.randomizeOnLaunch) wallpaperManager.randomize();
    if (preferences.randomizeIntervalMinutes <= 0) return;
    const timer = window.setInterval(
      () => wallpaperManager.randomize(),
      preferences.randomizeIntervalMinutes * 60_000
    );
    return () => window.clearInterval(timer);
  }, [preferences.randomizeIntervalMinutes, preferences.randomizeOnLaunch]);

  useEffect(() => {
    const updatePlayback = () => {
      if (!video.current) return;
      const shouldPause =
        (preferences.pauseVideoWhenHidden && document.hidden) ||
        (preferences.pauseVideoOnBattery && onAcPower === false);
      if (shouldPause) video.current.pause();
      else void video.current.play().catch(() => undefined);
    };
    document.addEventListener("visibilitychange", updatePlayback);
    updatePlayback();
    return () => document.removeEventListener("visibilitychange", updatePlayback);
  }, [active?.id, onAcPower, preferences.pauseVideoOnBattery, preferences.pauseVideoWhenHidden]);

  const fit = preferences.fit === "stretch" ? "fill" : preferences.fit === "tile" ? "none" : preferences.fit;
  return (
    <div
      className="elix-wallpaper-layer"
      data-kind={active?.kind ?? "image"}
      style={{
        "--wallpaper-dim": preferences.dim / 100,
        "--wallpaper-blur": `${preferences.blur}px`,
        "--wallpaper-saturation": `${preferences.saturation}%`
      } as React.CSSProperties}
      aria-hidden="true"
    >
      {active?.kind === "video" ? (
        <video
          ref={video}
          className="elix-live-wallpaper"
          src={active.source}
          muted={active.muted !== false}
          loop
          playsInline
          autoPlay
          preload="metadata"
          style={{ objectFit: fit as React.CSSProperties["objectFit"] }}
          onLoadedMetadata={(event) => { event.currentTarget.playbackRate = active.playbackRate ?? 1; }}
        />
      ) : active?.kind === "gradient" ? (
        <div className="elix-gradient-wallpaper" style={{ background: active.source }} />
      ) : (
        <div
          className="elix-image-wallpaper"
          style={{
            backgroundImage: `url("${active?.source ?? "/wallpaper/current.jpg"}")`,
            backgroundSize: preferences.fit === "stretch" ? "100% 100%" : preferences.fit,
            backgroundRepeat: preferences.fit === "tile" ? "repeat" : "no-repeat",
            backgroundPosition: "center"
          }}
        />
      )}
      <div className="elix-wallpaper-dimmer" />
    </div>
  );
}
