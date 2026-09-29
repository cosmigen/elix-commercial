//! Error types and conversions for ELIX Native Core.

use serde::{Deserialize, Serialize};
use std::fmt;

/// Structured native error model shared across Rust and TypeScript.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeError {
    /// Domain identifying the subsystem where the error originated.
    pub domain: String,
    /// Symbolic machine-readable error code.
    pub code: String,
    /// Human-readable explanation.
    pub message: String,
    /// Optional underlying Win32 error code.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_code: Option<u32>,
    /// Optional underlying COM HRESULT.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hresult: Option<i32>,
    /// Whether the operation may succeed if retried.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retryable: Option<bool>,
}

impl NativeError {
    /// Creates a new custom NativeError.
    pub fn new(
        domain: impl Into<String>,
        code: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            domain: domain.into(),
            code: code.into(),
            message: message.into(),
            native_code: None,
            hresult: None,
            retryable: None,
        }
    }

    /// Creates a NativeError from a Win32 error code.
    pub fn from_win32(code: u32, context: &str) -> Self {
        Self {
            domain: "win32".to_string(),
            code: format!("WIN32_ERROR_{}", code),
            message: format!("{}: Win32 error {}", context, code),
            native_code: Some(code),
            hresult: None,
            retryable: Some(code == 58 || code == 121), // ERROR_NOTIFY_ENUM_DIR or ERROR_SEM_TIMEOUT
        }
    }

    /// Creates a NativeError from a COM HRESULT.
    pub fn from_hresult(hresult: windows::core::HRESULT, context: &str) -> Self {
        Self {
            domain: "com".to_string(),
            code: format!("HRESULT_0x{:08X}", hresult.0 as u32),
            message: format!("{}: COM HRESULT 0x{:08X}", context, hresult.0 as u32),
            native_code: None,
            hresult: Some(hresult.0),
            retryable: None,
        }
    }

    /// Creates a NativeError from a windows::core::Error.
    pub fn from_windows_error(err: windows::core::Error, context: &str) -> Self {
        Self {
            domain: "windows".to_string(),
            code: format!("WINDOWS_ERROR_0x{:08X}", err.code().0 as u32),
            message: format!("{}: {}", context, err.message()),
            native_code: None,
            hresult: Some(err.code().0),
            retryable: None,
        }
    }

    /// Creates an invalid argument error.
    pub fn invalid_argument(msg: impl Into<String>) -> Self {
        Self {
            domain: "native".to_string(),
            code: "INVALID_ARGUMENT".to_string(),
            message: msg.into(),
            native_code: None,
            hresult: None,
            retryable: Some(false),
        }
    }

    /// Creates a not-found error.
    pub fn not_found(msg: impl Into<String>) -> Self {
        Self {
            domain: "native".to_string(),
            code: "NOT_FOUND".to_string(),
            message: msg.into(),
            native_code: None,
            hresult: None,
            retryable: Some(false),
        }
    }

    /// Creates an I/O error.
    pub fn io_error(err: std::io::Error, context: &str) -> Self {
        Self {
            domain: "io".to_string(),
            code: format!("IO_ERROR_{:?}", err.kind()),
            message: format!("{}: {}", context, err),
            native_code: err.raw_os_error().map(|c| c as u32),
            hresult: None,
            retryable: None,
        }
    }

    /// Creates a panic boundary error.
    pub fn panic_error(msg: impl Into<String>) -> Self {
        Self {
            domain: "native".to_string(),
            code: "PANIC".to_string(),
            message: msg.into(),
            native_code: None,
            hresult: None,
            retryable: Some(false),
        }
    }

    /// Creates a cancelled error.
    pub fn cancelled(msg: impl Into<String>) -> Self {
        Self {
            domain: "native".to_string(),
            code: "CANCELLED".to_string(),
            message: msg.into(),
            native_code: None,
            hresult: None,
            retryable: Some(true),
        }
    }

    /// Creates a resource-exhausted error when capacity or memory limits are reached.
    pub fn resource_exhausted(msg: impl Into<String>) -> Self {
        Self {
            domain: "native".to_string(),
            code: "RESOURCE_EXHAUSTED".to_string(),
            message: msg.into(),
            native_code: None,
            hresult: None,
            retryable: Some(false),
        }
    }
}

impl fmt::Display for NativeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[{}::{}] {}", self.domain, self.code, self.message)
    }
}

impl std::error::Error for NativeError {}

impl From<windows::core::Error> for NativeError {
    fn from(err: windows::core::Error) -> Self {
        Self::from_windows_error(err, "Windows API operation failed")
    }
}

impl From<std::io::Error> for NativeError {
    fn from(err: std::io::Error) -> Self {
        Self::io_error(err, "Filesystem I/O failed")
    }
}

/// Specialized Result type for ELIX Native Core.
pub type NativeResult<T> = Result<T, NativeError>;
