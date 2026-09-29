//! Windows Shell Link (.lnk) metadata resolution via native COM.
//!
//! Uses IShellLinkW and IPersistFile to extract shortcut targets, arguments,
//! working directories, descriptions, and icon locations without executing them.

use crate::error::{NativeError, NativeResult};
use crate::runtime::apartment::run_in_sta;
use crate::runtime::paths::{from_wide_slice, normalize_canonical_path, path_exists, to_wide};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use windows::core::{Interface, PCWSTR};
use windows::Win32::Storage::FileSystem::WIN32_FIND_DATAW;
use windows::Win32::System::Com::{
    CoCreateInstance, IPersistFile, CLSCTX_INPROC_SERVER, STGM_READ,
};
use windows::Win32::UI::Shell::{IShellLinkW, ShellLink, SLGP_RAWPATH};

/// Lightweight icon reference extracted from shortcut metadata.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ShortcutIconReference {
    #[serde(rename_all = "camelCase")]
    Resource {
        source_path: String,
        resource_index: i32,
    },
    #[serde(rename_all = "camelCase")]
    File { file_path: String },
}

/// Metadata extracted from a Windows `.lnk` shortcut.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShellShortcutMetadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arguments: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub working_directory: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<ShortcutIconReference>,
    pub is_broken: bool,
}

/// Splits a raw arguments string into individual tokens according to Windows CLI parsing rules.
pub fn parse_arguments_string(raw: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;

    for c in raw.chars() {
        match c {
            '"' => {
                in_quotes = !in_quotes;
            }
            ' ' | '\t' if !in_quotes => {
                if !current.is_empty() {
                    args.push(current.clone());
                    current.clear();
                }
            }
            _ => {
                current.push(c);
            }
        }
    }

    if !current.is_empty() {
        args.push(current);
    }

    args
}

/// Resolves shortcut metadata for a single `.lnk` file on the current STA thread.
fn resolve_shortcut_sta(link_path: &str) -> NativeResult<ShellShortcutMetadata> {
    let wide_link = to_wide(link_path);

    unsafe {
        let shell_link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)
            .map_err(|err| {
                NativeError::from_windows_error(err, "Failed to create ShellLink COM object")
            })?;

        let persist_file: IPersistFile = shell_link.cast().map_err(|err| {
            NativeError::from_windows_error(err, "Failed to cast ShellLink to IPersistFile")
        })?;

        persist_file
            .Load(PCWSTR(wide_link.as_ptr()), STGM_READ)
            .map_err(|err| {
                NativeError::from_windows_error(
                    err,
                    &format!("Failed to load shortcut file: {}", link_path),
                )
            })?;

        // 1. Target path
        let mut target_buf = [0u16; 2048];
        let mut find_data: WIN32_FIND_DATAW = std::mem::zeroed();
        let _ = shell_link.GetPath(&mut target_buf, &mut find_data, SLGP_RAWPATH.0 as u32);
        let raw_target = from_wide_slice(&target_buf);
        let target = if raw_target.trim().is_empty() {
            None
        } else {
            Some(normalize_canonical_path(&raw_target))
        };

        // 2. Arguments
        let mut args_buf = [0u16; 2048];
        let _ = shell_link.GetArguments(&mut args_buf);
        let raw_args = from_wide_slice(&args_buf);
        let arguments = if raw_args.trim().is_empty() {
            None
        } else {
            let parsed = parse_arguments_string(raw_args.trim());
            if parsed.is_empty() {
                None
            } else {
                Some(parsed)
            }
        };

        // 3. Working Directory
        let mut dir_buf = [0u16; 2048];
        let _ = shell_link.GetWorkingDirectory(&mut dir_buf);
        let raw_dir = from_wide_slice(&dir_buf);
        let working_directory = if raw_dir.trim().is_empty() {
            None
        } else {
            Some(normalize_canonical_path(&raw_dir))
        };

        // 4. Description
        let mut desc_buf = [0u16; 2048];
        let _ = shell_link.GetDescription(&mut desc_buf);
        let raw_desc = from_wide_slice(&desc_buf);
        let description = if raw_desc.trim().is_empty() {
            None
        } else {
            Some(raw_desc.trim().to_string())
        };

        // 5. Icon Location & Index
        let mut icon_buf = [0u16; 2048];
        let mut icon_index = 0i32;
        let _ = shell_link.GetIconLocation(&mut icon_buf, &mut icon_index);
        let raw_icon_path = from_wide_slice(&icon_buf);
        let icon = if raw_icon_path.trim().is_empty() {
            None
        } else {
            let norm_icon_path = normalize_canonical_path(&raw_icon_path);
            if norm_icon_path.to_lowercase().ends_with(".ico") && icon_index == 0 {
                Some(ShortcutIconReference::File {
                    file_path: norm_icon_path,
                })
            } else {
                Some(ShortcutIconReference::Resource {
                    source_path: norm_icon_path,
                    resource_index: icon_index,
                })
            }
        };

        // 6. Broken check
        let is_broken = match &target {
            Some(t) => {
                // If it's a URL or special shell protocol, don't flag as broken
                if t.contains("://") {
                    false
                } else {
                    !path_exists(t)
                }
            }
            None => false,
        };

        Ok(ShellShortcutMetadata {
            target,
            arguments,
            working_directory,
            description,
            icon,
            is_broken,
        })
    }
}

/// Resolves shortcut metadata for a single `.lnk` file using native COM in a dedicated STA thread.
pub fn resolve_shortcut(link_path: &str) -> NativeResult<ShellShortcutMetadata> {
    let path = link_path.to_string();
    run_in_sta(move || resolve_shortcut_sta(&path))
}

/// Resolves multiple shortcuts in a batch pass inside a single dedicated STA session.
pub fn resolve_shortcut_batch(link_paths: &[String]) -> HashMap<String, ShellShortcutMetadata> {
    let paths = link_paths.to_vec();
    let result = run_in_sta(move || {
        let mut map = HashMap::new();
        for path in paths {
            if let Ok(meta) = resolve_shortcut_sta(&path) {
                map.insert(path, meta);
            }
        }
        Ok(map)
    });
    result.unwrap_or_default()
}
