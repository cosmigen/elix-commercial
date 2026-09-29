# Phase 6 Windows Context Core

English | [中文](phase-6-windows-context-architecture.zh.md)

Windows Context is ELIX's single production authority for monitor topology, per-monitor DPI, current foreground application context, and fullscreen classification. Its public entry point is `ctx.windowsContext`; Home consumes a projection and does not query Win32 or invent a production monitor.

## State and coordinates

Every public update is a complete immutable `WindowsContextSnapshot` with a TypeScript-owned monotonically increasing revision. Monitor bounds, work areas, and foreground bounds use signed virtual-screen physical pixels, including negative coordinates. DPI is reported as `dpiX`, `dpiY`, and `scaleFactor = dpiX / 96`; renderer DIPs, CSS pixels, surface DPI transitions, and `WM_DPICHANGED` belong to Phase 7.

Monitor IDs are stable/best-effort SHA-256 projections of the active DisplayConfig target device path. If that path is absent, the key uses adapter LUID, target ID, EDID manufacturer/product values, and connector instance. Current GDI device names remain metadata and never define identity alone.

## Native capture

The Rust native core enumerates complete geometry with `EnumDisplayMonitors` and `GetMonitorInfoW`, enriches it through `GetDisplayConfigBufferSizes`, `QueryDisplayConfig`, and `DisplayConfigGetDeviceInfo`, and queries effective DPI with `GetDpiForMonitor` under a scoped `DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2` thread context. A capture is published only after all active monitors have valid geometry, DisplayConfig identity, DPI, and exactly one primary designation; failure retains the previous snapshot.

Foreground capture uses `GetForegroundWindow`, `IsWindowVisible`, `IsIconic`, `DwmGetWindowAttribute(DWMWA_CLOAKED)`, `DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS)` with `GetWindowRect` fallback, `GetWindowLongPtrW`, `GetWindowThreadProcessId`, `GetClassNameW`, and `MonitorFromWindow`. Invisible, minimized, cloaked, tool, desktop, WorkerW, and taskbar windows produce no application foreground context.

Fullscreen is a classification, not one Win32 flag. A visible application must cover its foreground monitor's full bounds within two physical pixels and pass shell/tool/cloak/minimize filtering. Popup or captionless monitor-covering windows classify as fullscreen; framed maximized windows do not, and filling only the work area is insufficient.

## Observation and recovery

One process-wide native observer owns a dedicated per-monitor-v2-aware message-loop thread. The thread installs out-of-context WinEvent hooks for foreground, minimize, window show/hide/destroy, state, and foreground-window location changes. A hidden zero-sized top-level notification window receives display, settings, and device broadcasts; it is observation infrastructure, not an ELIX shell surface. Native filtering admits location/state signals only for the current foreground top-level window.

Startup reports readiness only after the window, hooks, and initial snapshot exist. Shutdown posts to the owning thread, unhooks every `HWINEVENTHOOK`, destroys and unregisters the notification window, restores thread DPI awareness, and joins the thread. Capture errors and unexpected thread termination emit observable faults; listener panics or exceptions are contained.

The existing bounded NDJSON bridge exposes `windowsContext/getSnapshot`, `windowsContext/start`, `windowsContext/stop`, `windowsContext/refresh`, and `windowsContext/status`, plus `windowsContext/change` and `windowsContext/fault` events. Windows Context changes use a sticky latest-state outbound slot, so pressure cannot create unbounded events and the latest coherent state remains deliverable. The TypeScript bridge installs listeners before start, rejects stale host-generation frames, restores one declarative observation intent after reconnect, and publishes the new process's initial state as `recovered`.

## Public service

`ctx.windowsContext` provides `getSnapshot()`, `getMonitors()`, `getMonitor(id)`, `getPrimaryMonitor()`, `getForegroundContext()`, `refresh()`, and `subscribe(listener)`. Wire validation rejects empty or duplicate monitor sets, invalid rectangles, inconsistent primary designation, invalid DPI/scale, and filtered foreground records before state replacement. Subscriber exceptions do not interrupt later subscribers or revisions.

## Deferred ownership

Windows Context creates no shell HWND, WorkerW parent, WebView2 controller, Dock, Status Bar, AppBar reservation, renderer, window-control API, capture pipeline, workspace model, or persistent Window Registry. Those remain Phase 7 or later responsibilities.
