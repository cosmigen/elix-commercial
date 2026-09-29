# `@deepseek-ai/dsh-windows-context`

`ctx.windowsContext` is ELIX's authoritative source for connected-monitor topology, virtual-screen physical-pixel bounds, work areas, primary-monitor state, per-monitor DPI, foreground application context, and fullscreen classification. It projects complete immutable snapshots with service-owned monotonic revisions over the existing supervised native host.

Monitor IDs are stable/best-effort hashes of Windows DisplayConfig target identity. Foreground `nativeId` values are transient HWND representations and are not durable window identity. Native capture failures retain the previous known-good snapshot and emit `windows-context/fault`; native-host recovery restores observation and publishes a `recovered` replacement.

## Known Limitations and Deferred Work

- Hardware replacement and some driver topology changes can legitimately change a best-effort monitor ID.
- Phase 7 owns surface creation, renderer coordinate conversion, and `WM_DPICHANGED`; this package creates no shell windows.
