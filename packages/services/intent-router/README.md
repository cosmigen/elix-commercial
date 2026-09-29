# @deepseek-ai/dsh-intent-router

ELIX OS Intent Router and File Operations plugin: authoritative action coordination, user intent validation, target resolution, and filesystem mutations.

## Architecture

```text
User interaction
      ↓
Home / Launcher / future shell UI
      ↓
Intent Router (ctx.intentRouter)
      ↓
authoritative capability owner
      ↓
App Registry / Shell Namespace / Native Core
      ↓
Windows OS
```

- **Home** owns interaction semantics and visual desktop state.
- **Intent Router** owns semantic action routing, input validation, and typed outcomes.
- **App Registry** owns application identity and catalog metadata.
- **Shell Namespace** owns shell and filesystem identity.
- **Native Core** owns native execution mechanics (`CreateProcessW`, Win32 API).

## Supported Phase 9 Intents

- `open-app`: Activates registered applications via App Registry and Native Core.
- `open-file`: Launches files with default system handlers.
- `open-folder`: Opens directory containers in Windows Explorer.
- `open-shortcut`: Inspects `.lnk` targets (app, file, folder, URL) with recursive loop protection.
- `reveal-in-folder`: Highlights and selects items in Windows Explorer (`/select,`).
- `rename`: Validates Windows filename constraints, performs atomic rename, and updates identity state.
- `delete`: Deletes items with explicit permanent deletion policy (`permanent: true`). Recycle Bin deletion returns typed `unsupported` until backed by native shell capability.
- `move`: Validates container hierarchy (preventing recursive folder moves into self or descendants) and moves items.
- `copy`: Copies items with hierarchy validation and per-item status.
- `create-folder`: Creates a new directory with Windows filename validation.
- `resolve-target`: Resolves effective target classification without execution.
- `get-available-actions`: Queries valid user actions for a given shell item.

## Known Limitations and Deferred Work

- Windows Recycle Bin deletion (`SHFileOperation`/`IFileOperation`) is not implemented by the current provider; delete operations require explicit `permanent: true` or return typed `unsupported`.
- Context menu UI, Dock, Status Bar, and AppBar reservations remain deferred to future phases (Phase 10+).
