/**
 * Top-Level Window Functional Classification.
 *
 * Classifies real Windows windows into deterministic categories:
 * - APPLICATION: Standard user-facing application windows
 * - SHELL: Windows Desktop Shell components (Taskbar, Desktop, Start)
 * - ELIX_SURFACE: Surface Core instances owned by ELIX
 * - TOOL: Toolbars, palettes, tooltips
 * - TRANSIENT: Menus, dialogs, popups, dropdowns
 * - SYSTEM: Windows background infrastructure and input services
 * - IGNORED: Zero-sized, hidden utility, or irrelevant windows
 *
 * @module @deepseek-ai/dsh-window-registry/classification
 */

import type { NativeRawWindow } from '@deepseek-ai/dsh-native-core'
import type { WindowClassification, WindowState } from './types.ts'

const KNOWN_SHELL_CLASSES = new Set([
  'Shell_TrayWnd',
  'Shell_SecondaryTrayWnd',
  'Progman',
  'WorkerW',
  'Shell_CharmWindow',
  'DV2ControlHost',
  'NotifyIconOverflowWindow',
  'Shell_InputSwitchTopLevelWindow',
])

const KNOWN_SYSTEM_CLASSES = new Set([
  'Default IME',
  'MSCTFIME UI',
  'IME',
  'OleMainThreadWndClass',
  'CicMarshalWndClass',
  'SystemSettings',
  'LockScreenWindow',
  'NarratorHelperWindow',
  'EdgeUiInputTopWndClass',
  'Chrome_WidgetWin_0',
  'UAC Input Indicator',
  'UAC_InputIndicatorOverlayWnd',
])

/**
 * Infrastructure window titles observed on real Windows desktops during Phase 13
 * acceptance. These are message/input/OLE helpers, not independently user-facing apps.
 * Keep this list deliberately narrow: Window Registry classification must not become
 * a broad "hide from Dock" policy layer.
 */
const KNOWN_SYSTEM_TITLES = new Set([
  'Default IME',
  'MSCTFIME UI',
  'DDE Server Window',
  'OLEChannelWnd',
  'OleMainThreadWndName',
  'MIT Message Only Window',
  'CicMarshalWnd',
  'LiftedDMITCursorRecalculateWindow',
  'WUIconWindow',
])

/** Native helper classes that should never be treated as application windows. */
const KNOWN_IGNORED_HELPER_CLASSES = new Set([
  'GDI+ Hook Window Class',
])

const KNOWN_TOOL_CLASSES = new Set([
  'tooltips_class32',
  'ToolbarWindow32',
])

const KNOWN_TRANSIENT_CLASSES = new Set([
  '#32768', // Win32 Standard Menu
  'ComboLBox', // Win32 Dropdown List
])

const KNOWN_TRANSIENT_TITLES = new Set([
  'PopupHost',
])

function isGdiPlusHelperTitle(title: string): boolean {
  // Common GDI+ notification/helper HWND, e.g. "GDI+ Window (Notepad.exe)".
  // Requiring the parenthesized executable suffix keeps this rule narrow and avoids
  // suppressing ordinary documents/windows that merely contain "GDI+" in their title.
  return /^GDI\+ Window \([^()]+\.exe\)$/i.test(title.trim())
}

/**
 * Classifies a raw window into an authoritative WindowClassification.
 *
 * @param raw - The raw window properties from native core.
 * @param isSurface - Whether the HWND is owned by ELIX Surface Core.
 * @returns The authoritative functional classification.
 */
export function classifyWindow(
  raw: NativeRawWindow,
  isSurface: boolean,
): WindowClassification {
  // 1. ELIX Surface takes immediate precedence
  if (isSurface || raw.className === 'ELIX_SURFACE_WINDOW_CLASS') {
    return 'ELIX_SURFACE'
  }

  // 2. Zero-sized windows are ignored
  if (raw.bounds.width <= 0 || raw.bounds.height <= 0) {
    return 'IGNORED'
  }

  // 3. Internal ELIX native helper windows are ignored
  if (
    raw.className === 'ELIX_WindowsContext' ||
    raw.className === 'ELIX_WindowRegistry' ||
    raw.className.startsWith('ELIX_AppBarHelper')
  ) {
    return 'IGNORED'
  }

  // 4. Known Windows Shell components
  if (raw.isShellWindow || KNOWN_SHELL_CLASSES.has(raw.className)) {
    return 'SHELL'
  }

  // Windows.UI.Core.CoreWindow with shell titles
  if (raw.className === 'Windows.UI.Core.CoreWindow') {
    const lowerTitle = raw.title.toLowerCase()
    if (
      lowerTitle === 'start' ||
      lowerTitle === 'search' ||
      lowerTitle === 'cortana' ||
      lowerTitle === 'action center'
    ) {
      return 'SHELL'
    }
  }

  // 5. Known non-user-facing native helpers. Phase 13 live acceptance observed
  // GDI+ helper HWNDs being otherwise misclassified as separate APPLICATION windows.
  if (
    KNOWN_IGNORED_HELPER_CLASSES.has(raw.className) ||
    isGdiPlusHelperTitle(raw.title)
  ) {
    return 'IGNORED'
  }

  // 6. Known system background/input/OLE infrastructure. Match both class and the
  // narrow exact-title set because some frameworks expose helper identity primarily
  // through window text while using generic implementation classes.
  if (
    KNOWN_SYSTEM_CLASSES.has(raw.className) ||
    KNOWN_SYSTEM_TITLES.has(raw.title.trim())
  ) {
    return 'SYSTEM'
  }

  // Invisible/cloaked helper windows with empty titles are irrelevant. Deliberately do
  // not ignore every hidden titled window: legitimate applications/tray windows can be
  // hidden while still being real application identities.
  if ((!raw.isVisible || raw.isCloaked) && !raw.title && !raw.isMinimized) {
    return 'IGNORED'
  }

  // 7. Tool windows (WS_EX_TOOLWINDOW)
  if (raw.isToolWindow || KNOWN_TOOL_CLASSES.has(raw.className)) {
    return 'TOOL'
  }

  // 8. Transient windows (menus, dialogs, popup hosts)
  if (
    KNOWN_TRANSIENT_CLASSES.has(raw.className) ||
    KNOWN_TRANSIENT_TITLES.has(raw.title.trim())
  ) {
    return 'TRANSIENT'
  }

  if (raw.className === '#32770') {
    return 'TRANSIENT'
  }

  // 9. Application windows. This remains a functional classification, not a Dock
  // eligibility decision; Phase 15/App Registry and Dock policy still decide grouping
  // and whether an application identity should be presented to the user.
  return 'APPLICATION'
}

/**
 * Derives the presentation state of a window.
 */
export function deriveWindowState(raw: NativeRawWindow): WindowState {
  if (raw.isMinimized) return 'minimized'
  if (raw.isMaximized) return 'maximized'
  if (!raw.isVisible || raw.isCloaked) return 'hidden'
  return 'normal'
}
