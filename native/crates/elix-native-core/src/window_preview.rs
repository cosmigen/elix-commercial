//! Native DWM thumbnail composition backend for ELIX window previews.
//!
//! The backend owns process-local DWM thumbnail registrations. Public ELIX UI
//! never receives HWND or HTHUMBNAIL values; those remain behind Native Core.

use crate::error::{NativeError, NativeResult};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::LazyLock;
use windows::core::BOOL;
use windows::Win32::Foundation::{CloseHandle, HWND, RECT};
use windows::Win32::Graphics::Dwm::{
    DwmQueryThumbnailSourceSize, DwmRegisterThumbnail, DwmUnregisterThumbnail,
    DwmUpdateThumbnailProperties, DWM_THUMBNAIL_PROPERTIES, DWM_TNP_OPACITY,
    DWM_TNP_RECTDESTINATION, DWM_TNP_SOURCECLIENTAREAONLY, DWM_TNP_VISIBLE,
};
use windows::Win32::System::Threading::{
    GetCurrentProcessId, GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetAncestor, GetWindowThreadProcessId, IsWindow, GA_ROOT,
};

const ACCESS_DENIED_HRESULT: u32 = 0x8007_0005;
const MAX_PREVIEW_DIMENSION: i32 = 32_767;

/// Physical-pixel rectangle relative to the destination surface client area.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl PreviewRect {
    fn validate(self) -> NativeResult<()> {
        if self.width <= 0 || self.height <= 0 {
            return Err(NativeError::invalid_argument(
                "Preview destination rectangle must have positive width and height",
            ));
        }
        if self.width > MAX_PREVIEW_DIMENSION || self.height > MAX_PREVIEW_DIMENSION {
            return Err(NativeError::invalid_argument(format!(
                "Preview rectangle {}x{} exceeds the Win32 coordinate limit",
                self.width, self.height
            )));
        }
        self.x.checked_add(self.width).ok_or_else(|| {
            NativeError::invalid_argument("Preview destination rectangle overflows on x axis")
        })?;
        self.y.checked_add(self.height).ok_or_else(|| {
            NativeError::invalid_argument("Preview destination rectangle overflows on y axis")
        })?;
        Ok(())
    }

    fn to_rect(self) -> RECT {
        RECT {
            left: self.x,
            top: self.y,
            right: self.x + self.width,
            bottom: self.y + self.height,
        }
    }
}

/// Registration request for one live DWM preview relationship.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DwmPreviewSpec {
    pub id: String,
    pub source_hwnd: isize,
    pub destination_hwnd: isize,
    pub destination_rect: PreviewRect,
    #[serde(default = "default_opacity")]
    pub opacity: u8,
    #[serde(default)]
    pub source_client_area_only: bool,
    #[serde(default = "default_true")]
    pub visible: bool,
    #[serde(default)]
    pub process_id: u32,
    #[serde(default)]
    pub process_creation_time: f64,
}

const fn default_opacity() -> u8 {
    u8::MAX
}

const fn default_true() -> bool {
    true
}

/// Partial update for one active native preview relationship.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DwmPreviewUpdate {
    pub id: String,
    #[serde(default)]
    pub destination_rect: Option<PreviewRect>,
    #[serde(default)]
    pub opacity: Option<u8>,
    #[serde(default)]
    pub source_client_area_only: Option<bool>,
    #[serde(default)]
    pub visible: Option<bool>,
}

/// Serializable native preview state. HTHUMBNAIL is intentionally omitted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DwmPreviewSnapshot {
    pub id: String,
    pub source_hwnd: isize,
    pub destination_hwnd: isize,
    pub source_width: i32,
    pub source_height: i32,
    pub destination_rect: PreviewRect,
    pub opacity: u8,
    pub source_client_area_only: bool,
    pub visible: bool,
    pub backend: String,
}

struct Registration {
    thumbnail: isize,
    snapshot: DwmPreviewSnapshot,
}

static PREVIEWS: LazyLock<Mutex<HashMap<String, Registration>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn hwnd_from_isize(value: isize) -> HWND {
    HWND(value as *mut core::ffi::c_void)
}

fn preview_error(error: windows::core::Error, operation: &str) -> NativeError {
    let raw = error.code().0 as u32;
    let code = if raw == ACCESS_DENIED_HRESULT {
        "PREVIEW_ACCESS_DENIED"
    } else {
        "PREVIEW_NATIVE_FAILURE"
    };
    let mut result = NativeError::new(
        "window-preview",
        code,
        format!("{}: {}", operation, error.message()),
    );
    result.hresult = Some(error.code().0);
    result.retryable = Some(raw != ACCESS_DENIED_HRESULT);
    result
}

fn validate_window(hwnd: HWND, role: &str) -> NativeResult<u32> {
    if hwnd.0.is_null() || !unsafe { IsWindow(Some(hwnd)).as_bool() } {
        return Err(NativeError::new(
            "window-preview",
            "PREVIEW_WINDOW_INVALID",
            format!("{} HWND is not a live Windows window", role),
        ));
    }

    let root = unsafe { GetAncestor(hwnd, GA_ROOT) };
    if root != hwnd {
        return Err(NativeError::new(
            "window-preview",
            "PREVIEW_WINDOW_NOT_TOP_LEVEL",
            format!("{} HWND must be a top-level window", role),
        ));
    }

    let mut process_id = 0u32;
    unsafe {
        GetWindowThreadProcessId(hwnd, Some(&mut process_id));
    }
    if process_id == 0 {
        return Err(NativeError::new(
            "window-preview",
            "PREVIEW_WINDOW_IDENTITY_UNKNOWN",
            format!("Could not resolve process identity for {} HWND", role),
        ));
    }
    Ok(process_id)
}

fn query_process_creation_time(pid: u32) -> NativeResult<u64> {
    let handle =
        unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.map_err(|error| {
            let mut err = NativeError::new(
                "window-preview",
                "PREVIEW_SOURCE_IDENTITY_STALE",
                format!("Unable to open preview source process {pid} for lifetime validation: {error}"),
            );
            err.retryable = Some(false);
            err
        })?;

    let mut creation = windows::Win32::Foundation::FILETIME::default();
    let mut exit = windows::Win32::Foundation::FILETIME::default();
    let mut kernel = windows::Win32::Foundation::FILETIME::default();
    let mut user = windows::Win32::Foundation::FILETIME::default();
    let result =
        unsafe { GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) };
    let _ = unsafe { CloseHandle(handle) };
    result.map_err(|error| {
        let mut err = NativeError::new(
            "window-preview",
            "PREVIEW_SOURCE_IDENTITY_STALE",
            format!("Unable to read process creation time for pid {pid}: {error}"),
        );
        err.retryable = Some(false);
        err
    })?;

    Ok((creation.dwLowDateTime as u64) | ((creation.dwHighDateTime as u64) << 32))
}

/// Validates that the preview source window exists, is top-level, and matches expected process identity.
pub fn revalidate_source_identity(
    source: HWND,
    expected_pid: u32,
    expected_creation_time: f64,
) -> NativeResult<()> {
    if expected_creation_time.is_nan() || !expected_creation_time.is_finite() {
        return Err(NativeError::invalid_argument(
            "Preview source processCreationTime must be finite and not NaN",
        ));
    }

    if source.0.is_null() || !unsafe { IsWindow(Some(source)).as_bool() } {
        return Err(NativeError::new(
            "window-preview",
            "PREVIEW_SOURCE_IDENTITY_STALE",
            "Preview source HWND is not a live window",
        ));
    }

    let root = unsafe { GetAncestor(source, GA_ROOT) };
    if root != source {
        return Err(NativeError::new(
            "window-preview",
            "PREVIEW_SOURCE_IDENTITY_STALE",
            "Preview source HWND is not a top-level window",
        ));
    }

    let mut live_pid = 0u32;
    unsafe {
        GetWindowThreadProcessId(source, Some(&mut live_pid));
    }
    if live_pid == 0 {
        return Err(NativeError::new(
            "window-preview",
            "PREVIEW_SOURCE_IDENTITY_STALE",
            "Could not resolve live process identity for preview source HWND",
        ));
    }

    if expected_pid != 0 && live_pid != expected_pid {
        return Err(NativeError::new(
            "window-preview",
            "PREVIEW_SOURCE_IDENTITY_STALE",
            format!(
                "Preview source window process ID changed (expected {}, found {})",
                expected_pid, live_pid
            ),
        ));
    }

    if expected_creation_time > 0.0 {
        let live_creation_time = query_process_creation_time(live_pid)? as f64;
        if live_creation_time != expected_creation_time {
            return Err(NativeError::new(
                "window-preview",
                "PREVIEW_SOURCE_IDENTITY_STALE",
                format!(
                    "Preview source process creation time changed (expected {}, found {})",
                    expected_creation_time, live_creation_time
                ),
            ));
        }
    }

    Ok(())
}

fn validate_spec(spec: &DwmPreviewSpec) -> NativeResult<(HWND, HWND)> {
    if spec.id.trim().is_empty() {
        return Err(NativeError::invalid_argument(
            "Preview registration id must not be empty",
        ));
    }
    spec.destination_rect.validate()?;
    if spec.source_hwnd == spec.destination_hwnd {
        return Err(NativeError::new(
            "window-preview",
            "PREVIEW_SELF_CAPTURE",
            "Preview source and destination HWND must differ",
        ));
    }

    let source = hwnd_from_isize(spec.source_hwnd);
    let destination = hwnd_from_isize(spec.destination_hwnd);
    let source_pid = validate_window(source, "source")?;
    let destination_pid = validate_window(destination, "destination")?;
    let current_pid = unsafe { GetCurrentProcessId() };

    if destination_pid != current_pid {
        return Err(NativeError::new(
            "window-preview",
            "PREVIEW_DESTINATION_NOT_OWNED",
            "DWM preview destination must be an ELIX top-level surface owned by the native host",
        ));
    }
    if source_pid == current_pid {
        return Err(NativeError::new(
            "window-preview",
            "PREVIEW_SELF_CAPTURE",
            "ELIX native-host surfaces cannot be used as preview sources",
        ));
    }
    revalidate_source_identity(source, spec.process_id, spec.process_creation_time)?;
    Ok((source, destination))
}

fn apply_properties(
    thumbnail: isize,
    rect: PreviewRect,
    opacity: u8,
    visible: bool,
    source_client_area_only: bool,
) -> NativeResult<()> {
    let properties = DWM_THUMBNAIL_PROPERTIES {
        dwFlags: DWM_TNP_RECTDESTINATION
            | DWM_TNP_OPACITY
            | DWM_TNP_VISIBLE
            | DWM_TNP_SOURCECLIENTAREAONLY,
        rcDestination: rect.to_rect(),
        rcSource: RECT::default(),
        opacity,
        fVisible: BOOL(if visible { 1 } else { 0 }),
        fSourceClientAreaOnly: BOOL(if source_client_area_only { 1 } else { 0 }),
    };
    unsafe { DwmUpdateThumbnailProperties(thumbnail, &properties) }
        .map_err(|error| preview_error(error, "Failed to update DWM thumbnail properties"))
}

fn source_size(thumbnail: isize) -> NativeResult<(i32, i32)> {
    let size = unsafe { DwmQueryThumbnailSourceSize(thumbnail) }
        .map_err(|error| preview_error(error, "Failed to query DWM thumbnail source size"))?;
    Ok((size.cx, size.cy))
}

/// Creates or atomically replaces one native DWM thumbnail relationship.
pub fn register(spec: DwmPreviewSpec) -> NativeResult<DwmPreviewSnapshot> {
    let (source, destination) = validate_spec(&spec)?;

    // Never retain two native relationships for the same logical lease id.
    let _ = unregister(&spec.id);

    // Revalidate source HWND identity fence natively immediately before DwmRegisterThumbnail.
    revalidate_source_identity(source, spec.process_id, spec.process_creation_time)?;

    let thumbnail = unsafe { DwmRegisterThumbnail(destination, source) }
        .map_err(|error| preview_error(error, "Failed to register DWM thumbnail"))?;

    if let Err(error) = apply_properties(
        thumbnail,
        spec.destination_rect,
        spec.opacity,
        spec.visible,
        spec.source_client_area_only,
    ) {
        let _ = unsafe { DwmUnregisterThumbnail(thumbnail) };
        return Err(error);
    }

    let (source_width, source_height) = match source_size(thumbnail) {
        Ok(size) => size,
        Err(error) => {
            let _ = unsafe { DwmUnregisterThumbnail(thumbnail) };
            return Err(error);
        }
    };

    let snapshot = DwmPreviewSnapshot {
        id: spec.id.clone(),
        source_hwnd: spec.source_hwnd,
        destination_hwnd: spec.destination_hwnd,
        source_width,
        source_height,
        destination_rect: spec.destination_rect,
        opacity: spec.opacity,
        source_client_area_only: spec.source_client_area_only,
        visible: spec.visible,
        backend: "dwm-thumbnail".to_string(),
    };

    PREVIEWS.lock().insert(
        spec.id,
        Registration {
            thumbnail,
            snapshot: snapshot.clone(),
        },
    );
    Ok(snapshot)
}

/// Updates one active DWM preview without recreating its relationship.
pub fn update(update: DwmPreviewUpdate) -> NativeResult<DwmPreviewSnapshot> {
    if update.id.trim().is_empty() {
        return Err(NativeError::invalid_argument(
            "Preview update id must not be empty",
        ));
    }
    if let Some(rect) = update.destination_rect {
        rect.validate()?;
    }

    let mut previews = PREVIEWS.lock();
    let registration = previews.get_mut(&update.id).ok_or_else(|| {
        NativeError::not_found(format!("Preview registration '{}' does not exist", update.id))
    })?;

    let rect = update
        .destination_rect
        .unwrap_or(registration.snapshot.destination_rect);
    let opacity = update.opacity.unwrap_or(registration.snapshot.opacity);
    let visible = update.visible.unwrap_or(registration.snapshot.visible);
    let source_client_area_only = update
        .source_client_area_only
        .unwrap_or(registration.snapshot.source_client_area_only);

    apply_properties(
        registration.thumbnail,
        rect,
        opacity,
        visible,
        source_client_area_only,
    )?;
    let (source_width, source_height) = source_size(registration.thumbnail)?;

    registration.snapshot.destination_rect = rect;
    registration.snapshot.opacity = opacity;
    registration.snapshot.visible = visible;
    registration.snapshot.source_client_area_only = source_client_area_only;
    registration.snapshot.source_width = source_width;
    registration.snapshot.source_height = source_height;
    Ok(registration.snapshot.clone())
}

/// Returns a current snapshot of one active relationship.
pub fn query(id: &str) -> NativeResult<DwmPreviewSnapshot> {
    let mut previews = PREVIEWS.lock();
    let registration = previews.get_mut(id).ok_or_else(|| {
        NativeError::not_found(format!("Preview registration '{}' does not exist", id))
    })?;
    let (source_width, source_height) = source_size(registration.thumbnail)?;
    registration.snapshot.source_width = source_width;
    registration.snapshot.source_height = source_height;
    Ok(registration.snapshot.clone())
}

/// Removes one native relationship. Missing ids are an idempotent false result.
pub fn unregister(id: &str) -> NativeResult<bool> {
    let registration = PREVIEWS.lock().remove(id);
    let Some(registration) = registration else {
        return Ok(false);
    };
    unsafe { DwmUnregisterThumbnail(registration.thumbnail) }
        .map_err(|error| preview_error(error, "Failed to unregister DWM thumbnail"))?;
    Ok(true)
}

/// Returns all active native relationships without exposing HTHUMBNAIL handles.
pub fn get_active() -> Vec<DwmPreviewSnapshot> {
    PREVIEWS
        .lock()
        .values()
        .map(|registration| registration.snapshot.clone())
        .collect()
}

/// Releases every DWM thumbnail owned by this native-host process.
pub fn dispose_all() -> usize {
    let registrations: Vec<Registration> = PREVIEWS.lock().drain().map(|(_, value)| value).collect();
    let count = registrations.len();
    for registration in registrations {
        let _ = unsafe { DwmUnregisterThumbnail(registration.thumbnail) };
    }
    count
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_preview_rectangles() {
        assert!(PreviewRect { x: 0, y: 0, width: 320, height: 180 }.validate().is_ok());
        assert!(PreviewRect { x: 0, y: 0, width: 0, height: 180 }.validate().is_err());
        assert!(PreviewRect { x: 0, y: 0, width: 40_000, height: 180 }.validate().is_err());
    }

    #[test]
    fn invalid_window_registration_fails_without_leaking() {
        let before = get_active().len();
        let result = register(DwmPreviewSpec {
            id: "invalid-preview".to_string(),
            source_hwnd: 1,
            destination_hwnd: 2,
            destination_rect: PreviewRect { x: 0, y: 0, width: 320, height: 180 },
            opacity: 255,
            source_client_area_only: false,
            visible: true,
            process_id: 0,
            process_creation_time: 0.0,
        });
        assert!(result.is_err());
        assert_eq!(get_active().len(), before);
    }

    #[test]
    fn stale_process_identity_fails_without_leaking() {
        let before = get_active().len();
        let result = register(DwmPreviewSpec {
            id: "stale-pid-preview".to_string(),
            source_hwnd: 1,
            destination_hwnd: 2,
            destination_rect: PreviewRect { x: 0, y: 0, width: 320, height: 180 },
            opacity: 255,
            source_client_area_only: false,
            visible: true,
            process_id: 999_999,
            process_creation_time: 12345.0,
        });
        assert!(result.is_err());
        assert_eq!(get_active().len(), before);
    }

    #[test]
    fn revalidate_source_identity_detects_mismatches() {
        // Invalid window handle returns PREVIEW_SOURCE_IDENTITY_STALE
        let err = revalidate_source_identity(hwnd_from_isize(1), 100, 200.0).unwrap_err();
        assert_eq!(err.code, "PREVIEW_SOURCE_IDENTITY_STALE");

        // Non-finite creation time returns INVALID_ARGUMENT
        let err = revalidate_source_identity(hwnd_from_isize(1), 0, f64::NAN).unwrap_err();
        assert_eq!(err.code, "INVALID_ARGUMENT");

        // If shell window is available on this Windows session, test live identity fences
        let shell_hwnd = unsafe { windows::Win32::UI::WindowsAndMessaging::GetShellWindow() };
        if !shell_hwnd.0.is_null() {
            let mut shell_pid = 0u32;
            unsafe {
                GetWindowThreadProcessId(shell_hwnd, Some(&mut shell_pid));
            }
            if shell_pid != 0 {
                // Stale expected PID
                let err = revalidate_source_identity(shell_hwnd, shell_pid + 9999, 0.0).unwrap_err();
                assert_eq!(err.code, "PREVIEW_SOURCE_IDENTITY_STALE");

                // Stale expected creation time
                let err = revalidate_source_identity(shell_hwnd, shell_pid, 999_999_999.0).unwrap_err();
                assert_eq!(err.code, "PREVIEW_SOURCE_IDENTITY_STALE");

                // Valid live identity revalidation succeeds
                if let Ok(real_time) = query_process_creation_time(shell_pid) {
                    assert!(revalidate_source_identity(shell_hwnd, shell_pid, real_time as f64).is_ok());
                }
            }
        }
    }
}
