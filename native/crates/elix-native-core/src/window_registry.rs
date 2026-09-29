//! Real top-level Windows window enumeration, WinEvent observation, and snapshot capture.
//!
//! Geometry is always expressed in virtual-screen physical pixels. The observer owns one
//! message-loop thread, its WinEvent hooks, its process metadata cache, and delivers push
//! change events to the native bridge client.

use crate::error::{NativeError, NativeResult};
use crate::windows_context::PhysicalPixelRect;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::mem::size_of;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use windows::core::{BOOL, PCWSTR};
use windows::Win32::Foundation::{GetLastError, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Dwm::{
    DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS,
};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITORINFOEXW, MONITOR_DEFAULTTONEAREST,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::{
    GetCurrentThreadId, GetProcessTimes, OpenProcess, QueryFullProcessImageNameW,
    PROCESS_NAME_FORMAT, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK};
use windows::Win32::UI::HiDpi::{
    SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows::Win32::UI::Input::KeyboardAndMouse::IsWindowEnabled;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, EnumWindows, GetAncestor,
    GetClassNameW, GetDesktopWindow, GetForegroundWindow, GetMessageW, GetWindowLongPtrW,
    GetWindowPlacement, GetWindowRect, GetWindowTextW, GetWindowThreadProcessId, IsIconic,
    IsWindow, IsWindowVisible, IsZoomed, PostThreadMessageW, RegisterClassW, TranslateMessage,
    CHILDID_SELF, EVENT_OBJECT_CREATE, EVENT_OBJECT_DESTROY, EVENT_OBJECT_HIDE,
    EVENT_OBJECT_LOCATIONCHANGE, EVENT_OBJECT_NAMECHANGE, EVENT_OBJECT_STATECHANGE,
    EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_MINIMIZEEND, EVENT_SYSTEM_MINIMIZESTART, GA_ROOT,
    GWL_EXSTYLE, GWL_STYLE, MSG, OBJID_WINDOW, WINDOWPLACEMENT, WINDOW_EX_STYLE, WINDOW_STYLE,
    WINEVENT_OUTOFCONTEXT, WNDCLASSW, WS_CHILD, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW, WS_MAXIMIZE,
};

const WM_ELIX_WINDOW_REFRESH: u32 = 0x8010;
const WM_ELIX_WINDOW_STOP: u32 = 0x8011;
const WM_ELIX_WINDOW_EVENT: u32 = 0x8012;
const REFRESH_RUNTIME_FAILURE: usize = 99;
const REFRESH_WAIT_TIMEOUT: Duration = Duration::from_secs(5);

const WINDOW_CLASS: &[u16] = &[
    69, 76, 73, 88, 95, 87, 105, 110, 100, 111, 119, 82, 101, 103, 105, 115, 116, 114, 121, 0,
];

/// Raw description of one discovered top-level Windows window.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativeRawWindow {
    pub hwnd: isize,
    pub process_id: u32,
    pub thread_id: u32,
    pub process_creation_time: u64,
    pub executable_path: Option<String>,
    pub executable_name: Option<String>,
    pub package_full_name: Option<String>,
    pub aumid: Option<String>,
    pub title: String,
    pub class_name: String,
    pub bounds: PhysicalPixelRect,
    pub is_visible: bool,
    pub is_minimized: bool,
    pub is_maximized: bool,
    pub is_cloaked: bool,
    pub is_tool_window: bool,
    pub is_shell_window: bool,
    pub is_enabled: bool,
    pub is_foreground: bool,
    pub monitor_device_name: Option<String>,
}

/// Point-in-time snapshot of all active top-level Windows windows.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativeWindowRegistrySnapshot {
    pub revision: u64,
    pub windows: Vec<NativeRawWindow>,
    pub foreground_hwnd: Option<isize>,
    pub captured_at: u64,
}

/// Change notification event emitted by the native window registry observer.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativeWindowRegistryChange {
    pub reason: String,
    pub snapshot: NativeWindowRegistrySnapshot,
    pub window: Option<NativeRawWindow>,
    pub destroyed_hwnd: Option<isize>,
    pub foreground_hwnd: Option<isize>,
}

/// Operational status of the window registry observer thread.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeWindowRegistryStatus {
    pub observing: bool,
    pub thread_alive: bool,
}

#[derive(Clone, Default)]
struct ProcessMeta {
    creation_time: u64,
    executable_path: Option<String>,
    executable_name: Option<String>,
    package_full_name: Option<String>,
    aumid: Option<String>,
}

struct RegistryState {
    capture_lock: Mutex<()>,
    snapshot: Mutex<Option<NativeWindowRegistrySnapshot>>,
    refresh_completed: AtomicU64,
    callback: Arc<dyn Fn(NativeWindowRegistryChange) + Send + Sync>,
    fault_callback: Arc<dyn Fn(NativeError) + Send + Sync>,
}

struct ObserverWorker {
    thread_id: u32,
    handle: JoinHandle<()>,
}

/// Owns the process-wide Window Registry observer thread and state synchronization.
pub struct WindowRegistryObserver {
    state: Arc<RegistryState>,
    worker: Mutex<Option<ObserverWorker>>,
    fail_next_start: AtomicBool,
    next_refresh_request: AtomicU64,
}

impl WindowRegistryObserver {
    /// Creates a new observer with isolated change and fault callbacks.
    pub fn new(
        callback: Arc<dyn Fn(NativeWindowRegistryChange) + Send + Sync>,
        fault_callback: Arc<dyn Fn(NativeError) + Send + Sync>,
    ) -> Self {
        Self {
            state: Arc::new(RegistryState {
                capture_lock: Mutex::new(()),
                snapshot: Mutex::new(None),
                refresh_completed: AtomicU64::new(0),
                callback,
                fault_callback,
            }),
            worker: Mutex::new(None),
            fail_next_start: AtomicBool::new(false),
            next_refresh_request: AtomicU64::new(1),
        }
    }

    /// Captures a complete snapshot without starting continuous observation.
    pub fn get_snapshot(&self) -> NativeResult<NativeWindowRegistrySnapshot> {
        self.reap_finished_worker();
        if self.status().thread_alive {
            if let Some(snapshot) = self.state.snapshot.lock().clone() {
                return Ok(snapshot);
            }
        }
        let _capture = self.state.capture_lock.lock();
        let mut cache = HashMap::new();
        let windows = enumerate_top_level_windows(&mut cache);
        let foreground_hwnd = query_foreground_hwnd();
        let revision = self
            .state
            .snapshot
            .lock()
            .as_ref()
            .map(|c| c.revision + 1)
            .unwrap_or(1);
        let snapshot = NativeWindowRegistrySnapshot {
            revision,
            windows,
            foreground_hwnd,
            captured_at: now_ms(),
        };
        *self.state.snapshot.lock() = Some(snapshot.clone());
        Ok(snapshot)
    }

    /// Starts the background observer thread and returns its initial snapshot.
    pub fn start(&self) -> NativeResult<(NativeWindowRegistrySnapshot, bool)> {
        self.reap_finished_worker();
        if let Some(worker) = self.worker.lock().as_ref() {
            if !worker.handle.is_finished() {
                let snapshot = self.state.snapshot.lock().clone().ok_or_else(|| {
                    NativeError::new(
                        "window-registry",
                        "OBSERVER_NOT_READY",
                        "Window Registry observer is running without an initial snapshot",
                    )
                })?;
                return Ok((snapshot, true));
            }
        }

        if self.fail_next_start.swap(false, Ordering::SeqCst) {
            return Err(NativeError::new(
                "window-registry",
                "OBSERVER_START_FAILED",
                "Injected Window Registry observer startup failure",
            ));
        }

        let state = Arc::clone(&self.state);
        let (ready_tx, ready_rx) =
            mpsc::sync_channel::<NativeResult<(u32, NativeWindowRegistrySnapshot)>>(1);
        let handle = thread::Builder::new()
            .name("elix-window-registry".to_string())
            .spawn(move || event_thread_entry(state, ready_tx))
            .map_err(|error| {
                NativeError::new(
                    "window-registry",
                    "OBSERVER_START_FAILED",
                    format!("Failed to spawn Window Registry event thread: {error}"),
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
                    "window-registry",
                    "OBSERVER_START_FAILED",
                    "Window Registry event thread ended before reporting startup readiness",
                ))
            }
        }
    }

    /// Forces a complete re-enumeration and updates the snapshot.
    pub fn refresh(&self) -> NativeResult<NativeWindowRegistrySnapshot> {
        self.reap_finished_worker();

        let active_thread_id = {
            let worker = self.worker.lock();
            worker
                .as_ref()
                .filter(|worker| !worker.handle.is_finished())
                .map(|worker| worker.thread_id)
        };

        if let Some(thread_id) = active_thread_id {
            // A live observer owns the authoritative tracked_windows/process_cache state. Route
            // refresh through that same message-loop thread so the returned snapshot and the
            // observer's future event state cannot diverge.
            let request_id = self.next_refresh_request.fetch_add(1, Ordering::SeqCst);
            let posted = unsafe {
                PostThreadMessageW(
                    thread_id,
                    WM_ELIX_WINDOW_REFRESH,
                    WPARAM(0),
                    LPARAM(request_id as isize),
                )
            };
            if let Err(_err) = posted {
                return Err(NativeError::from_win32(
                    unsafe { GetLastError().0 },
                    "Failed to post Window Registry refresh request",
                ));
            }

            let deadline = Instant::now() + REFRESH_WAIT_TIMEOUT;
            loop {
                if self.state.refresh_completed.load(Ordering::SeqCst) >= request_id {
                    return self.state.snapshot.lock().clone().ok_or_else(|| {
                        NativeError::new(
                            "window-registry",
                            "REFRESH_NO_SNAPSHOT",
                            "Window Registry refresh completed without a snapshot",
                        )
                    });
                }

                if Instant::now() >= deadline {
                    return Err(NativeError::new(
                        "window-registry",
                        "REFRESH_TIMEOUT",
                        "Timed out waiting for Window Registry observer refresh",
                    ));
                }

                if !self.status().thread_alive {
                    return Err(NativeError::new(
                        "window-registry",
                        "OBSERVER_RUNTIME_FAILED",
                        "Window Registry observer ended while refresh was pending",
                    ));
                }

                thread::sleep(Duration::from_millis(2));
            }
        }

        // No live observer exists, so an isolated point-in-time re-enumeration is safe.
        let _capture = self.state.capture_lock.lock();
        let mut cache = HashMap::new();
        let windows = enumerate_top_level_windows(&mut cache);
        let foreground_hwnd = query_foreground_hwnd();
        let revision = self
            .state
            .snapshot
            .lock()
            .as_ref()
            .map(|c| c.revision + 1)
            .unwrap_or(1);
        let snapshot = NativeWindowRegistrySnapshot {
            revision,
            windows,
            foreground_hwnd,
            captured_at: now_ms(),
        };
        *self.state.snapshot.lock() = Some(snapshot.clone());
        invoke_change_callback(
            &self.state,
            NativeWindowRegistryChange {
                reason: "refresh".to_string(),
                snapshot: snapshot.clone(),
                window: None,
                destroyed_hwnd: None,
                foreground_hwnd,
            },
        );
        Ok(snapshot)
    }

    /// Stops the observer thread cleanly and releases WinEvent hooks.
    pub fn stop(&self) -> NativeResult<bool> {
        let worker = self.worker.lock().take();
        let Some(worker) = worker else {
            return Ok(false);
        };
        if !worker.handle.is_finished() {
            unsafe {
                let _ =
                    PostThreadMessageW(worker.thread_id, WM_ELIX_WINDOW_STOP, WPARAM(0), LPARAM(0));
            }
        }
        worker.handle.join().map_err(|_| {
            NativeError::new(
                "window-registry",
                "OBSERVER_STOP_FAILED",
                "Window Registry event thread panicked while stopping",
            )
        })?;
        *self.state.snapshot.lock() = None;
        Ok(true)
    }

    /// Returns the current thread status.
    pub fn status(&self) -> NativeWindowRegistryStatus {
        let worker = self.worker.lock();
        let thread_alive = worker
            .as_ref()
            .map(|w| !w.handle.is_finished())
            .unwrap_or(false);
        NativeWindowRegistryStatus {
            observing: thread_alive && self.state.snapshot.lock().is_some(),
            thread_alive,
        }
    }

    /// Injects a startup failure for test coverage.
    pub fn fail_next_start_for_test(&self) {
        self.fail_next_start.store(true, Ordering::SeqCst);
    }

    /// Injects a runtime fault for supervisor recovery testing.
    pub fn fail_runtime_for_test(&self) -> NativeResult<()> {
        let worker = self.worker.lock();
        let Some(worker) = worker.as_ref() else {
            return Err(NativeError::new(
                "window-registry",
                "OBSERVER_NOT_RUNNING",
                "Cannot inject runtime failure when Window Registry observer is not running",
            ));
        };
        let ok = unsafe {
            PostThreadMessageW(
                worker.thread_id,
                WM_ELIX_WINDOW_REFRESH,
                WPARAM(REFRESH_RUNTIME_FAILURE),
                LPARAM(0),
            )
        };
        if let Err(_err) = ok {
            return Err(NativeError::from_win32(
                unsafe { GetLastError().0 },
                "Failed to post test runtime failure message",
            ));
        }
        Ok(())
    }

    fn reap_finished_worker(&self) {
        let mut worker = self.worker.lock();
        if let Some(active) = worker.as_ref() {
            if active.handle.is_finished() {
                let _ = worker.take();
            }
        }
    }
}

fn event_thread_entry(
    state: Arc<RegistryState>,
    ready_tx: mpsc::SyncSender<NativeResult<(u32, NativeWindowRegistrySnapshot)>>,
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
                "window-registry",
                "OBSERVER_THREAD_PANIC",
                "Window Registry event thread panicked",
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
    state: &Arc<RegistryState>,
    ready_tx: &mpsc::SyncSender<NativeResult<(u32, NativeWindowRegistrySnapshot)>>,
    ready_sent: &AtomicBool,
) -> NativeResult<()> {
    let _dpi = ThreadDpiAwareness::per_monitor_v2()?;
    let thread_id = unsafe { GetCurrentThreadId() };
    let _window = NotificationWindow::create()?;
    let _hooks = WinEventHooks::install()?;

    let mut process_cache: HashMap<u32, ProcessMeta> = HashMap::new();
    let mut tracked_windows: HashMap<isize, NativeRawWindow> = HashMap::new();

    // Initial enumeration
    let enumerated = enumerate_top_level_windows(&mut process_cache);
    for w in &enumerated {
        tracked_windows.insert(w.hwnd, w.clone());
    }
    let foreground_hwnd = query_foreground_hwnd();

    let initial_snapshot = NativeWindowRegistrySnapshot {
        revision: 1,
        windows: enumerated,
        foreground_hwnd,
        captured_at: now_ms(),
    };
    *state.snapshot.lock() = Some(initial_snapshot.clone());

    ready_tx
        .send(Ok((thread_id, initial_snapshot)))
        .map_err(|_| {
            NativeError::new(
                "window-registry",
                "OBSERVER_START_CANCELLED",
                "Window Registry observer owner disappeared during startup",
            )
        })?;
    ready_sent.store(true, Ordering::SeqCst);

    let mut message = MSG::default();
    loop {
        let result = unsafe { GetMessageW(&mut message, None, 0, 0) };
        if result.0 == -1 {
            return Err(NativeError::from_win32(
                unsafe { GetLastError().0 },
                "Window Registry message loop failed",
            ));
        }
        if result.0 == 0 || message.message == WM_ELIX_WINDOW_STOP {
            break;
        }

        if message.message == WM_ELIX_WINDOW_REFRESH {
            if message.wParam.0 == REFRESH_RUNTIME_FAILURE {
                return Err(NativeError::new(
                    "window-registry",
                    "OBSERVER_RUNTIME_FAILED",
                    "Injected Window Registry observer runtime failure",
                ));
            }
            // Full refresh requested on the observer thread so tracked_windows and process_cache
            // remain coherent with the published snapshot.
            process_cache.clear();
            let windows = enumerate_top_level_windows(&mut process_cache);
            tracked_windows.clear();
            for w in &windows {
                tracked_windows.insert(w.hwnd, w.clone());
            }
            let fg = query_foreground_hwnd();
            let revision = state
                .snapshot
                .lock()
                .as_ref()
                .map(|s| s.revision + 1)
                .unwrap_or(1);
            let snapshot = NativeWindowRegistrySnapshot {
                revision,
                windows,
                foreground_hwnd: fg,
                captured_at: now_ms(),
            };
            *state.snapshot.lock() = Some(snapshot.clone());
            invoke_change_callback(
                state,
                NativeWindowRegistryChange {
                    reason: "refresh".to_string(),
                    snapshot,
                    window: None,
                    destroyed_hwnd: None,
                    foreground_hwnd: fg,
                },
            );
            let request_id = message.lParam.0 as u64;
            if request_id != 0 {
                state.refresh_completed.store(request_id, Ordering::SeqCst);
            }
            continue;
        }

        if message.message == WM_ELIX_WINDOW_EVENT {
            let event = message.wParam.0 as u32;
            let hwnd_val = message.lParam.0;
            let hwnd = HWND(hwnd_val as *mut std::ffi::c_void);

            handle_single_window_event(
                event,
                hwnd,
                hwnd_val,
                &mut process_cache,
                &mut tracked_windows,
                state,
            );
            if process_cache.len() > 512 {
                let active_pids: std::collections::HashSet<u32> =
                    tracked_windows.values().map(|w| w.process_id).collect();
                process_cache.retain(|pid, _| active_pids.contains(pid));
            }
            continue;
        }

        unsafe {
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }

    Ok(())
}

fn handle_single_window_event(
    event: u32,
    hwnd: HWND,
    hwnd_val: isize,
    process_cache: &mut HashMap<u32, ProcessMeta>,
    tracked_windows: &mut HashMap<isize, NativeRawWindow>,
    state: &Arc<RegistryState>,
) {
    if event == EVENT_SYSTEM_FOREGROUND {
        let current_fg = query_foreground_hwnd();
        if let Some(fg_hwnd) = current_fg {
            if let std::collections::hash_map::Entry::Vacant(e) = tracked_windows.entry(fg_hwnd) {
                if let Some(inspected) = inspect_window(HWND(fg_hwnd as *mut _), process_cache) {
                    e.insert(inspected);
                }
            }
        }
        let mut changed = false;

        // Update foreground flag on tracked windows
        for (h, win) in tracked_windows.iter_mut() {
            let should_be_fg = Some(*h) == current_fg;
            if win.is_foreground != should_be_fg {
                win.is_foreground = should_be_fg;
                changed = true;
            }
        }

        let old_fg = state
            .snapshot
            .lock()
            .as_ref()
            .and_then(|s| s.foreground_hwnd);
        if changed || old_fg != current_fg {
            let revision = state
                .snapshot
                .lock()
                .as_ref()
                .map(|s| s.revision + 1)
                .unwrap_or(1);
            let snapshot = NativeWindowRegistrySnapshot {
                revision,
                windows: tracked_windows.values().cloned().collect(),
                foreground_hwnd: current_fg,
                captured_at: now_ms(),
            };
            *state.snapshot.lock() = Some(snapshot.clone());
            let fg_window = current_fg.and_then(|fg| tracked_windows.get(&fg)).cloned();
            invoke_change_callback(
                state,
                NativeWindowRegistryChange {
                    reason: "foreground".to_string(),
                    snapshot,
                    window: fg_window,
                    destroyed_hwnd: None,
                    foreground_hwnd: current_fg,
                },
            );
        }
        return;
    }

    if event == EVENT_OBJECT_DESTROY {
        if let Some(_removed) = tracked_windows.remove(&hwnd_val) {
            let fg = query_foreground_hwnd();
            let revision = state
                .snapshot
                .lock()
                .as_ref()
                .map(|s| s.revision + 1)
                .unwrap_or(1);
            let snapshot = NativeWindowRegistrySnapshot {
                revision,
                windows: tracked_windows.values().cloned().collect(),
                foreground_hwnd: fg,
                captured_at: now_ms(),
            };
            *state.snapshot.lock() = Some(snapshot.clone());
            invoke_change_callback(
                state,
                NativeWindowRegistryChange {
                    reason: "destroyed".to_string(),
                    snapshot,
                    window: None,
                    destroyed_hwnd: Some(hwnd_val),
                    foreground_hwnd: fg,
                },
            );
        }
        return;
    }

    // Inspect window state
    let inspected = inspect_window(hwnd, process_cache);
    match inspected {
        None => {
            // Window is no longer valid or destroyed
            if let Some(_removed) = tracked_windows.remove(&hwnd_val) {
                let fg = query_foreground_hwnd();
                let revision = state
                    .snapshot
                    .lock()
                    .as_ref()
                    .map(|s| s.revision + 1)
                    .unwrap_or(1);
                let snapshot = NativeWindowRegistrySnapshot {
                    revision,
                    windows: tracked_windows.values().cloned().collect(),
                    foreground_hwnd: fg,
                    captured_at: now_ms(),
                };
                *state.snapshot.lock() = Some(snapshot.clone());
                invoke_change_callback(
                    state,
                    NativeWindowRegistryChange {
                        reason: "destroyed".to_string(),
                        snapshot,
                        window: None,
                        destroyed_hwnd: Some(hwnd_val),
                        foreground_hwnd: fg,
                    },
                );
            }
        }
        Some(mut new_window) => {
            let existing = tracked_windows.get(&hwnd_val);
            match existing {
                None => {
                    // New window discovered
                    tracked_windows.insert(hwnd_val, new_window.clone());
                    let fg = query_foreground_hwnd();
                    let revision = state
                        .snapshot
                        .lock()
                        .as_ref()
                        .map(|s| s.revision + 1)
                        .unwrap_or(1);
                    let snapshot = NativeWindowRegistrySnapshot {
                        revision,
                        windows: tracked_windows.values().cloned().collect(),
                        foreground_hwnd: fg,
                        captured_at: now_ms(),
                    };
                    *state.snapshot.lock() = Some(snapshot.clone());
                    invoke_change_callback(
                        state,
                        NativeWindowRegistryChange {
                            reason: "created".to_string(),
                            snapshot,
                            window: Some(new_window),
                            destroyed_hwnd: None,
                            foreground_hwnd: fg,
                        },
                    );
                }
                Some(old_window) => {
                    // If window transitioned to minimized, preserve old restored bounds
                    // to prevent DWM shadow frame margin discrepancies between
                    // DwmGetWindowAttribute and GetWindowPlacement
                    if new_window.is_minimized && !old_window.is_minimized {
                        new_window.bounds = old_window.bounds;
                    }

                    // Compare fields for deduplication and specific transition reasons
                    if old_window == &new_window {
                        // Exactly identical; suppress duplicate event
                        return;
                    }

                    let reason = if old_window.title != new_window.title {
                        "title"
                    } else if old_window.is_minimized != new_window.is_minimized
                        || old_window.is_maximized != new_window.is_maximized
                        || old_window.is_visible != new_window.is_visible
                        || old_window.is_cloaked != new_window.is_cloaked
                        || old_window.is_enabled != new_window.is_enabled
                    {
                        "state"
                    } else if old_window.bounds != new_window.bounds
                        || old_window.monitor_device_name != new_window.monitor_device_name
                    {
                        "bounds"
                    } else if old_window.is_foreground != new_window.is_foreground {
                        "foreground"
                    } else {
                        "changed"
                    };

                    tracked_windows.insert(hwnd_val, new_window.clone());
                    let fg = query_foreground_hwnd();
                    let revision = state
                        .snapshot
                        .lock()
                        .as_ref()
                        .map(|s| s.revision + 1)
                        .unwrap_or(1);
                    let snapshot = NativeWindowRegistrySnapshot {
                        revision,
                        windows: tracked_windows.values().cloned().collect(),
                        foreground_hwnd: fg,
                        captured_at: now_ms(),
                    };
                    *state.snapshot.lock() = Some(snapshot.clone());
                    invoke_change_callback(
                        state,
                        NativeWindowRegistryChange {
                            reason: reason.to_string(),
                            snapshot,
                            window: Some(new_window),
                            destroyed_hwnd: None,
                            foreground_hwnd: fg,
                        },
                    );
                }
            }
        }
    }
}

fn query_foreground_hwnd() -> Option<isize> {
    let fg = unsafe { GetForegroundWindow() };
    if fg.0.is_null() {
        None
    } else {
        Some(fg.0 as isize)
    }
}

unsafe extern "system" fn enum_windows_callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let list = unsafe { &mut *(lparam.0 as *mut Vec<HWND>) };
    list.push(hwnd);
    BOOL(1)
}

fn enumerate_top_level_windows(cache: &mut HashMap<u32, ProcessMeta>) -> Vec<NativeRawWindow> {
    // Ensure thread has a desktop connection by creating a temporary notification window if needed
    let _win = NotificationWindow::create().ok();
    let mut hwnds = Vec::<HWND>::new();
    let _ = unsafe {
        EnumWindows(
            Some(enum_windows_callback),
            LPARAM((&mut hwnds as *mut Vec<HWND>) as isize),
        )
    };
    let mut windows = Vec::new();
    for hwnd in hwnds {
        if let Some(w) = inspect_window(hwnd, cache) {
            windows.push(w);
        }
    }
    windows
}

fn inspect_window(hwnd: HWND, cache: &mut HashMap<u32, ProcessMeta>) -> Option<NativeRawWindow> {
    if hwnd.0.is_null() || !unsafe { IsWindow(Some(hwnd)).as_bool() } {
        return None;
    }

    let root = unsafe { GetAncestor(hwnd, GA_ROOT) };
    if root != hwnd {
        return None;
    }

    let style = unsafe { GetWindowLongPtrW(hwnd, GWL_STYLE) as u32 };
    if style & WS_CHILD.0 != 0 {
        return None;
    }

    if hwnd == unsafe { GetDesktopWindow() } {
        return None;
    }

    let ex_style = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32 };
    let is_visible = unsafe { IsWindowVisible(hwnd).as_bool() };
    let is_minimized = unsafe { IsIconic(hwnd).as_bool() };
    let is_maximized = (style & WS_MAXIMIZE.0 != 0) || unsafe { IsZoomed(hwnd).as_bool() };
    let is_enabled = unsafe { IsWindowEnabled(hwnd).as_bool() };

    let mut cloaked: u32 = 0;
    let _ = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            &mut cloaked as *mut _ as *mut _,
            size_of::<u32>() as u32,
        )
    };
    let is_cloaked = cloaked != 0;

    let mut process_id = 0u32;
    let thread_id = unsafe { GetWindowThreadProcessId(hwnd, Some(&mut process_id)) };
    if thread_id == 0 || process_id == 0 {
        return None;
    }

    let is_foreground = unsafe { GetForegroundWindow() == hwnd };

    let mut rect = RECT::default();
    let hr = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut rect as *mut _ as *mut _,
            size_of::<RECT>() as u32,
        )
    };
    if hr.is_err() {
        let _ = unsafe { GetWindowRect(hwnd, &mut rect) };
    }
    if is_minimized || rect.left <= -30000 || rect.top <= -30000 {
        let mut placement = WINDOWPLACEMENT {
            length: size_of::<WINDOWPLACEMENT>() as u32,
            ..Default::default()
        };
        if unsafe { GetWindowPlacement(hwnd, &mut placement).is_ok() } {
            rect = placement.rcNormalPosition;
        }
    }
    let bounds = PhysicalPixelRect::from(rect);

    let mut class_buf = [0u16; 256];
    let class_len = unsafe { GetClassNameW(hwnd, &mut class_buf) };
    let class_name = if class_len > 0 {
        wide_to_string(&class_buf[..class_len as usize])
    } else {
        String::new()
    };
    if class_name.starts_with("ELIX_") && class_name != "ELIX_SURFACE_WINDOW_CLASS" {
        return None;
    }

    let mut title_buf = [0u16; 512];
    let title_len = unsafe { GetWindowTextW(hwnd, &mut title_buf) };
    let title = if title_len > 0 {
        wide_to_string(&title_buf[..title_len as usize])
    } else {
        String::new()
    };

    let is_tool_window =
        (ex_style & WS_EX_TOOLWINDOW.0 != 0) && (ex_style & WS_EX_APPWINDOW.0 == 0);
    let is_shell_window = class_name == "Shell_TrayWnd"
        || class_name == "Shell_SecondaryTrayWnd"
        || class_name == "Progman"
        || class_name == "WorkerW";

    let monitor_handle = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
    let mut monitor_info = MONITORINFOEXW::default();
    monitor_info.monitorInfo.cbSize = size_of::<MONITORINFOEXW>() as u32;
    let monitor_device_name = if unsafe {
        GetMonitorInfoW(
            monitor_handle,
            &mut monitor_info as *mut _ as *mut MONITORINFO,
        )
        .as_bool()
    } {
        Some(wide_to_string(&monitor_info.szDevice))
    } else {
        None
    };

    let meta = query_process_info(process_id, cache);

    Some(NativeRawWindow {
        hwnd: hwnd.0 as isize,
        process_id,
        thread_id,
        process_creation_time: meta.creation_time,
        executable_path: meta.executable_path,
        executable_name: meta.executable_name,
        package_full_name: meta.package_full_name,
        aumid: meta.aumid,
        title,
        class_name,
        bounds,
        is_visible,
        is_minimized,
        is_maximized,
        is_cloaked,
        is_tool_window,
        is_shell_window,
        is_enabled,
        is_foreground,
        monitor_device_name,
    })
}

fn query_process_info(pid: u32, cache: &mut HashMap<u32, ProcessMeta>) -> ProcessMeta {
    if pid == 0 {
        return ProcessMeta::default();
    }

    let handle_res = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) };
    let Ok(handle) = handle_res else {
        return cache.get(&pid).cloned().unwrap_or_default();
    };

    let mut creation = windows::Win32::Foundation::FILETIME::default();
    let mut exit = windows::Win32::Foundation::FILETIME::default();
    let mut kernel = windows::Win32::Foundation::FILETIME::default();
    let mut user = windows::Win32::Foundation::FILETIME::default();
    let creation_time = if unsafe {
        GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user).is_ok()
    } {
        (creation.dwLowDateTime as u64) | ((creation.dwHighDateTime as u64) << 32)
    } else {
        0
    };

    if creation_time > 0 {
        if let Some(cached) = cache.get(&pid) {
            if cached.creation_time == creation_time {
                let _ = unsafe { windows::Win32::Foundation::CloseHandle(handle) };
                return cached.clone();
            }
        }
    }

    let mut path_buf = [0u16; 1024];
    let mut path_len = path_buf.len() as u32;
    let (exec_path, exec_name) = if unsafe {
        QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_FORMAT(0),
            windows::core::PWSTR(path_buf.as_mut_ptr()),
            &mut path_len,
        )
        .is_ok()
    } && path_len > 0
    {
        let full_path = wide_to_string(&path_buf[..path_len as usize]);
        let canonical = crate::runtime::paths::normalize_canonical_path(&full_path);
        let name = std::path::Path::new(&canonical)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        (Some(canonical), Some(name))
    } else {
        (None, None)
    };

    let (pkg_name, aumid) = query_package_info(handle);
    let _ = unsafe { windows::Win32::Foundation::CloseHandle(handle) };

    let meta = ProcessMeta {
        creation_time,
        executable_path: exec_path,
        executable_name: exec_name,
        package_full_name: pkg_name,
        aumid,
    };
    cache.insert(pid, meta.clone());
    meta
}

fn query_package_info(
    handle: windows::Win32::Foundation::HANDLE,
) -> (Option<String>, Option<String>) {
    unsafe {
        let kernel32 = GetModuleHandleW(windows::core::w!("kernel32.dll"));
        let Ok(kernel32) = kernel32 else {
            return (None, None);
        };

        type GetPkgNameFn = unsafe extern "system" fn(
            windows::Win32::Foundation::HANDLE,
            *mut u32,
            *mut u16,
        ) -> i32;
        type GetAumidFn = unsafe extern "system" fn(
            windows::Win32::Foundation::HANDLE,
            *mut u32,
            *mut u16,
        ) -> i32;

        let pkg_fn: Option<GetPkgNameFn> =
            std::mem::transmute(windows::Win32::System::LibraryLoader::GetProcAddress(
                kernel32,
                windows::core::s!("GetPackageFullName"),
            ));
        let aumid_fn: Option<GetAumidFn> =
            std::mem::transmute(windows::Win32::System::LibraryLoader::GetProcAddress(
                kernel32,
                windows::core::s!("GetApplicationUserModelId"),
            ));

        let pkg_name = if let Some(f) = pkg_fn {
            let mut len = 0u32;
            let _ = f(handle, &mut len, std::ptr::null_mut());
            if len > 0 {
                let mut buf = vec![0u16; len as usize];
                if f(handle, &mut len, buf.as_mut_ptr()) == 0 {
                    let s = wide_to_string(&buf);
                    if !s.is_empty() {
                        Some(s)
                    } else {
                        None
                    }
                } else {
                    None
                }
            } else {
                None
            }
        } else {
            None
        };

        let aumid = if let Some(f) = aumid_fn {
            let mut len = 0u32;
            let _ = f(handle, &mut len, std::ptr::null_mut());
            if len > 0 {
                let mut buf = vec![0u16; len as usize];
                if f(handle, &mut len, buf.as_mut_ptr()) == 0 {
                    let s = wide_to_string(&buf);
                    if !s.is_empty() {
                        Some(s)
                    } else {
                        None
                    }
                } else {
                    None
                }
            } else {
                None
            }
        } else {
            None
        };

        (pkg_name, aumid)
    }
}

fn wide_to_string(buffer: &[u16]) -> String {
    let length = buffer
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(buffer.len());
    String::from_utf16_lossy(&buffer[..length])
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn invoke_change_callback(state: &RegistryState, event: NativeWindowRegistryChange) {
    let callback = Arc::clone(&state.callback);
    let _ = catch_unwind(AssertUnwindSafe(|| callback(event)));
}

fn invoke_fault_callback(state: &RegistryState, error: NativeError) {
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
                "Failed to enter per-monitor-v2 DPI awareness for Window Registry",
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
        // ELIX surfaces live in the native host process. Do not use WINEVENT_SKIPOWNPROCESS here:
        // own-process top-level surface create/destroy/foreground transitions must reach the
        // registry. Internal ELIX helper HWNDs are filtered explicitly by inspect_window().
        let flags = WINEVENT_OUTOFCONTEXT;
        let specs = [
            (EVENT_OBJECT_CREATE, EVENT_OBJECT_HIDE),
            (EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND),
            (EVENT_SYSTEM_MINIMIZESTART, EVENT_SYSTEM_MINIMIZEEND),
            (EVENT_OBJECT_NAMECHANGE, EVENT_OBJECT_NAMECHANGE),
            (EVENT_OBJECT_LOCATIONCHANGE, EVENT_OBJECT_LOCATIONCHANGE),
            (EVENT_OBJECT_STATECHANGE, EVENT_OBJECT_STATECHANGE),
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
                    "Failed to install Window Registry WinEvent hook",
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
    if object_id != OBJID_WINDOW.0 || child_id != CHILDID_SELF as i32 || hwnd.0.is_null() {
        return;
    }
    let _ = PostThreadMessageW(
        GetCurrentThreadId(),
        WM_ELIX_WINDOW_EVENT,
        WPARAM(event as usize),
        LPARAM(hwnd.0 as isize),
    );
}

struct NotificationWindow {
    hwnd: HWND,
}

unsafe extern "system" fn notification_wndproc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
}

impl NotificationWindow {
    fn create() -> NativeResult<Self> {
        let module = unsafe { GetModuleHandleW(None) }.map_err(|error| {
            NativeError::from_windows_error(error, "Failed to get native host module handle")
        })?;
        let instance = windows::Win32::Foundation::HINSTANCE(module.0);
        let class = WNDCLASSW {
            lpfnWndProc: Some(notification_wndproc),
            hInstance: instance,
            lpszClassName: PCWSTR(WINDOW_CLASS.as_ptr()),
            ..Default::default()
        };
        let atom = unsafe { RegisterClassW(&class) };
        if atom == 0 {
            let err = unsafe { GetLastError().0 };
            if err != 1410 {
                return Err(NativeError::from_win32(
                    err,
                    "Failed to register Window Registry notification window class",
                ));
            }
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
            NativeError::from_windows_error(
                error,
                "Failed to create Window Registry notification window",
            )
        })?;
        Ok(Self { hwnd })
    }
}

impl Drop for NotificationWindow {
    fn drop(&mut self) {
        unsafe {
            let _ = DestroyWindow(self.hwnd);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    #[test]
    fn test_window_snapshot_serialization() {
        let win = NativeRawWindow {
            hwnd: 12345,
            process_id: 100,
            thread_id: 200,
            process_creation_time: 999999,
            executable_path: Some("C:/Windows/System32/notepad.exe".to_string()),
            executable_name: Some("notepad.exe".to_string()),
            package_full_name: None,
            aumid: None,
            title: "Untitled - Notepad".to_string(),
            class_name: "Notepad".to_string(),
            bounds: PhysicalPixelRect {
                x: 100,
                y: 100,
                width: 800,
                height: 600,
            },
            is_visible: true,
            is_minimized: false,
            is_maximized: false,
            is_cloaked: false,
            is_tool_window: false,
            is_shell_window: false,
            is_enabled: true,
            is_foreground: true,
            monitor_device_name: Some(r"\\.\DISPLAY1".to_string()),
        };

        let snapshot = NativeWindowRegistrySnapshot {
            revision: 1,
            windows: vec![win.clone()],
            foreground_hwnd: Some(12345),
            captured_at: 1000000,
        };

        let serialized = serde_json::to_string(&snapshot).expect("must serialize");
        let deserialized: NativeWindowRegistrySnapshot =
            serde_json::from_str(&serialized).expect("must deserialize");

        assert_eq!(snapshot, deserialized);
        assert_eq!(deserialized.windows[0].hwnd, 12345);
        assert_eq!(deserialized.windows[0].title, "Untitled - Notepad");
        assert_eq!(deserialized.windows[0].class_name, "Notepad");
    }

    #[test]
    fn test_observer_start_failure_injection() {
        let observer = WindowRegistryObserver::new(Arc::new(|_| {}), Arc::new(|_| {}));
        observer.fail_next_start_for_test();
        let result = observer.start();
        assert!(result.is_err());
        assert!(!observer.status().observing);
        assert!(!observer.status().thread_alive);
    }

    #[test]
    fn test_observer_lifecycle_and_live_snapshot() {
        let change_count = Arc::new(AtomicUsize::new(0));
        let change_counter = Arc::clone(&change_count);
        let observer = WindowRegistryObserver::new(
            Arc::new(move |_change| {
                change_counter.fetch_add(1, Ordering::SeqCst);
            }),
            Arc::new(|_| {}),
        );

        // Get snapshot without starting observer
        let snapshot = observer.get_snapshot().expect("snapshot must succeed");
        assert!(snapshot.revision >= 1);
        assert!(
            !snapshot.windows.is_empty(),
            "Windows desktop must have at least one top-level window"
        );

        // Start observer
        let (live_snapshot, already_started) = observer.start().expect("start must succeed");
        assert!(!already_started);
        assert!(!live_snapshot.windows.is_empty());
        assert!(observer.status().observing);
        assert!(observer.status().thread_alive);

        // Second start call returns already_started: true
        let (_, second_start) = observer.start().expect("second start must succeed");
        assert!(second_start);

        // Refresh must execute on the live observer thread and leave it observing.
        let refreshed = observer.refresh().expect("refresh must succeed");
        assert!(refreshed.revision > live_snapshot.revision);
        assert!(observer.status().observing);
        assert!(observer.status().thread_alive);
        assert!(change_count.load(Ordering::SeqCst) >= 1);

        // Stop
        let stopped = observer.stop().expect("stop must succeed");
        assert!(stopped);
        assert!(!observer.status().observing);
    }

    #[test]
    fn test_observer_runtime_fault_injection() {
        let (fault_tx, fault_rx) = mpsc::channel();
        let observer = WindowRegistryObserver::new(
            Arc::new(|_| {}),
            Arc::new(move |err| {
                let _ = fault_tx.send(err);
            }),
        );

        let (_, _) = observer.start().expect("start must succeed");
        observer
            .fail_runtime_for_test()
            .expect("inject fault must succeed");

        let fault = fault_rx
            .recv_timeout(std::time::Duration::from_secs(3))
            .expect("must receive fault");
        assert_eq!(fault.domain, "window-registry");
        assert_eq!(fault.code, "OBSERVER_RUNTIME_FAILED");

        let _ = observer.stop();
    }
}
