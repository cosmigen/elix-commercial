//! Core types and data structures for ELIX Surface Core.

use crate::error::NativeError;
use serde::{Deserialize, Serialize};

/// Canonical physical-pixel bounds for a native surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhysicalBounds {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl PhysicalBounds {
    pub const fn new(x: i32, y: i32, width: i32, height: i32) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }

    /// Validates surface dimensions. Dimensions must be positive and within reasonable limits.
    pub fn validate(&self) -> Result<(), NativeError> {
        if self.width <= 0 {
            return Err(NativeError::invalid_argument(format!(
                "Invalid surface width: {}. Width must be positive physical pixels.",
                self.width
            )));
        }
        if self.height <= 0 {
            return Err(NativeError::invalid_argument(format!(
                "Invalid surface height: {}. Height must be positive physical pixels.",
                self.height
            )));
        }
        if self.width > 32767 || self.height > 32767 {
            return Err(NativeError::invalid_argument(format!(
                "Surface dimensions {}x{} exceed maximum Win32 coordinate limit (32767).",
                self.width, self.height
            )));
        }
        Ok(())
    }
}

/// Window focus and activation policy for a native surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum SurfaceFocusPolicy {
    /// Surface can gain foreground focus and activate normally.
    #[default]
    Normal,
    /// Surface never steals foreground focus upon creation or click (WS_EX_NOACTIVATE / MA_NOACTIVATE).
    NoActivate,
}

/// Z-Order placement policy for a native surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum SurfaceZOrderPolicy {
    /// Normal window z-order.
    #[default]
    Normal,
    /// Always on top of normal windows (WS_EX_TOPMOST / HWND_TOPMOST).
    Topmost,
    /// Placed at the bottom of the z-order behind normal application windows (HWND_BOTTOM).
    Bottom,
}

/// Renderer specification specifying the content loaded in the surface's WebView2.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "target", rename_all = "camelCase")]
pub enum SurfaceRendererSpec {
    /// URL to load (e.g. `http://localhost:5173`, `file:///...`).
    Url(String),
    /// Raw HTML string content to navigate to directly.
    Html(String),
}

impl SurfaceRendererSpec {
    /// Validates navigation target security. Shell surfaces are restricted to local,
    /// loopback HTTP(S) destinations and about:blank to prevent arbitrary web execution.
    pub fn validate(&self) -> Result<(), NativeError> {
        match self {
            Self::Url(url) => validate_renderer_url(url),
            Self::Html(html) => {
                if html.trim().is_empty() {
                    return Err(NativeError::invalid_argument(
                        "Surface renderer HTML string must not be empty.",
                    ));
                }
                Ok(())
            }
        }
    }
}

/// Authoritative structural validation for surface renderer URLs.
///
/// Shell surfaces are strictly constrained to loopback HTTP/HTTPS (localhost,
/// 127.0.0.1, ::1) and about:blank. Arbitrary file://, data:, and external
/// web URLs are disallowed.
pub fn validate_renderer_url(url: &str) -> Result<(), NativeError> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err(NativeError::invalid_argument(
            "Surface renderer URL must not be empty.",
        ));
    }

    if trimmed.eq_ignore_ascii_case("about:blank") {
        return Ok(());
    }

    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("file://") || lower.starts_with("file:") {
        return Err(NativeError::invalid_argument(
            "file:// URLs are not permitted for shell surfaces in Phase 7.",
        ));
    }
    if lower.starts_with("data:") {
        return Err(NativeError::invalid_argument(
            "data: URLs are not permitted for shell surfaces in Phase 7.",
        ));
    }

    let (scheme, rest) = trimmed
        .split_once("://")
        .ok_or_else(|| NativeError::invalid_argument(format!("Invalid URL format: '{}'", url)))?;

    let scheme_lower = scheme.to_ascii_lowercase();
    if scheme_lower != "http" && scheme_lower != "https" {
        return Err(NativeError::invalid_argument(format!(
            "Unsupported scheme '{}'. Only loopback http, https, and about:blank are permitted.",
            scheme
        )));
    }

    // Extract authority component (before '/', '?', '#')
    let authority = rest.split(['/', '?', '#']).next().unwrap_or(rest);

    if authority.is_empty() {
        return Err(NativeError::invalid_argument(
            "URL authority must not be empty.",
        ));
    }

    // Reject userinfo / credentials in authority to prevent spoofing (e.g. http://localhost@evil.example/)
    if authority.contains('@') {
        return Err(NativeError::invalid_argument(
            "Userinfo / credentials are not permitted in surface renderer URLs.",
        ));
    }

    // Parse host and optional port
    let host = if authority.starts_with('[') {
        // IPv6 literal e.g. [::1] or [::1]:8080
        let close_bracket = authority.find(']').ok_or_else(|| {
            NativeError::invalid_argument("Malformed IPv6 literal in URL authority.")
        })?;
        let ip6_host = &authority[1..close_bracket];
        let port_part = &authority[close_bracket + 1..];
        if !port_part.is_empty() {
            if !port_part.starts_with(':') {
                return Err(NativeError::invalid_argument(
                    "Malformed port separator after IPv6 address.",
                ));
            }
            let port_str = &port_part[1..];
            let port = port_str.parse::<u16>().map_err(|_| {
                NativeError::invalid_argument(format!("Invalid port number '{}'.", port_str))
            })?;
            if port == 0 {
                return Err(NativeError::invalid_argument("Port number must not be 0."));
            }
        }
        ip6_host
    } else {
        let (h, port_opt) = match authority.split_once(':') {
            Some((h, p)) => (h, Some(p)),
            None => (authority, None),
        };
        if let Some(port_str) = port_opt {
            let port = port_str.parse::<u16>().map_err(|_| {
                NativeError::invalid_argument(format!("Invalid port number '{}'.", port_str))
            })?;
            if port == 0 {
                return Err(NativeError::invalid_argument("Port number must not be 0."));
            }
        }
        h
    };

    let host_lower = host.to_ascii_lowercase();
    let is_allowed_host =
        host_lower == "localhost" || host_lower == "127.0.0.1" || host_lower == "::1";

    if !is_allowed_host {
        return Err(NativeError::invalid_argument(format!(
            "Disallowed host '{}'. Only loopback hosts ('localhost', '127.0.0.1', '::1') are permitted for shell surfaces.",
            host
        )));
    }

    Ok(())
}

/// Explicit lifecycle state of a native surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SurfaceLifecycleState {
    /// Surface allocation intent registered.
    Allocated,
    /// Win32 HWND successfully created.
    NativeCreated,
    /// WebView2 environment and controller initialization in progress.
    WebviewInitializing,
    /// WebView2 controller attached to HWND.
    WebviewCreated,
    /// Navigation to target renderer in progress.
    Navigating,
    /// Renderer reported navigation completion.
    RendererReady,
    /// Ready for presentation (native + renderer readiness proven).
    Ready,
    /// Surface visible on screen.
    Visible,
    /// Surface hidden / suspended.
    Hidden,
    /// Surface encountered a terminal fault or initialization error.
    Faulted,
    /// Teardown in progress.
    Destroying,
    /// Surface completely disposed, resources released.
    Disposed,
}

impl SurfaceLifecycleState {
    pub const fn is_alive(self) -> bool {
        !matches!(self, Self::Destroying | Self::Disposed | Self::Faulted)
    }

    pub const fn is_ready(self) -> bool {
        matches!(self, Self::Ready | Self::Visible | Self::Hidden)
    }
}

impl std::fmt::Display for SurfaceLifecycleState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Allocated => write!(f, "ALLOCATED"),
            Self::NativeCreated => write!(f, "NATIVE_CREATED"),
            Self::WebviewInitializing => write!(f, "WEBVIEW_INITIALIZING"),
            Self::WebviewCreated => write!(f, "WEBVIEW_CREATED"),
            Self::Navigating => write!(f, "NAVIGATING"),
            Self::RendererReady => write!(f, "RENDERER_READY"),
            Self::Ready => write!(f, "READY"),
            Self::Visible => write!(f, "VISIBLE"),
            Self::Hidden => write!(f, "HIDDEN"),
            Self::Faulted => write!(f, "FAULTED"),
            Self::Destroying => write!(f, "DESTROYING"),
            Self::Disposed => write!(f, "DISPOSED"),
        }
    }
}

/// Creation parameters for a new native surface.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceCreateSpec {
    /// Unique durable ELIX surface identifier.
    pub id: String,
    /// Initial physical-pixel bounds.
    pub bounds: PhysicalBounds,
    /// Target renderer content.
    #[serde(default)]
    pub renderer: Option<SurfaceRendererSpec>,
    /// Associated physical monitor identifier (if known).
    #[serde(default)]
    pub monitor_id: Option<String>,
    /// Window focus policy.
    #[serde(default)]
    pub focus_policy: SurfaceFocusPolicy,
    /// Window z-order policy.
    #[serde(default)]
    pub z_order_policy: SurfaceZOrderPolicy,
    /// Whether to suppress Windows taskbar button and Alt+Tab switcher (WS_EX_TOOLWINDOW).
    #[serde(default = "default_true")]
    pub skip_taskbar: bool,
    /// Whether the surface supports transparency (WS_EX_LAYERED and transparent WebView2 background).
    #[serde(default)]
    pub transparent: bool,
    /// Initial visibility request (enforcing ready-before-show: shown only after readiness).
    #[serde(default)]
    pub visible: bool,
    /// Optional user data folder for WebView2 profile storage.
    #[serde(default)]
    pub user_data_folder: Option<String>,
}

const fn default_true() -> bool {
    true
}

impl SurfaceCreateSpec {
    pub fn validate(&self) -> Result<(), NativeError> {
        if self.id.trim().is_empty() {
            return Err(NativeError::invalid_argument(
                "Surface ID must not be empty or whitespace.",
            ));
        }
        self.bounds.validate()?;
        if let Some(renderer) = &self.renderer {
            renderer.validate()?;
        }
        Ok(())
    }
}

/// Point-in-time snapshot of an active native surface.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceSnapshot {
    pub id: String,
    pub hwnd: isize,
    pub bounds: PhysicalBounds,
    pub state: SurfaceLifecycleState,
    pub visible: bool,
    pub dpi: u32,
    pub scale_factor: f64,
    pub focus_policy: SurfaceFocusPolicy,
    pub z_order_policy: SurfaceZOrderPolicy,
    pub monitor_id: Option<String>,
}

/// Authoritative real-time focus and foreground activation status for a surface.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceFocusState {
    pub id: String,
    pub hwnd: isize,
    pub is_foreground: bool,
    pub foreground_hwnd: isize,
    pub has_keyboard_focus: bool,
}

/// Asynchronous events emitted by Surface Core to the bridge and TypeScript host.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SurfaceEvent {
    Created {
        snapshot: SurfaceSnapshot,
    },
    NativeReady {
        id: String,
        hwnd: isize,
    },
    RendererReady {
        id: String,
    },
    Shown {
        id: String,
    },
    Hidden {
        id: String,
    },
    BoundsChanged {
        id: String,
        bounds: PhysicalBounds,
    },
    DpiChanged {
        id: String,
        dpi: u32,
        scale_factor: f64,
        suggested_bounds: PhysicalBounds,
    },
    Fault {
        id: String,
        error: NativeError,
    },
    Destroyed {
        id: String,
    },
    InputKey {
        id: String,
        key: String,
    },
    Pointer {
        id: String,
        action: String,
        x: i32,
        y: i32,
    },
    Message {
        id: String,
        message: String,
    },
}
