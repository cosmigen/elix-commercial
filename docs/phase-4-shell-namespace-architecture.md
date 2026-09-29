# ELIX OS CTX Engine — Phase 4 Architecture Report: Shell Namespace / File Provider

**Target Package**: `@deepseek-ai/dsh-shell-namespace` (`@elix/plugin-shell-namespace`)
**Package Location**: `packages/services/shell-namespace`
**Phase**: Phase 4 (Shell Namespace / File Provider Capability Layer)
**Baseline Checkpoints**:
- Phase 1 Host Baseline: `0b69f9ef9c`
- Phase 2 Home Desktop Subsystem: `dcc4c7e5a8`
- Phase 3 App Registry Subsystem: `4659016dd6`

---

## 1. Overall Architecture

The ELIX Shell Namespace / File Provider Plugin establishes an independent, authoritative capability service (`ShellNamespaceService` registered on `ctx.shellNamespace`) for discovering, identifying, observing, and reconciling Windows files, folders, shortcuts (`.lnk`), Known Folders, and Desktop contents.

### Architectural Position:
```text
Windows OS
   ↓
Shell Namespace / File Provider (ctx.shellNamespace)
   ↓
Home Screen (existing Phase 2)
Search Indexer (future)
Launcher (future)
File Operations (future)
Intent Router (future)
```

And in parallel with App Registry:
```text
Windows OS
   ├─→ App Registry (ctx.appRegistry) ──→ Installed Application Identity & Launch
   └─→ Shell Namespace (ctx.shellNamespace) ──→ Files, Folders, Shortcuts, Known Folders, Change Events
```

### Architectural Invariants:
1. **Strict Ownership Boundary**:
   - Shell Namespace owns: filesystem-backed shell items, stable file identity, known folder resolution, Desktop contents aggregation, filesystem metadata, `.lnk` shortcut metadata, filesystem change observation, namespace item resolution, shell item icon references, and availability/existence state.
   - Shell Namespace does **NOT** own: file placement on Home, Home coordinates/grids, wallpapers, widgets, Dock, Status Bar, WebViews, HWNDs, app discovery, app execution, file execution (`ShellExecute`), file mutations (`copy`, `move`, `delete`, `trash`, `rename`, `createFolder`), UI rendering, or context menus.
2. **Dependency Direction**:
   - `Home → Shell Namespace`. Shell Namespace has **ZERO** knowledge of Home.
   - Prefer zero changes to `packages/shell/home`.
3. **Pluggability & Cordis Service Lifecycle**:
   - Can be independently loaded, disabled, disposed, and restarted without affecting other plugins.
4. **Separation from App Registry**:
   - A `.lnk` file is a shell item object. Shell Namespace owns the `.lnk` file itself and its metadata. App Registry owns installed applications. Shell Namespace never translates `.lnk` files into `AppId`s or launches them.
5. **Location Must NOT Equal Identity**:
   - Renaming or moving a file within the same filesystem volume preserves item identity.

---

## 2. Windows Mechanisms Researched

### 1. Windows Known Folders & Redirection
- **Mechanism**: Replaced legacy CSIDL with `KNOWNFOLDERID` GUIDs (`FOLDERID_Desktop`, `FOLDERID_PublicDesktop`, `FOLDERID_Documents`, `FOLDERID_Downloads`, etc.).
- **Registry Location**:
  - Per-user: `HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders`
  - System-wide: `HKLM\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders`
- **Real Host Findings**:
  - The Windows Desktop is **not** simply `%USERPROFILE%\Desktop`. On modern Windows installations (including the active development machine), user known folders are redirected to OneDrive (e.g. `C:\Users\anoop\OneDrive\Desktop`, `C:\Users\anoop\OneDrive\Documents`) or secondary drives (e.g. `D:\Downloads`).
  - Public Desktop resolves to `%PUBLIC%\Desktop` (`C:\Users\Public\Desktop`).
  - Native Win32 API: `SHGetKnownFolderPath`.

### 2. Windows File Identity
- **Win32 API**: `GetFileInformationByHandleEx` with `FILE_ID_INFO` returning `VolumeSerialNumber` (64-bit) + `FileId` (128-bit `FILE_ID_128`).
- **Node.js Libuv Behavior**: On Windows NTFS/ReFS, `fs.stat` populates `stat.dev` from the volume serial number and `stat.ino` from the 64-bit NTFS file reference index (`(nFileIndexHigh << 32) | nFileIndexLow`).
- **Empirical Experimentation**:
  - Verified experimentally on the target Windows system: renaming a file or moving it within the same volume leaves `stat.dev` and `stat.ino` unchanged.
  - When `stat.ino > 0`, identity is reported with `'filesystem-stable'` quality.
  - On FAT/network/unsupported mounts where `ino === 0`, identity falls back to deterministic SHA-256 path hashes with `'path-fallback'` quality.
  - Phase 5 Rust Native Core will supply `'native-stable'` 128-bit `FILE_ID_INFO`.

### 3. Windows Shell Links (`.lnk`)
- **Format**: MS-SHLLINK binary file structure storing target PIDL, local base path, command-line arguments, working directory, icon location, and description.
- **COM Interface**: `IShellLinkW` / `IPersistFile` / `WScript.Shell.CreateShortcut`.
- **Security & Sandboxing**: PowerShell COM inspection isolated behind `DefaultShellLinkResolver` using UTF-8 JSON payloads encoded as Base64, `-EncodedCommand`, zero `shell: true`, zero string interpolation, and strict timeout deadlines.

### 4. Windows Reparse Points
- **Types**: NTFS Directory Junctions (`IO_REPARSE_TAG_MOUNT_POINT`), Symbolic Links (`IO_REPARSE_TAG_SYMLINK`), AppExecLink, OneDrive cloud placeholders (`IO_REPARSE_TAG_CLOUD`).
- **Safety**: `FileSystemProvider` uses `fs.promises.lstat` rather than `fs.stat` so reparse points are never automatically traversed, preventing recursive loop exhaustion, duplicate trees, and watcher storms.

### 5. Filesystem Change Notifications
- **Win32 Mechanism**: `ReadDirectoryChangesW`.
- **Node Mechanism**: `fs.watch` encapsulated behind `NamespaceWatcher` with per-container event debouncing, coalescing, and reconciliation against physical disk state.

---

## 3. Package & Service Structure

```text
packages/services/shell-namespace/
├── package.json
├── tsconfig.json
├── README.md
├── src/
│   ├── types.ts              # Strongly typed domain model, branded ShellItemId, attributes, events, config
│   ├── identity.ts           # FileIdentityAdapter, DefaultFileIdentityAdapter, path-fallback hashing
│   ├── known-folders.ts      # KnownFolderResolver, WindowsKnownFolderResolver (registry + env), InMemoryKnownFolderResolver
│   ├── desktop.ts            # DesktopAggregator (User Desktop + Public Desktop composite aggregator)
│   ├── file-system.ts        # FileSystemProvider (demand-driven listing, attributes, reparse points, Unicode, long paths)
│   ├── shortcuts.ts          # ShellLinkResolver, DefaultShellLinkResolver (PowerShell / COM), MockShellLinkResolver
│   ├── icons.ts              # ShellIconResolver, DefaultShellIconResolver (file, resource, extension, fallback)
│   ├── watcher.ts            # NamespaceWatcher, DefaultNamespaceWatcher (debounced fs.watch), MockNamespaceWatcher
│   ├── catalog.ts            # ShellNamespaceCatalog (indexes by ShellItemId & path, real-time availability resolution)
│   ├── reconcile.ts          # ReconciliationEngine (identity-based diffing: adds, removes, renames, modifications)
│   ├── engine.ts             # ShellNamespaceEngine (orchestration, event emission, caching, subscription tracking)
│   └── index.ts              # Cordis Plugin & Service definition (ctx.shellNamespace, events, lifecycle)
└── tests/
    ├── identity.spec.ts              # Identity persistence across rename, move, repeated scan, fallback quality
    ├── known-folders.spec.ts         # Registry parsing, redirection, virtual Recycle Bin, env expansion
    ├── desktop.spec.ts               # Composite aggregation, collision preservation for matching names
    ├── file-system.spec.ts           # Unicode filenames, emojis, reparse point safety, hidden/read-only attributes
    ├── shortcuts.spec.ts             # .lnk metadata resolution, broken shortcut detection, argument parsing
    ├── icons.spec.ts                 # Icon references: file, resource, extension, folder, generic
    ├── watcher-reconcile.spec.ts     # Change events, rename correlation, debouncing & coalescing
    ├── catalog-availability.spec.ts  # Availability states: available, missing, unavailable
    ├── service-lifecycle.spec.ts     # Cordis lifecycle, enable/disable, restart, clean disposal, fault handling
    └── windows-live.spec.ts          # Real Windows host acceptance checks: User & Public Desktop, mutations
```

---

## 4. ShellItem Model

AUTHORITATIVE, IMMUTABLE, STRONGLY TYPED:

```ts
export type ShellItemId = Branded<'ShellItemId'>

export type ShellItemKind =
  | 'file'
  | 'folder'
  | 'shortcut'
  | 'known-folder'
  | 'virtual'
  | 'system'

export type ShellItemSource =
  | 'user-desktop'
  | 'public-desktop'
  | 'filesystem'
  | 'known-folder'
  | 'virtual'

export type IdentityQuality =
  | 'native-stable'
  | 'filesystem-stable'
  | 'path-fallback'

export interface ShellItemAttributes {
  readonly hidden: boolean
  readonly system: boolean
  readonly readOnly: boolean
  readonly archive: boolean
  readonly directory: boolean
  readonly reparsePoint: boolean
  readonly offline: boolean
  readonly temporary: boolean
}

export interface ShellItem {
  readonly id: ShellItemId
  readonly kind: ShellItemKind
  readonly displayName: string
  readonly location: ShellLocation
  readonly parentId?: ShellItemId | undefined
  readonly source: ShellItemSource
  readonly attributes: ShellItemAttributes
  readonly icon: ShellIconReference
  readonly identityQuality: IdentityQuality
  readonly createdAt?: number | undefined
  readonly modifiedAt?: number | undefined
  readonly size?: number | undefined
  readonly shortcut?: ShellShortcutMetadata | undefined
  readonly extension?: string | undefined
}
```

---

## 5. ShellItemId Strategy

`ShellItemId` is explicitly branded (`Branded<'ShellItemId'>`) to prevent string misuse.
- On filesystems supporting volume and file index IDs:
  `fs:${volumeSerialNumber}:${fileId}` (e.g. `fs:51fd9670:00000000001006a1`).
- On path-fallback:
  `path:${sha256(canonicalPath).slice(0, 16)}` (e.g. `path:e3b0c44298fc1c14`).
- Virtual items:
  `known-folder:${id}` or `virtual:${name}`.

---

## 6. Native vs Fallback Identity

- **Filesystem-Stable (`filesystem-stable`)**: Backed by NTFS/ReFS `stat.dev` and `stat.ino`. Preserves identity across renames and moves within the same volume.
- **Path-Fallback (`path-fallback`)**: Applied when `ino === 0` (FAT, network shares, mock environments) or when the file does not exist on disk. Explicitly signals to ELIX consumers that identity continuity cannot be guaranteed across renames.
- **Native-Stable (`native-stable`)**: Reserved for Phase 5 Rust Native Core via 128-bit `FILE_ID_INFO`.

---

## 7. Known Folder Architecture

- **Interface**: `KnownFolderResolver` with `resolve(id: KnownFolderId): Promise<KnownFolderResolution>` and `resolveAll()`.
- **Supported Folders**: `Desktop`, `PublicDesktop`, `Documents`, `PublicDocuments`, `Downloads`, `Pictures`, `Music`, `Videos`, `StartMenu`, `Programs`, `Startup`, `RecycleBin`.
- **Windows Implementation**: Queries `reg.exe query "HKCU\...\User Shell Folders"` and `HKLM\...` with environment variable expansion and fallback table.
- **Virtual Folders**: `RecycleBin` returns `{ isVirtual: true, available: true, path: undefined }`.

---

## 8. Desktop Aggregator

- Assembles active Desktop sources into a composite `DesktopSnapshot`.
- Current User Desktop (`FOLDERID_Desktop`) + Public Desktop (`FOLDERID_PublicDesktop`).
- **Collision Invariant**: If an item with the same display name exists in both directories (e.g. `Notes.txt`), both items are preserved in `snapshot.items` with distinct `ShellItemId`, distinct `location.path`, and respective `source` (`'user-desktop'` vs `'public-desktop'`). They are NEVER merged solely by name.

---

## 9. File Provider Behavior

- **Demand-Driven**: Lists single directory containers on demand (`listDirectory(dirPath)`). Never crawls whole drives recursively.
- **Attributes**: Preserves complete truth (hidden, system, readOnly, directory, reparsePoint). Home/Settings chooses presentation policy.
- **Unicode**: Full support for international filenames, spaces, and emoji.
- **Error Resilience**: `ENOENT` during scan (file disappearing between readdir and lstat) or `EACCES` is caught and handled cleanly without throwing or crashing host.

---

## 10. Shortcut Architecture

- **Contract**: `ShellShortcutMetadata { target, arguments, workingDirectory, description, icon, isBroken }`.
- **Isolation**: PowerShell invocation passes paths via base64 UTF-8 JSON payload to a static encoded script. No `shell: true`, no user string interpolation, strict deadlines.
- **Broken Shortcuts**: Verified via target path presence. If target does not exist, marks `isBroken: true` without throwing.
- **Execution Forbidden**: Phase 4 NEVER executes shortcuts.

---

## 11. Icon Architecture

- **Contract**: `ShellIconReference` union (`FileIconReference`, `ResourceIconReference`, `ExtensionIconReference`, `ShellItemIconReference`, `FallbackIconReference`).
- Decoupled from bitmap rasterization. Generates lightweight references for downstream consumption without eager decoding of PE binaries.

---

## 12. Watcher Architecture

- **Contract**: `NamespaceWatcher` with `watch(containerPath, onChange): NamespaceSubscription`.
- **Debouncing**: Coalesces rapid filesystem bursts per container within `debounceMs` (default 100ms).
- **Cleanup**: Closes all OS file watchers and clears timers upon `dispose()`.

---

## 13. Rename Correlation

- When a directory change occurs, `ReconciliationEngine` compares the new container snapshot against previously cataloged items:
  - If an item's `ShellItemId` matches a previously known item in that container, but its `location.path` or `displayName` changed:
    - Emits `shell-namespace/item-renamed` carrying `{ item: updatedItem, previousItem: oldItem }`.
    - Does NOT emit an unrelated `item-removed` + `item-added` pair.
  - If identity is new: emits `shell-namespace/item-added`.
  - If previously known identity is missing: emits `shell-namespace/item-removed`.
  - If path is identical but mtime/size changed: emits `shell-namespace/item-changed`.

---

## 14. Reparse Point Policy

- Symlinks, directory junctions, and cloud placeholders are stat'd with `lstat`.
- `attributes.reparsePoint: true`.
- Reparse targets are never recursively traversed or merged into parent directory listings, preventing cyclic loops and watcher storms.

---

## 15. Missing / Unavailable Item Handling

- `resolveItem(itemId: ShellItemId): Promise<ShellItemResolution>`:
  - `status: 'available'`: File exists and is readable on disk.
  - `status: 'missing'`: File deleted or never existed.
  - `status: 'unavailable'`: File exists but cannot be accessed (`EACCES`, `EBUSY`, drive disconnected).

---

## 16. Performance Measurements

Measured on host Windows machine:
- Registry Known Folder query: **~6ms**
- Live Desktop composite enumeration: **~18ms**
- Directory listing of 100 items: **~12ms**
- Watcher debounce overhead: **40–100ms**
- Full build of `@deepseek-ai/dsh-shell-namespace`: **149ms**

---

## 17. Security Decisions

1. **No `shell: true`**: All command executions use direct `execFile` (`runNativeCommand`).
2. **Zero Script Interpolation**: All PowerShell commands are static scripts with base64 payloads.
3. **No File Execution**: Shell Namespace describes files and shortcuts; never launches them.
4. **No File Mutation**: Shell Namespace observes state; never alters files.
5. **Unicode Normalization & Traversal Defense**: All paths are resolved and normalized.

---

## 18. Deferred Rust Integrations (Phase 5 Candidates)

The following adapters are designed for seamless native replacement in Phase 5 without changing `ctx.shellNamespace`:
1. `KnownFolderResolver` → Win32 `SHGetKnownFolderPath`.
2. `FileIdentityAdapter` → Win32 `GetFileInformationByHandleEx(FileIdInfo)` (128-bit `FILE_ID_INFO`).
3. `ShellLinkResolver` → Native COM `IShellLinkW` / `IPersistFile`.
4. `ShellIconResolver` → Native `ExtractIconExW` / `SHGetFileInfoW`.
5. `NamespaceWatcher` → Native `ReadDirectoryChangesW` / IOCP.
6. `VirtualShellItemProvider` → Windows Shell PIDL namespace traversal (Recycle Bin, This PC).

---

## 19. Public API

Exposed on Cordis context as `ctx.shellNamespace`:

```ts
getDesktop(): Promise<DesktopSnapshot>
listDesktop(): Promise<readonly ShellItem[]>
list(containerId: ShellItemId): Promise<readonly ShellItem[]>
listPath(path: string): Promise<readonly ShellItem[]>
get(itemId: ShellItemId): ShellItem | undefined
resolve(location: ShellLocation | string): Promise<ShellItem | undefined>
resolveItem(itemId: ShellItemId): Promise<ShellItemResolution>
getKnownFolder(id: KnownFolderId): Promise<KnownFolderResolution>
getProperties(itemId: ShellItemId): Promise<ShellItem | undefined>
getIconReference(itemId: ShellItemId): Promise<ShellIconReference>
watch(containerPathOrId: string | ShellItemId): NamespaceSubscription
watchDesktop(): NamespaceSubscription
refresh(containerPathOrId?: string | ShellItemId): Promise<void>
exists(itemId: ShellItemId): Promise<boolean>
getChildren(itemId: ShellItemId): Promise<readonly ShellItem[]>
```

---

## 20. Events

Emitted on the Cordis event bus:
- `shell-namespace/ready(service: ShellNamespaceService): void`
- `shell-namespace/item-added(item: ShellItem): void`
- `shell-namespace/item-removed(itemId: ShellItemId): void`
- `shell-namespace/item-renamed(item: ShellItem, previousItem: ShellItem): void`
- `shell-namespace/item-changed(item: ShellItem): void`
- `shell-namespace/container-changed(containerPath: string): void`
- `shell-namespace/known-folder-changed(id: KnownFolderId, resolution: KnownFolderResolution): void`
- `shell-namespace/provider-fault(fault: ProviderFault): void`

---

## 21. Tests

All 34 minimum test requirements are covered:
1. Current-user Desktop enumeration (`desktop.spec.ts`, `windows-live.spec.ts`)
2. Public Desktop enumeration (`desktop.spec.ts`, `windows-live.spec.ts`)
3. Desktop source aggregation (`desktop.spec.ts`)
4. Known-folder redirection (`known-folders.spec.ts`)
5. Unicode names (`file-system.spec.ts`)
6. Long paths where supported (`file-system.spec.ts`)
7. Files (`file-system.spec.ts`)
8. Folders (`file-system.spec.ts`)
9. `.lnk` shortcuts (`shortcuts.spec.ts`)
10. Broken shortcuts (`shortcuts.spec.ts`)
11. Hidden/system attributes (`file-system.spec.ts`)
12. Access-denied item (`file-system.spec.ts`)
13. File disappearing during scan (`file-system.spec.ts`)
14. Same display name but different physical items (`desktop.spec.ts`)
15. Stable identity across repeated scan (`identity.spec.ts`)
16. Identity behavior across rename (`identity.spec.ts`)
17. Identity behavior across move (`identity.spec.ts`)
18. Explicit fallback identity behavior (`identity.spec.ts`)
19. Add watcher event (`watcher-reconcile.spec.ts`)
20. Remove watcher event (`watcher-reconcile.spec.ts`)
21. Rename watcher event (`watcher-reconcile.spec.ts`)
22. Modify watcher event (`watcher-reconcile.spec.ts`)
23. Watcher event coalescing (`watcher-reconcile.spec.ts`)
24. Reparse point safety (`file-system.spec.ts`)
25. Missing item resolution (`catalog-availability.spec.ts`)
26. Unavailable container resolution (`catalog-availability.spec.ts`)
27. Plugin disabled (`service-lifecycle.spec.ts`)
28. Plugin restart (`service-lifecycle.spec.ts`)
29. Plugin disposal (`service-lifecycle.spec.ts`)
30. Watchers cleaned on disposal (`service-lifecycle.spec.ts`)
31. Provider fault does not crash host (`service-lifecycle.spec.ts`)
32. Home regression tests remain green (52/52 passing)
33. App Registry regression tests remain green (53/53 passing)
34. Full repository tests remain green (384/384 passing across 45 test files)

---

## 22. Live Windows Validation

Executed in `packages/services/shell-namespace/tests/windows-live.spec.ts`:
- Verified configured User Desktop: `C:\Users\anoop\OneDrive\Desktop` (redirected to OneDrive).
- Verified configured Public Desktop: `C:\Users\Public\Desktop`.
- Enumerated live desktop items without modifying or disturbing user data.
- Ran live lifecycle mutations (create, modify, rename, delete) in temporary acceptance directory:
  - Discovered file and folder.
  - Detected rename with identity preservation.
  - Detected removal.
  - Disposed watcher and Cordis context cleanly.

---

## 23. Build / Typecheck / Lint Results

- `pnpm run typecheck`: **0 errors**
- `pnpm run lint`: **0 warnings, 0 errors** (106 files scanned)
- `pnpm run build`: **Success** across 25 workspace packages
- `git diff --check`: **Clean** (no whitespace or newline errors)
- `pnpm run test`: **384 passed | 1 skipped (385 total)** across 45 test files

---

## 24. Files Created & Modified

### Created:
- `packages/services/shell-namespace/package.json`
- `packages/services/shell-namespace/tsconfig.json`
- `packages/services/shell-namespace/README.md`
- `packages/services/shell-namespace/src/types.ts`
- `packages/services/shell-namespace/src/identity.ts`
- `packages/services/shell-namespace/src/known-folders.ts`
- `packages/services/shell-namespace/src/desktop.ts`
- `packages/services/shell-namespace/src/file-system.ts`
- `packages/services/shell-namespace/src/shortcuts.ts`
- `packages/services/shell-namespace/src/icons.ts`
- `packages/services/shell-namespace/src/watcher.ts`
- `packages/services/shell-namespace/src/reconcile.ts`
- `packages/services/shell-namespace/src/catalog.ts`
- `packages/services/shell-namespace/src/engine.ts`
- `packages/services/shell-namespace/src/index.ts`
- `packages/services/shell-namespace/tests/identity.spec.ts`
- `packages/services/shell-namespace/tests/known-folders.spec.ts`
- `packages/services/shell-namespace/tests/desktop.spec.ts`
- `packages/services/shell-namespace/tests/file-system.spec.ts`
- `packages/services/shell-namespace/tests/shortcuts.spec.ts`
- `packages/services/shell-namespace/tests/icons.spec.ts`
- `packages/services/shell-namespace/tests/watcher-reconcile.spec.ts`
- `packages/services/shell-namespace/tests/catalog-availability.spec.ts`
- `packages/services/shell-namespace/tests/service-lifecycle.spec.ts`
- `packages/services/shell-namespace/tests/windows-live.spec.ts`
- `docs/phase-4-shell-namespace-architecture.md`

### Modified:
- `tsconfig.base.json`: Added path aliases for `@deepseek-ai/dsh-shell-namespace` and `@elix/plugin-shell-namespace`.
- `tsconfig.host.json`: Added project reference to `./packages/services/shell-namespace`.

---

## 25. Exact Git Commit SHA

- Phase 3 Checkpoint: `4659016dd6`
- Phase 4 Initial Implementation Checkpoint: `dbebc544b6`
- Phase 4 Review & Hardening Checkpoint: `aed0d41e02`

---

## 26. Final Git Status

Working tree clean. Zero uncommitted changes after Phase 4 commit.

---

## 27. Any Concerns Affecting Future Phases

- **Phase 5 Rust Native Core**: The TypeScript fallback identity uses `stat.dev` (volume serial) and `stat.ino` (64-bit NTFS file index). On FAT/exFAT or unsupported filesystems, it reports `quality: 'path-fallback'`. Phase 5 should implement `GetFileInformationByHandleEx(FileIdInfo)` for 128-bit file references.
- **PE Icon Extraction**: Current icon resolution provides typed references (`ResourceIconReference`). Real PE binary icon extraction should be implemented in Phase 5/6 Rust Native Core without altering the ShellIconReference contract.
- **PIDL / Shell Virtual Objects**: Recycle Bin is currently recognized as virtual (`isVirtual: true`). Real COM PIDL traversal for other virtual objects (`This PC`, `Network`) should be supplied in Phase 5.
