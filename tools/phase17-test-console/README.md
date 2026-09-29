# ELIX Phase 17 Test Console

Interactive Windows acceptance console for Phase 17A Window Preview and Phase 17B Window Placement.

This is developer-only verification tooling. It boots the real Cordis services and Rust native host, opens one Surface Core/WebView2 dashboard, and drives the production `WindowPreviewService`, `WindowControlService`, `WindowsContextService`, `ShellLayoutService`, and `WindowPlacementService` APIs. It does not replace package tests or the final Phase 17 regression gate.

## Start

From the repository root on Windows, either double-click `run-phase17-test-console.cmd` or run:

```powershell
pnpm demo:phase17
```

The launcher builds the native bridge first, then opens the dashboard. The dashboard uses a random loopback port and temporary WebView2 profiles under the operating-system temp directory; normal exit removes those profiles.

## Recommended acceptance flow

1. Click **Open test Notepad**. The console resolves its stable `WindowId` through Window Registry.
2. In Phase 17A, acquire Preview A and B, type into Notepad, and visually confirm both DWM previews show the same live source. Then run visibility, minimize/restore, session-cycle, resize, and budget tests.
3. In Phase 17B, click every placement zone, restore the original position, query constraints, then run maximized placement, operation-conflict, and cancellation tests.
4. If multiple monitors are connected, select another monitor and run move-to-monitor. Open/select a second application window for the named two-window layout test.
5. Change monitor topology, DPI, or orientation manually, click **Refresh**, repeat a placement, and mark the topology check only after visual confirmation.
6. Run **Close target + verify stale WindowId** last. It intentionally closes the selected window and verifies both preview teardown and stale-lifetime rejection.
7. Download the JSON report before exiting if evidence is needed.

## What the console verifies

Phase 17A coverage includes stable source resolution, two simultaneous live consumers, DWM binding lifecycle, hide/show reconciliation, minimized-source fallback, explicit restore recovery, simulated session lock/unlock, source resize reconciliation, live-preview priority budgeting, source-destruction cleanup, and user-confirmed live visual content.

Phase 17B coverage includes all ten manual placement zones, reversible restore records, application sizing constraints, maximized-window placement/restore, operation-conflict fencing, cooperative cancellation, stale `WindowId` rejection, monitor moves, named two-window layouts, and guided monitor/DPI/orientation verification.

## Safety and cleanup

The stale-ID action is destructive to the selected target because closing the window is the condition being tested. Use the spawned Notepad when you do not want to close another application. The console only controls windows selected through Window Registry and tears down its preview leases, Surface instances, Cordis fiber, native bridge, spawned Notepad, HTTP listener, and temporary state on normal exit.
