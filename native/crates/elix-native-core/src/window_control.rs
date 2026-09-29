//! Guarded native control operations for real top-level Windows application windows.
//!
//! Every mutation revalidates HWND lifetime evidence immediately before touching the
//! target so a recycled handle cannot redirect an ELIX command to an unrelated process.
//! Geometry is expressed in virtual-screen physical pixels.

use crate::error::{NativeError, NativeResult};
use crate::windows_context::PhysicalPixelRect;
use serde::{Deserialize, Serialize};
use std::mem::size_of;
use std::thread;
use std::time::{Duration, Instant};
use windows::Win32::Foundation::{CloseHandle, GetLastError, HWND, LPARAM, RECT, WPARAM};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows::Win32::System::Threading::{
    GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::HiDpi::{
    GetDpiForWindow, GetSystemMetricsForDpi, SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT,
    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows::Win32::UI::Input::KeyboardAndMouse::IsWindowEnabled;
use windows::Win32::UI::WindowsAndMessaging::{
    GetAncestor, GetClassNameW, GetDesktopWindow, GetForegroundWindow, GetWindowLongPtrW,
    GetWindowRect, GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible, IsZoomed,
    PostMessageW, SendMessageTimeoutW, SetForegroundWindow, SetWindowPos, ShowWindowAsync, GA_ROOT,
    GWL_STYLE, MINMAXINFO, SMTO_ABORTIFHUNG, SMTO_BLOCK, SM_CXMAXTRACK, SM_CXMINTRACK,
    SM_CYMAXTRACK, SM_CYMINTRACK, SWP_ASYNCWINDOWPOS, SWP_NOACTIVATE, SWP_NOZORDER, SW_MAXIMIZE,
    SW_MINIMIZE, SW_RESTORE, WM_CLOSE, WM_GETMINMAXINFO, WS_CHILD, WS_THICKFRAME,
};

const MAX_WINDOW_DIMENSION: i32 = 100_000;
const MAX_VIRTUAL_COORDINATE: i32 = 1_000_000;
const COMPLETION_WAIT: Duration = Duration::from_millis(1000);
const COMPLETION_POLL: Duration = Duration::from_millis(10);
const PLACEMENT_CONSTRAINT_QUERY_TIMEOUT_MS: u32 = 100;

/// Immutable lifetime evidence captured by Window Registry for the target window.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativeWindowControlTarget {
    pub hwnd: isize,
    pub process_id: u32,
    pub thread_id: u32,
    /// Raw Win32 FILETIME ticks transported through JavaScript's f64 Number.
    /// Comparing against `live_ticks as f64` preserves the exact bridge representation.
    pub process_creation_time: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub class_name: Option<String>,
}

/// Primitive operation performed against one validated application window.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WindowControlAction {
    Activate,
    Minimize,
    Maximize,
    Restore,
    Close,
    SetBounds,
    QueryPlacementConstraints,
}

/// One native control request. Bounds are required only by `setBounds`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativeWindowControlRequest {
    pub action: WindowControlAction,
    pub target: NativeWindowControlTarget,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bounds: Option<PhysicalPixelRect>,
}

/// Immediate post-command observation of the target HWND.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeWindowControlObservation {
    pub exists: bool,
    pub visible: bool,
    pub minimized: bool,
    pub maximized: bool,
    pub foreground: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bounds: Option<PhysicalPixelRect>,
}

/// Guarded structural/application placement evidence for a foreign application window.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeWindowPlacementConstraints {
    /// Whether the target exposes the standard Win32 sizing frame.
    pub resizable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_track_width: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_track_height: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_track_width: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_track_height: Option<i32>,
    /// Registry-compatible DWM extended-frame geometry at query time.
    pub visible_bounds: PhysicalPixelRect,
    /// True only when the target processed bounded WM_GETMINMAXINFO interrogation.
    pub app_constraints_observed: bool,
}

/// Result of an accepted native command/query.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeWindowControlResult {
    pub action: WindowControlAction,
    pub hwnd: isize,
    pub accepted: bool,
    pub completed: bool,
    pub observation: NativeWindowControlObservation,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placement_constraints: Option<NativeWindowPlacementConstraints>,
}

/// Executes one guarded external-window operation.
pub fn execute_window_control(
    request: &NativeWindowControlRequest,
) -> NativeResult<NativeWindowControlResult> {
    let _dpi = ThreadDpiAwareness::per_monitor_v2()?;
    let hwnd = validate_target(&request.target)?;

    match request.action {
        WindowControlAction::Activate => execute_activate(hwnd, request),
        WindowControlAction::Minimize => execute_show_state(hwnd, request, SW_MINIMIZE),
        WindowControlAction::Maximize => execute_show_state(hwnd, request, SW_MAXIMIZE),
        WindowControlAction::Restore => execute_show_state(hwnd, request, SW_RESTORE),
        WindowControlAction::Close => execute_close(hwnd, request),
        WindowControlAction::SetBounds => execute_set_bounds(hwnd, request),
        WindowControlAction::QueryPlacementConstraints => {
            execute_query_placement_constraints(hwnd, request)
        }
    }
}

fn execute_activate(
    hwnd: HWND,
    request: &NativeWindowControlRequest,
) -> NativeResult<NativeWindowControlResult> {
    if unsafe { IsIconic(hwnd).as_bool() } {
        request_show_state(hwnd, SW_RESTORE, "RESTORE_FAILED")?;
        let _ = wait_until(hwnd, |observation| !observation.minimized);
        validate_target(&request.target)?;
    }

    if !unsafe { IsWindowVisible(hwnd).as_bool() } {
        return Err(control_error(
            "WINDOW_NOT_VISIBLE",
            "Cannot activate a hidden application window",
            false,
        ));
    }
    if !unsafe { IsWindowEnabled(hwnd).as_bool() } {
        return Err(control_error(
            "WINDOW_DISABLED",
            "Cannot activate a disabled application window",
            true,
        ));
    }

    if !unsafe { SetForegroundWindow(hwnd).as_bool() } {
        return Err(control_error(
            "FOREGROUND_DENIED",
            "Windows denied the foreground activation request",
            true,
        ));
    }

    Ok(result_after_wait(request, hwnd, |observation| {
        observation.foreground
    }))
}

fn execute_show_state(
    hwnd: HWND,
    request: &NativeWindowControlRequest,
    command: windows::Win32::UI::WindowsAndMessaging::SHOW_WINDOW_CMD,
) -> NativeResult<NativeWindowControlResult> {
    let error_code = match request.action {
        WindowControlAction::Minimize => "MINIMIZE_FAILED",
        WindowControlAction::Maximize => "MAXIMIZE_FAILED",
        WindowControlAction::Restore => "RESTORE_FAILED",
        _ => unreachable!("show-state helper used with non-state action"),
    };
    request_show_state(hwnd, command, error_code)?;

    let predicate: fn(&NativeWindowControlObservation) -> bool = match request.action {
        WindowControlAction::Minimize => |observation| observation.minimized,
        WindowControlAction::Maximize => |observation| observation.maximized,
        WindowControlAction::Restore => {
            |observation| observation.exists && !observation.minimized && !observation.maximized
        }
        _ => unreachable!("show-state helper used with non-state action"),
    };

    Ok(result_after_wait(request, hwnd, predicate))
}

fn request_show_state(
    hwnd: HWND,
    command: windows::Win32::UI::WindowsAndMessaging::SHOW_WINDOW_CMD,
    error_code: &str,
) -> NativeResult<()> {
    if unsafe { ShowWindowAsync(hwnd, command).as_bool() } {
        return Ok(());
    }

    let native_code = unsafe { GetLastError().0 };
    let mut error = control_error(
        error_code,
        "Windows rejected the asynchronous show-state request",
        true,
    );
    if native_code != 0 {
        error.native_code = Some(native_code);
    }
    Err(error)
}

fn execute_close(
    hwnd: HWND,
    request: &NativeWindowControlRequest,
) -> NativeResult<NativeWindowControlResult> {
    unsafe {
        PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0)).map_err(|error| {
            windows_control_error(
                error,
                "CLOSE_FAILED",
                "Failed to post WM_CLOSE to target window",
                true,
            )
        })?;
    }

    Ok(result_after_wait(request, hwnd, |observation| {
        !observation.exists
    }))
}

fn execute_set_bounds(
    hwnd: HWND,
    request: &NativeWindowControlRequest,
) -> NativeResult<NativeWindowControlResult> {
    let requested = request.bounds.ok_or_else(|| {
        NativeError::invalid_argument("windowControl setBounds requires a 'bounds' object")
    })?;
    validate_bounds(requested)?;

    if unsafe { IsIconic(hwnd).as_bool() || IsZoomed(hwnd).as_bool() } {
        return Err(control_error(
            "WINDOW_NOT_NORMAL",
            "setBounds requires a normal (restored) window",
            false,
        ));
    }

    let outer = window_rect(hwnd)?;
    let visible = visible_frame_bounds(hwnd).unwrap_or(outer);
    let left_margin = visible.left.saturating_sub(outer.left);
    let top_margin = visible.top.saturating_sub(outer.top);
    let right_margin = outer.right.saturating_sub(visible.right);
    let bottom_margin = outer.bottom.saturating_sub(visible.bottom);

    let x = checked_i32(requested.x as i64 - left_margin as i64, "x")?;
    let y = checked_i32(requested.y as i64 - top_margin as i64, "y")?;
    let width = checked_i32(
        requested.width as i64 + left_margin as i64 + right_margin as i64,
        "width",
    )?;
    let height = checked_i32(
        requested.height as i64 + top_margin as i64 + bottom_margin as i64,
        "height",
    )?;

    validate_target(&request.target)?;
    unsafe {
        SetWindowPos(
            hwnd,
            None,
            x,
            y,
            width,
            height,
            SWP_NOZORDER | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS,
        )
        .map_err(|error| {
            windows_control_error(
                error,
                "SET_BOUNDS_FAILED",
                "Failed to update target window bounds",
                true,
            )
        })?;
    }

    Ok(result_after_wait(request, hwnd, |observation| {
        observation
            .bounds
            .map(|actual| rect_near(actual, requested, 2))
            .unwrap_or(false)
    }))
}

fn execute_query_placement_constraints(
    hwnd: HWND,
    request: &NativeWindowControlRequest,
) -> NativeResult<NativeWindowControlResult> {
    validate_target(&request.target)?;
    let style = unsafe { GetWindowLongPtrW(hwnd, GWL_STYLE) as u32 };
    let outer = window_rect(hwnd)?;
    let visible = visible_frame_bounds(hwnd).unwrap_or(outer);
    let visible_bounds = PhysicalPixelRect {
        x: visible.left,
        y: visible.top,
        width: visible.right - visible.left,
        height: visible.bottom - visible.top,
    };
    let resizable = style & WS_THICKFRAME.0 != 0;
    let track = if resizable {
        query_visible_track_constraints(hwnd, &request.target, outer, visible)?
    } else {
        TrackConstraints::default()
    };

    // A bounded cross-process message can outlive the HWND identity that initiated it. Fence
    // again before publishing any geometry/constraints obtained from that interaction.
    validate_target(&request.target)?;
    let observation = observe(hwnd);

    Ok(NativeWindowControlResult {
        action: request.action,
        hwnd: request.target.hwnd,
        accepted: true,
        completed: true,
        observation,
        placement_constraints: Some(NativeWindowPlacementConstraints {
            resizable,
            min_track_width: track.min_width,
            min_track_height: track.min_height,
            max_track_width: track.max_width,
            max_track_height: track.max_height,
            visible_bounds,
            app_constraints_observed: track.observed,
        }),
    })
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct TrackConstraints {
    min_width: Option<i32>,
    min_height: Option<i32>,
    max_width: Option<i32>,
    max_height: Option<i32>,
    observed: bool,
}

fn query_visible_track_constraints(
    hwnd: HWND,
    target: &NativeWindowControlTarget,
    outer: RECT,
    visible: RECT,
) -> NativeResult<TrackConstraints> {
    let dpi = unsafe { GetDpiForWindow(hwnd) };
    let dpi = if dpi == 0 { 96 } else { dpi };
    let mut info = MINMAXINFO::default();
    unsafe {
        info.ptMinTrackSize.x = GetSystemMetricsForDpi(SM_CXMINTRACK, dpi);
        info.ptMinTrackSize.y = GetSystemMetricsForDpi(SM_CYMINTRACK, dpi);
        info.ptMaxTrackSize.x = GetSystemMetricsForDpi(SM_CXMAXTRACK, dpi);
        info.ptMaxTrackSize.y = GetSystemMetricsForDpi(SM_CYMAXTRACK, dpi);
    }

    validate_target(target)?;

    let mut message_result = 0usize;
    let sent = unsafe {
        SendMessageTimeoutW(
            hwnd,
            WM_GETMINMAXINFO,
            WPARAM(0),
            LPARAM((&mut info as *mut MINMAXINFO) as isize),
            SMTO_ABORTIFHUNG | SMTO_BLOCK,
            PLACEMENT_CONSTRAINT_QUERY_TIMEOUT_MS,
            Some(&mut message_result as *mut usize),
        )
    };

    // Distinguish a hung/unresponsive application from an HWND lifetime change. A timeout simply
    // means app-specific constraints are unavailable; stale identity must fail the public query.
    validate_target(target)?;
    if sent.0 == 0 {
        return Ok(TrackConstraints::default());
    }

    let invisible_width = visible
        .left
        .saturating_sub(outer.left)
        .max(0)
        .saturating_add(outer.right.saturating_sub(visible.right).max(0));
    let invisible_height = visible
        .top
        .saturating_sub(outer.top)
        .max(0)
        .saturating_add(outer.bottom.saturating_sub(visible.bottom).max(0));

    Ok(TrackConstraints {
        min_width: visible_track_dimension(info.ptMinTrackSize.x, invisible_width),
        min_height: visible_track_dimension(info.ptMinTrackSize.y, invisible_height),
        max_width: visible_track_dimension(info.ptMaxTrackSize.x, invisible_width),
        max_height: visible_track_dimension(info.ptMaxTrackSize.y, invisible_height),
        observed: true,
    })
}

fn visible_track_dimension(outer_dimension: i32, invisible_margin: i32) -> Option<i32> {
    let value = outer_dimension.saturating_sub(invisible_margin.max(0));
    (value > 0).then_some(value)
}

fn result_after_wait<F>(
    request: &NativeWindowControlRequest,
    hwnd: HWND,
    predicate: F,
) -> NativeWindowControlResult
where
    F: Fn(&NativeWindowControlObservation) -> bool,
{
    let observation = wait_until(hwnd, predicate);
    let completed = match request.action {
        WindowControlAction::Activate => observation.foreground,
        WindowControlAction::Minimize => observation.minimized,
        WindowControlAction::Maximize => observation.maximized,
        WindowControlAction::Restore => {
            observation.exists && !observation.minimized && !observation.maximized
        }
        WindowControlAction::Close => !observation.exists,
        WindowControlAction::SetBounds => request
            .bounds
            .zip(observation.bounds)
            .map(|(expected, actual)| rect_near(actual, expected, 2))
            .unwrap_or(false),
        WindowControlAction::QueryPlacementConstraints => true,
    };

    NativeWindowControlResult {
        action: request.action,
        hwnd: request.target.hwnd,
        accepted: true,
        completed,
        observation,
        placement_constraints: None,
    }
}

fn wait_until<F>(hwnd: HWND, predicate: F) -> NativeWindowControlObservation
where
    F: Fn(&NativeWindowControlObservation) -> bool,
{
    let started = Instant::now();
    loop {
        let observation = observe(hwnd);
        if predicate(&observation) || started.elapsed() >= COMPLETION_WAIT {
            return observation;
        }
        thread::sleep(COMPLETION_POLL);
    }
}

fn observe(hwnd: HWND) -> NativeWindowControlObservation {
    if hwnd.0.is_null() || !unsafe { IsWindow(Some(hwnd)).as_bool() } {
        return NativeWindowControlObservation {
            exists: false,
            visible: false,
            minimized: false,
            maximized: false,
            foreground: false,
            bounds: None,
        };
    }

    let bounds = query_visible_bounds(hwnd).ok();
    NativeWindowControlObservation {
        exists: true,
        visible: unsafe { IsWindowVisible(hwnd).as_bool() },
        minimized: unsafe { IsIconic(hwnd).as_bool() },
        maximized: unsafe { IsZoomed(hwnd).as_bool() },
        foreground: unsafe { GetForegroundWindow() == hwnd },
        bounds,
    }
}

fn validate_target(target: &NativeWindowControlTarget) -> NativeResult<HWND> {
    if target.hwnd <= 0 || target.process_id == 0 || target.thread_id == 0 {
        return Err(stale_window("Window identity evidence is incomplete"));
    }

    let hwnd = HWND(target.hwnd as *mut _);
    if !unsafe { IsWindow(Some(hwnd)).as_bool() } {
        return Err(stale_window("Target HWND no longer exists"));
    }

    if hwnd == unsafe { GetDesktopWindow() } || unsafe { GetAncestor(hwnd, GA_ROOT) } != hwnd {
        return Err(control_error(
            "TARGET_NOT_TOP_LEVEL",
            "Window Control accepts only real top-level windows",
            false,
        ));
    }

    let style = unsafe { GetWindowLongPtrW(hwnd, GWL_STYLE) as u32 };
    if style & WS_CHILD.0 != 0 {
        return Err(control_error(
            "TARGET_NOT_TOP_LEVEL",
            "Child windows cannot be controlled through Window Control",
            false,
        ));
    }

    let mut live_pid = 0u32;
    let live_tid = unsafe { GetWindowThreadProcessId(hwnd, Some(&mut live_pid)) };
    if live_tid == 0 || live_pid == 0 {
        return Err(stale_window("Unable to resolve target HWND ownership"));
    }
    if live_pid != target.process_id || live_tid != target.thread_id {
        return Err(stale_window(
            "Target HWND ownership changed since Window Registry captured it",
        ));
    }

    let class_name = query_class_name(hwnd);
    if let Some(expected) = target.class_name.as_ref().filter(|name| !name.is_empty()) {
        if &class_name != expected {
            return Err(stale_window(
                "Target HWND class changed since Window Registry captured it",
            ));
        }
    }
    if is_protected_class(&class_name) {
        return Err(control_error(
            "TARGET_PROTECTED",
            format!("Window class '{class_name}' is protected from external Window Control"),
            false,
        ));
    }

    if target.process_creation_time > 0.0 {
        if !target.process_creation_time.is_finite() {
            return Err(stale_window("Process lifetime evidence is not finite"));
        }
        let live_creation_time = query_process_creation_time(live_pid)? as f64;
        if live_creation_time != target.process_creation_time {
            return Err(stale_window(
                "Target process lifetime changed since Window Registry captured it",
            ));
        }
    }

    Ok(hwnd)
}

fn query_process_creation_time(pid: u32) -> NativeResult<u64> {
    let handle =
        unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.map_err(|error| {
            windows_control_error(
                error,
                "IDENTITY_UNVERIFIABLE",
                "Unable to revalidate target process lifetime",
                true,
            )
        })?;

    let mut creation = windows::Win32::Foundation::FILETIME::default();
    let mut exit = windows::Win32::Foundation::FILETIME::default();
    let mut kernel = windows::Win32::Foundation::FILETIME::default();
    let mut user = windows::Win32::Foundation::FILETIME::default();
    let result = unsafe { GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) };
    let _ = unsafe { CloseHandle(handle) };
    result.map_err(|error| {
        windows_control_error(
            error,
            "IDENTITY_UNVERIFIABLE",
            "Unable to read target process creation time",
            true,
        )
    })?;

    Ok((creation.dwLowDateTime as u64) | ((creation.dwHighDateTime as u64) << 32))
}

fn query_class_name(hwnd: HWND) -> String {
    let mut buffer = [0u16; 256];
    let length = unsafe { GetClassNameW(hwnd, &mut buffer) };
    if length <= 0 {
        String::new()
    } else {
        String::from_utf16_lossy(&buffer[..length as usize])
    }
}

fn is_protected_class(class_name: &str) -> bool {
    class_name.starts_with("ELIX_")
        || matches!(
            class_name,
            "Shell_TrayWnd" | "Shell_SecondaryTrayWnd" | "Progman" | "WorkerW"
        )
}

fn query_visible_bounds(hwnd: HWND) -> NativeResult<PhysicalPixelRect> {
    let rect = visible_frame_bounds(hwnd).or_else(|_| window_rect(hwnd))?;
    Ok(PhysicalPixelRect {
        x: rect.left,
        y: rect.top,
        width: rect.right - rect.left,
        height: rect.bottom - rect.top,
    })
}

fn visible_frame_bounds(hwnd: HWND) -> NativeResult<RECT> {
    let mut rect = RECT::default();
    unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut rect as *mut _ as *mut _,
            size_of::<RECT>() as u32,
        )
        .map_err(|error| {
            windows_control_error(
                error,
                "GEOMETRY_QUERY_FAILED",
                "Failed to query DWM extended frame bounds",
                true,
            )
        })?;
    }
    Ok(rect)
}

fn window_rect(hwnd: HWND) -> NativeResult<RECT> {
    let mut rect = RECT::default();
    unsafe {
        GetWindowRect(hwnd, &mut rect).map_err(|error| {
            windows_control_error(
                error,
                "GEOMETRY_QUERY_FAILED",
                "Failed to query target window rectangle",
                true,
            )
        })?;
    }
    Ok(rect)
}

fn validate_bounds(bounds: PhysicalPixelRect) -> NativeResult<()> {
    if bounds.width <= 0 || bounds.height <= 0 {
        return Err(NativeError::invalid_argument(
            "Window bounds width and height must be positive",
        ));
    }
    if bounds.width > MAX_WINDOW_DIMENSION || bounds.height > MAX_WINDOW_DIMENSION {
        return Err(NativeError::invalid_argument(format!(
            "Window bounds exceed the maximum dimension of {MAX_WINDOW_DIMENSION} physical pixels"
        )));
    }
    if (bounds.x as i64).abs() > MAX_VIRTUAL_COORDINATE as i64
        || (bounds.y as i64).abs() > MAX_VIRTUAL_COORDINATE as i64
    {
        return Err(NativeError::invalid_argument(format!(
            "Window coordinates exceed the supported virtual desktop range of +/-{MAX_VIRTUAL_COORDINATE}"
        )));
    }
    Ok(())
}

fn checked_i32(value: i64, field: &str) -> NativeResult<i32> {
    i32::try_from(value).map_err(|_| {
        NativeError::invalid_argument(format!(
            "Computed window {field} is outside the Win32 range"
        ))
    })
}

fn rect_near(actual: PhysicalPixelRect, expected: PhysicalPixelRect, tolerance: i32) -> bool {
    let tolerance = tolerance as i64;
    ((actual.x as i64) - (expected.x as i64)).abs() <= tolerance
        && ((actual.y as i64) - (expected.y as i64)).abs() <= tolerance
        && ((actual.width as i64) - (expected.width as i64)).abs() <= tolerance
        && ((actual.height as i64) - (expected.height as i64)).abs() <= tolerance
}

fn stale_window(message: impl Into<String>) -> NativeError {
    control_error("STALE_WINDOW", message, false)
}

fn control_error(code: &str, message: impl Into<String>, retryable: bool) -> NativeError {
    let mut error = NativeError::new("window-control", code, message);
    error.retryable = Some(retryable);
    error
}

fn windows_control_error(
    error: windows::core::Error,
    code: &str,
    message: impl Into<String>,
    retryable: bool,
) -> NativeError {
    let mut native = NativeError::from_windows_error(error, &message.into());
    native.domain = "window-control".to_string();
    native.code = code.to_string();
    native.retryable = Some(retryable);
    native
}

struct ThreadDpiAwareness {
    previous: DPI_AWARENESS_CONTEXT,
}

impl ThreadDpiAwareness {
    fn per_monitor_v2() -> NativeResult<Self> {
        let previous = unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
        if previous.0.is_null() {
            return Err(control_error(
                "DPI_CONTEXT_FAILED",
                format!(
                    "Failed to enter per-monitor-v2 DPI awareness for Window Control (win32={})",
                    unsafe { GetLastError().0 }
                ),
                true,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounds_validation_rejects_invalid_geometry() {
        assert!(validate_bounds(PhysicalPixelRect {
            x: 0,
            y: 0,
            width: 800,
            height: 600
        })
        .is_ok());
        assert!(validate_bounds(PhysicalPixelRect {
            x: 0,
            y: 0,
            width: 0,
            height: 600
        })
        .is_err());
        assert!(validate_bounds(PhysicalPixelRect {
            x: 0,
            y: 0,
            width: 800,
            height: -1
        })
        .is_err());
        assert!(validate_bounds(PhysicalPixelRect {
            x: 1_000_001,
            y: 0,
            width: 800,
            height: 600
        })
        .is_err());
        assert!(validate_bounds(PhysicalPixelRect {
            x: i32::MIN,
            y: 0,
            width: 800,
            height: 600
        })
        .is_err());
    }

    #[test]
    fn visible_track_dimensions_remove_invisible_frame_margins() {
        assert_eq!(visible_track_dimension(640, 16), Some(624));
        assert_eq!(visible_track_dimension(10, 16), None);
        assert_eq!(visible_track_dimension(0, 0), None);
    }

    #[test]
    fn protected_shell_and_elix_classes_are_blocked() {
        assert!(is_protected_class("Shell_TrayWnd"));
        assert!(is_protected_class("WorkerW"));
        assert!(is_protected_class("ELIX_SURFACE_WINDOW_CLASS"));
        assert!(!is_protected_class("Notepad"));
        assert!(!is_protected_class("Chrome_WidgetWin_1"));
    }

    #[test]
    fn obviously_invalid_hwnd_is_rejected_as_stale() {
        let request = NativeWindowControlRequest {
            action: WindowControlAction::Close,
            target: NativeWindowControlTarget {
                hwnd: 1,
                process_id: 1,
                thread_id: 1,
                process_creation_time: 0.0,
                class_name: None,
            },
            bounds: None,
        };
        let error = execute_window_control(&request).unwrap_err();
        assert_eq!(error.domain, "window-control");
        assert_eq!(error.code, "STALE_WINDOW");
    }
}
