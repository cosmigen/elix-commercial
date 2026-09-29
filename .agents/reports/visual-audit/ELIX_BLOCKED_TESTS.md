# ELIX OS — Visual Audit Blocked and Out-of-Scope Checks

Audit date: 2026-09-16. These items were not silently counted as passes.

## BLOCKED — native CUA/Sky control channel unavailable

The requested visual audit was performed against real native windows and WebView2 surfaces, with screenshots captured by the repository capture utility and direct window wrappers. The native CUA/Sky RPC was unavailable with Trusted RPC service is not configured: sky, and the available browser-only CUA inventory did not expose native application surfaces.

Documented PTY demos were therefore driven through their own command interfaces. A screenshot was retained only when it represented the actual rendered native window or surface; no simulated click was counted as visual proof.

## BLOCKED — multi-monitor and topology matrix

The machine exposed one active display: B160UAN08.1, 1920×1200, 125% scale, 1920×1140 work area. The following checks could not be exercised on this host:

- a second monitor and cross-monitor movement;
- negative virtual-screen coordinates;
- portrait orientation;
- mixed-DPI monitors;
- monitor unplug/replug and topology-change restore;
- a separate monitor work-area exclusion zone.

Phase 6 is marked PASS only for the available one-monitor path; the topology matrix remains blocked. Phase 17B was still tested for the available display and failed its restore path independently.

## BLOCKED — real Windows accessibility/display settings

The audit did not change the user's persistent Windows settings. Real OS High Contrast, HDR, brightness, and system-wide text scaling were not toggled. Phase 16B used the product's documented UI overrides and captured dark, light, high-contrast, 200% text, reduced-motion, opaque-fallback, and themed-overlay states. Those are visual probes, not a claim that the OS settings integration is fully verified.

## NOT_IMPLEMENTED FOR THIS AUDIT — official Phase 17B chooser surface

The checked-out Phase 17B package exposes the placement policy/authority and service path, but the roadmap places the user-facing chooser integration later (Phase 23G). The audit used an audit-only runner to exercise the available authority against a real Notepad window; it did not invent or count a missing official chooser UI as implemented.

The Phase 17B authority is therefore marked FAIL because restore behavior failed, not BLOCKED. The future chooser remains an explicit NOT_IMPLEMENTED/out-of-scope surface.

## BLOCKED — immediate WebView2 profile cleanup

Several demos rendered correctly but Windows returned EPERM when their WebView2 temporary profile directories were removed immediately during teardown. The visible test windows and dedicated native targets were closed, and the final desktop capture is retained, but the temporary-profile cleanup is not clean. This is recorded as a teardown limitation/failure rather than hidden.

## Completed cleanup checks

pnpm run shell:recovery:check passed with taskbars=1 visible=1. The final desktop capture showed no ELIX native test window remaining.
