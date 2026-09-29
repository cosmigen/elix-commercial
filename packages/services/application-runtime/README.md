# ELIX Application Runtime Core — Phase 15

`@deepseek-ai/dsh-application-runtime` is the application/window runtime projection between App Registry, Window Registry, and Window Control.

## Authority boundaries

Application Runtime does **not** own application discovery, native windows, or Win32 mutations.

- `ctx.appRegistry` remains authoritative for `AppId`, installed/launchable application metadata, search, and launch requests.
- `ctx.windowRegistry` remains authoritative for current `WindowId` state, lifetime, classification, foreground state, and native-host recovery.
- `ctx.windowControl` remains authoritative for activate/restore and all other window mutations.
- `ctx.applicationRuntime` owns only AppId↔WindowId association, application/window MRU policy, coherent derived snapshots, and app-level launch-or-activate orchestration.

Consumers must not bypass those owners. In particular, this package must never add its own EnumWindows loop, process launcher, raw HWND mutation path, monitor/DPI observer, surface host, or overlay renderer.

## Runtime truth, not process truth

Phase 15 deliberately exposes `hasObservedWindows(appId)`. It does **not** expose `isRunning(appId)`.

A process can be alive without an observable top-level application window. ELIX does not yet have an authoritative Process Registry, so `hasObservedWindows(appId) === false` must never be interpreted as proof that the process is stopped.

The public runtime snapshot contains only applications with confidently matched observed `APPLICATION` windows. Installed applications with no observed windows remain App Registry state, not duplicated Application Runtime catalog state.

## Identity matching

The matching precedence is deterministic:

1. exact normalized AUMID when the observed window provides an AUMID;
2. normalized direct Win32 executable path;
3. normalized shortcut target executable path.

A present AUMID is strong identity evidence. If that AUMID is not in App Registry, Application Runtime does not fall back to a shared host executable such as `ApplicationFrameHost.exe`.

Windows paths are compared with Windows path semantics, case-insensitively and without filesystem I/O on each Window Registry update. Phase 15 does not guess identity from window titles, executable basenames, PID alone, or HWND values.

If multiple same-precedence AppIds match one WindowId, the window remains explicitly `ambiguous-catalog-match`; it is never attached to multiple applications and launch-or-activate refuses to create a likely duplicate process.

## MRU and activation

Application and per-application window MRU order is derived from authoritative Window Registry foreground transitions/snapshots. Destroyed or no-longer-eligible WindowIds are removed during reconciliation.

Activation target precedence is:

1. most-recent eligible non-minimized window;
2. most-recent eligible minimized window;
3. no target.

Minimized targets are restored through Window Control before activation. Maximized windows are activated without implicitly restoring them.

Hidden, cloaked, disabled, non-`APPLICATION`, shell, ELIX surface, tool, transient, system, and ignored windows are not normal activation targets.

## `launchOrActivate`

`launchOrActivate(appId)` behaves as follows:

- existing eligible window: activate the deterministic MRU target;
- minimized MRU target: restore, then activate;
- confidently matched windows exist but none are eligible: fail without launching a duplicate;
- an ambiguous existing window may belong to this AppId: fail without launching a duplicate;
- no matched/ambiguous observed window: request launch through App Registry.

A successful launch request does not fabricate a WindowId and does not wait indefinitely for a window. The action result `launch-requested` means the launch request completed successfully, not that a visible window has appeared.

Concurrent same-AppId operations with identical launch options share the same in-flight operation. Different launch options return `CONCURRENT_LAUNCH_CONFLICT` instead of silently dropping arguments or launching duplicate instances.

## Failure and recovery semantics

Window Control `accepted` is not treated as proof that Windows completed foreground activation. Partial outcomes such as restore-success/activation-failure are returned honestly.

If the selected WindowId becomes stale between selection and mutation, Phase 15 performs at most one safe re-resolution to a different surviving target. It never retries indefinitely.

Full Window Registry snapshots remain authoritative. Native-host generation changes, event duplication, reordering, app catalog refreshes, late catalog arrival, app removal, and HWND reuse are handled by rebuilding the derived projection rather than mutating native truth.

Subscriber exceptions are isolated and cannot corrupt runtime state or prevent other subscribers from receiving updates.

## Deferred capabilities

Phase 15 intentionally does not implement:

- full process observation / Process Registry;
- Dock or Status Bar UI;
- Alt+Tab or Mission Control UI;
- window tiling, snapping, placement, or workspace policy;
- global shortcuts;
- shell overlays or previews;
- native surfaces/WebView2;
- agent or proactive automation behavior.

Those capabilities belong to later ELIX phases and should consume Application Runtime rather than duplicate it.
