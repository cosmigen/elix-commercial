# @deepseek-ai/dsh-native-core

Typed TypeScript bridge and adapters for the out-of-process ELIX Rust Native Core.

`NativeBridgeClient` owns protocol handshake, bounded request deadlines, stdin backpressure, host generations, restart policy, declarative watcher restoration, and deterministic shutdown. Native watcher IDs are paired with the host generation that created them and are cleared immediately when that host terminates.

`createNativeAdapters()` exposes Known Folder, file identity, Shell Link, icon, namespace watcher, and application launch adapters. Shell Namespace and App Registry consume these adapters behind their existing domain APIs; this package does not add a public Cordis service.

Watcher invalidation means fine-grained precision was lost. The watcher adapter waits for every registered reconciliation listener to complete successfully before calling native `watcher/rearm`; a rejected listener leaves the native watcher degraded.

See [Phase 5 Rust Native Core](../../../docs/phase-5-rust-native-core-architecture.md) for protocol, failure, resource, and reparse-point semantics.
