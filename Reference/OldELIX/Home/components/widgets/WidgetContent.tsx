import { useEffect, useRef, useState } from "react";
import {
  Cpu, FolderOpen, HardDrive, LayoutGrid, Music2, Network, NotebookPen,
  Pause, Play, RotateCw, Settings2, ShieldCheck, Terminal, TimerReset, Wifi
} from "../../icons";
import type { IntegrationStatus, SystemSummary, WidgetManifest } from "../../osService";
import { osService } from "../../osService";
import { openNative } from "../../model";

export function WidgetContent({
  manifest,
  integrations,
  system,
  battery,
  appCount,
  runningWindowCount
}: {
  manifest: WidgetManifest;
  integrations: IntegrationStatus | null;
  system: SystemSummary | null;
  battery: number | null;
  appCount: number;
  runningWindowCount: number;
}) {
  if (manifest.entrypoint === "builtin:anime-clock") return <AnimeClockWidget />;
  if (manifest.entrypoint === "builtin:clock") return <ClockWidget />;
  if (manifest.entrypoint === "builtin:notes") return <NotesWidget id={manifest.id} />;
  if (manifest.entrypoint === "builtin:system") {
    return (
      <div className="widget-system">
        <Network />
        <strong>{integrations?.backendAvailable ? "Backend connected" : "Shell local"}</strong>
        <span>{integrations?.backendAvailable ? `${integrations.skillCount} skills · ${integrations.mcpServerCount} MCP` : system?.machineName ?? "Checking system"}</span>
        <small>{system ? `${system.processorCount} logical processors` : "Waiting for the OS service"}</small>
      </div>
    );
  }
  if (manifest.entrypoint === "builtin:calendar") return <CalendarWidget />;
  if (manifest.entrypoint === "builtin:power") {
    return (
      <div className="widget-power">
        <strong>{battery === null ? "—" : `${battery}%`}</strong>
        <span>{battery === null ? "Battery data unavailable" : "Live Windows power state"}</span>
      </div>
    );
  }
  if (manifest.entrypoint === "builtin:backend") {
    return (
      <div className="widget-backend">
        <i className={integrations?.backendAvailable ? "online" : ""} />
        <strong>{integrations?.backendAvailable ? "ELIX connected" : "Backend offline"}</strong>
        <span>{integrations ? `${integrations.skillCount} skills · ${integrations.pinnedToolCount} tools` : "Checking capabilities"}</span>
      </div>
    );
  }
  if (manifest.entrypoint === "builtin:focus") return <FocusWidget />;
  if (manifest.entrypoint === "builtin:music") return <MusicWidget />;
  if (manifest.entrypoint === "builtin:shortcuts") return <ShortcutsWidget />;
  if (manifest.entrypoint === "builtin:storage") return <StorageWidget system={system} />;
  if (manifest.entrypoint === "builtin:performance") return <PerformanceWidget system={system} />;
  if (manifest.entrypoint === "builtin:connectivity") return <ConnectivityWidget integrations={integrations} />;
  if (manifest.entrypoint === "builtin:workspace") {
    return <WorkspaceWidget appCount={appCount} runningWindowCount={runningWindowCount} />;
  }
  if (manifest.entrypoint === "builtin:date") return <DateWidget />;
  if (manifest.entrypoint === "builtin:world-clock") return <WorldClockWidget />;
  if (manifest.entrypoint === "builtin:device") {
    return (
      <InfoWidget
        icon={<Cpu />}
        title={system?.machineName ?? "This device"}
        lines={[
          system?.osVersion ?? "Reading Windows version",
          system ? `${system.processorCount} logical processors` : "Waiting for system data"
        ]}
      />
    );
  }
  if (manifest.entrypoint === "builtin:processes") return <PerformanceWidget system={system} />;
  if (manifest.entrypoint === "builtin:network") return <ConnectivityWidget integrations={integrations} />;
  if (manifest.entrypoint === "builtin:drives") return <StorageWidget system={system} />;
  if (manifest.entrypoint === "builtin:session") {
    return <WorkspaceWidget appCount={appCount} runningWindowCount={runningWindowCount} />;
  }
  if (manifest.entrypoint === "builtin:quick-settings") {
    return <PanelActionWidget icon={<Settings2 />} title="System controls" detail="Wi-Fi, Bluetooth, sound and display" panel="controls" />;
  }
  if (manifest.entrypoint === "builtin:search") {
    return <PanelActionWidget icon={<LayoutGrid />} title="Find anything" detail={`${appCount} applications indexed locally`} panel="start" />;
  }
  if (manifest.entrypoint === "builtin:recent") {
    return <InfoWidget icon={<FolderOpen />} title={`${runningWindowCount} open windows`} lines={[`${appCount} indexed applications`, "Local activity only"]} />;
  }
  if (manifest.entrypoint === "builtin:privacy") {
    return <InfoWidget icon={<ShieldCheck />} title="Privacy status" lines={["Local-first shell storage", "No widget data leaves this device"]} />;
  }
  if (manifest.entrypoint === "builtin:uptime") return <UptimeWidget />;
  return <div className="widget-unsupported"><RotateCw /><span>Widget runtime unavailable</span></div>;
}

function AnimeClockWidget() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer = 0;
    const scheduleMinuteBoundary = () => {
      const current = new Date();
      const delay = 60_000 - (current.getSeconds() * 1_000 + current.getMilliseconds()) + 16;
      timer = window.setTimeout(() => {
        setNow(new Date());
        scheduleMinuteBoundary();
      }, delay);
    };
    scheduleMinuteBoundary();
    return () => window.clearTimeout(timer);
  }, []);
  const timeParts = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true
  }).formatToParts(now);
  const hour = timeParts.find((part) => part.type === "hour")?.value ?? "--";
  const minute = timeParts.find((part) => part.type === "minute")?.value ?? "--";
  const period = timeParts.find((part) => part.type === "dayPeriod")?.value ?? "";
  const date = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric"
  }).format(now);
  return (
    <div className="widget-anime-clock" aria-label={`${hour}:${minute} ${period}, ${date}`}>
      <div className="widget-character-art" aria-hidden="true">
        <span className="widget-character-moon" />
        <span className="widget-character-silhouette"><i /><b /></span>
        <span className="widget-character-raven raven-a" />
        <span className="widget-character-raven raven-b" />
        <span className="widget-character-ribbon" />
      </div>
      <time dateTime={now.toISOString()}>
        <span>{hour}:{minute}</span>
        <small>{period}</small>
      </time>
      <footer>{date}</footer>
    </div>
  );
}

function PanelActionWidget({
  icon,
  title,
  detail,
  panel
}: {
  icon: React.ReactNode;
  title: string;
  detail: string;
  panel: "start" | "controls";
}) {
  return (
    <button
      className="widget-panel-action"
      type="button"
      onClick={() => window.dispatchEvent(new CustomEvent("elix-open-panel", { detail: panel }))}
    >
      {icon}
      <span><strong>{title}</strong><small>{detail}</small></span>
      <b>Open</b>
    </button>
  );
}

function InfoWidget({ icon, title, lines }: { icon: React.ReactNode; title: string; lines: string[] }) {
  return (
    <div className="widget-info">
      {icon}
      <strong>{title}</strong>
      {lines.map((line) => <span key={line}>{line}</span>)}
    </div>
  );
}

function DateWidget() {
  const now = new Date();
  return (
    <div className="widget-date">
      <span>{new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(now)}</span>
      <strong>{now.getDate()}</strong>
      <small>{new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(now)}</small>
    </div>
  );
}

function WorldClockWidget() {
  const zones = [
    ["Local", undefined],
    ["London", "Europe/London"],
    ["Tokyo", "Asia/Tokyo"]
  ] as const;
  return (
    <div className="widget-world-clock">
      {zones.map(([label, timeZone]) => (
        <span key={label}>
          <small>{label}</small>
          <strong>{new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", timeZone }).format(new Date())}</strong>
        </span>
      ))}
    </div>
  );
}

function UptimeWidget() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const started = performance.now();
    const timer = window.setInterval(() => setSeconds(Math.floor((performance.now() - started) / 1000)), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <div className="widget-info">
      <TimerReset />
      <strong>{Math.floor(seconds / 60)}m {seconds % 60}s</strong>
      <span>ELIX session uptime</span>
      <span>Local compositor active</span>
    </div>
  );
}

function MusicWidget() {
  const audio = useRef<HTMLAudioElement | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const sourceUrl = useRef<string | undefined>(undefined);
  const [track, setTrack] = useState("Choose a local track");
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);

  useEffect(() => () => {
    if (sourceUrl.current) URL.revokeObjectURL(sourceUrl.current);
  }, []);

  const selectTrack = (file: File) => {
    if (sourceUrl.current) URL.revokeObjectURL(sourceUrl.current);
    sourceUrl.current = URL.createObjectURL(file);
    if (!audio.current) return;
    audio.current.src = sourceUrl.current;
    audio.current.load();
    setTrack(file.name.replace(/\.[^.]+$/, ""));
    setProgress(0);
    if ("mediaSession" in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: file.name.replace(/\.[^.]+$/, ""),
        artist: "Local audio",
        album: "ELIX Music"
      });
      navigator.mediaSession.setActionHandler("play", () => void audio.current?.play());
      navigator.mediaSession.setActionHandler("pause", () => audio.current?.pause());
      navigator.mediaSession.setActionHandler("seekbackward", () => {
        if (audio.current) audio.current.currentTime = Math.max(0, audio.current.currentTime - 10);
      });
      navigator.mediaSession.setActionHandler("seekforward", () => {
        if (audio.current) audio.current.currentTime = Math.min(audio.current.duration || Infinity, audio.current.currentTime + 10);
      });
    }
  };

  return (
    <div className="widget-music">
      <audio
        ref={audio}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(event) => {
          const element = event.currentTarget;
          setProgress(element.duration ? element.currentTime / element.duration * 100 : 0);
        }}
      />
      <input
        ref={input}
        className="visually-hidden"
        type="file"
        accept="audio/*"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) selectTrack(file);
        }}
      />
      <button type="button" className="widget-music-art" onClick={() => input.current?.click()} aria-label="Choose local music">
        <Music2 />
      </button>
      <span>
        <strong>{track}</strong>
        <small>{audio.current?.src ? "Local audio · private" : "MP3, M4A, WAV, FLAC, or OGG"}</small>
        <i><b style={{ width: `${progress}%` }} /></i>
      </span>
      <button
        type="button"
        disabled={!audio.current?.src}
        aria-label={playing ? "Pause" : "Play"}
        onClick={() => {
          if (!audio.current) return;
          if (audio.current.paused) void audio.current.play();
          else audio.current.pause();
        }}
      >
        {playing ? <Pause /> : <Play />}
      </button>
    </div>
  );
}

function FocusWidget() {
  const [remaining, setRemaining] = useState(25 * 60);
  const [running, setRunning] = useState(false);
  useEffect(() => {
    if (!running || remaining <= 0) return;
    const timer = window.setInterval(() => {
      setRemaining((value) => {
        if (value <= 1) {
          setRunning(false);
          return 0;
        }
        return value - 1;
      });
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [remaining, running]);
  const minutes = Math.floor(remaining / 60).toString().padStart(2, "0");
  const seconds = (remaining % 60).toString().padStart(2, "0");
  return (
    <div className="widget-focus">
      <strong>{minutes}:{seconds}</strong>
      <span>Focus session</span>
      <div>
        <button type="button" aria-label={running ? "Pause focus timer" : "Start focus timer"} onClick={() => setRunning((value) => !value)}>
          {running ? <Pause /> : <Play />}
        </button>
        <button type="button" aria-label="Reset focus timer" onClick={() => {
          setRunning(false);
          setRemaining(25 * 60);
        }}><TimerReset /></button>
      </div>
    </div>
  );
}

function ShortcutsWidget() {
  const shortcuts = [
    { label: "Files", icon: FolderOpen, target: "explorer.exe" },
    { label: "Settings", icon: Settings2, target: "ms-settings:" },
    { label: "Terminal", icon: Terminal, target: "wt.exe" },
    { label: "Security", icon: ShieldCheck, target: "windowsdefender:" }
  ];
  return (
    <div className="widget-shortcuts">
      {shortcuts.map(({ label, icon: Icon, target }) => (
        <button type="button" key={label} onClick={() => openNative(target)}>
          <Icon /><span>{label}</span>
        </button>
      ))}
    </div>
  );
}

function StorageWidget({ system }: { system: SystemSummary | null }) {
  const total = system?.systemDriveTotalBytes ?? 0;
  const free = system?.systemDriveFreeBytes ?? 0;
  const used = Math.max(0, total - free);
  const ratio = total > 0 ? Math.round((used / total) * 100) : 0;
  const format = (bytes: number) => `${Math.round(bytes / 1024 / 1024 / 1024)} GB`;
  return (
    <div className="widget-storage">
      <HardDrive />
      <strong>{total ? `${ratio}% used` : "Checking storage"}</strong>
      <span>{total ? `${format(free)} free of ${format(total)}` : "Waiting for Windows drive data"}</span>
      <i><b style={{ width: `${ratio}%` }} /></i>
    </div>
  );
}

function PerformanceWidget({ system }: { system: SystemSummary | null }) {
  const memory = system ? Math.round(system.workingSetBytes / 1024 / 1024) : null;
  return (
    <div className="widget-performance">
      <Cpu />
      <strong>{system?.processCount ?? "—"} processes</strong>
      <span>{system ? `${system.processorCount} logical processors` : "Reading Windows performance"}</span>
      <small>{memory === null ? "Service memory unavailable" : `ELIX service · ${memory} MB`}</small>
    </div>
  );
}

function ConnectivityWidget({ integrations }: { integrations: IntegrationStatus | null }) {
  return (
    <div className="widget-connectivity">
      <Wifi />
      <strong>{integrations?.backendAvailable ? "ELIX online" : "Local shell"}</strong>
      <span>{integrations?.backendAvailable ? `${integrations.mcpServerCount} MCP servers available` : "Native Windows capabilities remain available"}</span>
      <button type="button" onClick={() => openNative("ms-settings:network-status")}>Network settings</button>
    </div>
  );
}

function WorkspaceWidget({ appCount, runningWindowCount }: { appCount: number; runningWindowCount: number }) {
  return (
    <div className="widget-workspace">
      <LayoutGrid />
      <strong>Desktop 01</strong>
      <span>{runningWindowCount} open window{runningWindowCount === 1 ? "" : "s"}</span>
      <small>{appCount} applications indexed locally</small>
    </div>
  );
}

function CalendarWidget() {
  const now = new Date();
  const days = Array.from({ length: 14 }, (_, index) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - 3 + index));
  return (
    <div className="widget-calendar">
      <strong>{new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(now)}</strong>
      <div>
        {days.map((day) => (
          <span className={day.toDateString() === now.toDateString() ? "today" : ""} key={day.toISOString()}>
            <small>{new Intl.DateTimeFormat(undefined, { weekday: "narrow" }).format(day)}</small>
            <b>{day.getDate()}</b>
          </span>
        ))}
      </div>
    </div>
  );
}

function ClockWidget() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <div className="widget-clock">
      <strong>{new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(now)}</strong>
      <span>{new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" }).format(now)}</span>
    </div>
  );
}

function NotesWidget({ id }: { id: string }) {
  const [text, setText] = useState("");
  const [ready, setReady] = useState(false);
  useEffect(() => {
    void osService.widgetState<{ text?: string }>(id)
      .then((state) => setText(state.text ?? ""))
      .catch(() => undefined)
      .finally(() => setReady(true));
  }, [id]);
  useEffect(() => {
    if (!ready) return;
    const timer = window.setTimeout(() => {
      void osService.saveWidgetState(id, { text }).catch(() => undefined);
    }, 450);
    return () => window.clearTimeout(timer);
  }, [id, ready, text]);
  return (
    <label className="widget-notes">
      <NotebookPen />
      <textarea
        aria-label="Scratchpad"
        value={text}
        placeholder={ready ? "Write a local note…" : "Loading…"}
        onChange={(event) => setText(event.target.value)}
      />
    </label>
  );
}
