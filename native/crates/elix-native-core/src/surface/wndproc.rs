//! Win32 Window Procedure implementation for ELIX surfaces.

use crate::surface::types::{PhysicalBounds, SurfaceFocusPolicy};
use parking_lot::RwLock;
use std::collections::HashMap;
use std::sync::Arc;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{BeginPaint, EndPaint, PAINTSTRUCT};
use windows::Win32::UI::WindowsAndMessaging::{
    DefWindowProcW, GetCursorPos, SetWindowPos, MA_NOACTIVATE, SWP_NOACTIVATE, SWP_NOZORDER,
    WM_CLOSE, WM_DPICHANGED, WM_ERASEBKGND, WM_LBUTTONDOWN, WM_MBUTTONDOWN, WM_MOUSEACTIVATE,
    WM_MOVE, WM_PAINT, WM_PARENTNOTIFY, WM_RBUTTONDOWN, WM_SETFOCUS, WM_SIZE,
};

/// Trait implemented by native surface instances to receive WndProc messages.
pub trait SurfaceMessageReceiver: Send + Sync {
    fn id(&self) -> &str;
    fn focus_policy(&self) -> SurfaceFocusPolicy;
    fn on_resize(&self, width: i32, height: i32);
    fn on_move(&self, x: i32, y: i32);
    fn on_dpi_changed(&self, new_dpi: u32, suggested_bounds: PhysicalBounds);
    fn on_pointer_down(&self, x: i32, y: i32);
    fn on_set_focus(&self);
}

static SURFACE_ROUTING_MAP: RwLock<Option<HashMap<isize, Arc<dyn SurfaceMessageReceiver>>>> =
    RwLock::new(None);

/// Associates an HWND with a message receiver.
pub fn register_surface_wnd(hwnd: HWND, receiver: Arc<dyn SurfaceMessageReceiver>) {
    let mut map_guard = SURFACE_ROUTING_MAP.write();
    let map = map_guard.get_or_insert_with(HashMap::new);
    map.insert(hwnd.0 as isize, receiver);
}

/// Disassociates an HWND when the surface is destroyed.
pub fn unregister_surface_wnd(hwnd: HWND) {
    let mut map_guard = SURFACE_ROUTING_MAP.write();
    if let Some(map) = map_guard.as_mut() {
        map.remove(&(hwnd.0 as isize));
    }
}

/// Static Win32 WndProc for ELIX surface windows.
///
/// # Safety
///
/// Must only be invoked by the Win32 window message dispatcher on the STA UI thread with valid HWND and message arguments.
pub unsafe extern "system" fn surface_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_ERASEBKGND => {
            // Suppress standard GDI background erase to eliminate visual white flash before WebView2 paints
            LRESULT(1)
        }

        WM_PAINT => {
            let mut ps = PAINTSTRUCT::default();
            let _hdc = BeginPaint(hwnd, &mut ps);
            let _ = EndPaint(hwnd, &ps);
            LRESULT(0)
        }

        WM_MOUSEACTIVATE => {
            let receiver = {
                let guard = SURFACE_ROUTING_MAP.read();
                guard
                    .as_ref()
                    .and_then(|m| m.get(&(hwnd.0 as isize)).cloned())
            };
            if let Some(receiver) = receiver {
                let mut pt = POINT::default();
                let _ = GetCursorPos(&mut pt);
                receiver.on_pointer_down(pt.x, pt.y);
                if receiver.focus_policy() == SurfaceFocusPolicy::NoActivate {
                    return LRESULT(MA_NOACTIVATE as _);
                }
            }
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }

        WM_LBUTTONDOWN | WM_RBUTTONDOWN => {
            let receiver = {
                let guard = SURFACE_ROUTING_MAP.read();
                guard
                    .as_ref()
                    .and_then(|m| m.get(&(hwnd.0 as isize)).cloned())
            };
            if let Some(receiver) = receiver {
                let mut pt = POINT::default();
                let _ = GetCursorPos(&mut pt);
                receiver.on_pointer_down(pt.x, pt.y);
            }
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }

        WM_PARENTNOTIFY => {
            let event = (wparam.0 & 0xffff) as u32;
            if event == WM_LBUTTONDOWN || event == WM_RBUTTONDOWN || event == WM_MBUTTONDOWN {
                let receiver = {
                    let guard = SURFACE_ROUTING_MAP.read();
                    guard
                        .as_ref()
                        .and_then(|m| m.get(&(hwnd.0 as isize)).cloned())
                };
                if let Some(receiver) = receiver {
                    let mut pt = POINT::default();
                    let _ = GetCursorPos(&mut pt);
                    receiver.on_pointer_down(pt.x, pt.y);
                }
            }
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }

        WM_SIZE => {
            let width = (lparam.0 & 0xffff) as i32;
            let height = ((lparam.0 >> 16) & 0xffff) as i32;
            let receiver = {
                let guard = SURFACE_ROUTING_MAP.read();
                guard
                    .as_ref()
                    .and_then(|m| m.get(&(hwnd.0 as isize)).cloned())
            };
            if let Some(receiver) = receiver {
                receiver.on_resize(width, height);
            }
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }

        WM_MOVE => {
            let x = (lparam.0 & 0xffff) as i16 as i32;
            let y = ((lparam.0 >> 16) & 0xffff) as i16 as i32;
            let receiver = {
                let guard = SURFACE_ROUTING_MAP.read();
                guard
                    .as_ref()
                    .and_then(|m| m.get(&(hwnd.0 as isize)).cloned())
            };
            if let Some(receiver) = receiver {
                receiver.on_move(x, y);
            }
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }

        WM_DPICHANGED => {
            let new_dpi = (wparam.0 & 0xffff) as u32;
            let suggested_rect = *(lparam.0 as *const RECT);
            let suggested_bounds = PhysicalBounds::new(
                suggested_rect.left,
                suggested_rect.top,
                suggested_rect.right - suggested_rect.left,
                suggested_rect.bottom - suggested_rect.top,
            );

            // Per-Monitor DPI: Update HWND to suggested rect from Windows
            let _ = SetWindowPos(
                hwnd,
                None,
                suggested_bounds.x,
                suggested_bounds.y,
                suggested_bounds.width,
                suggested_bounds.height,
                SWP_NOZORDER | SWP_NOACTIVATE,
            );

            let receiver = {
                let guard = SURFACE_ROUTING_MAP.read();
                guard
                    .as_ref()
                    .and_then(|m| m.get(&(hwnd.0 as isize)).cloned())
            };
            if let Some(receiver) = receiver {
                receiver.on_dpi_changed(new_dpi, suggested_bounds);
            }
            LRESULT(0)
        }

        WM_SETFOCUS => {
            let receiver = {
                let guard = SURFACE_ROUTING_MAP.read();
                guard
                    .as_ref()
                    .and_then(|m| m.get(&(hwnd.0 as isize)).cloned())
            };
            if let Some(receiver) = receiver {
                receiver.on_set_focus();
            }
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }

        WM_CLOSE => {
            // Ignore system close; Surface Core controls destruction via destroy()
            LRESULT(0)
        }

        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}
