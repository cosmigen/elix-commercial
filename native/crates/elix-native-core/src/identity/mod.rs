//! Windows File Identity using native GetFileInformationByHandleEx (FILE_ID_INFO).
//!
//! Provides authoritative native file identity that persists across renames and moves
//! within the same filesystem volume.

use crate::error::NativeResult;
use crate::runtime::apartment::SafeHandle;
use crate::runtime::paths::{normalize_canonical_path, to_wide, to_win32_path};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::mem::size_of;
use windows::core::PCWSTR;
use windows::Win32::Foundation::GetLastError;
use windows::Win32::Storage::FileSystem::{
    CreateFileW, FileIdInfo, GetFileInformationByHandleEx, FILE_FLAG_BACKUP_SEMANTICS,
    FILE_ID_INFO, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    OPEN_EXISTING,
};

/// Quality level of resolved file identity.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum IdentityQuality {
    NativeStable,
    FilesystemStable,
    PathFallback,
}

/// Resolved file identity structure.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileIdentity {
    pub id: String,
    pub quality: IdentityQuality,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub volume_serial_number: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_id: Option<String>,
    pub canonical_path: String,
}

/// Computes a deterministic path-fallback identifier.
pub fn compute_path_fallback_id(canonical_path: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(canonical_path.to_lowercase().as_bytes());
    let hash = hasher.finalize();
    let hex = format!("{:x}", hash);
    format!("path:{}", &hex[..16])
}

/// Resolves native file identity from a filesystem path.
///
/// Uses `CreateFileW` with `FILE_READ_ATTRIBUTES` and `FILE_FLAG_BACKUP_SEMANTICS`
/// (supporting both files and directories) and queries `FILE_ID_INFO` via
/// `GetFileInformationByHandleEx`.
///
/// If the file does not exist or the volume does not support file IDs, falls back
/// to a deterministic `path-fallback` identifier.
pub fn identify_file(path: &str) -> NativeResult<FileIdentity> {
    let canonical = normalize_canonical_path(path);
    let win32_path = to_win32_path(&canonical);
    let wide_path = to_wide(&win32_path);

    unsafe {
        let handle = CreateFileW(
            PCWSTR(wide_path.as_ptr()),
            FILE_READ_ATTRIBUTES.0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            None,
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            None,
        );

        let safe_handle = match handle {
            Ok(h) => match SafeHandle::new(h) {
                Some(sh) => sh,
                None => {
                    return Ok(FileIdentity {
                        id: compute_path_fallback_id(&canonical),
                        quality: IdentityQuality::PathFallback,
                        volume_serial_number: None,
                        file_id: None,
                        canonical_path: canonical,
                    });
                }
            },
            Err(_) => {
                return Ok(FileIdentity {
                    id: compute_path_fallback_id(&canonical),
                    quality: IdentityQuality::PathFallback,
                    volume_serial_number: None,
                    file_id: None,
                    canonical_path: canonical,
                });
            }
        };

        let mut id_info: FILE_ID_INFO = std::mem::zeroed();
        let success = GetFileInformationByHandleEx(
            safe_handle.raw(),
            FileIdInfo,
            &mut id_info as *mut _ as _,
            size_of::<FILE_ID_INFO>() as u32,
        );

        if success.is_err() {
            let _err_code = GetLastError().0;
            return Ok(FileIdentity {
                id: compute_path_fallback_id(&canonical),
                quality: IdentityQuality::PathFallback,
                volume_serial_number: None,
                file_id: None,
                canonical_path: canonical,
            });
        }

        let volume_serial = (id_info.VolumeSerialNumber & 0xFFFFFFFF) as u32;
        let volume_serial_hex = format!("{:08x}", volume_serial);

        // Check if upper 64 bits of 128-bit ID are non-zero (ReFS) or zero (NTFS)
        let bytes = id_info.FileId.Identifier;
        let lower_64 = u64::from_le_bytes(bytes[0..8].try_into().unwrap());
        let upper_64 = u64::from_le_bytes(bytes[8..16].try_into().unwrap());

        let file_id_hex = if upper_64 == 0 {
            format!("{:016x}", lower_64)
        } else {
            format!("{:016x}{:016x}", upper_64, lower_64)
        };

        let id = format!("fs:{}:{}", volume_serial_hex, file_id_hex);

        Ok(FileIdentity {
            id,
            quality: IdentityQuality::NativeStable,
            volume_serial_number: Some(volume_serial_hex),
            file_id: Some(file_id_hex),
            canonical_path: canonical,
        })
    }
}
