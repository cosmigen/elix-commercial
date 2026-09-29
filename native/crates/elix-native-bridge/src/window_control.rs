//! Native Bridge facade for Phase 14 Window Control.
//!
//! Raw Win32 mechanics are owned by `elix-native-core::window_control`; the bridge only
//! validates the transport-level lifetime contract, invokes the native-core primitive,
//! and serializes its result.

use elix_native_core::error::{NativeError, NativeResult};
use elix_native_core::window_control::execute_window_control as execute_native_window_control;

pub use elix_native_core::window_control::{NativeWindowControlRequest, NativeWindowControlResult};

/// Executes one RPC-originated Window Control command after requiring complete lifetime evidence.
///
/// The public ELIX service always supplies this evidence from Window Registry. Refusing weak
/// transport requests here prevents an internal/raw bridge caller from silently downgrading the
/// stale-HWND fence by omitting process creation time or window class.
pub fn execute_window_control(
    request: &NativeWindowControlRequest,
) -> NativeResult<NativeWindowControlResult> {
    if !request.target.process_creation_time.is_finite()
        || request.target.process_creation_time <= 0.0
    {
        return Err(identity_unverifiable(
            "Window Control requires finite positive process creation-time evidence",
        ));
    }

    if request
        .target
        .class_name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .is_none()
    {
        return Err(identity_unverifiable(
            "Window Control requires non-empty window-class lifetime evidence",
        ));
    }

    execute_native_window_control(request)
}

fn identity_unverifiable(message: impl Into<String>) -> NativeError {
    let mut error = NativeError::new("window-control", "IDENTITY_UNVERIFIABLE", message);
    error.retryable = Some(false);
    error
}
