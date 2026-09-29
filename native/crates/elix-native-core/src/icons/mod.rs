//! Windows Shell Icon resolution and PE resource inspection primitives.
//!
//! Provides lightweight, typed icon references and resource extraction capabilities
//! with strict RAII ownership of HICON handles.

use crate::error::NativeResult;
use crate::runtime::paths::{normalize_canonical_path, to_wide};
use serde::{Deserialize, Serialize};
use std::path::Path;
use windows::core::PCWSTR;
use windows::Win32::Storage::FileSystem::FILE_ATTRIBUTE_NORMAL;
use windows::Win32::UI::Shell::{
    ExtractIconExW, SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON,
    SHGFI_USEFILEATTRIBUTES,
};
use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, HICON};

/// RAII wrapper around Win32 HICON to guarantee DestroyIcon is invoked on drop.
pub struct SafeHicon(pub HICON);

impl SafeHicon {
    pub fn new(hicon: HICON) -> Option<Self> {
        if hicon.is_invalid() || hicon.0.is_null() {
            None
        } else {
            Some(Self(hicon))
        }
    }

    pub fn raw(&self) -> HICON {
        self.0
    }
}

impl Drop for SafeHicon {
    fn drop(&mut self) {
        if !self.0.is_invalid() && !self.0 .0.is_null() {
            unsafe {
                let _ = DestroyIcon(self.0);
            }
        }
    }
}

/// Strongly typed shell icon reference matching Phase 4 contracts.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ShellIconReference {
    #[serde(rename_all = "camelCase")]
    File {
        file_path: String,
    },
    #[serde(rename_all = "camelCase")]
    Resource {
        source_path: String,
        resource_index: i32,
    },
    Extension {
        extension: String,
    },
    #[serde(rename_all = "camelCase")]
    Fallback {
        default_icon_id: String,
    },
}

/// Result of resolving shell icon properties for a given file or container.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShellIconDescriptor {
    pub reference: ShellIconReference,
    pub has_embedded_icon: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_resource_icons: Option<u32>,
}

/// Direct image formats that can be referenced as plain file icons.
const DIRECT_IMAGE_EXTENSIONS: &[&str] = &[".ico", ".png", ".jpg", ".jpeg", ".svg", ".webp"];

/// Binary executable and library extensions containing PE icon resources.
const RESOURCE_EXTENSIONS: &[&str] = &[".exe", ".dll", ".scr"];

/// Queries the number of icon resources embedded in a PE executable or library.
pub fn query_pe_icon_count(file_path: &str) -> u32 {
    let wide = to_wide(file_path);
    unsafe {
        // Passing -1 as nIconIndex and None buffers returns the total count of icons
        ExtractIconExW(PCWSTR(wide.as_ptr()), -1, None, None, 0)
    }
}

/// Resolves an icon reference and metadata for a given path and kind.
pub fn resolve_shell_icon(path_str: &str, is_directory: bool) -> NativeResult<ShellIconDescriptor> {
    let canonical = normalize_canonical_path(path_str);

    // 1. Folders
    if is_directory {
        return Ok(ShellIconDescriptor {
            reference: ShellIconReference::Fallback {
                default_icon_id: "generic-folder".to_string(),
            },
            has_embedded_icon: false,
            total_resource_icons: None,
        });
    }

    let p = Path::new(&canonical);
    let ext = p
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| format!(".{}", s.to_lowercase()))
        .unwrap_or_default();

    // 2. Direct image files
    if DIRECT_IMAGE_EXTENSIONS.contains(&ext.as_str()) {
        return Ok(ShellIconDescriptor {
            reference: ShellIconReference::File {
                file_path: canonical,
            },
            has_embedded_icon: false,
            total_resource_icons: None,
        });
    }

    // 3. Executables and DLLs
    if RESOURCE_EXTENSIONS.contains(&ext.as_str()) {
        let count = query_pe_icon_count(&canonical);
        return Ok(ShellIconDescriptor {
            reference: ShellIconReference::Resource {
                source_path: canonical,
                resource_index: 0,
            },
            has_embedded_icon: count > 0,
            total_resource_icons: Some(count),
        });
    }

    // 4. Test if system associates an icon with this extension via SHGetFileInfoW
    if !ext.is_empty() {
        let wide_ext = to_wide(&ext);
        let mut shfi: SHFILEINFOW = unsafe { std::mem::zeroed() };
        let res = unsafe {
            SHGetFileInfoW(
                PCWSTR(wide_ext.as_ptr()),
                FILE_ATTRIBUTE_NORMAL,
                Some(&mut shfi),
                std::mem::size_of::<SHFILEINFOW>() as u32,
                SHGFI_USEFILEATTRIBUTES | SHGFI_ICON | SHGFI_LARGEICON,
            )
        };

        if res != 0 {
            // Valid icon handle returned; destroy it immediately to prevent handle leak
            let _guard = SafeHicon::new(shfi.hIcon);
            return Ok(ShellIconDescriptor {
                reference: ShellIconReference::Extension { extension: ext },
                has_embedded_icon: false,
                total_resource_icons: None,
            });
        }
    }

    // 5. Default generic file fallback
    Ok(ShellIconDescriptor {
        reference: ShellIconReference::Fallback {
            default_icon_id: "generic-file".to_string(),
        },
        has_embedded_icon: false,
        total_resource_icons: None,
    })
}
