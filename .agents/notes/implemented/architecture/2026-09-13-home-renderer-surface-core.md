# Agent Note: Home renderer ownership on Surface Core

Status: implemented

## Problem

The Home domain model had an independent synchronous desktop-window abstraction while Surface Core owned the production HWND and WebView2 lifecycle. Keeping both paths would duplicate native ownership, hide asynchronous failures, and leave the visible renderer disconnected from Home's layout, selection, wallpaper, and persistence authorities.

## Decision

Home consumes `SurfaceService` and wraps each `SurfaceInstance` only with monitor identity and wallpaper runtime policy. Surface Core remains the sole owner of HWNDs, WebView2 controllers, current-generation readiness, visibility, z-order, physical bounds, recovery, and native teardown. Home awaits every native mutation and serializes monitor reconciliation so one logical surface exists for each Windows Context monitor.

The renderer is a projection of Home state. Home registers a tokenized loopback route with the shared webserver, renders the initial document and subsequent roots with React server rendering, publishes authoritative replacements through server-sent events, and accepts only a bounded discriminated union of interaction intents. A small client adapter owns temporary pointer and marquee feedback but cannot commit item state. Shortcut targets and local asset paths are not projected into renderer data.

Home stores desktop geometry in physical virtual-screen pixels. The renderer reports monitor-local CSS pixels; Home converts them with the Windows Context monitor origin and scale factor before applying selection, marquee, drag, collision, or grid snapping. Generic exclusion rectangles remain Home placement inputs rather than surface bounds, input hitboxes, or Windows work-area reservations. Exclusion updates reconcile only covered root items through the existing nearest-free-slot algorithm.

Wallpaper preferences remain durable Home state. Static image and video files use tokenized same-origin asset routes, video supports byte ranges and releases media sources during replacement or unload, and live wallpaper is limited to a closed set of ELIX-owned CSS scenes. Visibility and teardown publish explicit runtime states that can accept later power-policy input without adding that policy to Home.

## Alternatives considered

**Keep the Phase 7 Home adapter.** The adapter translated asynchronous Surface operations into fire-and-forget synchronous calls and preserved a second native-window contract. Direct Surface consumption makes failure, ordering, and ownership explicit and deletes the obsolete path.

**Add a new native WebView message protocol.** Surface Core does not expose such a channel. The existing loopback webserver supports recoverable renderer URLs, bounded HTTP intents, media range requests, and server-sent updates without expanding the native protocol.

**Hydrate a second client-side Home store.** A client store would compete with Home persistence and complicate reload and native-host recovery. Stateless React projections plus typed intents preserve one domain authority.

**Allow downloaded live wallpaper scripts.** Home is a privileged shell renderer without a third-party permission or sandbox model. A closed scene registry supplies animated wallpaper without crossing the later runtime boundary.

## Consequences

Home requires Windows Context, Surface Core, and the shared webserver in production. Renderer reload and native-host recreation recover from the durable Home model, while token revocation and stream closure follow monitor and service lifetimes. The loopback renderer adds an HTTP/SSE connection per active WebView and uses full-root replacement for model changes; steady state performs no polling, and transient drag feedback stays local.

Dock, Status Bar, AppBar reservation, WorkerW attachment, shared overlays, launch execution, arbitrary widgets or wallpaper code, window management, and fullscreen shell policy remain unavailable until their owning capabilities exist.
