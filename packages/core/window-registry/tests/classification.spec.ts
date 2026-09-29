import type { NativeRawWindow } from '@deepseek-ai/dsh-native-core'
import { describe, expect, it } from 'vitest'
import { classifyWindow, deriveWindowState } from '../src/classification.ts'

function mockRaw(overrides: Partial<NativeRawWindow> = {}): NativeRawWindow {
  return {
    hwnd: 0x1000,
    processId: 100,
    threadId: 200,
    processCreationTime: 1000,
    title: 'Visual Studio Code',
    className: 'Chrome_WidgetWin_1',
    bounds: { x: 0, y: 0, width: 1200, height: 800 },
    isVisible: true,
    isMinimized: false,
    isMaximized: false,
    isCloaked: false,
    isToolWindow: false,
    isShellWindow: false,
    isEnabled: true,
    isForeground: false,
    ...overrides,
  }
}

describe('classifyWindow', () => {
  it('classifies ELIX Surface windows with top priority', () => {
    const raw = mockRaw({ isShellWindow: true, className: 'Shell_TrayWnd' })
    expect(classifyWindow(raw, true)).toBe('ELIX_SURFACE')

    // Also recognizes ELIX_SURFACE_WINDOW_CLASS directly
    const surfaceRaw = mockRaw({ className: 'ELIX_SURFACE_WINDOW_CLASS' })
    expect(classifyWindow(surfaceRaw, false)).toBe('ELIX_SURFACE')
  })

  it('classifies internal ELIX helper windows as IGNORED', () => {
    expect(classifyWindow(mockRaw({ className: 'ELIX_WindowsContext' }), false)).toBe('IGNORED')
    expect(classifyWindow(mockRaw({ className: 'ELIX_WindowRegistry' }), false)).toBe('IGNORED')
    expect(classifyWindow(mockRaw({ className: 'ELIX_AppBarHelper_123_1' }), false)).toBe('IGNORED')
  })

  it('classifies zero-sized windows as IGNORED', () => {
    const raw1 = mockRaw({ bounds: { x: 0, y: 0, width: 0, height: 0 } })
    const raw2 = mockRaw({ bounds: { x: 0, y: 0, width: 100, height: 0 } })
    expect(classifyWindow(raw1, false)).toBe('IGNORED')
    expect(classifyWindow(raw2, false)).toBe('IGNORED')
  })

  it('classifies known Windows Shell classes as SHELL', () => {
    expect(classifyWindow(mockRaw({ className: 'Shell_TrayWnd' }), false)).toBe('SHELL')
    expect(classifyWindow(mockRaw({ className: 'Shell_SecondaryTrayWnd' }), false)).toBe('SHELL')
    expect(classifyWindow(mockRaw({ className: 'Progman' }), false)).toBe('SHELL')
    expect(classifyWindow(mockRaw({ className: 'WorkerW' }), false)).toBe('SHELL')
    expect(classifyWindow(mockRaw({ className: 'NotifyIconOverflowWindow' }), false)).toBe('SHELL')
    expect(classifyWindow(mockRaw({ className: 'Shell_InputSwitchTopLevelWindow' }), false)).toBe('SHELL')
    expect(classifyWindow(mockRaw({ isShellWindow: true }), false)).toBe('SHELL')
    expect(classifyWindow(mockRaw({ className: 'Windows.UI.Core.CoreWindow', title: 'Start' }), false)).toBe('SHELL')
  })

  it('classifies known system classes as SYSTEM', () => {
    expect(classifyWindow(mockRaw({ className: 'Default IME' }), false)).toBe('SYSTEM')
    expect(classifyWindow(mockRaw({ className: 'MSCTFIME UI' }), false)).toBe('SYSTEM')
    expect(classifyWindow(mockRaw({ className: 'SystemSettings' }), false)).toBe('SYSTEM')
    expect(classifyWindow(mockRaw({ className: 'LockScreenWindow' }), false)).toBe('SYSTEM')
    expect(classifyWindow(mockRaw({ className: 'Chrome_WidgetWin_0' }), false)).toBe('SYSTEM')
    expect(classifyWindow(mockRaw({ className: 'CicMarshalWndClass' }), false)).toBe('SYSTEM')
    expect(classifyWindow(mockRaw({ className: 'UAC Input Indicator' }), false)).toBe('SYSTEM')
    expect(classifyWindow(mockRaw({ className: 'UAC_InputIndicatorOverlayWnd' }), false)).toBe('SYSTEM')
  })

  it('classifies real message/input/OLE helper titles as SYSTEM', () => {
    for (const title of [
      'Default IME',
      'MSCTFIME UI',
      'DDE Server Window',
      'OLEChannelWnd',
      'OleMainThreadWndName',
      'MIT Message Only Window',
      'CicMarshalWnd',
      'LiftedDMITCursorRecalculateWindow',
      'WUIconWindow',
    ]) {
      expect(
        classifyWindow(
          mockRaw({
            title,
            className: 'GenericFrameworkClass',
            isVisible: false,
          }),
          false,
        ),
      ).toBe('SYSTEM')
    }
  })

  it('ignores GDI+ notification/helper windows observed during live acceptance', () => {
    expect(
      classifyWindow(
        mockRaw({
          title: 'GDI+ Window (Notepad.exe)',
          className: 'GDI+ Hook Window Class',
          isVisible: false,
        }),
        false,
      ),
    ).toBe('IGNORED')

    // The title signature is also sufficient when a framework exposes a generic class.
    expect(
      classifyWindow(
        mockRaw({
          title: 'GDI+ Window (AsusOSD.exe)',
          className: 'GenericFrameworkClass',
          isVisible: false,
        }),
        false,
      ),
    ).toBe('IGNORED')
  })

  it('does not over-filter legitimate hidden or minimized titled applications', () => {
    expect(
      classifyWindow(
        mockRaw({
          title: 'Music Player',
          className: 'MusicPlayerMainWindow',
          isVisible: false,
          isMinimized: false,
        }),
        false,
      ),
    ).toBe('APPLICATION')

    expect(
      classifyWindow(
        mockRaw({
          title: 'WhatsApp',
          className: 'ApplicationFrameWindow',
          isVisible: true,
          isMinimized: true,
        }),
        false,
      ),
    ).toBe('APPLICATION')
  })

  it('classifies tool windows as TOOL', () => {
    expect(classifyWindow(mockRaw({ isToolWindow: true }), false)).toBe('TOOL')
    expect(classifyWindow(mockRaw({ className: 'tooltips_class32' }), false)).toBe('TOOL')
    expect(classifyWindow(mockRaw({ className: 'ToolbarWindow32' }), false)).toBe('TOOL')
  })

  it('classifies transient dialogs, menus, and popup hosts as TRANSIENT', () => {
    expect(classifyWindow(mockRaw({ className: '#32768' }), false)).toBe('TRANSIENT')
    expect(classifyWindow(mockRaw({ className: '#32770' }), false)).toBe('TRANSIENT')
    expect(classifyWindow(mockRaw({ className: 'ComboLBox' }), false)).toBe('TRANSIENT')
    expect(classifyWindow(mockRaw({ title: 'PopupHost', className: 'GenericPopupClass' }), false)).toBe('TRANSIENT')
  })

  it('classifies standard top-level application windows as APPLICATION', () => {
    const rawApp = mockRaw({
      title: 'Google Chrome',
      className: 'Chrome_WidgetWin_1',
      bounds: { x: 10, y: 10, width: 1000, height: 700 },
      isVisible: true,
    })
    expect(classifyWindow(rawApp, false)).toBe('APPLICATION')
  })
})

describe('deriveWindowState', () => {
  it('returns minimized when isMinimized is true', () => {
    expect(deriveWindowState(mockRaw({ isMinimized: true }))).toBe('minimized')
  })

  it('returns maximized when isMaximized is true', () => {
    expect(deriveWindowState(mockRaw({ isMaximized: true }))).toBe('maximized')
  })

  it('returns hidden when invisible or cloaked', () => {
    expect(deriveWindowState(mockRaw({ isVisible: false }))).toBe('hidden')
    expect(deriveWindowState(mockRaw({ isVisible: true, isCloaked: true }))).toBe('hidden')
  })

  it('returns normal for visible non-maximized non-minimized windows', () => {
    expect(deriveWindowState(mockRaw({ isVisible: true, isMinimized: false, isMaximized: false, isCloaked: false }))).toBe('normal')
  })
})
