/**
 * Core types, data models, and contracts for the ELIX Shell Namespace / File Provider subsystem.
 *
 * Defines strongly typed models for Shell items, stable file identities, known folders,
 * Desktop aggregation, shortcut metadata, icon references, filesystem attributes,
 * change events, and availability states.
 *
 * @module @deepseek-ai/dsh-shell-namespace/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/**
 * Deterministic unique shell item identifier.
 * Decoupled from location/path to survive renames and same-volume moves.
 */
export type ShellItemId = Branded<'ShellItemId'>

/**
 * Constructor helper for strongly typed ShellItemId.
 *
 * @param id - The raw unique shell item identifier string.
 * @returns A ShellItemId carrying compile-time branding.
 */
export function makeShellItemId(id: string): ShellItemId {
  return id as ShellItemId
}

/**
 * Supported classification kinds of shell items.
 */
export type ShellItemKind =
  | 'file'
  | 'folder'
  | 'shortcut'
  | 'known-folder'
  | 'virtual'
  | 'system'

/**
 * Origin source contributing the shell item into the aggregated namespace.
 */
export type ShellItemSource =
  | 'user-desktop'
  | 'public-desktop'
  | 'filesystem'
  | 'known-folder'
  | 'virtual'

/**
 * Explicit confidence quality of a file's identity.
 * Communicates whether an identity is backed by native OS hardware IDs or a path fallback.
 */
export type IdentityQuality =
  | 'native-stable'
  | 'filesystem-stable'
  | 'path-fallback'

/**
 * Authoritative identity descriptor of a filesystem item.
 */
export interface FileIdentity {
  /** Unique branded identifier. */
  readonly id: ShellItemId
  /** Confidence level of this identity. */
  readonly quality: IdentityQuality
  /** Hex-encoded volume serial number when available. */
  readonly volumeSerialNumber?: string | undefined
  /** Hex-encoded filesystem file index (NTFS File ID) when available. */
  readonly fileId?: string | undefined
  /** Normalized canonical path at time of identification. */
  readonly canonicalPath: string
}

/**
 * Physical or logical location of a shell item.
 */
export interface ShellLocation {
  /** Absolute operating system path. */
  readonly path: string
  /** Optional standard file URI (e.g. file:///C:/path/to/item). */
  readonly uri?: string | undefined
}

/**
 * Normalized filesystem attributes of a shell item.
 * Never hides hidden or system items at the provider layer.
 */
export interface ShellItemAttributes {
  /** Whether the item has the hidden attribute or dotfile prefix. */
  readonly hidden: boolean
  /** Whether the item is marked as an OS system file. */
  readonly system: boolean
  /** Whether the item is marked read-only. */
  readonly readOnly: boolean
  /** Whether the item has the archive bit set. */
  readonly archive: boolean
  /** Whether the item is a directory/container. */
  readonly directory: boolean
  /** Whether the item is a Windows reparse point (junction, symlink, or cloud placeholder). */
  readonly reparsePoint: boolean
  /** Whether the item's content is stored offline / cloud placeholder. */
  readonly offline: boolean
  /** Whether the item is marked as temporary storage. */
  readonly temporary: boolean
}

/**
 * Reference to an icon stored directly as a file on disk (.ico, .png, etc.).
 */
export interface FileIconReference {
  readonly kind: 'file'
  readonly filePath: string
}

/**
 * Reference to an icon embedded inside a PE binary (.exe or .dll resource).
 */
export interface ResourceIconReference {
  readonly kind: 'resource'
  readonly sourcePath: string
  readonly resourceIndex: number
}

/**
 * Reference to a shell icon based on file extension mapping.
 */
export interface ExtensionIconReference {
  readonly kind: 'extension'
  readonly extension: string
}

/**
 * Reference to an icon identified by a specific ShellItemId.
 */
export interface ShellItemIconReference {
  readonly kind: 'shell-item'
  readonly itemId: ShellItemId
}

/**
 * Generic fallback icon reference when no specific icon can be extracted.
 */
export interface FallbackIconReference {
  readonly kind: 'fallback'
  readonly defaultIconId:
    | 'generic-file'
    | 'generic-folder'
    | 'generic-shortcut'
    | 'generic-drive'
    | 'generic-system'
}

/**
 * Union of all supported shell icon reference contracts.
 */
export type ShellIconReference =
  | FileIconReference
  | ResourceIconReference
  | ExtensionIconReference
  | ShellItemIconReference
  | FallbackIconReference

/**
 * Structured metadata extracted from a Windows `.lnk` Shell Link shortcut.
 */
export interface ShellShortcutMetadata {
  /** Target file, folder, executable, or URI pointed to by the shortcut. */
  readonly target?: string | undefined
  /** Command-line arguments associated with shortcut activation. */
  readonly arguments?: readonly string[] | undefined
  /** Working directory configured for the target. */
  readonly workingDirectory?: string | undefined
  /** Tooltip or descriptive comment stored in the link. */
  readonly description?: string | undefined
  /** Explicit icon location reference defined in the link. */
  readonly icon?: ShellIconReference | undefined
  /** Whether the target of the link is known to be missing or inaccessible. */
  readonly isBroken?: boolean | undefined
}

/**
 * Authoritative strongly typed Shell Item model.
 */
export interface ShellItem {
  /** Unique, stable identity. */
  readonly id: ShellItemId
  /** Classification kind. */
  readonly kind: ShellItemKind
  /** Human-readable display name. */
  readonly displayName: string
  /** Physical or virtual location. */
  readonly location: ShellLocation
  /** Optional parent container identifier. */
  readonly parentId?: ShellItemId | undefined
  /** Contributing origin source. */
  readonly source: ShellItemSource
  /** Normalized Windows file attributes. */
  readonly attributes: ShellItemAttributes
  /** Icon reference descriptor. */
  readonly icon: ShellIconReference
  /** Quality confidence of this item's identity. */
  readonly identityQuality: IdentityQuality
  /** File creation timestamp in milliseconds since epoch. */
  readonly createdAt?: number | undefined
  /** File last modification timestamp in milliseconds since epoch. */
  readonly modifiedAt?: number | undefined
  /** Size in bytes for files. */
  readonly size?: number | undefined
  /** Structured shortcut metadata if kind is 'shortcut'. */
  readonly shortcut?: ShellShortcutMetadata | undefined
  /** Lowercase file extension including leading dot (e.g. '.pdf', '.lnk'). */
  readonly extension?: string | undefined
}

/**
 * Result of resolving the availability of a referenced shell item.
 */
export type ShellItemResolution =
  | {
    readonly status: 'available'
    readonly item: ShellItem
  }
  | {
    readonly status: 'missing'
    readonly itemId: ShellItemId
  }
  | {
    readonly status: 'unavailable'
    readonly itemId: ShellItemId
    readonly reason: string
  }

/**
 * Supported Windows Known Folder canonical identifiers.
 */
export type KnownFolderId =
  | 'Desktop'
  | 'PublicDesktop'
  | 'Documents'
  | 'Downloads'
  | 'Pictures'
  | 'Music'
  | 'Videos'
  | 'StartMenu'
  | 'Programs'
  | 'Startup'
  | 'PublicDocuments'
  | 'RecycleBin'

/**
 * Resolution details for a Windows Known Folder.
 */
export interface KnownFolderResolution {
  /** Known Folder canonical identifier. */
  readonly id: KnownFolderId
  /** Physical filesystem directory path, or undefined for virtual folders. */
  readonly path?: string | undefined
  /** Whether the folder currently exists and is accessible. */
  readonly available: boolean
  /** Whether the folder is a virtual shell namespace folder (e.g. Recycle Bin). */
  readonly isVirtual: boolean
  /** Standard localized or configured display name. */
  readonly displayName: string
}

/**
 * Normalized merged view of desktop sources (User Desktop + Public Desktop).
 */
export interface DesktopSnapshot {
  /** All unique items aggregated from active desktop sources. */
  readonly items: readonly ShellItem[]
  /** Configured physical path for Current User Desktop. */
  readonly userDesktopPath?: string | undefined
  /** Configured physical path for Public Desktop. */
  readonly publicDesktopPath?: string | undefined
  /** Timestamp when snapshot was assembled. */
  readonly timestamp: number
}

/**
 * Types of normalized change events emitted by the Shell Namespace watcher.
 */
export type NamespaceChangeType =
  | 'item-added'
  | 'item-removed'
  | 'item-renamed'
  | 'item-modified'
  | 'container-invalidated'

/**
 * Normalized change notification emitted when directory contents change.
 */
export interface NamespaceChangeEvent {
  /** Classification of the change. */
  readonly type: NamespaceChangeType
  /** Container path that was observed. */
  readonly containerPath: string
  /** Updated item state for added/modified/renamed items. */
  readonly item?: ShellItem | undefined
  /** Previous item state for renamed items. */
  readonly previousItem?: ShellItem | undefined
  /** Identifier of the removed or changed item. */
  readonly itemId?: ShellItemId | undefined
  /** Timestamp of change observation. */
  readonly timestamp: number
}

/**
 * Active subscription to namespace directory changes.
 */
export interface NamespaceSubscription {
  /** Path being watched. */
  readonly path: string
  /** Disposes the subscription and releases underlying file system handles. */
  dispose(): void
}

/**
 * Error detail emitted when a provider or adapter encounters an unexpected failure.
 */
export interface ProviderFault {
  /** Component or adapter where fault occurred. */
  readonly provider: string
  /** The underlying error encountered. */
  readonly error: Error
  /** Timestamp of fault occurrence. */
  readonly timestamp: number
}

/**
 * Configuration options for the Shell Namespace service.
 */
export interface Config {
  /** Whether the Shell Namespace service is enabled. Defaults to true. */
  enabled?: boolean | undefined
  /** Whether to automatically start watching Desktop on service initialization. Defaults to false. */
  watchDesktopOnStartup?: boolean | undefined
  /** Debounce delay in milliseconds for filesystem change event coalescing. Defaults to 100ms. */
  debounceMs?: number | undefined
  /** Custom KnownFolderResolver (useful for testing or platform virtualization). */
  knownFolderResolver?: unknown
  /** Custom FileIdentityAdapter. */
  fileIdentityAdapter?: unknown
  /** Custom ShellLinkResolver. */
  shellLinkResolver?: unknown
  /** Custom ShellIconResolver. */
  iconResolver?: unknown
  /** Custom NamespaceWatcher. */
  watcher?: unknown
}
