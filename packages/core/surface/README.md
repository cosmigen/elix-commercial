# `@deepseek-ai/dsh-surface`

Authoritative native Windows surface system for ELIX with WebView2 hosting, PMv2 DPI awareness, z-order control, focus policy, and ready-before-show semantics.

`ctx.surface` is ELIX's core surface capability providing:

- Managed Win32 HWND allocation on dedicated STA UI thread with message loop pumping.
- Embedded Microsoft Edge WebView2 hosting with isolated or shared user data environments.
- Ready-before-show guarantee: surfaces are not mapped to visible desktop z-order until both native HWND and webview renderer report ready.
- Physical pixel coordinate geometry integrated with `ctx.windowsContext`.
- Declarative intent restoration across out-of-process native host restarts.

Consumers use `SurfaceService` and `SurfaceInstance` directly and await their asynchronous operations. Home adds only monitor identity and renderer runtime policy around those instances; Surface Core remains the owner of HWND, WebView2, readiness, visibility, z-order, DPI, bounds, recovery, and native teardown.
