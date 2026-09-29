# ELIX OS CTX Engine — Phase 3 Architecture Report: App Registry Plugin

**Target Package**: `@deepseek-ai/dsh-app-registry` (`@elix/plugin-app-registry`)
**Package Location**: `packages/services/app-registry`
**Phase**: Phase 3 (App Registry Capability Layer)
**Baseline / Preceding Checkpoints**: Phase 1 Host Baseline (`0b69f9ef9c`), Phase 2 Home Desktop Subsystem (`dcc4c7e5a8`)

---

## 1. App Registry Architecture

The ELIX Application Registry Plugin establishes an independent, high-performance capability service (`AppRegistryService` registered on `ctx.appRegistry`) for discovering, identifying, reconciling, caching, searching, and launching applications on Windows.

### Architectural Invariants:
1. **Strict Ownership Boundary**: App Registry owns installed software capability (discovery, identity, catalog, search, icons, launch resolution, atomic cache). App Registry does **NOT** own UI rendering, desktop grids, icon x/y coordinates, folders, widgets, dock, status bar, launcher window, or WebView creation.
2. **Dependency Direction**: Downstream consumers (Home Screen, future Launcher, Dock, Search, Agent) consume App Registry. App Registry never depends on Home or shell surfaces.
3. **Pluggability & Cordis Service Lifecycle**: Can be independently loaded, disabled, disposed, and restarted. Disabling App Registry leaves the OS CTX host and other plugins completely operational.
4. **Deferred Rust Surface Core Alignment**: Defines clear adapter boundaries (`AppLaunchAdapter`, `AppIconResolver`, discovery scanners) so the future Phase 6 Rust Native Core can plug into Win32/ShellExecute/PE extraction mechanisms without altering public TypeScript APIs.

---

## 2. Windows Discovery Mechanisms Researched

Windows provides several distinct mechanisms for application enumeration and execution:

### 1. Win32 Desktop Applications
- **Executables**: Portable Executable (PE32/PE32+) binaries (`.exe`).
- **Standard Locations**: `%ProgramFiles%`, `%ProgramFiles(x86)%`, `%LocalAppData%\Programs`.
- **Launch Mechanism**: Direct execution via `CreateProcessW` / Node `spawn` with executable path, argv array, and working directory. Shell execution (`cmd /c` or `shell: true`) is strictly forbidden for security.

### 2. Start Menu Shortcuts (`.lnk` Shell Links)
- **User Programs Directory**: `%APPDATA%\Microsoft\Windows\Start Menu\Programs`
- **System-Wide Programs Directory**: `%ProgramData%\Microsoft\Windows\Start Menu\Programs`
- **Structure**: Shell link binary files (`MS-SHLLINK`) storing target executable path, command-line arguments, working directory, icon location (path + resource index), and tooltip/description.
- **Darwin/Advertised Links**: Windows Installer (MSI) shortcuts may point to advertised component descriptors rather than raw exe paths; resolved via Windows Shell COM interfaces (`WScript.Shell` / `IShellLinkW`).

### 3. Packaged MSIX / Appx / UWP Applications
- **AppModel / Manifest**: Installed under `%ProgramFiles%\WindowsApps` or Windows `SystemApps`.
- **Application User Model ID (AUMID)**: The canonical Windows identity string, typically formatted as `<PackageFamilyName>!<ApplicationId>` (e.g. `Microsoft.WindowsCalculator_8wekyb3d8bbwe!App` or `Microsoft.WindowsTerminal_8wekyb3d8bbwe!App`).
- **`shell:AppsFolder` Namespace**: The Windows Shell virtual folder consolidating all launchable applications.
- **Launch Mechanism**: Invocation via `explorer.exe shell:AppsFolder\<AUMID>` or `IApplicationActivationManager::ActivateApplication` (deferred to Rust Native Core).

### 4. Windows Registry Application Metadata
- **Keys**:
  - `HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall`
  - `HKLM\Software\Wow6432Node\Microsoft\Windows\CurrentVersion\Uninstall`
  - `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall`
- **Metadata Available**: `DisplayName`, `DisplayVersion`, `Publisher`, `InstallLocation`, `DisplayIcon`, `UninstallString`, `SystemComponent`, `ParentKeyName`.
- **Enrichment Role**: Not every uninstall entry represents a launchable application. The registry provides authoritative publisher, version, and install location data used to enrich shortcut and packaged app discoveries.

---

## 3. Providers Implemented

All discovery mechanisms are encapsulated inside internal providers adhering to `AppDiscoveryProvider`:

```ts
interface AppDiscoveryProvider {
  readonly id: string
  discover(signal?: AbortSignal): Promise<readonly DiscoveredApplication[]>
}
```

1. **`StartMenuProvider` (`providers/start-menu.ts`)**:
   - Scans per-user and all-users Start Menu Programs directories.
   - Batch-resolves `.lnk` files in a single pass via `PowerShellAdapter` (or custom injected scanner).
   - Filters out non-application targets (uninstallers, help files, license/release notes).
   - Classifies discoveries into `start-menu-user` vs `start-menu-system`.
2. **`PackagedAppsProvider` (`providers/packaged-apps.ts`)**:
   - Discovers modern Windows packaged applications and their canonical AUMIDs via `Get-StartApps` and `Get-AppxPackage`.
   - Extracts PackageFamilyName, Publisher, InstallLocation, and DisplayName.
3. **`RegistryMetadataProvider` (`providers/registry-metadata.ts`)**:
   - Scans HKLM and HKCU CurrentVersion Uninstall branches.
   - Filters out Windows updates, patches, and system components (`SystemComponent === 1`).
   - Extracts metadata for cross-provider reconciliation and identifies launchable executables when specified by `DisplayIcon` / `InstallLocation`.

---

## 4. Application Model

The domain model is strongly typed, immutable, and strict:

```ts
export type AppId = Branded<'AppId'>

export interface AppRecord {
  readonly id: AppId
  readonly kind: AppKind
  readonly displayName: string
  readonly description?: string | undefined
  readonly publisher?: string | undefined
  readonly icon: AppIconReference
  readonly launch: AppLaunchSpec
  readonly source: AppDiscoverySource
  readonly aliases: readonly string[]
  readonly installLocation?: string | undefined
  readonly firstSeenAt: number
  readonly lastSeenAt: number
  readonly updatedAt: number
}
```

- **Supported Kinds**: `'win32' | 'packaged' | 'shortcut' | 'pwa' | 'protocol' | 'remote'`.
- **Supported Sources**: `'start-menu-user' | 'start-menu-system' | 'packaged-apps' | 'registry' | 'manual'`.
- **Availability State**: `AppResolution = { status: 'available', app: AppRecord } | { status: 'missing', appId: AppId }`.

---

## 5. Stable Identity Algorithm

Application identities must remain deterministic, invariant across machine restarts, rescan cycles, path casing variations, and minor updates:

1. **Packaged Applications**:
   - Canonical descriptor: `packaged:aumid:<normalized-aumid>`
   - Generated ID: `app:packaged:<sha256-hash-16-hex>`
2. **Win32 Applications**:
   - Path normalization: Transforms drive letters, converts slashes to `/`, lowercases strings, and replaces dynamic user/machine prefixes with known-folder tokens:
     - `%ProgramFiles%`
     - `%ProgramFiles(x86)%`
     - `%ProgramData%`
     - `%SystemRoot%`
     - `%LocalAppData%`
     - `%AppData%`
   - Canonical descriptor: `win32:exe:<normalized-path>`
   - Generated ID: `app:win32:<sha256-hash-16-hex>`
3. **Shortcut Applications**:
   - Canonical descriptor: `shortcut:<normalized-shortcut-target-or-path>`
   - Generated ID: `app:shortcut:<sha256-hash-16-hex>`
4. **Different Apps with Same Display Name**:
   - Two apps titled "Setup" in `C:\VendorA\setup.exe` and `C:\VendorB\setup.exe` produce distinct canonical descriptors and distinct `AppId` values. They never collide.

---

## 6. Deduplication & Reconciliation Rules

When the same application is reported by multiple Windows sources (e.g. Start Menu shortcut + Registry entry):
- **Source Priority**: `packaged-apps` (50) > `win32` (40) > `start-menu-user` (30) > `start-menu-system` (20) > `registry` (10).
- **Correlation**: Registry entries are correlated to executable apps if the executable resides within the registry entry's `InstallLocation` or matches `DisplayIcon`.
- **Metadata Merging**:
  - `displayName`: Start Menu / Packaged > Registry
  - `publisher`: Packaged / Registry > Shortcut
  - `description`: Shortcut tooltip > Registry
  - `installLocation`: Registry / Package > Shortcut
  - `icon`: Shortcut explicit icon > Registry DisplayIcon > Packaged logo > Fallback
  - `aliases`: Union of all deduplicated, cleaned alias tokens.
- **Timestamp Continuity**: Reconciled apps retain their original `firstSeenAt` timestamp, updating `lastSeenAt` and `updatedAt`.

---

## 7. Catalog API

Exposed on Cordis context as `ctx.appRegistry`:

```ts
list(): readonly AppRecord[]
get(appId: AppId): AppRecord | undefined
resolve(appId: AppId): AppResolution
search(query: string, options?: AppSearchOptions): readonly AppRecord[]
refresh(): Promise<AppRegistryRefreshResult>
launch(appId: AppId, options?: AppLaunchOptions): Promise<AppLaunchResult>
registerProvider(provider: AppDiscoveryProvider): RegistryDisposer
```

All catalog arrays and records returned are frozen / copies to prevent external mutation of internal registry state.

---

## 8. Cache Design

- **Atomic File Writing**: Uses `@deepseek-ai/dsh-atomic-write` (`writeFileAtomic`), ensuring complete atomic replacement without partial reads.
- **Location**: Defaults to `dshHomePath('cache', 'app-registry-cache.json')`, configurable via `Config.cachePath`.
- **Schema & Versioning**: Monotonic `CACHE_SCHEMA_VERSION = 1`.
- **Fault Tolerance**: If the cache file is absent, corrupt, or invalid JSON, it returns `undefined` without throwing, triggering an initial background discovery scan.

---

## 9. Icon Architecture

Decouples icon metadata from visual asset decoding:

```ts
type AppIconReference =
  | FileIconReference
  | ResourceIconReference
  | PackagedIconReference
  | FallbackIconReference
```

- **Resolver Interface**: `AppIconResolver.resolve(reference): Promise<ResolvedIcon>`.
- **Deferred Native Decoding**: True Windows PE resource decoding (.exe and .dll icon extraction) is documented as deferred to Phase 6 Rust Surface/Native Core. `DefaultAppIconResolver` maps existing file paths to `file://` URLs and missing/unsupported resources to SVGs without third-party native binaries.

---

## 10. Launch Architecture

Launch operations are strictly resolved by App Registry and executed through `AppLaunchAdapter`:

```ts
interface AppLaunchAdapter {
  launchWin32(spec: Win32LaunchSpec, options?: AppLaunchOptions): Promise<AppLaunchResult>
  launchPackaged(spec: PackagedLaunchSpec, options?: AppLaunchOptions): Promise<AppLaunchResult>
  launchShortcut(spec: ShortcutLaunchSpec, options?: AppLaunchOptions): Promise<AppLaunchResult>
}
```

- **Safety**: Never uses `shell: true`. Arguments and executable paths are strictly split.
- **Process Decoupling**: Uses Node's `spawn` with `detached: true`, `stdio: 'ignore'`, and `child.unref()`, preventing process leaks or zombie handles.
- **Pluggable**: The future Rust Native Core can substitute `AppLaunchAdapter` without touching public API.

---

## 11. Missing / Uninstalled App Behavior

When an application is uninstalled:
- Downstream shell plugins (e.g. Home desktop shortcuts) retain their stored `appId`.
- Calling `appRegistry.resolve(appId)` returns `{ status: 'missing', appId }`.
- App Registry never deletes user desktop shortcuts or mutates Home state.
- Attempting to launch a missing app returns `{ success: false, error: 'Application ... is not installed or missing' }` and emits `app-registry/launch-failed`.

---

## 12. Search Behavior

Deterministic, multi-field search engine (`search.ts`):
- Exact display title match: 1000 pts
- Title starts with query: 500 pts
- Word-boundary title prefix: 300 pts
- Title substring: 200 pts
- Alias exact match: 150 pts
- Alias prefix match: 100 pts
- Publisher match: 50 pts
- Description match: 20 pts
- Deterministic tie-breaking: Score DESC, DisplayName ASC, AppId ASC.

---

## 13. Plugin Lifecycle

- **Mounting**: Implements Cordis `[Service.init]()`. Loads cache immediately; starts non-blocking background discovery scan.
- **Disposal**: Unbinds all internal event handlers; disposes `AppRegistryEngine`; cancels any active `AbortController` in discovery providers; clears catalog state.
- **Resilience**: A disabled App Registry (`enabled: false`) leaves the host context, Home plugin, and all other services healthy and operational.

---

## 14. Security Decisions

- **Untrusted Input**: All OS paths, titles, arguments, and registry strings are treated as untrusted input. Control characters, null bytes, and script injection vectors are stripped.
- **Script Blocking**: Direct launch of dangerous script formats (`.vbs`, `.js`, `.wsf`, `.reg`, `.ps1`, `.hta`) is rejected.
- **PowerShell Isolation**: Encapsulated inside `PowerShellAdapter`:
  - Enforces deadlines via `@deepseek-ai/dsh-timeout`.
  - Zero string interpolation of user input (all scripts are static encoded scripts).
  - Uses `-EncodedCommand` with UTF-16LE Base64 to bypass shell argument escaping.
  - Zero usage of `shell: true`.

---

## 15. Performance Observations

- **Batch Discovery**: Providers execute all queries in parallel and batch enumerate Start Menu shortcuts in a single process rather than spawning per `.lnk`.
- **Live Windows Scan Metrics**:
  - Live Start Menu discovery: ~1.3 seconds for all system and user programs.
  - Live Packaged apps query: ~2.2 seconds across all Windows Store apps and AUMIDs.
  - Live Registry scan: ~0.9 seconds across 3 registry branches.
  - Reconciliation: < 5 milliseconds.
  - Search: < 1 millisecond across full catalog.

---

## 16. Deferred Native Capabilities

The following capabilities are deliberately deferred to Phase 6 Rust Surface/Native Core:
1. **Direct Win32 PE Resource Extraction**: Decoding `.ico` bitmaps and group icon directories from `.exe` and `.dll` files via `EnumResourceNamesW` / `LookupIconIdFromDirectoryEx`.
2. **Direct Windows COM AppModel Activation**: `IApplicationActivationManager::ActivateApplication` for modern packaged apps instead of `explorer.exe shell:AppsFolder\...`.
3. **Low-Level Native Process Spawning**: `CreateProcessW` with token and sandbox control.

---

## 17. Files & Modules Created

### Package `packages/services/app-registry`:
- `package.json`: Manifest for `@deepseek-ai/dsh-app-registry`.
- `tsconfig.json`: Project reference configuration.
- `README.md`: Package overview and documentation.
- `src/types.ts`: Application domain models, launch specs, icon references, provider interfaces.
- `src/identity.ts`: Canonical path normalization, descriptor construction, deterministic SHA-256 AppId derivation.
- `src/normalize.ts`: Untrusted OS input sanitization, path validation, icon/launch spec resolution.
- `src/powershell.ts`: Isolated, secure PowerShell runner with deadlines and encoded commands.
- `src/providers/start-menu.ts`: Start Menu shortcut discovery provider.
- `src/providers/packaged-apps.ts`: Packaged MSIX/UWP discovery provider.
- `src/providers/registry-metadata.ts`: Registry uninstall discovery provider.
- `src/reconcile.ts`: Deduplication, source precedence, and metadata enrichment engine.
- `src/cache.ts`: Atomic disk cache serialization using `@deepseek-ai/dsh-atomic-write`.
- `src/icons.ts`: Icon reference resolver and fallback provider.
- `src/launch.ts`: Pluggable launch adapter and execution engine.
- `src/search.ts`: Deterministic multi-field application search engine.
- `src/registry.ts`: Transactional catalog replacement and event dispatcher.
- `src/index.ts`: Cordis `AppRegistryService` plugin export and module augmentation.

### Tests `packages/services/app-registry/tests/`:
- `identity.spec.ts`: Unit tests for stable AppId generation and invariant paths.
- `normalize.spec.ts`: Unit tests for input sanitization and launch spec construction.
- `reconcile.spec.ts`: Unit tests for cross-provider deduplication and metadata merging.
- `search.spec.ts`: Unit tests for ranking and filtering.
- `cache.spec.ts`: Unit tests for atomic serialization and corruption recovery.
- `launch.spec.ts`: Unit tests for launch adapter and invalid path rejection.
- `providers.spec.ts`: Unit tests for Start Menu, Packaged, and Registry providers.
- `registry-service.spec.ts`: Integration tests for Cordis lifecycle, events, transactional refresh, event spam suppression, provider timeout, cancellation, coalescing, and disabled state.
- `windows-live.spec.ts`: Real Windows live OS integration tests.

---

## 18. Validation Results

- **Vitest Test Suite**: 35 test files passed (35/35), 326 tests passed (0 failed, 1 skipped).
- **TypeScript Typecheck**: `tsc -b tsconfig.host.json` exited 0 with 0 errors.
- **Linter**: `oxlint .` passed with 0 warnings, 0 errors across 84 files.
- **Build**: `tsdown` built all runtime bundles and type declarations cleanly in ~130ms.
- **Whitespace / Git Invariants**: `git diff --check` passed cleanly.

---

## 19. Architecture Concerns for Future Phases

1. **Phase 6 Native Core Icon Resolution**: When implementing Rust Surface Core, implement an `AppIconResolver` that decodes PE icon group resources directly into shared memory or data URIs to avoid disk roundtrips.
2. **Phase 7 Shell Layout / Dock & Launcher Integration**: The future Launcher and Dock plugins should consume `ctx.appRegistry.search()` and `ctx.appRegistry.resolve()` directly. Home desktop shortcuts should continue to reference `appId` as an opaque identifier, resolving icon and title at render time.
