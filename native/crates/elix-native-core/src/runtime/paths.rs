//! Windows path normalization and wide-string utilities.
//!
//! Provides long-path-safe primitives, UTF-16 conversions, and canonicalization
//! preserving international characters, spaces, and emojis.

use std::path::{Path, PathBuf};

/// Converts a Rust UTF-8 string to a null-terminated UTF-16 wide string vector.
pub fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Converts a null-terminated wide pointer into a Rust String.
///
/// # Safety
/// `ptr` must point to a valid null-terminated UTF-16 buffer.
pub unsafe fn from_wide_ptr(ptr: *const u16) -> String {
    if ptr.is_null() {
        return String::new();
    }
    let mut len = 0;
    while *ptr.add(len) != 0 {
        len += 1;
    }
    let slice = std::slice::from_raw_parts(ptr, len);
    String::from_utf16_lossy(slice)
}

/// Converts a wide slice (with or without trailing nulls) into a Rust String.
pub fn from_wide_slice(slice: &[u16]) -> String {
    let end = slice.iter().position(|&c| c == 0).unwrap_or(slice.len());
    String::from_utf16_lossy(&slice[..end])
}

/// Normalizes a Windows path to a forward-slash canonical representation.
/// Strips extended-length prefixes (`\\?\` and `\\?\UNC\`) for uniform comparisons.
pub fn normalize_canonical_path(raw: &str) -> String {
    let mut clean = raw.trim();

    // Strip \\?\UNC\ prefix
    if clean.starts_with(r"\\?\UNC\") || clean.starts_with("//?/UNC/") {
        clean = &clean[8..];
        return format!("//{}", clean.replace('\\', "/"));
    }

    // Strip \\?\ prefix
    if clean.starts_with(r"\\?\") || clean.starts_with("//?/") {
        clean = &clean[4..];
    }

    // Convert all backslashes to forward slashes
    let mut normalized = clean.replace('\\', "/");

    // Ensure Windows drive letter is capitalized (e.g. c:/ -> C:/)
    if normalized.len() >= 2 {
        let bytes = normalized.as_bytes();
        if bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
            let drive = (bytes[0] as char).to_ascii_uppercase();
            normalized.replace_range(0..1, &drive.to_string());
        }
    }

    // Trim any trailing slash unless it's the root drive (e.g. "C:/")
    if normalized.len() > 3 && normalized.ends_with('/') {
        normalized.pop();
    }

    normalized
}

/// Prepares a path for Win32 API calls.
/// If the path length is >= 240 characters and does not already have an extended-length
/// prefix (`\\?\`), prepends `\\?\` so Windows long-path restrictions are bypassed.
pub fn to_win32_path(path: &str) -> String {
    let normalized = path.replace('/', "\\");
    if normalized.starts_with(r"\\?\") {
        return normalized;
    }

    // Check if absolute drive path
    if normalized.len() >= 240 {
        let bytes = normalized.as_bytes();
        if bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && bytes[2] == b'\\'
        {
            return format!(r"\\?\{}", normalized);
        }
    }

    normalized
}

/// Verifies that a path exists on disk.
pub fn path_exists(path: &str) -> bool {
    let win_path = to_win32_path(path);
    Path::new(&win_path).exists()
}

/// Resolves a path to its canonical absolute PathBuf.
pub fn resolve_path(path: &str) -> PathBuf {
    let p = Path::new(path);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(p)
    }
}
