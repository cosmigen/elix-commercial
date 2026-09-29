# `@deepseek-ai/dsh-window-preview`

Phase 17A Window Preview + Visual Composition authority for ELIX.

## Ownership

`WindowPreviewService` sits above two existing authorities:

- **Window Registry** owns stable source `WindowId` identity and current HWND/lifecycle evidence.
- **Surface Core** owns destination ELIX HWNDs, visibility, DPI, WebView2, and native teardown.
- **Window Preview** owns preview leases, live-resource scheduling, backend selection, fallback state, native preview registration/release, and recovery.

Consumers never receive an `HWND`, `HTHUMBNAIL`, screenshot byte buffer, or native capture object. They request a lease using stable `WindowId` + Surface ID and observe backend-neutral state.

## Backend decision

Phase 17A uses **DWM thumbnails** as the first live backend. The relationship is composed by Windows directly into an ELIX destination surface, so continuously changing frame bytes do not cross the JSON bridge. The public lease API does not depend on DWM and is intentionally suitable for a future Windows Graphics Capture backend where arbitrary texture composition is needed.

A screenshot/WebP/base64 loop was explicitly not adopted as the primary architecture. It creates repeated capture/encode/decode work and couples preview quality to IPC throughput rather than to the Windows compositor.

## Lease states

- `live` — a native live relationship is active.
- `cached` — reserved for a future frame-producing backend that can retain a last-good frame; DWM itself does not manufacture cached pixels.
- `paused` — consumer hidden, session locked, or live-resource budget denied.
- `unavailable` — source currently cannot be composed (for example minimized/cloaked) or native setup failed.
- `denied` — Windows denied access; ELIX does not attempt to bypass the restriction.
- `destroyed` — source `WindowId` or destination Surface lifetime ended, or the consumer released the lease.

Minimized or cloaked applications are **never restored merely to obtain a preview**.

## Resource policy

`maxLivePreviews` bounds simultaneous native relationships. Candidates are selected by explicit importance and then recency. Hidden consumers, session lock, source destruction, destination destruction, and service disposal release native resources. Multiple consumers of the same source own independent destination relationships and can be released separately.

Resize/event storms are coalesced so native mutation converges to the newest requested geometry. The default fit is `contain`, preserving the source aspect ratio; `stretch` is explicit opt-in.

## Recovery and privacy

DWM thumbnail handles belong to the native-host process and are invalid after host restart. Registry recovery clears stale binding evidence and re-resolves stable `WindowId` + Surface identities before rebinding. Session lock drops all live relationships and unlock re-evaluates leases.

## Verification

Focused service tests:

```powershell
pnpm exec vitest run packages/core/window-preview/tests/service.spec.ts packages/bundle/windows-runtime/tests/composition.spec.ts --no-file-parallelism
```

Real Windows visual acceptance:

```powershell
pnpm run demo:window-preview
```

The live acceptance proves two simultaneous consumers, visibility pause/resume, minimized-source fallback, explicit restore recovery, source destruction, and final zero native preview relationships.
