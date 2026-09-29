/**
 * Core types, data models, and contracts for the ELIX Application Registry subsystem.
 *
 * @module @deepseek-ai/dsh-app-registry/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/**
 * Deterministic, source-aware branded unique application identifier.
 * Stable across machine restarts, rescans, and application minor updates.
 */
export type AppId = Branded<'AppId'>

/**
 * Constructor helper for strongly typed AppId.
 *
 * @param id - The raw validated application id string.
 * @returns An AppId carrying compile-time branding.
 */
export function makeAppId(id: string): AppId {
  return id as AppId
}

/**
 * Supported classification kinds of installed or launchable applications.
 */
export type AppKind =
  | 'win32'
  | 'packaged'
  | 'shortcut'
  | 'pwa'
  | 'protocol'
  | 'remote'

/**
 * Operating-system discovery sources capable of reporting installed applications.
 */
export type AppDiscoverySource =
  | 'start-menu-user'
  | 'start-menu-system'
  | 'packaged-apps'
  | 'registry'
  | 'manual'

/**
 * Reference to an icon stored as a direct file on disk (e.g. .ico or .png).
 */
export interface FileIconReference {
  readonly kind: 'file'
  readonly filePath: string
}

/**
 * Reference to an icon embedded inside a PE binary (e.g. .exe or .dll resource).
 */
export interface ResourceIconReference {
  readonly kind: 'resource'
  readonly sourcePath: string
  readonly resourceIndex: number
}

/**
 * Reference to an icon packaged inside an MSIX/UWP application bundle.
 */
export interface PackagedIconReference {
  readonly kind: 'packaged'
  readonly packageFamilyName: string
  readonly relativePath?: string | undefined
  readonly fullPath?: string | undefined
}

/**
 * Generic fallback icon reference when no specific visual asset can be extracted.
 */
export interface FallbackIconReference {
  readonly kind: 'fallback'
  readonly defaultIconId: 'generic-app' | 'generic-executable' | 'generic-system'
}

/**
 * Union of all supported icon reference contracts.
 */
export type AppIconReference =
  | FileIconReference
  | ResourceIconReference
  | PackagedIconReference
  | FallbackIconReference

/**
 * Win32 application execution specification.
 * Separates executable binary path from arguments and working directory.
 */
export interface Win32LaunchSpec {
  readonly kind: 'win32'
  readonly executablePath: string
  readonly arguments?: readonly string[] | undefined
  readonly workingDirectory?: string | undefined
}

/**
 * Packaged MSIX/UWP application execution specification.
 * Utilizes the Application User Model ID (AUMID).
 */
export interface PackagedLaunchSpec {
  readonly kind: 'packaged'
  readonly aumid: string
  readonly packageFamilyName?: string | undefined
  readonly arguments?: readonly string[] | undefined
}

/**
 * Shortcut-backed application execution specification.
 */
export interface ShortcutLaunchSpec {
  readonly kind: 'shortcut'
  readonly shortcutPath: string
  readonly targetPath: string
  readonly arguments?: readonly string[] | undefined
  readonly workingDirectory?: string | undefined
}

/**
 * Union of all concrete application launch specifications.
 */
export type AppLaunchSpec =
  | Win32LaunchSpec
  | PackagedLaunchSpec
  | ShortcutLaunchSpec

/**
 * Fully normalized, immutable record representing an application in the ELIX catalog.
 */
export interface AppRecord {
  /** Stable, deterministic application identifier. */
  readonly id: AppId
  /** Application classification kind. */
  readonly kind: AppKind
  /** Primary human-readable display title. */
  readonly displayName: string
  /** Optional application description or tooltip text. */
  readonly description?: string | undefined
  /** Software publisher or vendor name. */
  readonly publisher?: string | undefined
  /** Strongly typed icon reference. */
  readonly icon: AppIconReference
  /** Execution specification for launching the application. */
  readonly launch: AppLaunchSpec
  /** Primary discovery source from which this application was identified. */
  readonly source: AppDiscoverySource
  /** Searchable alternative names, command names, and aliases. */
  readonly aliases: readonly string[]
  /** Path to the folder where the application was installed. */
  readonly installLocation?: string | undefined
  /** Timestamp (ms) when this application was first observed by ELIX. */
  readonly firstSeenAt: number
  /** Timestamp (ms) of the most recent discovery scan that verified this application. */
  readonly lastSeenAt: number
  /** Timestamp (ms) of the most recent modification to metadata. */
  readonly updatedAt: number
}

/**
 * Application availability resolution outcome.
 * Allows callers (e.g. Home, Launcher, Dock) to distinguish between installed apps
 * and orphaned/uninstalled shortcuts without deleting layout elements.
 */
export type AppResolution =
  | { readonly status: 'available'; readonly app: AppRecord }
  | { readonly status: 'missing'; readonly appId: AppId }

/**
 * Raw discovery data produced by an underlying OS discovery provider.
 * Normalization and validation convert this into an authoritative {@link AppRecord}.
 */
export interface DiscoveredApplication {
  readonly source: AppDiscoverySource
  readonly kind: AppKind
  readonly rawId?: string | undefined
  readonly displayName: string
  readonly description?: string | undefined
  readonly publisher?: string | undefined
  readonly executablePath?: string | undefined
  readonly arguments?: readonly string[] | undefined
  readonly workingDirectory?: string | undefined
  readonly shortcutPath?: string | undefined
  readonly aumid?: string | undefined
  readonly packageFamilyName?: string | undefined
  readonly iconPath?: string | undefined
  readonly iconResourceIndex?: number | undefined
  readonly installLocation?: string | undefined
  readonly aliases?: readonly string[] | undefined
  readonly displayVersion?: string | undefined
}

/**
 * Contract implemented by internal Windows discovery providers.
 */
export interface AppDiscoveryProvider {
  /** Unique provider identifier (e.g. 'start-menu', 'packaged-apps', 'registry-metadata'). */
  readonly id: string

  /**
   * Execute an application discovery scan across the provider's backing OS source.
   *
   * @param signal - Optional cancellation signal.
   * @returns List of discovered raw applications.
   */
  discover(signal?: AbortSignal): Promise<readonly DiscoveredApplication[]>
}

/**
 * Diagnostic fault record captured when an individual provider fails or times out.
 */
export interface ProviderFault {
  readonly providerId: string
  readonly error: string
  readonly timestamp: number
}

/**
 * Aggregate summary of a catalog refresh operation.
 */
export interface AppRegistryRefreshResult {
  readonly totalApps: number
  readonly addedCount: number
  readonly updatedCount: number
  readonly removedCount: number
  readonly durationMs: number
  readonly faults: readonly ProviderFault[]
}

/**
 * Options passed when requesting an application launch.
 */
export interface AppLaunchOptions {
  /** Additional command-line arguments to append to the launch specification. */
  readonly additionalArgs?: readonly string[] | undefined
  /** Working directory override. */
  readonly workingDirectory?: string | undefined
}

/**
 * Outcome of an application launch attempt.
 */
export interface AppLaunchResult {
  readonly success: boolean
  readonly pid?: number | undefined
  readonly error?: string | undefined
}

/**
 * Pluggable adapter interface for executing application launches.
 * Decouples process launching from App Registry, allowing future Rust Native Core
 * to replace Win32/ShellExecute mechanisms seamlessly.
 */
export interface AppLaunchAdapter {
  launchWin32(spec: Win32LaunchSpec, options?: AppLaunchOptions): Promise<AppLaunchResult>
  launchPackaged(spec: PackagedLaunchSpec, options?: AppLaunchOptions): Promise<AppLaunchResult>
  launchShortcut(spec: ShortcutLaunchSpec, options?: AppLaunchOptions): Promise<AppLaunchResult>
}

/**
 * Search options for filtering and ranking applications.
 */
export interface AppSearchOptions {
  /** Maximum number of search results to return. Default 20. */
  readonly limit?: number | undefined
  /** Filter to specific application kinds (e.g. 'win32', 'packaged'). */
  readonly kinds?: readonly AppKind[] | undefined
}

/**
 * Resolved visual icon asset information ready for rendering.
 */
export interface ResolvedIcon {
  readonly uri: string
  readonly isFallback: boolean
}

/**
 * Contract for resolving an {@link AppIconReference} into a displayable URI.
 */
export interface AppIconResolver {
  resolve(reference: AppIconReference): Promise<ResolvedIcon>
}

/**
 * Serializable metadata payload stored in the atomic disk cache.
 */
export interface AppRegistryCacheData {
  readonly version: number
  readonly timestamp: number
  readonly apps: readonly AppRecord[]
}

/**
 * Configuration options for {@link AppRegistryService}.
 */
export interface Config {
  /** Whether the App Registry plugin is enabled. Default true. */
  readonly enabled: boolean
  /** Explicit persistent cache filepath override. */
  readonly cachePath?: string | undefined
  /** Whether to automatically execute a background discovery refresh on startup. Default true. */
  readonly autoRefreshOnStartup: boolean
  /** Provider timeout in milliseconds. Default 10000. */
  readonly providerTimeoutMs: number
  /** Custom launch adapter override for testing or native binding. */
  readonly launchAdapter?: AppLaunchAdapter | undefined
  /** Custom discovery providers override for headless tests. */
  readonly customProviders?: readonly AppDiscoveryProvider[] | undefined
}
