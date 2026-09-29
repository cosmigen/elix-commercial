//! Raw Windows monitor, DPI, foreground-window, and fullscreen observation.
//!
//! Geometry is always expressed in virtual-screen physical pixels. The observer owns one
//! message-loop thread, its WinEvent hooks, and its hidden top-level notification window.

use crate::error::{NativeError, NativeResult};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::mem::size_of;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread::{self, JoinHandle};
use std::time::{SystemTime, UNIX_EPOCH};
use windows::core::{BOOL, PCWSTR};
use windows::Win32::Devices::Display::{
    DisplayConfigGetDeviceInfo, GetDisplayConfigBufferSizes, QueryDisplayConfig,
    DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME, DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME,
    DISPLAYCONFIG_DEVICE_INFO_HEADER, DISPLAYCONFIG_MODE_INFO, DISPLAYCONFIG_PATH_INFO,
    DISPLAYCONFIG_SOURCE_DEVICE_NAME, DISPLAYCONFIG_TARGET_DEVICE_NAME, QDC_ONLY_ACTIVE_PATHS,
};
use windows::Win32::Foundation::{
    GetLastError, ERROR_INSUFFICIENT_BUFFER, ERROR_SUCCESS, HWND, LPARAM, LRESULT, RECT, WPARAM,
};
use windows::Win32::Graphics::Dwm::{
    DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS,
};
use windows::Win32::Graphics::Gdi::{
    EnumDisplayMonitors, GetMonitorInfoW, MonitorFromWindow, HDC, HMONITOR, MONITORINFO,
    MONITORINFOEXW, MONITOR_DEFAULTTONEAREST,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK};
use windows::Win32::UI::HiDpi::{
    GetDpiForMonitor, SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT,
    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, MDT_EFFECTIVE_DPI,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetClassNameW,
    GetDesktopWindow, GetForegroundWindow, GetMessageW, GetShellWindow, GetWindowLongPtrW,
    GetWindowRect, GetWindowThreadProcessId, IsIconic, IsWindowVisible, PostThreadMessageW,
    RegisterClassW, TranslateMessage, UnregisterClassW, CHILDID_SELF, EVENT_OBJECT_DESTROY,
    EVENT_OBJECT_HIDE, EVENT_OBJECT_LOCATIONCHANGE, EVENT_OBJECT_STATECHANGE,
    EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_MINIMIZEEND, EVENT_SYSTEM_MINIMIZESTART, GWL_EXSTYLE,
    GWL_STYLE, MONITORINFOF_PRIMARY, MSG, OBJID_WINDOW, WINDOW_EX_STYLE, WINDOW_STYLE,
    WINEVENT_OUTOFCONTEXT, WINEVENT_SKIPOWNPROCESS, WM_DEVICECHANGE, WM_DISPLAYCHANGE,
    WM_SETTINGCHANGE, WNDCLASSW, WS_CAPTION, WS_EX_TOOLWINDOW, WS_MAXIMIZE, WS_POPUP,
};

const WM_ELIX_CONTEXT_REFRESH: u32 = 0x8001;
const WM_ELIX_CONTEXT_STOP: u32 = 0x8002;
const REFRESH_FOREGROUND: usize = 1;
const REFRESH_GEOMETRY: usize = 2;
const REFRESH_TOPOLOGY: usize = 3;
const REFRESH_RUNTIME_FAILURE: usize = 4;
const FULLSCREEN_TOLERANCE_PIXELS: i32 = 2;
const WINDOW_CLASS: &[u16] = &[
    69, 76, 73, 88, 95, 87, 105, 110, 100, 111, 119, 115, 67, 111, 110, 116, 101, 120, 116, 0,
];

/// A rectangle in virtual-screen physical pixels.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PhysicalPixelRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl From<RECT> for PhysicalPixelRect {
    fn from(value: RECT) -> Self {
        Self {
            x: value.left,
            y: value.top,
            width: value.right - value.left,
            height: value.bottom - value.top,
        }
    }
}

/// Stable/best-effort identity and current physical geometry for one active monitor.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WindowsMonitor {
    pub id: String,
    pub device_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub friendly_name: Option<String>,
    pub bounds: PhysicalPixelRect,
    pub work_area: PhysicalPixelRect,
    pub dpi_x: u32,
    pub dpi_y: u32,
    pub scale_factor: f64,
    pub is_primary: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connector: Option<String>,
}

/// Transient context for the current foreground application window.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ForegroundWindowContext {
    pub native_id: String,
    pub process_id: u32,
    pub thread_id: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub monitor_id: Option<String>,
    pub bounds: PhysicalPixelRect,
    pub is_visible: bool,
    pub is_minimized: bool,
    pub is_cloaked: bool,
    pub is_tool_window: bool,
    pub is_shell_window: bool,
    pub is_fullscreen: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fullscreen_reason: Option<String>,
}

/// Complete raw context snapshot produced by one atomic capture.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WindowsContextSnapshot {
    pub revision: u64,
    pub monitors: Vec<WindowsMonitor>,
    pub primary_monitor_id: Option<String>,
    pub foreground: Option<ForegroundWindowContext>,
    pub captured_at: u64,
}

/// Reason assigned to a native context replacement.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum WindowsContextChangeReason {
    Initial,
    Topology,
    Dpi,
    WorkArea,
    Foreground,
    ForegroundGeometry,
    Fullscreen,
    Refresh,
}

/// Native context event delivered to the bridge.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WindowsContextChange {
    pub reason: WindowsContextChangeReason,
    pub snapshot: WindowsContextSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WindowsContextObserverStatus {
    pub observing: bool,
    pub thread_alive: bool,
}

#[derive(Clone)]
struct DisplayIdentity {
    stable_key: String,
    friendly_name: Option<String>,
    connector: Option<String>,
}

#[derive(Clone, Copy)]
struct RawMonitor {
    handle: HMONITOR,
    bounds: RECT,
    work_area: RECT,
    is_primary: bool,
    device_name: [u16; 32],
}

// HMONITOR is an opaque process-local value used only during one synchronous capture.
unsafe impl Send for RawMonitor {}

struct ContextState {
    capture_lock: Mutex<()>,
    snapshot: Mutex<Option<WindowsContextSnapshot>>,
    callback: Arc<dyn Fn(WindowsContextChange) + Send + Sync>,
    fault_callback: Arc<dyn Fn(NativeError) + Send + Sync>,
}

struct ObserverWorker {
    thread_id: u32,
    handle: JoinHandle<()>,
}

/// Owns the process-wide Windows context observer and its last known-good snapshot.
pub struct WindowsContextObserver {
    state: Arc<ContextState>,
    worker: Mutex<Option<ObserverWorker>>,
    fail_next_start: AtomicBool,
}

impl WindowsContextObserver {
    /// Creates an observer with isolated change and fault callbacks.
    pub fn new(
        callback: Arc<dyn Fn(WindowsContextChange) + Send + Sync>,
        fault_callback: Arc<dyn Fn(NativeError) + Send + Sync>,
    ) -> Self {
        Self {
            state: Arc::new(ContextState {
                capture_lock: Mutex::new(()),
                snapshot: Mutex::new(None),
                callback,
                fault_callback,
            }),
            worker: Mutex::new(None),
            fail_next_start: AtomicBool::new(false),
        }
    }

    /// Captures a complete snapshot without starting observation.
    pub fn get_snapshot(&self) -> NativeResult<WindowsContextSnapshot> {
        self.reap_finished_worker();
        if self.status().thread_alive {
            if let Some(snapshot) = self.state.snapshot.lock().clone() {
                return Ok(snapshot);
            }
        }
        let _capture = self.state.capture_lock.lock();
        let mut snapshot = capture_snapshot()?;
        snapshot.revision = self
            .state
            .snapshot
            .lock()
            .as_ref()
            .map(|current| current.revision + 1)
            .unwrap_or(1);
        *self.state.snapshot.lock() = Some(snapshot.clone());
        Ok(snapshot)
    }

    /// Starts the single observer thread and returns its initial authoritative snapshot.
    pub fn start(&self) -> NativeResult<(WindowsContextSnapshot, bool)> {
        self.reap_finished_worker();
        if let Some(worker) = self.worker.lock().as_ref() {
            if !worker.handle.is_finished() {
                let snapshot = self.state.snapshot.lock().clone().ok_or_else(|| {
                    NativeError::new(
                        "windows-context",
                        "OBSERVER_NOT_READY",
                        "Windows Context observer is running without an initial snapshot",
                    )
                })?;
                return Ok((snapshot, true));
            }
        }

        if self.fail_next_start.swap(false, Ordering::SeqCst) {
            return Err(NativeError::new(
                "windows-context",
                "OBSERVER_START_FAILED",
                "Injected Windows Context observer startup failure",
            ));
        }

        let state = Arc::clone(&self.state);
        let (ready_tx, ready_rx) =
            mpsc::sync_channel::<NativeResult<(u32, WindowsContextSnapshot)>>(1);
        let handle = thread::Builder::new()
            .name("elix-windows-context".to_string())
            .spawn(move || event_thread_entry(state, ready_tx))
            .map_err(|error| {
                NativeError::new(
                    "windows-context",
                    "OBSERVER_START_FAILED",
                    format!("Failed to spawn Windows Context event thread: {error}"),
                )
            })?;

        match ready_rx.recv() {
            Ok(Ok((thread_id, snapshot))) => {
                *self.worker.lock() = Some(ObserverWorker { thread_id, handle });
                Ok((snapshot, false))
            }
            Ok(Err(error)) => {
                let _ = handle.join();
                Err(error)
            }
            Err(_) => {
                let _ = handle.join();
                Err(NativeError::new(
                    "windows-context",
                    "OBSERVER_START_FAILED",
                    "Windows Context event thread ended before reporting startup readiness",
                ))
            }
        }
    }

    /// Captures and publishes one coherent refresh, serialized against observer captures.
    pub fn refresh(&self) -> NativeResult<WindowsContextSnapshot> {
        self.reap_finished_worker();
        refresh_state(&self.state, WindowsContextChangeReason::Refresh, true)
    }

    /// Stops observation, unhooks resources on their owning thread, and joins it.
    pub fn stop(&self) -> NativeResult<bool> {
        let worker = self.worker.lock().take();
        let Some(worker) = worker else {
            return Ok(false);
        };
        if !worker.handle.is_finished() {
            unsafe {
                let _ = PostThreadMessageW(
                    worker.thread_id,
                    WM_ELIX_CONTEXT_STOP,
                    WPARAM(0),
                    LPARAM(0),
                );
            }
        }
        worker.handle.join().map_err(|_| {
            NativeError::new(
                "windows-context",
                "OBSERVER_JOIN_FAILED",
                "Windows Context event thread panicked during shutdown",
            )
        })?;
        Ok(true)
    }

    /// Reports observer intent and whether the worker remains alive.
    pub fn status(&self) -> WindowsContextObserverStatus {
        let worker = self.worker.lock();
        WindowsContextObserverStatus {
            observing: worker.is_some(),
            thread_alive: worker
                .as_ref()
                .map(|worker| !worker.handle.is_finished())
                .unwrap_or(false),
        }
    }

    /// Makes the next start fail before any native resource is installed.
    pub fn fail_next_start_for_test(&self) {
        self.fail_next_start.store(true, Ordering::SeqCst);
    }

    /// Ends a running observer through its ordinary runtime-fault path.
    pub fn fail_runtime_for_test(&self) -> NativeResult<()> {
        let worker = self.worker.lock();
        let worker = worker.as_ref().ok_or_else(|| {
            NativeError::new(
                "windows-context",
                "OBSERVER_NOT_RUNNING",
                "Windows Context observer is not running",
            )
        })?;
        unsafe {
            PostThreadMessageW(
                worker.thread_id,
                WM_ELIX_CONTEXT_REFRESH,
                WPARAM(REFRESH_RUNTIME_FAILURE),
                LPARAM(0),
            )
            .map_err(|error| {
                NativeError::from_windows_error(error, "Failed to inject observer runtime failure")
            })
        }
    }

    fn reap_finished_worker(&self) {
        let finished = self
            .worker
            .lock()
            .as_ref()
            .map(|worker| worker.handle.is_finished())
            .unwrap_or(false);
        if finished {
            if let Some(worker) = self.worker.lock().take() {
                let _ = worker.handle.join();
            }
        }
    }
}

impl Drop for WindowsContextObserver {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

fn event_thread_entry(
    state: Arc<ContextState>,
    ready_tx: mpsc::SyncSender<NativeResult<(u32, WindowsContextSnapshot)>>,
) {
    let ready_sent = Arc::new(AtomicBool::new(false));
    let ready_marker = Arc::clone(&ready_sent);
    let result = catch_unwind(AssertUnwindSafe(|| {
        run_event_thread(&state, &ready_tx, &ready_marker)
    }));
    match result {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            if !ready_sent.load(Ordering::SeqCst) {
                let _ = ready_tx.send(Err(error));
            } else {
                invoke_fault_callback(&state, error);
            }
        }
        Err(_) => {
            let error = NativeError::new(
                "windows-context",
                "OBSERVER_THREAD_PANIC",
                "Windows Context event thread panicked",
            );
            if !ready_sent.load(Ordering::SeqCst) {
                let _ = ready_tx.send(Err(error));
            } else {
                invoke_fault_callback(&state, error);
            }
        }
    }
}

fn run_event_thread(
    state: &Arc<ContextState>,
    ready_tx: &mpsc::SyncSender<NativeResult<(u32, WindowsContextSnapshot)>>,
    ready_sent: &AtomicBool,
) -> NativeResult<()> {
    let _dpi = ThreadDpiAwareness::per_monitor_v2()?;
    let thread_id = unsafe { GetCurrentThreadId() };
    let window = NotificationWindow::create()?;
    let hooks = WinEventHooks::install()?;

    let snapshot = refresh_state(state, WindowsContextChangeReason::Initial, true)?;
    ready_tx.send(Ok((thread_id, snapshot))).map_err(|_| {
        NativeError::new(
            "windows-context",
            "OBSERVER_START_CANCELLED",
            "Windows Context observer owner disappeared during startup",
        )
    })?;
    ready_sent.store(true, Ordering::SeqCst);

    let mut message = MSG::default();
    loop {
        let result = unsafe { GetMessageW(&mut message, None, 0, 0) };
        if result.0 == -1 {
            return Err(NativeError::from_win32(
                unsafe { GetLastError().0 },
                "Windows Context message loop failed",
            ));
        }
        if result.0 == 0 || message.message == WM_ELIX_CONTEXT_STOP {
            break;
        }
        if message.message == WM_ELIX_CONTEXT_REFRESH {
            let hint = match message.wParam.0 {
                REFRESH_FOREGROUND => WindowsContextChangeReason::Foreground,
                REFRESH_GEOMETRY => WindowsContextChangeReason::ForegroundGeometry,
                REFRESH_TOPOLOGY => WindowsContextChangeReason::Topology,
                REFRESH_RUNTIME_FAILURE => {
                    return Err(NativeError::new(
                        "windows-context",
                        "OBSERVER_RUNTIME_FAILED",
                        "Injected Windows Context observer runtime failure",
                    ));
                }
                _ => WindowsContextChangeReason::Refresh,
            };
            if let Err(error) = refresh_state(state, hint, false) {
                invoke_fault_callback(state, error);
            }
            continue;
        }
        unsafe {
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }

    drop(hooks);
    drop(window);
    Ok(())
}

fn refresh_state(
    state: &ContextState,
    hint: WindowsContextChangeReason,
    force: bool,
) -> NativeResult<WindowsContextSnapshot> {
    let _capture = state.capture_lock.lock();
    let mut candidate = capture_snapshot()?;
    let (reason, should_publish) = {
        let mut current = state.snapshot.lock();
        let next_revision = current
            .as_ref()
            .map(|snapshot| snapshot.revision + 1)
            .unwrap_or(1);
        candidate.revision = next_revision;
        let reason = current
            .as_ref()
            .map(|previous| classify_change(previous, &candidate, hint))
            .unwrap_or(WindowsContextChangeReason::Initial);
        let changed = current
            .as_ref()
            .map(|previous| !snapshot_content_equal(previous, &candidate))
            .unwrap_or(true);
        if changed || force {
            *current = Some(candidate.clone());
            (reason, true)
        } else {
            return Ok(current.clone().expect("snapshot exists after comparison"));
        }
    };

    if should_publish {
        invoke_change_callback(
            state,
            WindowsContextChange {
                reason,
                snapshot: candidate.clone(),
            },
        );
    }
    Ok(candidate)
}

fn snapshot_content_equal(a: &WindowsContextSnapshot, b: &WindowsContextSnapshot) -> bool {
    a.monitors == b.monitors
        && a.primary_monitor_id == b.primary_monitor_id
        && a.foreground == b.foreground
}

fn classify_change(
    previous: &WindowsContextSnapshot,
    next: &WindowsContextSnapshot,
    hint: WindowsContextChangeReason,
) -> WindowsContextChangeReason {
    if previous.monitors != next.monitors || previous.primary_monitor_id != next.primary_monitor_id
    {
        if monitor_identity_and_geometry(previous) != monitor_identity_and_geometry(next) {
            return WindowsContextChangeReason::Topology;
        }
        if previous
            .monitors
            .iter()
            .zip(&next.monitors)
            .any(|(a, b)| a.dpi_x != b.dpi_x || a.dpi_y != b.dpi_y)
        {
            return WindowsContextChangeReason::Dpi;
        }
        return WindowsContextChangeReason::WorkArea;
    }
    match (&previous.foreground, &next.foreground) {
        (Some(a), Some(b)) if a.native_id == b.native_id => {
            if a.is_fullscreen != b.is_fullscreen {
                WindowsContextChangeReason::Fullscreen
            } else if a.bounds != b.bounds || a.monitor_id != b.monitor_id {
                WindowsContextChangeReason::ForegroundGeometry
            } else {
                hint
            }
        }
        (None, None) => hint,
        _ => WindowsContextChangeReason::Foreground,
    }
}

fn monitor_identity_and_geometry(
    snapshot: &WindowsContextSnapshot,
) -> Vec<(&str, PhysicalPixelRect, bool)> {
    snapshot
        .monitors
        .iter()
        .map(|monitor| (monitor.id.as_str(), monitor.bounds, monitor.is_primary))
        .collect()
}

fn capture_snapshot() -> NativeResult<WindowsContextSnapshot> {
    let _dpi = ThreadDpiAwareness::per_monitor_v2()?;
    let raw_monitors = enumerate_raw_monitors()?;
    let identities = query_display_identities()?;
    let mut handles_by_id = Vec::with_capacity(raw_monitors.len());
    let mut monitors = Vec::with_capacity(raw_monitors.len());

    for raw in raw_monitors {
        let device_name = wide_to_string(&raw.device_name);
        let identity = identities.get(&device_name.to_lowercase()).ok_or_else(|| {
            NativeError::new(
                "windows-context",
                "DISPLAY_IDENTITY_MISSING",
                format!("DisplayConfig did not identify active monitor {device_name}"),
            )
        })?;
        let mut dpi_x = 0;
        let mut dpi_y = 0;
        unsafe {
            GetDpiForMonitor(raw.handle, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y).map_err(
                |error| {
                    NativeError::from_windows_error(error, "Failed to query effective monitor DPI")
                },
            )?;
        }
        if dpi_x == 0 || dpi_y == 0 {
            return Err(NativeError::new(
                "windows-context",
                "INVALID_MONITOR_DPI",
                format!("Monitor {device_name} returned zero DPI"),
            ));
        }
        let id = stable_monitor_id(&identity.stable_key);
        handles_by_id.push((raw.handle, id.clone()));
        monitors.push(WindowsMonitor {
            id,
            device_name,
            friendly_name: identity.friendly_name.clone(),
            bounds: raw.bounds.into(),
            work_area: raw.work_area.into(),
            dpi_x,
            dpi_y,
            scale_factor: dpi_x as f64 / 96.0,
            is_primary: raw.is_primary,
            connector: identity.connector.clone(),
        });
    }

    monitors.sort_by(|a, b| a.id.cmp(&b.id));
    let primary_monitor_id = monitors
        .iter()
        .find(|monitor| monitor.is_primary)
        .map(|monitor| monitor.id.clone());
    let foreground = query_foreground(&monitors, &handles_by_id)?;

    Ok(WindowsContextSnapshot {
        revision: 0,
        monitors,
        primary_monitor_id,
        foreground,
        captured_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0),
    })
}

fn enumerate_raw_monitors() -> NativeResult<Vec<RawMonitor>> {
    unsafe extern "system" fn callback(
        monitor: HMONITOR,
        _hdc: HDC,
        _rect: *mut RECT,
        data: LPARAM,
    ) -> BOOL {
        let monitors = &mut *(data.0 as *mut Vec<RawMonitor>);
        let mut info = MONITORINFOEXW::default();
        info.monitorInfo.cbSize = size_of::<MONITORINFOEXW>() as u32;
        if GetMonitorInfoW(
            monitor,
            &mut info as *mut MONITORINFOEXW as *mut MONITORINFO,
        )
        .as_bool()
        {
            monitors.push(RawMonitor {
                handle: monitor,
                bounds: info.monitorInfo.rcMonitor,
                work_area: info.monitorInfo.rcWork,
                is_primary: info.monitorInfo.dwFlags & MONITORINFOF_PRIMARY != 0,
                device_name: info.szDevice,
            });
            BOOL(1)
        } else {
            BOOL(0)
        }
    }

    let mut monitors = Vec::<RawMonitor>::new();
    let ok = unsafe {
        EnumDisplayMonitors(
            None,
            None,
            Some(callback),
            LPARAM((&mut monitors as *mut Vec<RawMonitor>) as isize),
        )
    };
    if !ok.as_bool() {
        return Err(NativeError::from_win32(
            unsafe { GetLastError().0 },
            "Failed to enumerate active monitors",
        ));
    }
    if monitors.is_empty() {
        return Err(NativeError::new(
            "windows-context",
            "NO_ACTIVE_MONITORS",
            "Windows returned no active monitors",
        ));
    }
    Ok(monitors)
}

fn query_display_identities() -> NativeResult<HashMap<String, DisplayIdentity>> {
    for _ in 0..3 {
        let mut path_count = 0;
        let mut mode_count = 0;
        let size_result = unsafe {
            GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &mut path_count, &mut mode_count)
        };
        if size_result != ERROR_SUCCESS {
            return Err(NativeError::from_win32(
                size_result.0,
                "Failed to size active DisplayConfig topology",
            ));
        }
        let mut paths = vec![DISPLAYCONFIG_PATH_INFO::default(); path_count as usize];
        let mut modes = vec![DISPLAYCONFIG_MODE_INFO::default(); mode_count as usize];
        let query_result = unsafe {
            QueryDisplayConfig(
                QDC_ONLY_ACTIVE_PATHS,
                &mut path_count,
                paths.as_mut_ptr(),
                &mut mode_count,
                modes.as_mut_ptr(),
                None,
            )
        };
        if query_result == ERROR_INSUFFICIENT_BUFFER {
            continue;
        }
        if query_result != ERROR_SUCCESS {
            return Err(NativeError::from_win32(
                query_result.0,
                "Failed to query active DisplayConfig topology",
            ));
        }
        paths.truncate(path_count as usize);
        let mut result = HashMap::new();
        for path in paths {
            let mut source = DISPLAYCONFIG_SOURCE_DEVICE_NAME {
                header: DISPLAYCONFIG_DEVICE_INFO_HEADER {
                    r#type: DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME,
                    size: size_of::<DISPLAYCONFIG_SOURCE_DEVICE_NAME>() as u32,
                    adapterId: path.sourceInfo.adapterId,
                    id: path.sourceInfo.id,
                },
                ..Default::default()
            };
            let source_result = unsafe { DisplayConfigGetDeviceInfo(&mut source.header) };
            if source_result != 0 {
                return Err(NativeError::from_win32(
                    source_result as u32,
                    "Failed to query DisplayConfig source name",
                ));
            }

            let mut target = DISPLAYCONFIG_TARGET_DEVICE_NAME {
                header: DISPLAYCONFIG_DEVICE_INFO_HEADER {
                    r#type: DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME,
                    size: size_of::<DISPLAYCONFIG_TARGET_DEVICE_NAME>() as u32,
                    adapterId: path.targetInfo.adapterId,
                    id: path.targetInfo.id,
                },
                ..Default::default()
            };
            let target_result = unsafe { DisplayConfigGetDeviceInfo(&mut target.header) };
            if target_result != 0 {
                return Err(NativeError::from_win32(
                    target_result as u32,
                    "Failed to query DisplayConfig target identity",
                ));
            }

            let device_name = wide_to_string(&source.viewGdiDeviceName);
            let device_path = wide_to_string(&target.monitorDevicePath);
            let stable_key = if !device_path.is_empty() {
                device_path.to_lowercase()
            } else {
                format!(
                    "luid:{:08x}:{:08x}:target:{}:edid:{:04x}:{:04x}:connector:{}",
                    path.targetInfo.adapterId.HighPart as u32,
                    path.targetInfo.adapterId.LowPart,
                    path.targetInfo.id,
                    target.edidManufactureId,
                    target.edidProductCodeId,
                    target.connectorInstance,
                )
            };
            let friendly_name = non_empty(wide_to_string(&target.monitorFriendlyDeviceName));
            result.insert(
                device_name.to_lowercase(),
                DisplayIdentity {
                    stable_key,
                    friendly_name,
                    connector: Some(format!("{}", target.outputTechnology.0)),
                },
            );
        }
        return Ok(result);
    }
    Err(NativeError::new(
        "windows-context",
        "DISPLAY_TOPOLOGY_UNSTABLE",
        "Active DisplayConfig topology changed repeatedly during capture",
    ))
}

fn query_foreground(
    monitors: &[WindowsMonitor],
    handles_by_id: &[(HMONITOR, String)],
) -> NativeResult<Option<ForegroundWindowContext>> {
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.0.is_null() {
        return Ok(None);
    }
    let visible = unsafe { IsWindowVisible(hwnd).as_bool() };
    let minimized = unsafe { IsIconic(hwnd).as_bool() };
    let shell = is_shell_window(hwnd);
    let ex_style = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) } as u32;
    let style = unsafe { GetWindowLongPtrW(hwnd, GWL_STYLE) } as u32;
    let tool = ex_style & WS_EX_TOOLWINDOW.0 != 0;
    let mut cloaked = 0u32;
    let cloak_result = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            &mut cloaked as *mut u32 as *mut _,
            size_of::<u32>() as u32,
        )
    };
    if cloak_result.is_err() {
        cloaked = 0;
    }
    if !is_foreground_candidate(visible, minimized, cloaked != 0, tool, shell) {
        return Ok(None);
    }

    let mut bounds = RECT::default();
    if unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut bounds as *mut RECT as *mut _,
            size_of::<RECT>() as u32,
        )
    }
    .is_err()
    {
        unsafe { GetWindowRect(hwnd, &mut bounds) }.map_err(|error| {
            NativeError::from_windows_error(error, "Failed to query foreground window bounds")
        })?;
    }

    let monitor_handle = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
    let monitor_id = handles_by_id
        .iter()
        .find(|(handle, _)| *handle == monitor_handle)
        .map(|(_, id)| id.clone());
    let monitor = monitor_id
        .as_ref()
        .and_then(|id| monitors.iter().find(|monitor| &monitor.id == id));
    let physical_bounds = PhysicalPixelRect::from(bounds);
    let (is_fullscreen, fullscreen_reason) = monitor
        .map(|monitor| classify_fullscreen(physical_bounds, monitor, style))
        .unwrap_or((false, None));
    let mut process_id = 0;
    let thread_id = unsafe { GetWindowThreadProcessId(hwnd, Some(&mut process_id)) };

    Ok(Some(ForegroundWindowContext {
        native_id: format!("hwnd:{:x}", hwnd.0 as usize),
        process_id,
        thread_id,
        monitor_id,
        bounds: physical_bounds,
        is_visible: visible,
        is_minimized: minimized,
        is_cloaked: cloaked != 0,
        is_tool_window: tool,
        is_shell_window: shell,
        is_fullscreen,
        fullscreen_reason,
    }))
}

fn is_foreground_candidate(
    visible: bool,
    minimized: bool,
    cloaked: bool,
    tool: bool,
    shell: bool,
) -> bool {
    visible && !minimized && !cloaked && !tool && !shell
}

fn is_shell_window(hwnd: HWND) -> bool {
    if hwnd == unsafe { GetShellWindow() } || hwnd == unsafe { GetDesktopWindow() } {
        return true;
    }
    let mut class_name = [0u16; 64];
    let length = unsafe { GetClassNameW(hwnd, &mut class_name) };
    if length <= 0 {
        return false;
    }
    matches!(
        wide_to_string(&class_name).as_str(),
        "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd"
    )
}

fn classify_fullscreen(
    bounds: PhysicalPixelRect,
    monitor: &WindowsMonitor,
    style: u32,
) -> (bool, Option<String>) {
    let covers_monitor = rect_matches(bounds, monitor.bounds, FULLSCREEN_TOLERANCE_PIXELS);
    if !covers_monitor {
        return (false, None);
    }
    let matches_work_area = rect_matches(bounds, monitor.work_area, FULLSCREEN_TOLERANCE_PIXELS);
    let is_maximized = style & WS_MAXIMIZE.0 != 0;
    let is_popup = style & WS_POPUP.0 != 0;
    let has_caption = style & WS_CAPTION.0 != 0;
    if is_maximized && has_caption && !is_popup && matches_work_area {
        return (false, Some("maximized-work-area".to_string()));
    }
    if is_maximized && has_caption && !is_popup {
        return (false, Some("maximized-framed".to_string()));
    }
    (
        true,
        Some(
            if is_popup {
                "monitor-covering-popup"
            } else if !has_caption {
                "monitor-covering-borderless"
            } else {
                "monitor-covering"
            }
            .to_string(),
        ),
    )
}

fn rect_matches(a: PhysicalPixelRect, b: PhysicalPixelRect, tolerance: i32) -> bool {
    (a.x - b.x).abs() <= tolerance
        && (a.y - b.y).abs() <= tolerance
        && (a.width - b.width).abs() <= tolerance
        && (a.height - b.height).abs() <= tolerance
}

fn stable_monitor_id(key: &str) -> String {
    let digest = Sha256::digest(key.as_bytes());
    format!("monitor:{:x}", digest)[..40].to_string()
}

fn wide_to_string(buffer: &[u16]) -> String {
    let length = buffer
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(buffer.len());
    String::from_utf16_lossy(&buffer[..length])
}

fn non_empty(value: String) -> Option<String> {
    (!value.is_empty()).then_some(value)
}

fn invoke_change_callback(state: &ContextState, event: WindowsContextChange) {
    let callback = Arc::clone(&state.callback);
    let _ = catch_unwind(AssertUnwindSafe(|| callback(event)));
}

fn invoke_fault_callback(state: &ContextState, error: NativeError) {
    let callback = Arc::clone(&state.fault_callback);
    let _ = catch_unwind(AssertUnwindSafe(|| callback(error)));
}

struct ThreadDpiAwareness {
    previous: DPI_AWARENESS_CONTEXT,
}

impl ThreadDpiAwareness {
    fn per_monitor_v2() -> NativeResult<Self> {
        let previous =
            unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
        if previous.0.is_null() {
            return Err(NativeError::from_win32(
                unsafe { GetLastError().0 },
                "Failed to enter per-monitor-v2 DPI awareness",
            ));
        }
        Ok(Self { previous })
    }
}

impl Drop for ThreadDpiAwareness {
    fn drop(&mut self) {
        unsafe {
            let _ = SetThreadDpiAwarenessContext(self.previous);
        }
    }
}

struct WinEventHooks(Vec<HWINEVENTHOOK>);

impl WinEventHooks {
    fn install() -> NativeResult<Self> {
        let flags = WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS;
        let specs = [
            (EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND),
            (EVENT_SYSTEM_MINIMIZESTART, EVENT_SYSTEM_MINIMIZEEND),
            (EVENT_OBJECT_DESTROY, EVENT_OBJECT_HIDE),
            (EVENT_OBJECT_STATECHANGE, EVENT_OBJECT_STATECHANGE),
            (EVENT_OBJECT_LOCATIONCHANGE, EVENT_OBJECT_LOCATIONCHANGE),
        ];
        let mut hooks = Vec::new();
        for (minimum, maximum) in specs {
            let hook = unsafe {
                SetWinEventHook(
                    minimum,
                    maximum,
                    None,
                    Some(win_event_callback),
                    0,
                    0,
                    flags,
                )
            };
            if hook.0.is_null() {
                drop(Self(hooks));
                return Err(NativeError::from_win32(
                    unsafe { GetLastError().0 },
                    "Failed to install Windows Context WinEvent hook",
                ));
            }
            hooks.push(hook);
        }
        Ok(Self(hooks))
    }
}

impl Drop for WinEventHooks {
    fn drop(&mut self) {
        for hook in self.0.drain(..) {
            unsafe {
                let _ = UnhookWinEvent(hook);
            }
        }
    }
}

unsafe extern "system" fn win_event_callback(
    _hook: HWINEVENTHOOK,
    event: u32,
    hwnd: HWND,
    object_id: i32,
    child_id: i32,
    _event_thread: u32,
    _event_time: u32,
) {
    let foreground = GetForegroundWindow();
    let foreground_change = event == EVENT_SYSTEM_FOREGROUND;
    let relevant_window_event =
        hwnd == foreground && object_id == OBJID_WINDOW.0 && child_id == CHILDID_SELF as i32;
    if !foreground_change && !relevant_window_event {
        return;
    }
    let reason = if foreground_change {
        REFRESH_FOREGROUND
    } else {
        REFRESH_GEOMETRY
    };
    let _ = PostThreadMessageW(
        GetCurrentThreadId(),
        WM_ELIX_CONTEXT_REFRESH,
        WPARAM(reason),
        LPARAM(0),
    );
}

struct NotificationWindow {
    hwnd: HWND,
    instance: windows::Win32::Foundation::HINSTANCE,
}

impl NotificationWindow {
    fn create() -> NativeResult<Self> {
        let module = unsafe { GetModuleHandleW(None) }.map_err(|error| {
            NativeError::from_windows_error(error, "Failed to get native host module handle")
        })?;
        let instance = windows::Win32::Foundation::HINSTANCE(module.0);
        let class = WNDCLASSW {
            lpfnWndProc: Some(notification_window_proc),
            hInstance: instance,
            lpszClassName: PCWSTR(WINDOW_CLASS.as_ptr()),
            ..Default::default()
        };
        let atom = unsafe { RegisterClassW(&class) };
        if atom == 0 {
            return Err(NativeError::from_win32(
                unsafe { GetLastError().0 },
                "Failed to register Windows Context notification window class",
            ));
        }
        let hwnd = unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE(0),
                PCWSTR(WINDOW_CLASS.as_ptr()),
                PCWSTR(WINDOW_CLASS.as_ptr()),
                WINDOW_STYLE(0),
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
        .map_err(|error| {
            let _ = unsafe { UnregisterClassW(PCWSTR(WINDOW_CLASS.as_ptr()), Some(instance)) };
            NativeError::from_windows_error(
                error,
                "Failed to create Windows Context notification window",
            )
        })?;
        Ok(Self { hwnd, instance })
    }
}

impl Drop for NotificationWindow {
    fn drop(&mut self) {
        unsafe {
            let _ = DestroyWindow(self.hwnd);
            let _ = UnregisterClassW(PCWSTR(WINDOW_CLASS.as_ptr()), Some(self.instance));
        }
    }
}

unsafe extern "system" fn notification_window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if message == WM_DISPLAYCHANGE || message == WM_SETTINGCHANGE || message == WM_DEVICECHANGE {
        let _ = PostThreadMessageW(
            GetCurrentThreadId(),
            WM_ELIX_CONTEXT_REFRESH,
            WPARAM(REFRESH_TOPOLOGY),
            LPARAM(0),
        );
    }
    unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn monitor(bounds: PhysicalPixelRect, work_area: PhysicalPixelRect) -> WindowsMonitor {
        WindowsMonitor {
            id: "monitor:test".to_string(),
            device_name: r"\\.\DISPLAY1".to_string(),
            friendly_name: None,
            bounds,
            work_area,
            dpi_x: 144,
            dpi_y: 144,
            scale_factor: 1.5,
            is_primary: true,
            connector: None,
        }
    }

    #[test]
    fn rect_conversion_preserves_negative_virtual_coordinates() {
        let rect = PhysicalPixelRect::from(RECT {
            left: -1920,
            top: -200,
            right: 0,
            bottom: 880,
        });
        assert_eq!(rect.x, -1920);
        assert_eq!(rect.y, -200);
        assert_eq!(rect.width, 1920);
        assert_eq!(rect.height, 1080);
    }

    #[test]
    fn stable_id_is_deterministic_and_not_the_gdi_name() {
        let first = stable_monitor_id("monitor-device-path#a");
        let second = stable_monitor_id("monitor-device-path#a");
        assert_eq!(first, second);
        assert!(first.starts_with("monitor:"));
        assert_ne!(first, r"\\.\DISPLAY1");
    }

    #[test]
    fn fullscreen_classifier_rejects_maximized_work_area() {
        let display = monitor(
            PhysicalPixelRect {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
            },
            PhysicalPixelRect {
                x: 0,
                y: 0,
                width: 1920,
                height: 1040,
            },
        );
        assert!(!classify_fullscreen(display.work_area, &display, WS_MAXIMIZE.0 | WS_CAPTION.0).0);
        assert!(classify_fullscreen(display.bounds, &display, WS_POPUP.0).0);
        assert!(classify_fullscreen(display.bounds, &display, 0).0);
    }

    #[test]
    fn fullscreen_classifier_applies_small_pixel_tolerance() {
        let display = monitor(
            PhysicalPixelRect {
                x: -1920,
                y: 0,
                width: 1920,
                height: 1080,
            },
            PhysicalPixelRect {
                x: -1920,
                y: 0,
                width: 1920,
                height: 1040,
            },
        );
        let near = PhysicalPixelRect {
            x: -1919,
            y: 1,
            width: 1918,
            height: 1078,
        };
        let far = PhysicalPixelRect {
            x: -1916,
            y: 0,
            width: 1916,
            height: 1080,
        };
        assert!(classify_fullscreen(near, &display, WS_POPUP.0).0);
        assert!(!classify_fullscreen(far, &display, WS_POPUP.0).0);
    }

    #[test]
    fn foreground_candidate_filters_non_application_windows() {
        assert!(is_foreground_candidate(true, false, false, false, false));
        assert!(!is_foreground_candidate(false, false, false, false, false));
        assert!(!is_foreground_candidate(true, true, false, false, false));
        assert!(!is_foreground_candidate(true, false, true, false, false));
        assert!(!is_foreground_candidate(true, false, false, true, false));
        assert!(!is_foreground_candidate(true, false, false, false, true));
    }

    #[test]
    fn change_classifier_distinguishes_topology_dpi_and_foreground() {
        let base_monitor = monitor(
            PhysicalPixelRect {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
            },
            PhysicalPixelRect {
                x: 0,
                y: 0,
                width: 1920,
                height: 1040,
            },
        );
        let base = WindowsContextSnapshot {
            revision: 1,
            monitors: vec![base_monitor.clone()],
            primary_monitor_id: Some(base_monitor.id.clone()),
            foreground: None,
            captured_at: 1,
        };
        let mut dpi = base.clone();
        dpi.monitors[0].dpi_x = 120;
        assert_eq!(
            classify_change(&base, &dpi, WindowsContextChangeReason::Topology),
            WindowsContextChangeReason::Dpi
        );
        let mut topology = base.clone();
        topology.monitors[0].bounds.x = -1920;
        assert_eq!(
            classify_change(&base, &topology, WindowsContextChangeReason::Topology),
            WindowsContextChangeReason::Topology
        );
    }

    #[test]
    fn live_snapshot_has_one_primary_real_dpi_and_stable_ids() {
        let first = capture_snapshot().expect("live Windows Context snapshot");
        let second = capture_snapshot().expect("second live Windows Context snapshot");
        assert!(!first.monitors.is_empty());
        assert_eq!(
            first
                .monitors
                .iter()
                .filter(|monitor| monitor.is_primary)
                .count(),
            1
        );
        assert_eq!(
            first.primary_monitor_id,
            first
                .monitors
                .iter()
                .find(|monitor| monitor.is_primary)
                .map(|monitor| monitor.id.clone())
        );
        assert_eq!(
            first
                .monitors
                .iter()
                .map(|monitor| &monitor.id)
                .collect::<Vec<_>>(),
            second
                .monitors
                .iter()
                .map(|monitor| &monitor.id)
                .collect::<Vec<_>>()
        );
        for monitor in &first.monitors {
            assert!(monitor.bounds.width > 0 && monitor.bounds.height > 0);
            assert!(monitor.work_area.width > 0 && monitor.work_area.height > 0);
            assert!(monitor.dpi_x > 0 && monitor.dpi_y > 0);
            assert!((monitor.scale_factor - monitor.dpi_x as f64 / 96.0).abs() < f64::EPSILON);
        }
        if let Some(foreground) = first.foreground {
            assert!(foreground.is_visible);
            assert!(!foreground.is_minimized);
            assert!(!foreground.is_cloaked);
            assert!(!foreground.is_tool_window);
            assert!(!foreground.is_shell_window);
            assert!(foreground.monitor_id.is_some());
        }
    }

    #[test]
    fn live_primary_monitor_physical_geometry_matches_current_display_mode() {
        use windows::Win32::Graphics::Gdi::{
            EnumDisplaySettingsW, DEVMODEW, ENUM_CURRENT_SETTINGS,
        };
        use windows::Win32::UI::HiDpi::{
            GetAwarenessFromDpiAwarenessContext, GetThreadDpiAwarenessContext,
        };

        let thread_ctx = unsafe { GetThreadDpiAwarenessContext() };
        let initial_awareness = unsafe { GetAwarenessFromDpiAwarenessContext(thread_ctx) };

        let snapshot = capture_snapshot().expect("live Windows Context snapshot");
        let primary = snapshot
            .monitors
            .iter()
            .find(|monitor| monitor.is_primary)
            .expect("primary monitor");

        let device_wide: Vec<u16> = primary.device_name.encode_utf16().chain(Some(0)).collect();
        let mut mode = DEVMODEW {
            dmSize: size_of::<DEVMODEW>() as u16,
            ..Default::default()
        };
        let ok = unsafe {
            EnumDisplaySettingsW(
                PCWSTR(device_wide.as_ptr()),
                ENUM_CURRENT_SETTINGS,
                &mut mode,
            )
        };
        assert!(
            ok.as_bool(),
            "EnumDisplaySettingsW failed for primary monitor"
        );
        println!(
            "DIAGNOSTIC: Initial thread DPI awareness: {:?}, Display mode: {}x{}, Primary bounds: {}x{}, scale: {}",
            initial_awareness,
            mode.dmPelsWidth,
            mode.dmPelsHeight,
            primary.bounds.width,
            primary.bounds.height,
            primary.scale_factor
        );
        assert_eq!(
            primary.bounds.width, mode.dmPelsWidth as i32,
            "Primary monitor width must match physical display mode resolution"
        );
        assert_eq!(
            primary.bounds.height, mode.dmPelsHeight as i32,
            "Primary monitor height must match physical display mode resolution"
        );
        assert!(
            primary.work_area.width <= primary.bounds.width,
            "Work area width cannot exceed physical bounds width"
        );
        assert!(
            primary.work_area.height <= primary.bounds.height,
            "Work area height cannot exceed physical bounds height"
        );
    }

    #[test]
    fn live_observer_starts_once_contains_callback_panics_and_stops_quiescently() {
        let changes = Arc::new(AtomicUsize::new(0));
        let changes_for_callback = Arc::clone(&changes);
        let observer = WindowsContextObserver::new(
            Arc::new(move |_| {
                changes_for_callback.fetch_add(1, Ordering::SeqCst);
                panic!("injected listener failure");
            }),
            Arc::new(|_| {}),
        );
        let (_, duplicate) = observer.start().expect("observer start");
        assert!(!duplicate);
        let (_, duplicate) = observer.start().expect("duplicate observer start");
        assert!(duplicate);
        assert_eq!(
            observer.status(),
            WindowsContextObserverStatus {
                observing: true,
                thread_alive: true,
            }
        );
        assert!(changes.load(Ordering::SeqCst) >= 1);
        assert!(observer.stop().expect("observer stop"));
        assert!(!observer.stop().expect("idempotent observer stop"));
        assert_eq!(
            observer.status(),
            WindowsContextObserverStatus {
                observing: false,
                thread_alive: false,
            }
        );
    }

    #[test]
    fn observer_startup_failure_registers_no_worker() {
        let observer = WindowsContextObserver::new(Arc::new(|_| {}), Arc::new(|_| {}));
        observer.fail_next_start_for_test();
        assert_eq!(observer.start().unwrap_err().code, "OBSERVER_START_FAILED");
        assert!(!observer.status().observing);
    }

    #[test]
    #[ignore = "requires an interactive Windows desktop"]
    fn interactive_foreground_geometry_maximize_and_fullscreen_acceptance() {
        use std::time::{Duration, Instant};
        use windows::Win32::UI::WindowsAndMessaging::{
            PeekMessageW, SetForegroundWindow, SetWindowLongPtrW, SetWindowPos, ShowWindow,
            PM_REMOVE, SWP_FRAMECHANGED, SW_MAXIMIZE, SW_RESTORE, SW_SHOW, WS_OVERLAPPEDWINDOW,
        };

        fn pump(duration: Duration) {
            let deadline = Instant::now() + duration;
            while Instant::now() < deadline {
                let mut message = MSG::default();
                while unsafe { PeekMessageW(&mut message, None, 0, 0, PM_REMOVE).as_bool() } {
                    unsafe {
                        let _ = TranslateMessage(&message);
                        DispatchMessageW(&message);
                    }
                }
                thread::sleep(Duration::from_millis(10));
            }
        }

        unsafe extern "system" fn acceptance_window_proc(
            hwnd: HWND,
            message: u32,
            wparam: WPARAM,
            lparam: LPARAM,
        ) -> LRESULT {
            unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
        }

        let class_name: Vec<u16> = "ELIX_WindowsContextAcceptance\0".encode_utf16().collect();
        let title_one: Vec<u16> = "ELIX Context Acceptance One\0".encode_utf16().collect();
        let title_two: Vec<u16> = "ELIX Context Acceptance Two\0".encode_utf16().collect();
        let module = unsafe { GetModuleHandleW(None) }.expect("module handle");
        let instance = windows::Win32::Foundation::HINSTANCE(module.0);
        let class = WNDCLASSW {
            lpfnWndProc: Some(acceptance_window_proc),
            hInstance: instance,
            lpszClassName: PCWSTR(class_name.as_ptr()),
            ..Default::default()
        };
        assert_ne!(unsafe { RegisterClassW(&class) }, 0);
        let create = |title: &[u16], x: i32| unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE(0),
                PCWSTR(class_name.as_ptr()),
                PCWSTR(title.as_ptr()),
                WS_OVERLAPPEDWINDOW,
                x,
                100,
                800,
                600,
                None,
                None,
                Some(instance),
                None,
            )
            .expect("acceptance window")
        };
        let first_window = create(&title_one, 100);
        let second_window = create(&title_two, 300);

        let run = || -> NativeResult<()> {
            unsafe {
                let _ = ShowWindow(first_window, SW_SHOW);
                let _ = ShowWindow(second_window, SW_SHOW);
                let _ = SetForegroundWindow(first_window);
            }
            pump(Duration::from_millis(150));
            let snapshot = capture_snapshot()?;
            let raw = enumerate_raw_monitors()?;
            let handles_by_id = raw
                .iter()
                .filter_map(|item| {
                    let device_name = wide_to_string(&item.device_name);
                    snapshot
                        .monitors
                        .iter()
                        .find(|monitor| monitor.device_name == device_name)
                        .map(|monitor| (item.handle, monitor.id.clone()))
                })
                .collect::<Vec<_>>();
            let first = query_foreground(&snapshot.monitors, &handles_by_id)?
                .expect("first acceptance window is foreground");
            assert_eq!(
                first.native_id,
                format!("hwnd:{:x}", first_window.0 as usize)
            );

            unsafe {
                SetWindowPos(first_window, None, 140, 160, 900, 650, Default::default())?;
            }
            pump(Duration::from_millis(100));
            let moved = query_foreground(&snapshot.monitors, &handles_by_id)?
                .expect("moved acceptance window is foreground");
            assert_ne!(moved.bounds, first.bounds);

            unsafe {
                let _ = ShowWindow(first_window, SW_MAXIMIZE);
            }
            pump(Duration::from_millis(150));
            let maximized = query_foreground(&snapshot.monitors, &handles_by_id)?
                .expect("maximized acceptance window is foreground");
            assert!(!maximized.is_fullscreen);

            let monitor = snapshot
                .monitors
                .iter()
                .find(|monitor| Some(&monitor.id) == maximized.monitor_id.as_ref())
                .expect("foreground monitor");
            unsafe {
                let _ = ShowWindow(first_window, SW_RESTORE);
                SetWindowLongPtrW(first_window, GWL_STYLE, WS_POPUP.0 as isize);
                SetWindowPos(
                    first_window,
                    None,
                    monitor.bounds.x,
                    monitor.bounds.y,
                    monitor.bounds.width,
                    monitor.bounds.height,
                    SWP_FRAMECHANGED,
                )?;
                let _ = ShowWindow(first_window, SW_SHOW);
                let _ = SetForegroundWindow(first_window);
            }
            pump(Duration::from_millis(150));
            let fullscreen = query_foreground(&snapshot.monitors, &handles_by_id)?
                .expect("borderless acceptance window is foreground");
            assert!(fullscreen.is_fullscreen);

            unsafe {
                let _ = SetForegroundWindow(second_window);
            }
            pump(Duration::from_millis(150));
            let second = query_foreground(&snapshot.monitors, &handles_by_id)?
                .expect("second acceptance window is foreground");
            assert_eq!(
                second.native_id,
                format!("hwnd:{:x}", second_window.0 as usize)
            );
            Ok(())
        };

        let result = run();
        unsafe {
            let _ = DestroyWindow(first_window);
            let _ = DestroyWindow(second_window);
            let _ = UnregisterClassW(PCWSTR(class_name.as_ptr()), Some(instance));
        }
        result.expect("interactive Windows Context acceptance");
    }
}
