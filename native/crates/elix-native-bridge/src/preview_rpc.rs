//! RPC adapter for Phase 17A native DWM preview composition.

use crate::protocol::{BridgeRequest, BridgeResponse};
use elix_native_core::error::NativeError;
use elix_native_core::window_preview::{
    dispose_all, get_active, query, register, unregister, update, DwmPreviewSpec, DwmPreviewUpdate,
};
use serde_json::json;
use std::panic::{catch_unwind, AssertUnwindSafe};

/// Returns whether a method belongs to the dedicated preview RPC namespace.
pub fn handles(method: &str) -> bool {
    matches!(
        method,
        "preview/register"
            | "preview/update"
            | "preview/unregister"
            | "preview/query"
            | "preview/getActive"
            | "preview/disposeAll"
    )
}

/// Dispatches one preview request with the same panic boundary as the main dispatcher.
pub fn dispatch(request: BridgeRequest) -> BridgeResponse {
    let id = request.id;
    let result = catch_unwind(AssertUnwindSafe(|| handle_method(&request.method, request.params)));
    match result {
        Ok(Ok(value)) => BridgeResponse::success(id, value),
        Ok(Err(error)) => BridgeResponse::error(id, error),
        Err(payload) => {
            let message = if let Some(message) = payload.downcast_ref::<&str>() {
                (*message).to_string()
            } else if let Some(message) = payload.downcast_ref::<String>() {
                message.clone()
            } else {
                "Unknown preview backend panic".to_string()
            };
            BridgeResponse::error(id, NativeError::panic_error(message))
        }
    }
}

fn handle_method(
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, NativeError> {
    match method {
        "preview/register" => {
            let spec: DwmPreviewSpec = serde_json::from_value(params).map_err(|error| {
                NativeError::invalid_argument(format!("Invalid DwmPreviewSpec: {}", error))
            })?;
            Ok(json!(register(spec)?))
        }
        "preview/update" => {
            let update_spec: DwmPreviewUpdate = serde_json::from_value(params).map_err(|error| {
                NativeError::invalid_argument(format!("Invalid DwmPreviewUpdate: {}", error))
            })?;
            Ok(json!(update(update_spec)?))
        }
        "preview/unregister" => {
            let id = params
                .get("id")
                .and_then(|value| value.as_str())
                .ok_or_else(|| NativeError::invalid_argument("Missing preview 'id' parameter"))?;
            Ok(json!({ "unregistered": unregister(id)? }))
        }
        "preview/query" => {
            let id = params
                .get("id")
                .and_then(|value| value.as_str())
                .ok_or_else(|| NativeError::invalid_argument("Missing preview 'id' parameter"))?;
            Ok(json!(query(id)?))
        }
        "preview/getActive" => Ok(json!({ "previews": get_active() })),
        "preview/disposeAll" => Ok(json!({ "disposed": dispose_all() })),
        _ => Err(NativeError::new(
            "bridge",
            "METHOD_NOT_FOUND",
            format!("Unrecognized preview RPC method: '{}'", method),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_only_preview_namespace_contracts() {
        assert!(handles("preview/register"));
        assert!(handles("preview/getActive"));
        assert!(!handles("surface/create"));
        assert!(!handles("preview/unknown"));
    }

    #[test]
    fn invalid_registration_returns_typed_error() {
        let response = dispatch(BridgeRequest {
            id: 1,
            method: "preview/register".to_string(),
            params: json!({
                "id": "bad",
                "sourceHwnd": 1,
                "destinationHwnd": 2,
                "destinationRect": { "x": 0, "y": 0, "width": 0, "height": 120 }
            }),
        });
        assert_eq!(response.id, 1);
        assert!(response.result.is_none());
        assert_eq!(response.error.expect("typed error").code, "INVALID_ARGUMENT");
    }
}
