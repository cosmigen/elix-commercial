# Agent Note: App Folder UI, animations, and in-WebView overlay

Status: implemented

## Problem

ELIX desktop folders previously rendered as basic folder icons and badges, lacking the specialized application-group folder interaction language pioneered in Old ELIX. Furthermore, managing folder contents and overlay presentation required clarity on surface boundaries: allocating separate native HWNDs or Surface Core WebViews for every opened folder would cause window management churn, focus races, and visual flicker. A distinction was also required between desktop App Folders (groupings of application shortcuts) and filesystem folders.

## Decision

App Folder presentation and overlay interactions are adapted from the proven Old ELIX design baseline (`Reference/OldELIX/Home/components/AppFolder.tsx`) into the Phase 12 Home architecture.

The `AppFolderOverlay` is implemented strictly as an in-WebView portal overlay within the existing Home surface (`#home-root`). No additional Surface Core HWNDs or WebView2 controllers are allocated for open folders. The overlay features:
1. `AppFolderPreview`: A mini app-icon grid on the desktop item showing miniature monograms/icons of contained applications with color-accented liquid-glass frames.
2. Origin-morph open and close animations: Captures the bounding client rect of the originating desktop folder tile and uses the Web Animations API (`elix-folder-origin-morph-open` / `elix-folder-origin-morph-close`) to smoothly expand and collapse the floating window to and from the folder tile.
3. In-folder drag-and-drop and FLIP reordering: Users can reorder apps inside the folder grid with FLIP settling animations (`elix-folder-reorder-settle`) and drag desktop apps directly into the open folder window.
4. Paging and window geometry: Client-side pagination (`PAGE_SIZE = 12`) with page navigation arrows and pagination dots, title rename editing, manage mode toggle, app removal, folder deletion, and resize grip rails with dimension persistence.
5. Distinction of folder types: Filesystem folders (`isFilesystem: true`) render traditional SVG icons and route activation to external shell handlers, whereas App Folders activate into the in-WebView floating window overlay.

The renderer protocol is extended with typed intents (`openFolder`, `closeFolder`, `reorderFolderItems`, `addItemToFolder`, `removeItemFromFolder`, `deleteFolder`), maintaining strict unidirectional data flow and durable persistence.

## Alternatives considered

**Allocate an independent Surface Core HWND for each folder window.** Allocating a native HWND and WebView2 per opened folder would introduce heavy resource overhead, inter-window activation and focus stealing issues, and complex DWM transparency choreography. Implementing the folder as a portal layer inside the Home WebView keeps ownership unified, transitions instant, and resource usage bounded.

**Client-side stateful folder store.** Maintaining an independent folder database inside renderer JavaScript would diverge from Home's authoritative state and atomic persistence. The folder overlay remains a declarative projection of Home state driven by typed renderer intents.

## Consequences

App Folders feel responsive, fluid, and desktop-native with zero additional OS window handles. The in-WebView overlay integrates directly with existing grid layout, selection, drag-to-create-folder intent machine, and persistence v2 models.
