# Phase 17A — Window Preview + Visual Composition

Date: 2026-09-16

## Research conclusion

Before implementation, ELIX reviewed Seelen UI's existing preview direction as a reference point. Its screenshot-oriented path is useful for UI preview generation but does not match ELIX's Phase 17A requirement to establish a native visual-composition primitive with bounded live resources. ELIX therefore does not make encoded screenshot frames the core preview contract.

Windows offers two relevant architectural families:

1. **DWM thumbnail composition** — Windows owns a live source-to-destination relationship. This is low-copy and appropriate for proving native preview composition into a top-level ELIX HWND.
2. **Windows Graphics Capture** — produces frames/textures and is more flexible for arbitrary compositor graphs. It remains a future backend behind the same lease abstraction rather than being required for 17A.

Phase 17A selects DWM thumbnails first and keeps the consumer API backend-neutral.

## Authority boundaries

```text
Window Registry (stable WindowId + current lifetime evidence)
             +
Surface Core (ELIX destination HWND ownership)
             |
             v
Window Preview Service (lease/resource/fallback authority)
             |
             v
Native Core DWM backend (HWND + HTHUMBNAIL remain private)
```

Window Preview does not become a second window registry, surface manager, launcher, or application runtime. Source HWNDs are re-resolved from stable `WindowId` immediately before native work. Destination HWNDs are re-resolved from Surface Core.

The Preview service is a standalone `packages/core/window-preview` project. It must not live inside Surface because Window Registry already has a Surface dependency for ELIX-surface classification; embedding Preview in Surface would introduce a project-reference cycle.

## Public contract

Consumers acquire/update/release leases. Public states are `live`, `cached`, `paused`, `unavailable`, `denied`, and `destroyed`. `cached` is reserved for a future frame-producing backend; DWM does not fabricate a cached frame.

The API exposes no HWND, HTHUMBNAIL, image buffer, or capture session. The native bridge transports only control/state messages; continuously changing frame data is not serialized through NDJSON.

## Resource and lifecycle policy

- Default live budget: 12 relationships, configurable and bounded.
- Arbitration: explicit importance, then most-recent request.
- Hidden consumer: native relationship released, lease paused.
- Session lock: all live relationships released; unlock re-evaluates leases.
- Minimized/cloaked/hidden source: unavailable fallback; never restore just to capture.
- Protected/denied source: `denied`; no bypass attempt.
- Source or destination destruction: relationship released and lease destroyed.
- Native-host recovery: process-local handles are considered gone; stable identities are re-resolved and eligible leases are rebound.
- Service disposal: all owned native relationships are released.
- Resize storms: reconciliation coalesces to newest geometry.
- Default geometry policy: aspect-preserving `contain`; `stretch` is explicit.

## Acceptance proof

The real Windows harness builds an animated Win32 source and displays it simultaneously inside two transparent ELIX surfaces. It proves two independent live relationships, consumer hide/resume, minimized fallback, explicit source restore, source destruction, and zero native relationships after cleanup.
