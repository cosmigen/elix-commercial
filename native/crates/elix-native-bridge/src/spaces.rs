//! Native Bridge facade for Phase 18A Spaces.
//!
//! Public membership remains backed by documented `IVirtualDesktopManager`.
//! Rich desktop lifecycle/control is delegated to the separately runtime-probed
//! Shell provider so an Explorer/ABI failure can fall back without weakening
//! Window Registry lifetime fencing.

use elix_native_core::error::{NativeError, NativeResult};
use elix_native_core::shell_spaces::{
    shell_create_space as create_native_shell_space,
    shell_move_window_to_space as move_native_shell_window,
    shell_notification_status as native_shell_notification_status,
    shell_remove_space as remove_native_shell_space,
    shell_rename_space as rename_native_shell_space,
    shell_spaces_snapshot as native_shell_snapshot,
    shell_switch_space as switch_native_shell_space,
};
use elix_native_core::spaces::{
    move_window_to_space as move_native_window_to_space,
    query_window_space as query_native_window_space,
};

pub use elix_native_core::shell_spaces::{
    NativeShellCreateSpaceRequest, NativeShellNotificationStatus, NativeShellRemoveSpaceRequest,
    NativeShellRenameSpaceRequest, NativeShellSpace, NativeShellSpaceRequest,
    NativeShellSpacesSnapshot,
};
pub use elix_native_core::spaces::{
    NativeSpaceMembership, NativeSpacesMoveRequest, NativeSpacesWindowRequest,
};

pub fn query_window_space(
    request: &NativeSpacesWindowRequest,
) -> NativeResult<NativeSpaceMembership> {
    validate_transport_target(&request.target)?;
    query_native_window_space(request)
}

/// Documented move route kept only for compatibility/diagnostics. The TypeScript
/// authority does not advertise it for arbitrary cross-process application moves.
pub fn move_window_to_space(
    request: &NativeSpacesMoveRequest,
) -> NativeResult<NativeSpaceMembership> {
    validate_transport_target(&request.target)?;
    validate_desktop_id(&request.desktop_id)?;
    move_native_window_to_space(request)
}

pub fn shell_snapshot() -> NativeResult<NativeShellSpacesSnapshot> {
    native_shell_snapshot()
}

pub fn shell_notification_status() -> NativeResult<NativeShellNotificationStatus> {
    native_shell_notification_status()
}

pub fn shell_switch_space(
    request: &NativeShellSpaceRequest,
) -> NativeResult<NativeShellSpacesSnapshot> {
    validate_desktop_id(&request.desktop_id)?;
    switch_native_shell_space(request)
}

pub fn shell_create_space(
    request: &NativeShellCreateSpaceRequest,
) -> NativeResult<NativeShellSpace> {
    create_native_shell_space(request)
}

pub fn shell_remove_space(
    request: &NativeShellRemoveSpaceRequest,
) -> NativeResult<NativeShellSpacesSnapshot> {
    validate_desktop_id(&request.desktop_id)?;
    validate_desktop_id(&request.fallback_desktop_id)?;
    remove_native_shell_space(request)
}

pub fn shell_rename_space(
    request: &NativeShellRenameSpaceRequest,
) -> NativeResult<NativeShellSpace> {
    validate_desktop_id(&request.desktop_id)?;
    rename_native_shell_space(request)
}

pub fn shell_move_window_to_space(
    request: &NativeSpacesMoveRequest,
) -> NativeResult<NativeSpaceMembership> {
    validate_transport_target(&request.target)?;
    validate_desktop_id(&request.desktop_id)?;
    move_native_shell_window(request)
}

fn validate_transport_target(
    target: &elix_native_core::window_control::NativeWindowControlTarget,
) -> NativeResult<()> {
    if target.hwnd <= 0 || target.process_id == 0 || target.thread_id == 0 {
        return Err(identity_unverifiable(
            "Spaces requires complete HWND/PID/TID identity evidence",
        ));
    }
    if !target.process_creation_time.is_finite() || target.process_creation_time <= 0.0 {
        return Err(identity_unverifiable(
            "Spaces requires finite positive process creation-time evidence",
        ));
    }
    if target
        .class_name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .is_none()
    {
        return Err(identity_unverifiable(
            "Spaces requires non-empty window-class lifetime evidence",
        ));
    }
    Ok(())
}

fn validate_desktop_id(desktop_id: &str) -> NativeResult<()> {
    if desktop_id.trim().is_empty() {
        return Err(NativeError::invalid_argument(
            "Spaces requires a non-empty desktopId",
        ));
    }
    Ok(())
}

fn identity_unverifiable(message: impl Into<String>) -> NativeError {
    let mut error = NativeError::new("spaces", "IDENTITY_UNVERIFIABLE", message);
    error.retryable = Some(false);
    error
}
