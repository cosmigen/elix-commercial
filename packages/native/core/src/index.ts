/**
 * @deepseek-ai/dsh-native-core — ELIX OS Rust Native Core TypeScript Bridge.
 *
 * Exposes a typed, robust client to the out-of-process Rust Native Host
 * (`elix-native-host.exe`), providing high-performance, crash-isolated Windows
 * capabilities:
 *
 * 1. Authoritative Known Folders via native `SHGetKnownFolderPath`
 * 2. Stable File Identity via Win32 `FILE_ID_INFO` (128-bit file ID + volume serial)
 * 3. Windows Shell Link (.lnk) resolution via native COM `IShellLinkW` / `IPersistFile`
 * 4. Shell Icon and PE icon resource resolution via native Win32 APIs
 * 5. High-performance directory change watching via native `ReadDirectoryChangesW`
 * 6. Shell-independent process launching via native `CreateProcessW`
 * 7. Event-driven Windows monitor, DPI, foreground, and fullscreen context
 *
 * @module @deepseek-ai/dsh-native-core
 */

import { NativeBridgeClient } from './client.ts'
import type { NativeBridgeOptions } from './types.ts'
import { NativeKnownFolderResolver } from './adapters/known-folders.ts'
import { NativeFileIdentityAdapter } from './adapters/identity.ts'
import { NativeShellLinkResolver } from './adapters/shortcuts.ts'
import { NativeShellIconResolver } from './adapters/icons.ts'
import { NativeNamespaceWatcherAdapter } from './adapters/watcher.ts'
import { NativeAppLaunchAdapter } from './adapters/launch.ts'

export * from './types.ts'
export * from './client.ts'
export * from './adapters/known-folders.ts'
export * from './adapters/identity.ts'
export * from './adapters/shortcuts.ts'
export * from './adapters/icons.ts'
export * from './adapters/watcher.ts'
export * from './adapters/launch.ts'

/**
 * Composite bundle of native capability adapters bound to a shared bridge client.
 */
export interface NativeAdaptersBundle {
  readonly client: NativeBridgeClient
  readonly knownFolders: NativeKnownFolderResolver
  readonly identity: NativeFileIdentityAdapter
  readonly shortcuts: NativeShellLinkResolver
  readonly icons: NativeShellIconResolver
  readonly watcher: NativeNamespaceWatcherAdapter
  readonly launch: NativeAppLaunchAdapter
}

let sharedBridgeInstance: NativeBridgeClient | null = null

/**
 * Returns the shared process-wide Native Bridge client.
 * Lazily instantiated on first call. Ensures all ELIX plugins share one native host process.
 *
 * @param options - Optional bridge client options.
 * @returns Shared NativeBridgeClient instance.
 */
export function getSharedNativeBridge(options?: NativeBridgeOptions): NativeBridgeClient {
  if (!sharedBridgeInstance || sharedBridgeInstance.getStatus() === 'closed') {
    sharedBridgeInstance = new NativeBridgeClient(options)
  }
  return sharedBridgeInstance
}

/**
 * Disposes the shared Native Bridge client if active.
 */
export async function disposeSharedNativeBridge(): Promise<void> {
  if (sharedBridgeInstance) {
    const bridge = sharedBridgeInstance
    sharedBridgeInstance = null
    await bridge.dispose()
  }
}

/**
 * Creates and optionally configures an instance of the NativeBridgeClient.
 *
 * @param options - Optional bridge client options.
 * @returns Configured NativeBridgeClient instance.
 */
export function createNativeBridge(options?: NativeBridgeOptions): NativeBridgeClient {
  return new NativeBridgeClient(options)
}

/**
 * Creates a complete bundle of native capability adapters bound to the provided client.
 *
 * @param client - The NativeBridgeClient to bind adapters to.
 * @returns Bundle containing all native adapter instances.
 */
export function createNativeAdapters(client: NativeBridgeClient): NativeAdaptersBundle {
  return {
    client,
    knownFolders: new NativeKnownFolderResolver(client),
    identity: new NativeFileIdentityAdapter(client),
    shortcuts: new NativeShellLinkResolver(client),
    icons: new NativeShellIconResolver(client),
    watcher: new NativeNamespaceWatcherAdapter(client),
    launch: new NativeAppLaunchAdapter(client),
  }
}
