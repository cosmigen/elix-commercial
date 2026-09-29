//! Runtime-probed Windows Shell virtual-desktop provider for Phase 18A.
//!
//! The stable cross-process membership path remains in `spaces.rs` and uses the
//! documented `IVirtualDesktopManager`. Rich lifecycle/control operations are
//! isolated here because `winvd` binds undocumented Explorer/Shell COM.

use crate::error::{NativeError, NativeResult};
use crate::spaces::{
    query_window_space, NativeSpaceMembership, NativeSpacesMoveRequest, NativeSpacesWindowRequest,
};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

const SHELL_BACKEND: &str = "winvd-0.0.49";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeShellSpace {
    pub desktop_id: String,
    pub index: u32,
    pub name: String,
    pub is_current: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeShellSpacesSnapshot {
    pub provider: String,
    pub backend_version: String,
    pub spaces: Vec<NativeShellSpace>,
    pub current_desktop_id: String,
    pub native_notifications: bool,
    pub notification_generation: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeShellSpaceRequest {
    pub desktop_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct NativeShellCreateSpaceRequest {
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeShellRemoveSpaceRequest {
    pub desktop_id: String,
    pub fallback_desktop_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeShellRenameSpaceRequest {
    pub desktop_id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeShellNotificationStatus {
    pub generation: u64,
    pub active: bool,
}

struct ShellNotificationState {
    _listener: winvd::DesktopEventThread,
}

static SHELL_NOTIFICATION_STATE: OnceLock<Mutex<Option<ShellNotificationState>>> = OnceLock::new();
static SHELL_NOTIFICATION_GENERATION: AtomicU64 = AtomicU64::new(1);

/// Complete desktop enumeration. Successful return is the Shell runtime probe.
pub fn shell_spaces_snapshot() -> NativeResult<NativeShellSpacesSnapshot> {
    let desktops = winvd::get_desktops().map_err(|error| {
        shell_backend_error(
            "SHELL_ENUMERATION_FAILED",
            "Unable to enumerate Windows Shell virtual desktops",
            error,
            true,
        )
    })?;
    if desktops.is_empty() {
        return Err(shell_error(
            "SHELL_ENUMERATION_FAILED",
            "Windows Shell returned zero virtual desktops",
            true,
        ));
    }

    let current = winvd::get_current_desktop().map_err(|error| {
        shell_backend_error(
            "SHELL_CURRENT_FAILED",
            "Unable to resolve the current Windows Shell virtual desktop",
            error,
            true,
        )
    })?;
    let current_id = desktop_id(&current)?;

    let mut spaces = Vec::with_capacity(desktops.len());
    for (position, desktop) in desktops.iter().enumerate() {
        let id = desktop_id(desktop)?;
        spaces.push(NativeShellSpace {
            is_current: id == current_id,
            desktop_id: id,
            index: desktop.get_index().unwrap_or(position as u32),
            name: desktop.get_name().unwrap_or_default(),
        });
    }
    spaces.sort_by_key(|space| space.index);

    if !spaces.iter().any(|space| space.desktop_id == current_id) {
        return Err(shell_error(
            "SHELL_INCONSISTENT_STATE",
            "Current Windows Shell desktop was not present in the enumerated desktop set",
            true,
        ));
    }

    let (native_notifications, notification_generation) = match shell_notification_status() {
        Ok(status) => (status.active, status.generation),
        Err(_) => (
            false,
            SHELL_NOTIFICATION_GENERATION.load(Ordering::Acquire),
        ),
    };

    Ok(NativeShellSpacesSnapshot {
        provider: "windows-shell-virtual-desktop".to_string(),
        backend_version: SHELL_BACKEND.to_string(),
        spaces,
        current_desktop_id: current_id,
        native_notifications,
        notification_generation,
    })
}

pub fn shell_switch_space(
    request: &NativeShellSpaceRequest,
) -> NativeResult<NativeShellSpacesSnapshot> {
    let requested_id = canonical_desktop_id(&request.desktop_id)?;
    let index = shell_index_for_id(&requested_id)?;
    winvd::switch_desktop(index).map_err(|error| {
        shell_backend_error(
            "SHELL_SWITCH_FAILED",
            "Windows Shell rejected the virtual desktop switch",
            error,
            true,
        )
    })?;

    let snapshot = shell_spaces_snapshot()?;
    if snapshot.current_desktop_id != requested_id {
        return Err(shell_error(
            "SHELL_SWITCH_NOT_COMMITTED",
            "Windows Shell returned from switch but the requested desktop is not current",
            true,
        ));
    }
    Ok(snapshot)
}

pub fn shell_create_space(
    request: &NativeShellCreateSpaceRequest,
) -> NativeResult<NativeShellSpace> {
    validate_optional_name(request.name.as_deref())?;
    let desktop = winvd::create_desktop().map_err(|error| {
        shell_backend_error(
            "SHELL_CREATE_FAILED",
            "Windows Shell rejected virtual desktop creation",
            error,
            true,
        )
    })?;

    if let Some(name) = request.name.as_deref() {
        desktop.set_name(name).map_err(|error| {
            shell_backend_error(
                "SHELL_RENAME_FAILED",
                "Windows Shell created the desktop but rejected its requested name",
                error,
                true,
            )
        })?;
    }

    let created_id = desktop_id(&desktop)?;
    shell_spaces_snapshot()?
        .spaces
        .into_iter()
        .find(|space| space.desktop_id == created_id)
        .ok_or_else(|| {
            shell_error(
                "SHELL_CREATE_NOT_COMMITTED",
                "Created Windows Shell desktop was absent from the verification snapshot",
                true,
            )
        })
}

pub fn shell_remove_space(
    request: &NativeShellRemoveSpaceRequest,
) -> NativeResult<NativeShellSpacesSnapshot> {
    let target_id = canonical_desktop_id(&request.desktop_id)?;
    let fallback_id = canonical_desktop_id(&request.fallback_desktop_id)?;
    if target_id == fallback_id {
        return Err(shell_error(
            "INVALID_FALLBACK_SPACE",
            "A virtual desktop cannot use itself as the removal fallback",
            false,
        ));
    }

    let before = shell_spaces_snapshot()?;
    if before.spaces.len() <= 1 {
        return Err(shell_error(
            "LAST_SPACE_PROTECTED",
            "Windows must retain at least one virtual desktop",
            false,
        ));
    }

    let target_index = before
        .spaces
        .iter()
        .find(|space| space.desktop_id == target_id)
        .map(|space| space.index)
        .ok_or_else(|| shell_error("STALE_SPACE_ID", "Target desktop is no longer present", true))?;
    let fallback_index = before
        .spaces
        .iter()
        .find(|space| space.desktop_id == fallback_id)
        .map(|space| space.index)
        .ok_or_else(|| {
            shell_error(
                "STALE_SPACE_ID",
                "Fallback desktop is no longer present",
                true,
            )
        })?;

    winvd::remove_desktop(target_index, fallback_index).map_err(|error| {
        shell_backend_error(
            "SHELL_REMOVE_FAILED",
            "Windows Shell rejected virtual desktop removal",
            error,
            true,
        )
    })?;

    let after = shell_spaces_snapshot()?;
    if after.spaces.iter().any(|space| space.desktop_id == target_id) {
        return Err(shell_error(
            "SHELL_REMOVE_NOT_COMMITTED",
            "Windows Shell returned from removal but the target desktop is still present",
            true,
        ));
    }
    Ok(after)
}

pub fn shell_rename_space(
    request: &NativeShellRenameSpaceRequest,
) -> NativeResult<NativeShellSpace> {
    validate_name(&request.name)?;
    let target_id = canonical_desktop_id(&request.desktop_id)?;
    let index = shell_index_for_id(&target_id)?;
    let desktop = winvd::get_desktop(index);
    desktop.set_name(&request.name).map_err(|error| {
        shell_backend_error(
            "SHELL_RENAME_FAILED",
            "Windows Shell rejected the virtual desktop rename",
            error,
            true,
        )
    })?;

    shell_spaces_snapshot()?
        .spaces
        .into_iter()
        .find(|space| space.desktop_id == target_id && space.name == request.name)
        .ok_or_else(|| {
            shell_error(
                "SHELL_RENAME_NOT_COMMITTED",
                "Windows Shell returned from rename but verification did not observe the requested name",
                true,
            )
        })
}

/// Moves an arbitrary validated application through the Shell application-view path.
pub fn shell_move_window_to_space(
    request: &NativeSpacesMoveRequest,
) -> NativeResult<NativeSpaceMembership> {
    let target_id = canonical_desktop_id(&request.desktop_id)?;
    let query = NativeSpacesWindowRequest {
        target: request.target.clone(),
    };

    // Documented membership lookup supplies the same lifetime fence before private COM.
    let _before = query_window_space(&query)?;
    let index = shell_index_for_id(&target_id)?;

    // `winvd 0.0.49` is pinned to windows-rs 0.58. Its HWND is a transparent
    // pointer wrapper, while ELIX transports HWND as isize across JSON. Convert
    // only at this isolated ABI boundary instead of leaking a second HWND type.
    let hwnd = windows58::Win32::Foundation::HWND(
        request.target.hwnd as *mut core::ffi::c_void,
    );
    winvd::move_window_to_desktop(index, &hwnd).map_err(|error| {
        shell_backend_error(
            "SHELL_MOVE_FAILED",
            "Windows Shell rejected the application-view desktop move",
            error,
            true,
        )
    })?;

    // Re-querying verifies committed membership and re-fences HWND lifetime.
    let after = query_window_space(&query)?;
    if after.desktop_id != target_id {
        return Err(shell_error(
            "SHELL_MOVE_NOT_COMMITTED",
            "Windows Shell returned from move but the window is not on the requested desktop",
            true,
        ));
    }
    Ok(after)
}

/// Starts one process-lifetime native notification listener and exposes its generation.
pub fn shell_notification_status() -> NativeResult<NativeShellNotificationStatus> {
    let state = SHELL_NOTIFICATION_STATE.get_or_init(|| Mutex::new(None));
    let mut guard = state.lock().map_err(|_| {
        shell_error(
            "SHELL_NOTIFICATION_STATE_POISONED",
            "Windows Shell notification state mutex is poisoned",
            true,
        )
    })?;

    if guard.is_none() {
        let (sender, receiver) = std::sync::mpsc::channel::<winvd::DesktopEvent>();
        let listener = winvd::listen_desktop_events(sender).map_err(|error| {
            shell_backend_error(
                "SHELL_NOTIFICATIONS_UNAVAILABLE",
                "Unable to register Windows Shell virtual desktop notifications",
                error,
                true,
            )
        })?;

        std::thread::Builder::new()
            .name("elix-spaces-notification-forwarder".to_string())
            .spawn(move || {
                while receiver.recv().is_ok() {
                    SHELL_NOTIFICATION_GENERATION.fetch_add(1, Ordering::AcqRel);
                }
            })
            .map_err(|error| {
                shell_error(
                    "SHELL_NOTIFICATION_THREAD_FAILED",
                    format!("Unable to start Spaces notification forwarder: {error}"),
                    true,
                )
            })?;

        *guard = Some(ShellNotificationState {
            _listener: listener,
        });
    }

    Ok(NativeShellNotificationStatus {
        generation: SHELL_NOTIFICATION_GENERATION.load(Ordering::Acquire),
        active: true,
    })
}

fn shell_index_for_id(desktop_id: &str) -> NativeResult<u32> {
    let requested_id = canonical_desktop_id(desktop_id)?;
    shell_spaces_snapshot()?
        .spaces
        .into_iter()
        .find(|space| space.desktop_id == requested_id)
        .map(|space| space.index)
        .ok_or_else(|| {
            shell_error(
                "STALE_SPACE_ID",
                "Virtual desktop is no longer present",
                true,
            )
        })
}

fn desktop_id(desktop: &winvd::Desktop) -> NativeResult<String> {
    let guid = desktop.get_id().map_err(|error| {
        shell_backend_error(
            "SHELL_DESKTOP_ID_FAILED",
            "Unable to read Windows Shell virtual desktop GUID",
            error,
            true,
        )
    })?;
    if is_null_guid_parts(guid.data1, guid.data2, guid.data3, &guid.data4) {
        return Err(shell_error(
            "SPACE_ID_UNRESOLVED",
            "Windows Shell returned GUID_NULL for a virtual desktop",
            true,
        ));
    }
    Ok(format_guid_parts(
        guid.data1, guid.data2, guid.data3, &guid.data4,
    ))
}

fn canonical_desktop_id(value: &str) -> NativeResult<String> {
    let guid = windows::core::GUID::try_from(value).map_err(|_| {
        shell_error(
            "INVALID_SPACE_ID",
            "Virtual desktop identifier must be a canonical GUID",
            false,
        )
    })?;
    if is_null_guid_parts(guid.data1, guid.data2, guid.data3, &guid.data4) {
        return Err(shell_error(
            "INVALID_SPACE_ID",
            "GUID_NULL is not a valid virtual desktop identifier",
            false,
        ));
    }
    Ok(format_guid_parts(
        guid.data1, guid.data2, guid.data3, &guid.data4,
    ))
}

fn is_null_guid_parts(data1: u32, data2: u16, data3: u16, data4: &[u8; 8]) -> bool {
    data1 == 0 && data2 == 0 && data3 == 0 && data4.iter().all(|byte| *byte == 0)
}

fn format_guid_parts(data1: u32, data2: u16, data3: u16, data4: &[u8; 8]) -> String {
    format!(
        "{:08x}-{:04x}-{:04x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        data1,
        data2,
        data3,
        data4[0],
        data4[1],
        data4[2],
        data4[3],
        data4[4],
        data4[5],
        data4[6],
        data4[7],
    )
}

fn validate_optional_name(name: Option<&str>) -> NativeResult<()> {
    if let Some(name) = name {
        validate_name(name)?;
    }
    Ok(())
}

fn validate_name(name: &str) -> NativeResult<()> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(shell_error(
            "INVALID_SPACE_NAME",
            "Virtual desktop name must not be empty",
            false,
        ));
    }
    if trimmed.chars().count() > 128 {
        return Err(shell_error(
            "INVALID_SPACE_NAME",
            "Virtual desktop name must be 128 characters or fewer",
            false,
        ));
    }
    Ok(())
}

fn shell_backend_error(
    code: &str,
    context: &str,
    error: winvd::Error,
    retryable: bool,
) -> NativeError {
    shell_error(code, format!("{context}: {error:?}"), retryable)
}

fn shell_error(code: &str, message: impl Into<String>, retryable: bool) -> NativeError {
    let mut error = NativeError::new("spaces-shell", code, message);
    error.retryable = Some(retryable);
    error
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_id_validation_rejects_null_and_malformed_values() {
        assert!(canonical_desktop_id("nope").is_err());
        assert!(canonical_desktop_id("00000000-0000-0000-0000-000000000000").is_err());
        assert_eq!(
            canonical_desktop_id("AABBCCDD-EEFF-1234-5678-9ABCDEF01122").unwrap(),
            "aabbccdd-eeff-1234-5678-9abcdef01122"
        );
    }

    #[test]
    fn desktop_name_validation_is_bounded() {
        assert!(validate_name("").is_err());
        assert!(validate_name("   ").is_err());
        assert!(validate_name(&"x".repeat(129)).is_err());
        assert!(validate_name("Work").is_ok());
    }
}
