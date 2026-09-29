//! Windows Known Folder resolution using native SHGetKnownFolderPath.
//!
//! Maps canonical KnownFolderId identifiers to physical directories via Windows Shell APIs,
//! supporting user folder redirection (OneDrive, secondary drives, etc.).
//! Handles virtual folders such as FOLDERID_RecycleBinFolder as Shell namespace identities
//! rather than filesystem paths, per Windows Shell specifications.

use crate::error::{NativeError, NativeResult};
use crate::runtime::paths::{from_wide_ptr, normalize_canonical_path, path_exists};
use serde::{Deserialize, Serialize};
use std::ffi::c_void;
use windows::core::GUID;
use windows::Win32::System::Com::CoTaskMemFree;
use windows::Win32::UI::Shell::{
    FOLDERID_Desktop, FOLDERID_Documents, FOLDERID_Downloads, FOLDERID_Music, FOLDERID_Pictures,
    FOLDERID_Programs, FOLDERID_PublicDesktop, FOLDERID_PublicDocuments, FOLDERID_StartMenu,
    FOLDERID_Startup, FOLDERID_Videos, SHGetKnownFolderPath, KF_FLAG_DEFAULT,
};

/// Canonical KnownFolder identifiers supported by ELIX.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum KnownFolderId {
    Desktop,
    PublicDesktop,
    Documents,
    PublicDocuments,
    Downloads,
    Pictures,
    Music,
    Videos,
    StartMenu,
    Programs,
    Startup,
    RecycleBin,
}

impl KnownFolderId {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "Desktop" => Some(Self::Desktop),
            "PublicDesktop" => Some(Self::PublicDesktop),
            "Documents" => Some(Self::Documents),
            "PublicDocuments" => Some(Self::PublicDocuments),
            "Downloads" => Some(Self::Downloads),
            "Pictures" => Some(Self::Pictures),
            "Music" => Some(Self::Music),
            "Videos" => Some(Self::Videos),
            "StartMenu" => Some(Self::StartMenu),
            "Programs" => Some(Self::Programs),
            "Startup" => Some(Self::Startup),
            "RecycleBin" => Some(Self::RecycleBin),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Desktop => "Desktop",
            Self::PublicDesktop => "PublicDesktop",
            Self::Documents => "Documents",
            Self::PublicDocuments => "PublicDocuments",
            Self::Downloads => "Downloads",
            Self::Pictures => "Pictures",
            Self::Music => "Music",
            Self::Videos => "Videos",
            Self::StartMenu => "StartMenu",
            Self::Programs => "Programs",
            Self::Startup => "Startup",
            Self::RecycleBin => "RecycleBin",
        }
    }

    pub fn all() -> &'static [KnownFolderId] {
        &[
            Self::Desktop,
            Self::PublicDesktop,
            Self::Documents,
            Self::PublicDocuments,
            Self::Downloads,
            Self::Pictures,
            Self::Music,
            Self::Videos,
            Self::StartMenu,
            Self::Programs,
            Self::Startup,
            Self::RecycleBin,
        ]
    }
}

/// Resolution result for a Windows Known Folder.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KnownFolderResolution {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_virtual: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
}

/// Resolves a single Known Folder using native Win32/Shell APIs.
pub fn resolve_known_folder(id: KnownFolderId) -> NativeResult<KnownFolderResolution> {
    // Special handling for virtual folders: FOLDERID_RecycleBinFolder is a virtual shell
    // folder with no direct filesystem path. Calling SHGetKnownFolderPath on it can fail.
    if id == KnownFolderId::RecycleBin {
        return Ok(KnownFolderResolution {
            id: id.as_str().to_string(),
            path: None,
            available: true,
            is_virtual: Some(true),
            display_name: Some("Recycle Bin".to_string()),
        });
    }

    let guid: GUID = match id {
        KnownFolderId::Desktop => FOLDERID_Desktop,
        KnownFolderId::PublicDesktop => FOLDERID_PublicDesktop,
        KnownFolderId::Documents => FOLDERID_Documents,
        KnownFolderId::PublicDocuments => FOLDERID_PublicDocuments,
        KnownFolderId::Downloads => FOLDERID_Downloads,
        KnownFolderId::Pictures => FOLDERID_Pictures,
        KnownFolderId::Music => FOLDERID_Music,
        KnownFolderId::Videos => FOLDERID_Videos,
        KnownFolderId::StartMenu => FOLDERID_StartMenu,
        KnownFolderId::Programs => FOLDERID_Programs,
        KnownFolderId::Startup => FOLDERID_Startup,
        KnownFolderId::RecycleBin => unreachable!(),
    };

    unsafe {
        let pwstr_result = SHGetKnownFolderPath(&guid, KF_FLAG_DEFAULT, None);
        match pwstr_result {
            Ok(pwstr) => {
                let raw_path = from_wide_ptr(pwstr.0);
                // RAII free the memory allocated by SHGetKnownFolderPath
                CoTaskMemFree(Some(pwstr.0 as *mut c_void));

                let normalized = normalize_canonical_path(&raw_path);
                let available = path_exists(&normalized);

                Ok(KnownFolderResolution {
                    id: id.as_str().to_string(),
                    path: Some(normalized),
                    available,
                    is_virtual: Some(false),
                    display_name: None,
                })
            }
            Err(err) => {
                // If the folder is not configured or not found in registry, report available: false
                Err(NativeError::from_windows_error(
                    err,
                    &format!("Failed to resolve known folder: {}", id.as_str()),
                ))
            }
        }
    }
}

/// Resolves all supported Known Folders.
pub fn resolve_all_known_folders() -> Vec<KnownFolderResolution> {
    let mut results = Vec::new();
    for &id in KnownFolderId::all() {
        match resolve_known_folder(id) {
            Ok(res) => results.push(res),
            Err(_) => {
                // Return unavailable fallback rather than failing the whole set
                results.push(KnownFolderResolution {
                    id: id.as_str().to_string(),
                    path: None,
                    available: false,
                    is_virtual: Some(id == KnownFolderId::RecycleBin),
                    display_name: if id == KnownFolderId::RecycleBin {
                        Some("Recycle Bin".to_string())
                    } else {
                        None
                    },
                });
            }
        }
    }
    results
}
