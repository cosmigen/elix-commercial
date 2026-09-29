//! RPC Protocol types for ELIX Native Bridge.

use elix_native_core::error::NativeError;
use elix_native_core::{NATIVE_VERSION, PROTOCOL_VERSION};
use serde::{Deserialize, Serialize};
use std::io::{self, BufRead};

/// Maximum accepted NDJSON request frame size, excluding the newline delimiter.
pub const MAX_REQUEST_FRAME_BYTES: usize = 1024 * 1024;

/// Maximum shortcut paths accepted by one batch request.
pub const MAX_SHORTCUT_BATCH_ITEMS: usize = 512;

/// Result of reading one bounded NDJSON frame.
pub enum FrameRead {
    Frame(Vec<u8>),
    TooLarge,
    Eof,
}

/// Reads one line without allocating beyond the configured frame limit.
pub fn read_bounded_frame<R: BufRead>(reader: &mut R, limit: usize) -> io::Result<FrameRead> {
    let mut frame = Vec::with_capacity(limit.min(8 * 1024));
    let mut oversized = false;

    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return if oversized {
                Ok(FrameRead::TooLarge)
            } else if frame.is_empty() {
                Ok(FrameRead::Eof)
            } else {
                Ok(FrameRead::Frame(frame))
            };
        }

        let newline = available.iter().position(|byte| *byte == b'\n');
        let content_len = newline.unwrap_or(available.len());
        if !oversized {
            if frame.len().saturating_add(content_len) > limit {
                oversized = true;
                frame.clear();
            } else {
                frame.extend_from_slice(&available[..content_len]);
            }
        }

        let consumed = newline.map_or(available.len(), |index| index + 1);
        reader.consume(consumed);
        if newline.is_some() {
            return if oversized {
                Ok(FrameRead::TooLarge)
            } else {
                if frame.last() == Some(&b'\r') {
                    frame.pop();
                }
                Ok(FrameRead::Frame(frame))
            };
        }
    }
}

/// Incoming JSON-RPC style request from TypeScript host.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BridgeRequest {
    pub id: u64,
    pub method: String,
    #[serde(default)]
    pub params: serde_json::Value,
}

/// Outgoing response sent back to TypeScript host.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BridgeResponse {
    pub id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<NativeError>,
}

impl BridgeResponse {
    pub fn success(id: u64, result: serde_json::Value) -> Self {
        Self {
            id,
            result: Some(result),
            error: None,
        }
    }

    pub fn error(id: u64, error: NativeError) -> Self {
        Self {
            id,
            result: None,
            error: Some(error),
        }
    }
}

/// Outgoing push event streamed from native host to TypeScript.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BridgeEvent {
    pub event: String,
    pub payload: serde_json::Value,
    #[serde(skip)]
    pub subscription_id: Option<u64>,
}

/// Capability flags advertised during handshake.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeCapabilities {
    pub known_folders: bool,
    pub file_identity: bool,
    pub shell_links: bool,
    pub shell_icons: bool,
    pub namespace_watch: bool,
    pub process_launch: bool,
    pub process_observation: bool,
    pub windows_context: bool,
    pub surface: bool,
    pub window_preview: bool,
    pub app_bar: bool,
    pub window_registry: bool,
    pub spaces: bool,
    pub global_input: bool,
    pub window_control: bool,
}

impl Default for NativeCapabilities {
    fn default() -> Self {
        Self {
            known_folders: true,
            file_identity: true,
            shell_links: true,
            shell_icons: true,
            namespace_watch: true,
            process_launch: true,
            process_observation: true,
            windows_context: true,
            surface: true,
            window_preview: true,
            app_bar: true,
            window_registry: true,
            spaces: true,
            global_input: true,
            window_control: true,
        }
    }
}

/// Handshake result returned to TypeScript host upon initial connection.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HandshakeResult {
    pub protocol_version: u32,
    pub native_version: String,
    pub capabilities: NativeCapabilities,
}

impl Default for HandshakeResult {
    fn default() -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            native_version: NATIVE_VERSION.to_string(),
            capabilities: NativeCapabilities::default(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn bounded_frame_reader_recovers_after_oversized_frame() {
        let mut input = Cursor::new(b"123456789\n{}\n".to_vec());
        assert!(matches!(
            read_bounded_frame(&mut input, 8).unwrap(),
            FrameRead::TooLarge
        ));
        assert!(matches!(
            read_bounded_frame(&mut input, 8).unwrap(),
            FrameRead::Frame(frame) if frame == b"{}"
        ));
        assert!(matches!(
            read_bounded_frame(&mut input, 8).unwrap(),
            FrameRead::Eof
        ));
    }
}
