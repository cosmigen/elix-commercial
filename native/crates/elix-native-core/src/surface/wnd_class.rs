//! Win32 Window Class registration and lifetime management for ELIX surfaces.

use crate::error::{NativeError, NativeResult};
use std::sync::atomic::{AtomicUsize, Ordering};
use windows::core::w;
use windows::Win32::Foundation::{GetLastError, HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::Graphics::Gdi::HBRUSH;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    DefWindowProcW, GetClassInfoExW, LoadCursorW, RegisterClassExW, UnregisterClassW, CS_HREDRAW,
    CS_VREDRAW, IDC_ARROW, WNDCLASSEXW,
};

pub const ELIX_SURFACE_CLASS_NAME: windows::core::PCWSTR = w!("ELIX_SURFACE_WINDOW_CLASS");

static ACTIVE_SURFACE_COUNT: AtomicUsize = AtomicUsize::new(0);

/// Ensures the ELIX native surface window class is registered.
///
/// Thread-safe and idempotent.
pub fn ensure_surface_class_registered() -> NativeResult<()> {
    unsafe {
        let hinstance: HINSTANCE = GetModuleHandleW(None)
            .map_err(|e| NativeError::from_windows_error(e, "Failed to get current module handle"))?
            .into();

        let mut existing = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            ..Default::default()
        };
        if GetClassInfoExW(Some(hinstance), ELIX_SURFACE_CLASS_NAME, &mut existing).is_ok() {
            ACTIVE_SURFACE_COUNT.fetch_add(1, Ordering::SeqCst);
            return Ok(());
        }

        let cursor = LoadCursorW(None, IDC_ARROW).map_err(|e| {
            NativeError::from_windows_error(e, "Failed to load standard arrow cursor")
        })?;

        let wnd_class = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(crate::surface::wndproc::surface_wndproc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: hinstance,
            hIcon: windows::Win32::UI::WindowsAndMessaging::HICON::default(),
            hCursor: cursor,
            // Null background brush to prevent white background erase flash before WebView2 paints
            hbrBackground: HBRUSH(std::ptr::null_mut()),
            lpszMenuName: windows::core::PCWSTR::null(),
            lpszClassName: ELIX_SURFACE_CLASS_NAME,
            hIconSm: windows::Win32::UI::WindowsAndMessaging::HICON::default(),
        };

        let atom = RegisterClassExW(&wnd_class);
        if atom == 0 {
            let last_err = GetLastError().0;
            if GetClassInfoExW(Some(hinstance), ELIX_SURFACE_CLASS_NAME, &mut existing).is_err() {
                return Err(NativeError::from_win32(
                    last_err,
                    "Failed to register ELIX surface window class",
                ));
            }
        }

        ACTIVE_SURFACE_COUNT.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

/// Decrements active surface count and unregisters the window class when the last surface is destroyed.
pub fn decrement_surface_class_ref() {
    let prev = ACTIVE_SURFACE_COUNT
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |val| {
            if val > 0 {
                Some(val - 1)
            } else {
                Some(0)
            }
        })
        .unwrap_or(0);
    if prev == 1 {
        // Last surface removed, unregister window class
        unsafe {
            let hinstance: HINSTANCE = GetModuleHandleW(None)
                .map(Into::into)
                .unwrap_or(HINSTANCE(std::ptr::null_mut()));
            let _ = UnregisterClassW(ELIX_SURFACE_CLASS_NAME, Some(hinstance));
        }
    }
}

/// Fallback message dispatch procedure.
///
/// # Safety
///
/// Must only be called by the Win32 subsystem as an external window procedure with valid message parameters.
pub unsafe extern "system" fn fallback_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    DefWindowProcW(hwnd, msg, wparam, lparam)
}
