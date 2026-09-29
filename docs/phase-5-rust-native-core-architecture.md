# Phase 5 Rust Native Core

This reference defines the implemented Phase 5 native substrate. The system-wide ownership map is in [ELIX OS Architecture](architecture.md).

## Scope

Phase 5 supplies low-level Windows operations for Known Folders, stable file identity, Shell Link metadata, icon references, directory change observation, and process launch. It does not own Shell Namespace or App Registry semantics, monitor topology, DPI, foreground/fullscreen tracking, HWND surfaces, WorkerW, WebView2, shell UI, or an agent runtime.

The implementation has three parts:

- `native/crates/elix-native-core` owns Win32 and COM calls, handles, watcher workers, and structured native errors.
- `native/crates/elix-native-bridge` owns the native host executable, request dispatch, bounded stdout queues, sticky invalidation delivery, and bounded stdin framing.
- `packages/native/core` owns the TypeScript process supervisor, protocol client, host-generation state, declarative watcher intents, and adapters consumed by Shell Namespace and App Registry.

## Protocol

The host and client communicate through newline-delimited JSON. Each request carries an integer ID, method, and parameters. Responses carry the same ID and either a result or a structured error. Push events have a named event and payload.

`protocolVersion` is an explicit integer exchanged during `bridge/handshake`; `clientVersion` and `nativeVersion` identify package builds and do not determine protocol compatibility. A missing or incompatible protocol version fails the handshake deterministically.

Incoming request frames are limited to 1 MiB. Oversized frames are discarded through their newline without retaining the full input, and the host remains able to parse the following frame. Shortcut batch resolution accepts at most 512 string paths.

## Outbound backpressure

Responses use a bounded channel of 256 entries. Ordinary watcher events use a bounded channel of 1,024 entries and native in-flight budgets of 2,048 globally and 128 per container. At most 256 watcher workers may be active, each with one fixed 64 KiB buffer.

Fine-grained events may be dropped when any ordinary-event budget is exhausted. The watcher then enters degraded state. Priority invalidations do not use a second lossy event queue: a mutex-protected registry retains at most one invalidation per native subscription, while a capacity-one channel only wakes the writer. The writer peeks the oldest invalidation and removes it only after stdout successfully writes the frame. Repeated overflow therefore remains bounded and cannot erase the reconciliation requirement.

Native `ERROR_NOTIFY_ENUM_DIR`, a zero-byte `ReadDirectoryChangesW` completion, synthetic saturation, queue saturation, and fatal watcher-loop errors use the same degraded-container transition. The transition clears any pending rename old-name state before another event batch can be interpreted.

## Watcher lifecycle

`watcher/watch` returns success only after the worker has created its overlapped event and successfully queued the first `ReadDirectoryChangesW`. Initialization error, readiness-channel failure, or startup timeout returns a structured error and joins the worker without registering it.

The watcher opens the requested container without `FILE_FLAG_OPEN_REPARSE_POINT`, so a container reparse point is followed to its target. `ReadDirectoryChangesW` uses `bWatchSubtree = false`; descendants are not recursively observed.

Unexpected queueing, completion, or wait failure after registration marks the watcher dead and degraded, emits its deduplicated invalidation, and prevents `watcher/rearm` from reporting success. Statistics expose both invalidation and worker liveness. Unwatch and host disposal signal the stop event, call `CancelIoEx`, join the worker, and release all handles through RAII.

## Reconciliation and rearm

Rust reports loss of precision but does not reconcile domain state. `NativeNamespaceWatcherAdapter` awaits all Shell Namespace listeners for an invalidation. It sends `watcher/rearm` only if every listener completes successfully and the subscription is still live. Shell Namespace re-enumerates the directory, updates its catalog, emits normalized differences, and propagates reconciliation failure after emitting `provider-fault`; failure leaves native delivery degraded.

After a host restart, the bridge restores each live declarative watcher with a fresh native ID and explicitly invalidates the new watcher. The same reconciliation/rearm path therefore covers filesystem changes made while the host was down.

## Host generations and supervision

Each spawned process increments `hostGeneration`. Every pending request records its generation. Each watcher intent stores either no native binding or `{ id, generation }`. Incoming lines are rejected by generation before response or watcher-ID lookup.

Host termination immediately clears every native binding and the native-to-client map while preserving undisposed declarative intents. Disposing an intent while disconnected removes only that intent; it cannot transmit an earlier generation's ID. Internal sends also reject an explicit generation that is not current.

Automatic restart uses bounded exponential backoff and a maximum restart count. Successful handshake and watcher restoration publish `ready`, but do not reset the failure count. A per-generation stability timer resets the count only after the host remains healthy for the configured window. A process that repeatedly handshakes and crashes reaches `faulted` instead of reconnecting indefinitely.

## Process lifecycle

Node writes each request once. If stdin applies backpressure, the request waits for `drain` while also observing stream error/close, child error/exit, request deadline, and cancellation. Reconnect waiting happens before request creation, so a queued logical request is not duplicated across generations.

Client disposal cancels reconnect and stability timers, requests `bridge/shutdown`, and waits for child exit. If the graceful deadline expires it terminates the child and waits for the bounded fallback interval. The host disposes watchers before closing its channels and joining the stdout writer.

The host initializes its process MTA before accepting normal work. An unexpected COM initialization failure is returned as a structured response to the first request and the host exits. Shell Link operations continue to use their dedicated STA execution path.

## Validation tiers

- Rust unit tests cover bounded framing, sticky priority saturation, watcher startup failure, runtime death, invalidation deduplication, rearm, COM apartments, handles, and native operations.
- TypeScript process tests cover real host crashes, generation reuse, watcher restoration/disposal, downtime reconciliation without polling enumeration, crash-flapping, backpressure, protocol faults, and shutdown.
- Windows live tests exercise Known Folders, NTFS identity, Shell Links, PE icons, `ReadDirectoryChangesW`, reparse-point behavior, and native process cleanup.
- Shell Namespace, App Registry, and Home suites protect the existing domain contracts and Phase 2–4 behavior.
