//! Public Windows virtual-desktop primitives for ELIX Spaces.
//!
//! This module deliberately uses only the documented `IVirtualDesktopManager` surface:
//! window -> desktop membership, current-desktop membership, and moving a top-level
//! window to a known desktop GUID. Enumeration, switching, creation, removal, rename,
//! and desktop notifications are not exposed because Windows does not provide those
//! operations through this public interface.

use crate::error::{NativeError, NativeResult};
use crate::runtime::apartment::ComApartment;
use crate::window_control::NativeWindowControlTarget;
use serde::{Deserialize, Serialize};
use windows::core::GUID;
use windows::Win32::Foundation::{CloseHandle, HWND};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
use windows::Win32::System::Threading::{
    GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Shell::{IVirtualDesktopManager, VirtualDesktopManager};
use windows::Win32::UI::WindowsAndMessaging::{
    GetAncestor, GetClassNameW, GetDesktopWindow, GetWindowLongPtrW, GetWindowThreadProcessId,
    IsWindow, GA_ROOT, GWL_STYLE, WS_CHILD,
};

/// One guarded query for a Window Registry-backed top-level application window.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativeSpacesWindowRequest {
    pub target: NativeWindowControlTarget,
}

/// One guarded move request. `desktop_id` is a canonical 36-character GUID without braces.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativeSpacesMoveRequest {
    pub target: NativeWindowControlTarget,
    pub desktop_id: String,
}

/// Public Windows virtual-desktop membership for one validated HWND.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeSpaceMembership {
    pub hwnd: isize,
    pub desktop_id: String,
    pub on_current_desktop: bool,
}

/// Queries the documented Windows virtual-desktop membership for one top-level window.
pub fn query_window_space(
    request: &NativeSpacesWindowRequest,
) -> NativeResult<NativeSpaceMembership> {
    let hwnd = validate_target(&request.target)?;
    let _com = ComApartment::mta()?;
    let manager = create_manager()?;

    // Fence again after COM activation so a recycled HWND cannot be queried.
    validate_target(&request.target)?;
    let desktop_id = unsafe { manager.GetWindowDesktopId(hwnd) }.map_err(|error| {
        spaces_windows_error(
            error,
            "MEMBERSHIP_QUERY_FAILED",
            "Unable to query the target window virtual desktop",
            true,
        )
    })?;
    if is_null_guid(&desktop_id) {
        return Err(spaces_error(
            "SPACE_ID_UNRESOLVED",
            "Windows returned GUID_NULL for the target window virtual desktop; membership is not authoritative yet",
            true,
        ));
    }

    let on_current_desktop = unsafe { manager.IsWindowOnCurrentVirtualDesktop(hwnd) }
        .map_err(|error| {
            spaces_windows_error(
                error,
                "CURRENT_MEMBERSHIP_QUERY_FAILED",
                "Unable to determine whether the target window is on the current virtual desktop",
                true,
            )
        })?
        .as_bool();

    // Fence the result after the COM calls as well.
    validate_target(&request.target)?;
    Ok(NativeSpaceMembership {
        hwnd: request.target.hwnd,
        desktop_id: guid_to_string(desktop_id),
        on_current_desktop,
    })
}

/// Moves a validated top-level window to a desktop GUID previously observed by ELIX.
pub fn move_window_to_space(
    request: &NativeSpacesMoveRequest,
) -> NativeResult<NativeSpaceMembership> {
    let desktop_id = GUID::try_from(request.desktop_id.as_str()).map_err(|_| {
        spaces_error(
            "INVALID_SPACE_ID",
            "Virtual desktop identifier must be a canonical 36-character GUID",
            false,
        )
    })?;
    if is_null_guid(&desktop_id) {
        return Err(spaces_error(
            "INVALID_SPACE_ID",
            "GUID_NULL is not a valid virtual desktop target",
            false,
        ));
    }

    let hwnd = validate_target(&request.target)?;
    let _com = ComApartment::mta()?;
    let manager = create_manager()?;

    validate_target(&request.target)?;
    unsafe { manager.MoveWindowToDesktop(hwnd, &desktop_id) }.map_err(|error| {
        spaces_windows_error(
            error,
            "MOVE_FAILED",
            "Windows rejected the virtual desktop move request",
            true,
        )
    })?;

    // Verify both lifetime and the committed desktop membership before reporting success.
    validate_target(&request.target)?;
    let committed_id = unsafe { manager.GetWindowDesktopId(hwnd) }.map_err(|error| {
        spaces_windows_error(
            error,
            "MOVE_VERIFICATION_FAILED",
            "Unable to verify virtual desktop membership after the move",
            true,
        )
    })?;
    if is_null_guid(&committed_id) {
        return Err(spaces_error(
            "MOVE_NOT_COMMITTED",
            "Windows returned GUID_NULL while verifying the requested virtual desktop move",
            true,
        ));
    }
    if committed_id != desktop_id {
        return Err(spaces_error(
            "MOVE_NOT_COMMITTED",
            "Windows returned success but the target window did not commit to the requested virtual desktop",
            true,
        ));
    }
    let on_current_desktop = unsafe { manager.IsWindowOnCurrentVirtualDesktop(hwnd) }
        .map_err(|error| {
            spaces_windows_error(
                error,
                "CURRENT_MEMBERSHIP_QUERY_FAILED",
                "Unable to verify current-desktop membership after the move",
                true,
            )
        })?
        .as_bool();
    validate_target(&request.target)?;

    Ok(NativeSpaceMembership {
        hwnd: request.target.hwnd,
        desktop_id: guid_to_string(committed_id),
        on_current_desktop,
    })
}

fn create_manager() -> NativeResult<IVirtualDesktopManager> {
    unsafe { CoCreateInstance(&VirtualDesktopManager, None, CLSCTX_INPROC_SERVER) }.map_err(
        |error| {
            spaces_windows_error(
                error,
                "VIRTUAL_DESKTOP_MANAGER_UNAVAILABLE",
                "Unable to activate the documented Windows VirtualDesktopManager COM class",
                false,
            )
        },
    )
}

/// Revalidates the same lifetime evidence used by Window Control without exposing raw HWNDs upward.
fn validate_target(target: &NativeWindowControlTarget) -> NativeResult<HWND> {
    if target.hwnd <= 0
        || target.process_id == 0
        || target.thread_id == 0
        || !target.process_creation_time.is_finite()
        || target.process_creation_time <= 0.0
    {
        return Err(stale_window("Window identity evidence is incomplete"));
    }

    let hwnd = HWND(target.hwnd as *mut _);
    if !unsafe { IsWindow(Some(hwnd)).as_bool() } {
        return Err(stale_window("Target HWND no longer exists"));
    }
    if hwnd == unsafe { GetDesktopWindow() } || unsafe { GetAncestor(hwnd, GA_ROOT) } != hwnd {
        return Err(spaces_error(
            "TARGET_NOT_TOP_LEVEL",
            "Spaces accepts only real top-level windows",
            false,
        ));
    }
    let style = unsafe { GetWindowLongPtrW(hwnd, GWL_STYLE) as u32 };
    if style & WS_CHILD.0 != 0 {
        return Err(spaces_error(
            "TARGET_NOT_TOP_LEVEL",
            "Child windows cannot be managed through Spaces",
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
    let expected_class = target
        .class_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| stale_window("Window class lifetime evidence is missing"))?;
    if class_name != expected_class {
        return Err(stale_window(
            "Target HWND class changed since Window Registry captured it",
        ));
    }
    if is_protected_class(&class_name) {
        return Err(spaces_error(
            "TARGET_PROTECTED",
            format!("Window class '{class_name}' is protected from external Spaces operations"),
            false,
        ));
    }

    let live_creation_time = query_process_creation_time(live_pid)? as f64;
    if live_creation_time != target.process_creation_time {
        return Err(stale_window(
            "Target process lifetime changed since Window Registry captured it",
        ));
    }
    Ok(hwnd)
}

fn query_process_creation_time(pid: u32) -> NativeResult<u64> {
    let handle =
        unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.map_err(|error| {
            spaces_windows_error(
                error,
                "IDENTITY_UNVERIFIABLE",
                "Unable to reopen target process for lifetime validation",
                true,
            )
        })?;

    let mut creation = windows::Win32::Foundation::FILETIME::default();
    let mut exit = windows::Win32::Foundation::FILETIME::default();
    let mut kernel = windows::Win32::Foundation::FILETIME::default();
    let mut user = windows::Win32::Foundation::FILETIME::default();
    let result =
        unsafe { GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) };
    let _ = unsafe { CloseHandle(handle) };
    result.map_err(|error| {
        spaces_windows_error(
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

fn is_null_guid(guid: &GUID) -> bool {
    guid.data1 == 0
        && guid.data2 == 0
        && guid.data3 == 0
        && guid.data4.iter().all(|value| *value == 0)
}

fn guid_to_string(guid: GUID) -> String {
    format!(
        "{:08x}-{:04x}-{:04x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        guid.data1,
        guid.data2,
        guid.data3,
        guid.data4[0],
        guid.data4[1],
        guid.data4[2],
        guid.data4[3],
        guid.data4[4],
        guid.data4[5],
        guid.data4[6],
        guid.data4[7],
    )
}

fn stale_window(message: impl Into<String>) -> NativeError {
    spaces_error("STALE_WINDOW_ID", message, true)
}

fn spaces_error(code: &str, message: impl Into<String>, retryable: bool) -> NativeError {
    let mut error = NativeError::new("spaces", code, message);
    error.retryable = Some(retryable);
    error
}

fn spaces_windows_error(
    error: windows::core::Error,
    code: &str,
    context: &str,
    retryable: bool,
) -> NativeError {
    let mut native = NativeError::from_windows_error(error, context);
    native.domain = "spaces".to_string();
    native.code = code.to_string();
    native.retryable = Some(retryable);
    native
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guid_format_is_canonical_lowercase() {
        let guid = GUID::from_values(
            0xAABBCCDD,
            0xEEFF,
            0x1234,
            [0x56, 0x78, 0x9A, 0xBC, 0xDE, 0xF0, 0x11, 0x22],
        );
        assert_eq!(guid_to_string(guid), "aabbccdd-eeff-1234-5678-9abcdef01122");
    }

    #[test]
    fn null_guid_is_not_a_space_identity() {
        let guid = GUID::from_values(0, 0, 0, [0; 8]);
        assert!(is_null_guid(&guid));
    }

    #[test]
    fn invalid_move_guid_is_rejected_before_com_activation() {
        let request = NativeSpacesMoveRequest {
            target: NativeWindowControlTarget {
                hwnd: 1,
                process_id: 1,
                thread_id: 1,
                process_creation_time: 1.0,
                class_name: Some("TestWindow".to_string()),
            },
            desktop_id: "not-a-guid".to_string(),
        };
        let error = move_window_to_space(&request).unwrap_err();
        assert_eq!(error.domain, "spaces");
        assert_eq!(error.code, "INVALID_SPACE_ID");
        assert_eq!(error.retryable, Some(false));
    }

    #[test]
    fn null_move_guid_is_rejected_before_window_validation() {
        let request = NativeSpacesMoveRequest {
            target: NativeWindowControlTarget {
                hwnd: 1,
                process_id: 1,
                thread_id: 1,
                process_creation_time: 1.0,
                class_name: Some("TestWindow".to_string()),
            },
            desktop_id: "00000000-0000-0000-0000-000000000000".to_string(),
        };
        let error = move_window_to_space(&request).unwrap_err();
        assert_eq!(error.domain, "spaces");
        assert_eq!(error.code, "INVALID_SPACE_ID");
        assert_eq!(error.retryable, Some(false));
    }
}
