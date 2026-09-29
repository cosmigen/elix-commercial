//! Authoritative Windows Shell AppBar reservation primitives for ELIX.
//!
//! Exposes typed Win32 AppBar registration, updating, and unregistration
//! for reserving desktop work area space for docked shell surfaces.

use crate::error::{NativeError, NativeResult};
use crate::windows_context::PhysicalPixelRect;
use crossbeam_channel::{bounded, Receiver, Sender};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::thread::JoinHandle;

#[cfg(windows)]
static CLASS_COUNTER: AtomicU64 = AtomicU64::new(1);

#[cfg(windows)]
use windows::core::PCWSTR;
#[cfg(windows)]
use windows::Win32::Foundation::{GetLastError, HINSTANCE, HWND, LPARAM, LRESULT, RECT, WPARAM};
#[cfg(windows)]
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
#[cfg(windows)]
use windows::Win32::UI::Shell::{
    SHAppBarMessage, ABE_BOTTOM, ABE_LEFT, ABE_RIGHT, ABE_TOP, ABM_NEW, ABM_QUERYPOS, ABM_REMOVE,
    ABM_SETPOS, APPBARDATA,
};
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetWindowLongPtrW,
    PeekMessageW, RegisterClassW, SetWindowLongPtrW, SetWindowPos, TranslateMessage,
    UnregisterClassW, GWLP_USERDATA, HWND_TOPMOST, MSG, PM_REMOVE, SWP_NOACTIVATE, WM_USER,
    WNDCLASSW, WS_EX_TOOLWINDOW, WS_POPUP,
};

/// Screen edges on which an AppBar can dock to reserve desktop work area.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum AppBarEdge {
    Top,
    Bottom,
    Left,
    Right,
}

impl AppBarEdge {
    #[cfg(windows)]
    pub fn to_u32(self) -> u32 {
        match self {
            AppBarEdge::Left => ABE_LEFT,
            AppBarEdge::Top => ABE_TOP,
            AppBarEdge::Right => ABE_RIGHT,
            AppBarEdge::Bottom => ABE_BOTTOM,
        }
    }
}

/// Registration or update specification for an AppBar reservation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppBarSpec {
    pub id: String,
    pub edge: AppBarEdge,
    pub rect: PhysicalPixelRect,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hwnd: Option<isize>,
}

/// Point-in-time snapshot of an active AppBar registration.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RegisteredAppBar {
    pub id: String,
    pub edge: AppBarEdge,
    pub rect: PhysicalPixelRect,
    pub hwnd: isize,
}

enum AppBarCommand {
    RegisterOrUpdate {
        spec: AppBarSpec,
        reply: Sender<NativeResult<PhysicalPixelRect>>,
    },
    Unregister {
        id: String,
        reply: Sender<NativeResult<bool>>,
    },
    GetRegistered {
        reply: Sender<NativeResult<Vec<RegisteredAppBar>>>,
    },
    Dispose {
        reply: Sender<()>,
    },
}

/// Application-defined callback message registered with the shell for AppBar notifications.
pub const WM_APPBAR_CALLBACK: u32 = WM_USER + 211;

/// Shell AppBar notification sent when an event occurs that may affect the size/position of an AppBar.
pub const ABN_POSCHANGED: u32 = 1;

/// Pure helper adjusting a queried Win32 RECT to preserve the requested shell-surface thickness
/// on the anchored screen edge.
#[cfg(windows)]
pub fn adjust_rect_edge_thickness(
    edge: AppBarEdge,
    mut rc: RECT,
    requested_width: i32,
    requested_height: i32,
) -> RECT {
    match edge {
        AppBarEdge::Top => {
            rc.bottom = rc.top + requested_height.max(0);
        }
        AppBarEdge::Bottom => {
            rc.top = rc.bottom - requested_height.max(0);
        }
        AppBarEdge::Left => {
            rc.right = rc.left + requested_width.max(0);
        }
        AppBarEdge::Right => {
            rc.left = rc.right - requested_width.max(0);
        }
    }
    rc
}

/// Pure helper adjusting a PhysicalPixelRect to preserve requested edge thickness.
pub fn adjust_app_bar_thickness(
    edge: AppBarEdge,
    mut queried: PhysicalPixelRect,
    requested_width: i32,
    requested_height: i32,
) -> PhysicalPixelRect {
    match edge {
        AppBarEdge::Top => {
            queried.height = requested_height.max(0);
        }
        AppBarEdge::Bottom => {
            let bottom = queried.y + queried.height;
            let height = requested_height.max(0);
            queried.y = bottom - height;
            queried.height = height;
        }
        AppBarEdge::Left => {
            queried.width = requested_width.max(0);
        }
        AppBarEdge::Right => {
            let right = queried.x + queried.width;
            let width = requested_width.max(0);
            queried.x = right - width;
            queried.width = width;
        }
    }
    queried
}

struct InternalAppBarEntry {
    spec: AppBarSpec,
    approved_rect: PhysicalPixelRect,
    hwnd: isize,
    owned_window: bool,
    registered_with_shell: bool,
    is_repositioning: bool,
}

#[cfg(windows)]
pub(crate) struct WorkerContext {
    registrations: HashMap<String, InternalAppBarEntry>,
    hwnd_to_id: HashMap<isize, String>,
}

#[cfg(windows)]
thread_local! {
    static CURRENT_WORKER_CTX: std::cell::Cell<*mut WorkerContext> = const { std::cell::Cell::new(std::ptr::null_mut()) };
}

#[cfg(windows)]
pub(crate) fn handle_pos_changed_internal(hwnd: HWND, ctx: &mut WorkerContext) -> bool {
    if let Some(id) = ctx.hwnd_to_id.get(&(hwnd.0 as isize)) {
        if let Some(entry) = ctx.registrations.get_mut(id) {
            if entry.is_repositioning || !entry.registered_with_shell {
                return false;
            }
            entry.is_repositioning = true;
            let approved = negotiate_and_apply_app_bar_pos(hwnd, entry.spec.edge, &entry.spec.rect);
            entry.approved_rect = approved;
            entry.is_repositioning = false;
            return true;
        }
    }
    false
}

#[cfg(windows)]
unsafe extern "system" fn app_bar_window_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if msg == WM_APPBAR_CALLBACK {
        let notification = wparam.0 as u32;
        if notification == ABN_POSCHANGED {
            let mut handled = false;
            CURRENT_WORKER_CTX.with(|c| {
                let ptr = c.get();
                if !ptr.is_null() {
                    let ctx = unsafe { &mut *ptr };
                    handled = handle_pos_changed_internal(hwnd, ctx);
                }
            });
            if !handled {
                let user_data = unsafe { GetWindowLongPtrW(hwnd, GWLP_USERDATA) };
                if user_data != 0 {
                    let ctx = unsafe { &mut *(user_data as *mut WorkerContext) };
                    let _ = handle_pos_changed_internal(hwnd, ctx);
                }
            }
            return LRESULT(0);
        }
    }
    DefWindowProcW(hwnd, msg, wparam, lparam)
}

#[cfg(windows)]
pub fn dispatch_app_bar_window_msg_for_test(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    unsafe { app_bar_window_proc(hwnd, msg, wparam, lparam) }
}

/// Thread-safe manager owning native Windows AppBar reservations.
pub struct AppBarManager {
    command_tx: Sender<AppBarCommand>,
    worker_thread: Mutex<Option<JoinHandle<()>>>,
    is_disposed: AtomicBool,
}

impl AppBarManager {
    /// Creates and starts a new AppBarManager with a dedicated STA worker thread.
    pub fn new() -> NativeResult<Self> {
        let (command_tx, command_rx) = bounded::<AppBarCommand>(64);
        let (init_tx, init_rx) = bounded::<NativeResult<()>>(1);

        let thread_handle = std::thread::Builder::new()
            .name("elix-native-appbar".to_string())
            .spawn(move || {
                run_app_bar_worker(command_rx, init_tx);
            })
            .map_err(|e| {
                NativeError::new(
                    "app-bar",
                    "THREAD_SPAWN_FAILED",
                    format!("Failed to spawn AppBar worker thread: {e}"),
                )
            })?;

        init_rx.recv().map_err(|_| {
            NativeError::new(
                "app-bar",
                "INIT_CHANNEL_CLOSED",
                "AppBar worker thread exited before signaling initialization",
            )
        })??;

        Ok(Self {
            command_tx,
            worker_thread: Mutex::new(Some(thread_handle)),
            is_disposed: AtomicBool::new(false),
        })
    }

    /// Registers a new AppBar reservation or updates an existing one.
    pub fn register_or_update(&self, spec: AppBarSpec) -> NativeResult<PhysicalPixelRect> {
        if self.is_disposed.load(Ordering::SeqCst) {
            return Err(NativeError::new(
                "app-bar",
                "MANAGER_DISPOSED",
                "AppBarManager has been disposed",
            ));
        }
        if spec.id.trim().is_empty() {
            return Err(NativeError::invalid_argument("AppBar id must not be empty"));
        }
        if spec.rect.width < 0 || spec.rect.height < 0 {
            return Err(NativeError::invalid_argument(
                "AppBar rect dimensions cannot be negative",
            ));
        }

        let (reply_tx, reply_rx) = bounded(1);
        self.command_tx
            .send(AppBarCommand::RegisterOrUpdate {
                spec,
                reply: reply_tx,
            })
            .map_err(|_| {
                NativeError::new(
                    "app-bar",
                    "WORKER_DISCONNECTED",
                    "AppBar worker thread is unavailable",
                )
            })?;

        reply_rx.recv().map_err(|_| {
            NativeError::new(
                "app-bar",
                "REPLY_DROPPED",
                "AppBar worker dropped register reply",
            )
        })?
    }

    /// Unregisters an active AppBar reservation.
    pub fn unregister(&self, id: &str) -> NativeResult<bool> {
        if self.is_disposed.load(Ordering::SeqCst) {
            return Ok(false);
        }
        if id.trim().is_empty() {
            return Ok(false);
        }

        let (reply_tx, reply_rx) = bounded(1);
        self.command_tx
            .send(AppBarCommand::Unregister {
                id: id.to_string(),
                reply: reply_tx,
            })
            .map_err(|_| {
                NativeError::new(
                    "app-bar",
                    "WORKER_DISCONNECTED",
                    "AppBar worker thread is unavailable",
                )
            })?;

        reply_rx.recv().map_err(|_| {
            NativeError::new(
                "app-bar",
                "REPLY_DROPPED",
                "AppBar worker dropped unregister reply",
            )
        })?
    }

    /// Retrieves all currently registered AppBars.
    pub fn get_registered(&self) -> NativeResult<Vec<RegisteredAppBar>> {
        if self.is_disposed.load(Ordering::SeqCst) {
            return Ok(Vec::new());
        }

        let (reply_tx, reply_rx) = bounded(1);
        self.command_tx
            .send(AppBarCommand::GetRegistered { reply: reply_tx })
            .map_err(|_| {
                NativeError::new(
                    "app-bar",
                    "WORKER_DISCONNECTED",
                    "AppBar worker thread is unavailable",
                )
            })?;

        reply_rx.recv().map_err(|_| {
            NativeError::new(
                "app-bar",
                "REPLY_DROPPED",
                "AppBar worker dropped get_registered reply",
            )
        })?
    }

    /// Cleanly unregisters all active AppBars and disposes the manager.
    pub fn dispose(&self) {
        if self.is_disposed.swap(true, Ordering::SeqCst) {
            return;
        }

        let (reply_tx, reply_rx) = bounded(1);
        let _ = self
            .command_tx
            .send(AppBarCommand::Dispose { reply: reply_tx });
        let _ = reply_rx.recv();

        if let Some(handle) = self.worker_thread.lock().take() {
            let _ = handle.join();
        }
    }
}

impl Drop for AppBarManager {
    fn drop(&mut self) {
        self.dispose();
    }
}

#[cfg(windows)]
fn negotiate_and_apply_app_bar_pos(
    hwnd: HWND,
    edge: AppBarEdge,
    spec_rect: &PhysicalPixelRect,
) -> PhysicalPixelRect {
    let mut data = APPBARDATA {
        cbSize: std::mem::size_of::<APPBARDATA>() as u32,
        hWnd: hwnd,
        uEdge: edge.to_u32(),
        rc: RECT {
            left: spec_rect.x,
            top: spec_rect.y,
            right: spec_rect.x + spec_rect.width,
            bottom: spec_rect.y + spec_rect.height,
        },
        ..Default::default()
    };

    unsafe {
        SHAppBarMessage(ABM_QUERYPOS, &mut data);
        data.rc = adjust_rect_edge_thickness(edge, data.rc, spec_rect.width, spec_rect.height);
        SHAppBarMessage(ABM_SETPOS, &mut data);
        let _ = SetWindowPos(
            hwnd,
            Some(HWND_TOPMOST),
            data.rc.left,
            data.rc.top,
            data.rc.right - data.rc.left,
            data.rc.bottom - data.rc.top,
            SWP_NOACTIVATE,
        );
    }

    PhysicalPixelRect::from(data.rc)
}

#[cfg(windows)]
fn run_app_bar_worker(command_rx: Receiver<AppBarCommand>, init_tx: Sender<NativeResult<()>>) {
    let _apartment = match crate::runtime::apartment::ComApartment::sta() {
        Ok(apt) => apt,
        Err(e) => {
            let _ = init_tx.send(Err(e));
            return;
        }
    };

    let module = match unsafe { GetModuleHandleW(None) } {
        Ok(m) => m,
        Err(e) => {
            let _ = init_tx.send(Err(NativeError::from_windows_error(
                e,
                "Failed to get module handle in AppBar worker",
            )));
            return;
        }
    };
    let instance = HINSTANCE(module.0);
    let class_id = CLASS_COUNTER.fetch_add(1, Ordering::Relaxed);
    let class_name_str = format!("ELIX_AppBarHelper_{}_{}\0", std::process::id(), class_id);
    let class_name_utf16: Vec<u16> = class_name_str.encode_utf16().collect();

    let wnd_class = WNDCLASSW {
        lpfnWndProc: Some(app_bar_window_proc),
        hInstance: instance,
        lpszClassName: PCWSTR(class_name_utf16.as_ptr()),
        ..Default::default()
    };

    let atom = unsafe { RegisterClassW(&wnd_class) };
    if atom == 0 {
        let err_code = unsafe { GetLastError().0 };
        // If class already exists in process, that is fine
        if err_code != 1410 {
            // ERROR_CLASS_ALREADY_EXISTS = 1410
            let _ = init_tx.send(Err(NativeError::from_win32(
                err_code,
                "Failed to register AppBar helper window class",
            )));
            return;
        }
    }

    let _ = init_tx.send(Ok(()));

    let mut worker_ctx = WorkerContext {
        registrations: HashMap::new(),
        hwnd_to_id: HashMap::new(),
    };
    CURRENT_WORKER_CTX.with(|c| c.set(&mut worker_ctx as *mut _));

    struct WorkerCtxGuard;
    impl Drop for WorkerCtxGuard {
        fn drop(&mut self) {
            CURRENT_WORKER_CTX.with(|c| c.set(std::ptr::null_mut()));
        }
    }
    let _ctx_guard = WorkerCtxGuard;

    loop {
        // Drain any pending Win32 messages for helper windows
        unsafe {
            let mut msg = MSG::default();
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }

        match command_rx.recv_timeout(std::time::Duration::from_millis(50)) {
            Ok(AppBarCommand::RegisterOrUpdate { spec, reply }) => {
                let res =
                    handle_register_or_update(spec, &mut worker_ctx, &class_name_utf16, instance);
                let _ = reply.send(res);
            }
            Ok(AppBarCommand::Unregister { id, reply }) => {
                let res = handle_unregister(&id, &mut worker_ctx);
                let _ = reply.send(Ok(res));
            }
            Ok(AppBarCommand::GetRegistered { reply }) => {
                let list = worker_ctx
                    .registrations
                    .values()
                    .map(|entry| RegisteredAppBar {
                        id: entry.spec.id.clone(),
                        edge: entry.spec.edge,
                        rect: entry.approved_rect,
                        hwnd: entry.hwnd,
                    })
                    .collect();
                let _ = reply.send(Ok(list));
            }
            Ok(AppBarCommand::Dispose { reply }) => {
                for (_, entry) in worker_ctx.registrations.drain() {
                    let hwnd = HWND(entry.hwnd as *mut _);
                    if entry.registered_with_shell && is_shell_tray_available() {
                        let mut data = APPBARDATA {
                            cbSize: std::mem::size_of::<APPBARDATA>() as u32,
                            hWnd: hwnd,
                            ..Default::default()
                        };
                        unsafe {
                            SHAppBarMessage(ABM_REMOVE, &mut data);
                        }
                    }
                    if entry.owned_window {
                        unsafe {
                            let _ = DestroyWindow(hwnd);
                        }
                    }
                }
                worker_ctx.hwnd_to_id.clear();
                unsafe {
                    let _ = UnregisterClassW(PCWSTR(class_name_utf16.as_ptr()), Some(instance));
                }
                let _ = reply.send(());
                break;
            }
            Err(crossbeam_channel::RecvTimeoutError::Timeout) => {
                // Periodically loops to drain Win32 messages via PeekMessageW
            }
            Err(crossbeam_channel::RecvTimeoutError::Disconnected) => {
                // Sender dropped, clean up and exit
                for (_, entry) in worker_ctx.registrations.drain() {
                    let hwnd = HWND(entry.hwnd as *mut _);
                    if entry.registered_with_shell && is_shell_tray_available() {
                        let mut data = APPBARDATA {
                            cbSize: std::mem::size_of::<APPBARDATA>() as u32,
                            hWnd: hwnd,
                            ..Default::default()
                        };
                        unsafe {
                            SHAppBarMessage(ABM_REMOVE, &mut data);
                        }
                    }
                    if entry.owned_window {
                        unsafe {
                            let _ = DestroyWindow(hwnd);
                        }
                    }
                }
                worker_ctx.hwnd_to_id.clear();
                unsafe {
                    let _ = UnregisterClassW(PCWSTR(class_name_utf16.as_ptr()), Some(instance));
                }
                break;
            }
        }
    }
}

#[cfg(windows)]
fn is_shell_tray_available() -> bool {
    let tray_class: Vec<u16> = "Shell_TrayWnd\0".encode_utf16().collect();
    match unsafe {
        windows::Win32::UI::WindowsAndMessaging::FindWindowW(PCWSTR(tray_class.as_ptr()), None)
    } {
        Ok(hwnd) => !hwnd.0.is_null(),
        Err(_) => false,
    }
}

#[cfg(windows)]
fn handle_register_or_update(
    spec: AppBarSpec,
    ctx: &mut WorkerContext,
    class_name: &[u16],
    instance: HINSTANCE,
) -> NativeResult<PhysicalPixelRect> {
    let shell_available = is_shell_tray_available();

    if let Some(existing) = ctx.registrations.get_mut(&spec.id) {
        let hwnd = HWND(existing.hwnd as *mut _);
        let approved = if shell_available && existing.registered_with_shell {
            negotiate_and_apply_app_bar_pos(hwnd, spec.edge, &spec.rect)
        } else {
            spec.rect
        };

        existing.approved_rect = approved;
        existing.spec = spec;
        Ok(approved)
    } else {
        let ctx_ptr = ctx as *mut WorkerContext;
        let (hwnd, owned) = if let Some(h) = spec.hwnd {
            if h != 0 {
                let custom_hwnd = HWND(h as *mut _);
                unsafe {
                    let _ = SetWindowLongPtrW(custom_hwnd, GWLP_USERDATA, ctx_ptr as isize);
                }
                (custom_hwnd, false)
            } else {
                create_helper_window(class_name, instance, ctx_ptr)?
            }
        } else {
            create_helper_window(class_name, instance, ctx_ptr)?
        };

        let mut registered_with_shell = false;
        let approved = if shell_available {
            let mut data = APPBARDATA {
                cbSize: std::mem::size_of::<APPBARDATA>() as u32,
                hWnd: hwnd,
                uCallbackMessage: WM_APPBAR_CALLBACK,
                ..Default::default()
            };

            let ok = unsafe { SHAppBarMessage(ABM_NEW, &mut data) };
            if ok != 0 {
                registered_with_shell = true;
                negotiate_and_apply_app_bar_pos(hwnd, spec.edge, &spec.rect)
            } else {
                spec.rect
            }
        } else {
            spec.rect
        };

        let hwnd_raw = hwnd.0 as isize;
        ctx.hwnd_to_id.insert(hwnd_raw, spec.id.clone());
        ctx.registrations.insert(
            spec.id.clone(),
            InternalAppBarEntry {
                spec,
                approved_rect: approved,
                hwnd: hwnd_raw,
                owned_window: owned,
                registered_with_shell,
                is_repositioning: false,
            },
        );
        Ok(approved)
    }
}

#[cfg(windows)]
fn handle_unregister(id: &str, ctx: &mut WorkerContext) -> bool {
    if let Some(entry) = ctx.registrations.remove(id) {
        ctx.hwnd_to_id.remove(&entry.hwnd);
        let hwnd = HWND(entry.hwnd as *mut _);
        if entry.registered_with_shell && is_shell_tray_available() {
            let mut data = APPBARDATA {
                cbSize: std::mem::size_of::<APPBARDATA>() as u32,
                hWnd: hwnd,
                ..Default::default()
            };
            unsafe {
                SHAppBarMessage(ABM_REMOVE, &mut data);
            }
        }
        if entry.owned_window {
            unsafe {
                let _ = SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
                let _ = DestroyWindow(hwnd);
            }
        }
        true
    } else {
        false
    }
}

#[cfg(windows)]
fn create_helper_window(
    class_name: &[u16],
    instance: HINSTANCE,
    ctx_ptr: *mut WorkerContext,
) -> NativeResult<(HWND, bool)> {
    let window_title: Vec<u16> = "ELIX_AppBarHelper\0".encode_utf16().collect();
    let hwnd = unsafe {
        CreateWindowExW(
            WS_EX_TOOLWINDOW,
            PCWSTR(class_name.as_ptr()),
            PCWSTR(window_title.as_ptr()),
            WS_POPUP,
            0,
            0,
            0,
            0,
            None,
            None,
            Some(instance),
            None,
        )
    }
    .map_err(|e| NativeError::from_windows_error(e, "Failed to create AppBar helper window"))?;

    if !ctx_ptr.is_null() {
        unsafe {
            let _ = SetWindowLongPtrW(hwnd, GWLP_USERDATA, ctx_ptr as isize);
        }
    }

    Ok((hwnd, true))
}

#[cfg(not(windows))]
fn run_app_bar_worker(command_rx: Receiver<AppBarCommand>, init_tx: Sender<NativeResult<()>>) {
    let _ = init_tx.send(Ok(()));
    let mut registrations: HashMap<String, InternalAppBarEntry> = HashMap::new();

    while let Ok(cmd) = command_rx.recv() {
        match cmd {
            AppBarCommand::RegisterOrUpdate { spec, reply } => {
                let rect = adjust_app_bar_thickness(
                    spec.edge,
                    spec.rect,
                    spec.rect.width,
                    spec.rect.height,
                );
                registrations.insert(
                    spec.id.clone(),
                    InternalAppBarEntry {
                        spec,
                        approved_rect: rect,
                        hwnd: 1001,
                        owned_window: true,
                        registered_with_shell: false,
                        is_repositioning: false,
                    },
                );
                let _ = reply.send(Ok(rect));
            }
            AppBarCommand::Unregister { id, reply } => {
                let removed = registrations.remove(&id).is_some();
                let _ = reply.send(Ok(removed));
            }
            AppBarCommand::GetRegistered { reply } => {
                let list = registrations
                    .values()
                    .map(|e| RegisteredAppBar {
                        id: e.spec.id.clone(),
                        edge: e.spec.edge,
                        rect: e.approved_rect,
                        hwnd: e.hwnd,
                    })
                    .collect();
                let _ = reply.send(Ok(list));
            }
            AppBarCommand::Dispose { reply } => {
                registrations.clear();
                let _ = reply.send(());
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    static APP_BAR_TEST_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn test_app_bar_spec_validation() {
        let _guard = APP_BAR_TEST_LOCK.lock();
        let manager = AppBarManager::new().expect("manager creation");
        let err_empty = manager.register_or_update(AppBarSpec {
            id: "".to_string(),
            edge: AppBarEdge::Top,
            rect: PhysicalPixelRect {
                x: 0,
                y: 0,
                width: 100,
                height: 40,
            },
            hwnd: None,
        });
        assert!(err_empty.is_err());

        let err_neg = manager.register_or_update(AppBarSpec {
            id: "test".to_string(),
            edge: AppBarEdge::Top,
            rect: PhysicalPixelRect {
                x: 0,
                y: 0,
                width: -10,
                height: 40,
            },
            hwnd: None,
        });
        assert!(err_neg.is_err());
        manager.dispose();
    }

    #[test]
    fn test_app_bar_edge_serialization() {
        let json = serde_json::to_string(&AppBarEdge::Top).unwrap();
        assert_eq!(json, "\"top\"");
        let edge: AppBarEdge = serde_json::from_str("\"bottom\"").unwrap();
        assert_eq!(edge, AppBarEdge::Bottom);
    }

    #[test]
    fn test_app_bar_registration_lifecycle() {
        let _guard = APP_BAR_TEST_LOCK.lock();
        let manager = AppBarManager::new().expect("manager creation");
        let spec = AppBarSpec {
            id: "test-bar-1".to_string(),
            edge: AppBarEdge::Top,
            rect: PhysicalPixelRect {
                x: 0,
                y: 0,
                width: 1920,
                height: 40,
            },
            hwnd: None,
        };

        let reg_result = manager.register_or_update(spec);
        assert!(reg_result.is_ok());
        let approved = reg_result.unwrap();
        assert!(approved.height >= 0);
        let registered = manager.get_registered().unwrap();
        assert_eq!(registered.len(), 1);
        assert_eq!(registered[0].id, "test-bar-1");
        let unreg = manager.unregister("test-bar-1").unwrap();
        assert!(unreg);
        let registered_after = manager.get_registered().unwrap();
        assert_eq!(registered_after.len(), 0);

        manager.dispose();
    }

    #[test]
    fn test_app_bar_update_same_id_thickness() {
        let _guard = APP_BAR_TEST_LOCK.lock();
        let manager = AppBarManager::new().expect("manager creation");
        let spec1 = AppBarSpec {
            id: "test-bar-update".to_string(),
            edge: AppBarEdge::Top,
            rect: PhysicalPixelRect {
                x: 0,
                y: 0,
                width: 1920,
                height: 40,
            },
            hwnd: None,
        };
        let app1 = manager.register_or_update(spec1).expect("initial reg");
        assert!(app1.height >= 0);

        let spec2 = AppBarSpec {
            id: "test-bar-update".to_string(),
            edge: AppBarEdge::Top,
            rect: PhysicalPixelRect {
                x: 0,
                y: 0,
                width: 1920,
                height: 60,
            },
            hwnd: None,
        };
        let app2 = manager.register_or_update(spec2).expect("update reg");
        assert!(app2.height >= 0);

        let registered = manager.get_registered().expect("list");
        assert_eq!(registered.len(), 1);
        assert_eq!(registered[0].id, "test-bar-update");

        manager.unregister("test-bar-update").expect("unreg");
        manager.dispose();
    }

    #[test]
    #[cfg(windows)]
    fn test_adjust_edge_thickness_top() {
        let queried = RECT {
            left: 0,
            top: 30,
            right: 1920,
            bottom: 1080,
        };
        let adjusted = adjust_rect_edge_thickness(AppBarEdge::Top, queried, 1920, 40);
        assert_eq!(adjusted.left, 0);
        assert_eq!(adjusted.right, 1920);
        assert_eq!(adjusted.top, 30);
        assert_eq!(adjusted.bottom, 70);
    }

    #[test]
    #[cfg(windows)]
    fn test_adjust_edge_thickness_bottom() {
        let queried = RECT {
            left: 0,
            top: 0,
            right: 1920,
            bottom: 1040,
        };
        let adjusted = adjust_rect_edge_thickness(AppBarEdge::Bottom, queried, 1920, 48);
        assert_eq!(adjusted.left, 0);
        assert_eq!(adjusted.right, 1920);
        assert_eq!(adjusted.bottom, 1040);
        assert_eq!(adjusted.top, 1040 - 48);
    }

    #[test]
    #[cfg(windows)]
    fn test_adjust_edge_thickness_left() {
        let queried = RECT {
            left: 10,
            top: 0,
            right: 1920,
            bottom: 1080,
        };
        let adjusted = adjust_rect_edge_thickness(AppBarEdge::Left, queried, 64, 1080);
        assert_eq!(adjusted.left, 10);
        assert_eq!(adjusted.right, 10 + 64);
        assert_eq!(adjusted.top, 0);
        assert_eq!(adjusted.bottom, 1080);
    }

    #[test]
    #[cfg(windows)]
    fn test_adjust_edge_thickness_right() {
        let queried = RECT {
            left: 0,
            top: 0,
            right: 1900,
            bottom: 1080,
        };
        let adjusted = adjust_rect_edge_thickness(AppBarEdge::Right, queried, 64, 1080);
        assert_eq!(adjusted.right, 1900);
        assert_eq!(adjusted.left, 1900 - 64);
        assert_eq!(adjusted.top, 0);
        assert_eq!(adjusted.bottom, 1080);
    }

    #[test]
    fn test_adjust_app_bar_thickness_cross_platform() {
        let queried = PhysicalPixelRect {
            x: 100,
            y: 50,
            width: 1820,
            height: 1000,
        };
        let top = adjust_app_bar_thickness(AppBarEdge::Top, queried, 1820, 40);
        assert_eq!(top.x, 100);
        assert_eq!(top.y, 50);
        assert_eq!(top.width, 1820);
        assert_eq!(top.height, 40);

        let bottom = adjust_app_bar_thickness(AppBarEdge::Bottom, queried, 1820, 40);
        assert_eq!(bottom.x, 100);
        assert_eq!(bottom.y, 1010);
        assert_eq!(bottom.height, 40);

        let left = adjust_app_bar_thickness(AppBarEdge::Left, queried, 50, 1000);
        assert_eq!(left.x, 100);
        assert_eq!(left.width, 50);

        let right = adjust_app_bar_thickness(AppBarEdge::Right, queried, 50, 1000);
        assert_eq!(right.x, 1870);
        assert_eq!(right.width, 50);
    }

    #[test]
    fn test_app_bar_poschanged_callback_handling() {
        let _guard = APP_BAR_TEST_LOCK.lock();
        let manager = AppBarManager::new().expect("manager creation");
        let spec = AppBarSpec {
            id: "test-callback-bar".to_string(),
            edge: AppBarEdge::Top,
            rect: PhysicalPixelRect {
                x: 0,
                y: 0,
                width: 1920,
                height: 40,
            },
            hwnd: None,
        };
        let approved = manager.register_or_update(spec).expect("registration");
        assert!(approved.height >= 0);

        let registered = manager.get_registered().expect("registered list");
        assert_eq!(registered.len(), 1);

        #[cfg(windows)]
        {
            let hwnd_raw = registered[0].hwnd;
            let hwnd = HWND(hwnd_raw as *mut _);

            // 1. Dispatch ABN_POSCHANGED through the window proc
            let res = dispatch_app_bar_window_msg_for_test(
                hwnd,
                WM_APPBAR_CALLBACK,
                WPARAM(ABN_POSCHANGED as usize),
                LPARAM(0),
            );
            assert_eq!(res.0, 0);

            let registered_after = manager.get_registered().expect("registered list");
            assert_eq!(registered_after.len(), 1);
            assert_eq!(registered_after[0].id, "test-callback-bar");
            assert!(registered_after[0].rect.height >= 0);

            // 2. Dispatch unhandled notification
            let unhandled = dispatch_app_bar_window_msg_for_test(
                hwnd,
                WM_APPBAR_CALLBACK,
                WPARAM(999),
                LPARAM(0),
            );
            assert_eq!(unhandled.0, 0);
        }

        let unreg = manager.unregister("test-callback-bar").expect("unregister");
        assert!(unreg);
        manager.dispose();
    }

    #[test]
    #[cfg(windows)]
    fn test_handle_pos_changed_logic_and_recursion_guard() {
        let mut ctx = WorkerContext {
            registrations: HashMap::new(),
            hwnd_to_id: HashMap::new(),
        };

        let dummy_hwnd = HWND(0x54321 as *mut _);
        let spec = AppBarSpec {
            id: "guard-bar".to_string(),
            edge: AppBarEdge::Top,
            rect: PhysicalPixelRect {
                x: 0,
                y: 0,
                width: 1920,
                height: 40,
            },
            hwnd: None,
        };

        // 1. Unknown HWND -> returns false
        assert!(!handle_pos_changed_internal(dummy_hwnd, &mut ctx));

        ctx.hwnd_to_id
            .insert(dummy_hwnd.0 as isize, "guard-bar".to_string());
        ctx.registrations.insert(
            "guard-bar".to_string(),
            InternalAppBarEntry {
                spec: spec.clone(),
                approved_rect: spec.rect,
                hwnd: dummy_hwnd.0 as isize,
                owned_window: false,
                registered_with_shell: false,
                is_repositioning: false,
            },
        );

        // 2. Not registered with shell -> returns false
        assert!(!handle_pos_changed_internal(dummy_hwnd, &mut ctx));

        // 3. Registered with shell but is_repositioning is true -> returns false (recursion guard)
        if let Some(entry) = ctx.registrations.get_mut("guard-bar") {
            entry.registered_with_shell = true;
            entry.is_repositioning = true;
        }
        assert!(!handle_pos_changed_internal(dummy_hwnd, &mut ctx));

        // 4. Registered with shell and not repositioning -> returns true and clears recursion guard
        if let Some(entry) = ctx.registrations.get_mut("guard-bar") {
            entry.is_repositioning = false;
        }
        let handled = handle_pos_changed_internal(dummy_hwnd, &mut ctx);
        assert!(handled);
        assert!(!ctx.registrations.get("guard-bar").unwrap().is_repositioning);
    }
}
