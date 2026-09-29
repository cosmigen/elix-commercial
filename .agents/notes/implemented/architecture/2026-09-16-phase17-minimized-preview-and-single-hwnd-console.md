# Phase 17 preview integration correction

## Problem

The interactive Phase 17 console initially represented its two preview panes as two additional top-level Surface HWNDs positioned over the dashboard. That made the panes behave like independent floating windows and created unavoidable z-order artifacts. The production Window Preview service also explicitly removed minimized source windows from the live DWM path, even when DWM could continue composing the source.

## Correction

- Preview A and Preview B in the acceptance console use the main console Surface as their single DWM destination HWND, with independent destination rectangles.
- No extra preview Surface HWNDs are needed for those two panes.
- The preview-stage regions in the console are transparent so DWM composition remains visible through the WebView2 surface.
- Minimized windows remain eligible for the DWM live-preview path when they remain otherwise visible, uncloaked, and previewable.
- Cloaked, hidden, destroyed, access-denied, and budget-limited sources keep their existing policy behavior.
- The minimize acceptance check now requires preview leases/native bindings to remain live while minimized and after restore.

## Verification required on Windows

Run `pnpm demo:phase17`, open the disposable Notepad target, acquire both previews, minimize and restore the target, and confirm both panes remain visible and the test records live/native bindings throughout. Run the focused Phase 17 gate afterward. If a specific application cannot provide live minimized composition through DWM, add a cached-frame fallback rather than reintroducing helper top-level preview windows.
