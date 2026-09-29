//! ELIX Native Core
//!
//! Shared Rust native foundation for ELIX OS Windows capabilities.
//! Provides production-quality native primitives for Known Folders,
//! stable file identity, COM Shell Links, Shell Icons, Directory Change Watchers,
//! and safe Process Execution.

pub mod app_bar;
pub mod error;
pub mod icons;
pub mod identity;
pub mod known_folders;
pub mod process;
pub mod runtime;
pub mod shortcuts;
pub mod shell_spaces;
pub mod spaces;
pub mod surface;
pub mod watcher;
pub mod window_control;
pub mod window_preview;
pub mod window_registry;
pub mod windows_context;

pub use app_bar::{AppBarEdge, AppBarManager, AppBarSpec, RegisteredAppBar};
pub use error::{NativeError, NativeResult};
pub use window_control::{
    execute_window_control, NativeWindowControlObservation, NativeWindowControlRequest,
    NativeWindowControlResult, NativeWindowControlTarget, WindowControlAction,
};
pub use window_registry::{
    NativeRawWindow, NativeWindowRegistryChange, NativeWindowRegistrySnapshot,
    NativeWindowRegistryStatus, WindowRegistryObserver,
};

/// Protocol and capability definitions for Native Bridge.
pub const PROTOCOL_VERSION: u32 = 1;
pub const NATIVE_VERSION: &str = "0.1.0";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::NativeError;
    use crate::icons::resolve_shell_icon;
    use crate::identity::{compute_path_fallback_id, identify_file, IdentityQuality};
    use crate::known_folders::{resolve_all_known_folders, resolve_known_folder, KnownFolderId};
    use crate::process::escape_windows_arg;
    use crate::runtime::apartment::{ApartmentType, ComApartment, SafeHandle};
    use crate::runtime::paths::{normalize_canonical_path, to_wide, to_win32_path};
    use crate::shortcuts::parse_arguments_string;
    use std::fs;
    use windows::Win32::Foundation::HANDLE;

    #[test]
    fn test_path_normalization() {
        assert_eq!(
            normalize_canonical_path(r"c:\Users\foo\bar"),
            "C:/Users/foo/bar"
        );
        assert_eq!(
            normalize_canonical_path(r"\\?\C:\Program Files\app"),
            "C:/Program Files/app"
        );
        assert_eq!(
            normalize_canonical_path(r"\\?\UNC\server\share\file.txt"),
            "//server/share/file.txt"
        );
        assert_eq!(
            normalize_canonical_path("D:/Work/Project/"),
            "D:/Work/Project"
        );
        assert_eq!(
            normalize_canonical_path(r"C:\Users\テスト\📁\item.txt"),
            "C:/Users/テスト/📁/item.txt"
        );
    }

    #[test]
    fn test_to_win32_path() {
        let short = "C:/short/path.txt";
        assert_eq!(to_win32_path(short), r"C:\short\path.txt");

        let long_base = "C:/".to_string() + &"a".repeat(250) + "/file.txt";
        let win32_long = to_win32_path(&long_base);
        assert!(win32_long.starts_with(r"\\?\C:\"));
    }

    #[test]
    fn test_wide_string_conversion() {
        let wide = to_wide("hello world");
        assert_eq!(wide.last(), Some(&0));
        assert_eq!(wide.len(), 12);
    }

    #[test]
    fn test_safe_handle_invalid() {
        let handle = HANDLE(std::ptr::null_mut());
        assert!(SafeHandle::new(handle).is_none());
    }

    #[test]
    fn test_com_apartment_sta_and_mta() {
        let thread_handle = std::thread::spawn(|| {
            let mta = ComApartment::init(ApartmentType::Mta).expect("MTA init");
            let direct_sta = ComApartment::init(ApartmentType::Sta);
            assert!(
                direct_sta.is_err(),
                "Direct STA on MTA thread must fail with RPC_E_CHANGED_MODE"
            );
            let err = direct_sta.err().unwrap();
            assert_eq!(err.code, "APARTMENT_MODE_MISMATCH");

            let sta_res = crate::runtime::apartment::run_in_sta(|| Ok(42));
            assert_eq!(sta_res.unwrap(), 42);
            drop(mta);
        });
        thread_handle.join().expect("MTA test thread join");
    }

    #[test]
    fn test_path_fallback_id() {
        let id1 = compute_path_fallback_id("C:/Users/test/file.txt");
        let id2 = compute_path_fallback_id("c:/users/test/file.txt");
        assert_eq!(id1, id2);
        assert!(id1.starts_with("path:"));
    }

    #[test]
    fn test_known_folder_recycle_bin_virtual() {
        let res = resolve_known_folder(KnownFolderId::RecycleBin).expect("RecycleBin resolution");
        assert_eq!(res.id, "RecycleBin");
        assert_eq!(res.is_virtual, Some(true));
        assert_eq!(res.path, None);
        assert!(res.available);
        assert_eq!(res.display_name.as_deref(), Some("Recycle Bin"));
    }

    #[test]
    fn test_known_folder_desktop_resolves() {
        let res = resolve_known_folder(KnownFolderId::Desktop).expect("Desktop resolution");
        assert_eq!(res.id, "Desktop");
        assert_eq!(res.is_virtual, Some(false));
        assert!(res.path.is_some());
        let path = res.path.unwrap();
        assert!(path.contains("Desktop"));
        assert!(res.available);
    }

    #[test]
    fn test_resolve_all_known_folders() {
        let all = resolve_all_known_folders();
        assert_eq!(all.len(), KnownFolderId::all().len());
        let has_desktop = all.iter().any(|f| f.id == "Desktop" && f.available);
        assert!(has_desktop);
        let has_recycle = all
            .iter()
            .any(|f| f.id == "RecycleBin" && f.is_virtual == Some(true));
        assert!(has_recycle);
    }

    #[test]
    fn test_file_identity_and_rename_stability() {
        let temp_dir =
            std::env::temp_dir().join(format!("elix-native-ident-{}", std::process::id()));
        let _ = fs::create_dir_all(&temp_dir);

        let orig_file = temp_dir.join("original.txt");
        let renamed_file = temp_dir.join("renamed.txt");

        fs::write(&orig_file, "identity test contents").unwrap();

        let ident1 = identify_file(orig_file.to_str().unwrap()).unwrap();
        assert_eq!(ident1.quality, IdentityQuality::NativeStable);
        assert!(ident1.volume_serial_number.is_some());
        assert!(ident1.file_id.is_some());
        assert!(ident1.id.starts_with("fs:"));

        fs::rename(&orig_file, &renamed_file).unwrap();

        let ident2 = identify_file(renamed_file.to_str().unwrap()).unwrap();
        assert_eq!(ident2.quality, IdentityQuality::NativeStable);

        assert_eq!(ident1.id, ident2.id);
        assert_eq!(ident1.file_id, ident2.file_id);
        assert_eq!(ident1.volume_serial_number, ident2.volume_serial_number);
        assert_ne!(ident1.canonical_path, ident2.canonical_path);

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_missing_file_fallback_identity() {
        let missing_path = "C:/NonExistentPath/File1234567.xyz";
        let ident = identify_file(missing_path).unwrap();
        assert_eq!(ident.quality, IdentityQuality::PathFallback);
        assert!(ident.id.starts_with("path:"));
        assert!(ident.volume_serial_number.is_none());
        assert!(ident.file_id.is_none());
    }

    #[test]
    fn test_shortcut_argument_parsing() {
        let parsed = parse_arguments_string(r#"--profile "My Profile" -v --flag"#);
        assert_eq!(parsed, vec!["--profile", "My Profile", "-v", "--flag"]);

        let empty = parse_arguments_string("   ");
        assert!(empty.is_empty());
    }

    #[test]
    fn test_escape_windows_arg() {
        assert_eq!(escape_windows_arg("simple"), "simple");
        assert_eq!(escape_windows_arg("with space"), "\"with space\"");
        assert_eq!(escape_windows_arg("with\"quote"), "\"with\\\"quote\"");
        assert_eq!(escape_windows_arg(""), "\"\"");
    }

    #[test]
    fn test_icon_resolution() {
        let folder_desc = resolve_shell_icon("C:/Users", true).unwrap();
        match folder_desc.reference {
            icons::ShellIconReference::Fallback { default_icon_id } => {
                assert_eq!(default_icon_id, "generic-folder");
            }
            _ => panic!("Expected generic-folder fallback"),
        }

        let image_desc = resolve_shell_icon("C:/Users/photo.png", false).unwrap();
        match image_desc.reference {
            icons::ShellIconReference::File { file_path } => {
                assert!(file_path.ends_with(".png"));
            }
            _ => panic!("Expected file icon reference"),
        }
    }

    #[test]
    fn test_error_model() {
        let err = NativeError::new("test", "TEST_CODE", "An error occurred");
        assert_eq!(err.domain, "test");
        assert_eq!(err.code, "TEST_CODE");
        assert_eq!(err.to_string(), "[test::TEST_CODE] An error occurred");
    }

    #[test]
    fn test_watcher_lifecycle_and_events() {
        use crate::watcher::NativeNamespaceWatcher;
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;
        use std::time::Duration;

        let temp_dir =
            std::env::temp_dir().join(format!("elix-native-watch-{}", std::process::id()));
        let _ = fs::create_dir_all(&temp_dir);

        let watcher = NativeNamespaceWatcher::new();
        let event_count = Arc::new(AtomicUsize::new(0));
        let event_count_clone = Arc::clone(&event_count);

        let sub_id = watcher
            .watch(
                temp_dir.to_str().unwrap(),
                Arc::new(move |_ev| {
                    event_count_clone.fetch_add(1, Ordering::SeqCst);
                }),
            )
            .unwrap();

        std::thread::sleep(Duration::from_millis(50));

        let file_path = temp_dir.join("watch-file.txt");
        fs::write(&file_path, "watch content").unwrap();

        std::thread::sleep(Duration::from_millis(150));
        assert!(event_count.load(Ordering::SeqCst) > 0);

        fs::write(&file_path, "modified watch content").unwrap();
        std::thread::sleep(Duration::from_millis(150));

        let unwatched = watcher.unwatch(sub_id);
        assert!(unwatched);

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_watcher_saturation_and_rearm() {
        use crate::watcher::{ChangeType, NativeNamespaceWatcher};
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        let temp_dir = std::env::temp_dir().join(format!("elix-native-sat-{}", std::process::id()));
        let _ = fs::create_dir_all(&temp_dir);

        let watcher = NativeNamespaceWatcher::new();
        let invalidation_count = Arc::new(AtomicUsize::new(0));
        let invalidation_count_clone = Arc::clone(&invalidation_count);

        let sub_id = watcher
            .watch(
                temp_dir.to_str().unwrap(),
                Arc::new(move |ev| {
                    if ev.change_type == ChangeType::ContainerInvalidated {
                        invalidation_count_clone.fetch_add(1, Ordering::SeqCst);
                    }
                }),
            )
            .unwrap();

        assert!(!watcher.is_container_invalidated(sub_id));

        watcher.simulate_overflow(sub_id).unwrap();
        assert!(watcher.is_container_invalidated(sub_id));
        assert_eq!(invalidation_count.load(Ordering::SeqCst), 1);

        watcher.simulate_overflow(sub_id).unwrap();
        assert_eq!(invalidation_count.load(Ordering::SeqCst), 1);

        watcher.rearm_container(sub_id);
        assert!(!watcher.is_container_invalidated(sub_id));

        watcher.simulate_overflow(sub_id).unwrap();
        assert!(watcher.is_container_invalidated(sub_id));
        assert_eq!(invalidation_count.load(Ordering::SeqCst), 2);

        watcher.unwatch(sub_id);
        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_process_launch_validation() {
        use crate::process::{launch_win32_process, Win32LaunchSpec};

        let spec = Win32LaunchSpec {
            executable_path: "cmd.exe".to_string(),
            arguments: Some(vec!["/c".to_string(), "exit 0".to_string()]),
            working_directory: None,
        };

        let res = launch_win32_process(&spec).unwrap();
        assert!(res.success);
        assert!(res.pid.is_some());
    }

    #[test]
    fn test_com_shortcut_create_and_resolve() {
        use crate::shortcuts::resolve_shortcut;
        use windows::core::{Interface, PCWSTR};
        use windows::Win32::System::Com::{CoCreateInstance, IPersistFile, CLSCTX_INPROC_SERVER};
        use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};

        let temp_dir = std::env::temp_dir().join(format!("elix-native-lnk-{}", std::process::id()));
        let _ = fs::create_dir_all(&temp_dir);

        let lnk_path = temp_dir.join("test_shortcut.lnk");
        let wide_lnk = to_wide(lnk_path.to_str().unwrap());

        {
            let _com = ComApartment::init(ApartmentType::Sta).unwrap();
            unsafe {
                let shell_link: IShellLinkW =
                    CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).unwrap();
                let wide_target = to_wide("C:/Windows/notepad.exe");
                let wide_args = to_wide("--test-arg value");
                let wide_desc = to_wide("Test shortcut description");

                shell_link.SetPath(PCWSTR(wide_target.as_ptr())).unwrap();
                shell_link.SetArguments(PCWSTR(wide_args.as_ptr())).unwrap();
                shell_link
                    .SetDescription(PCWSTR(wide_desc.as_ptr()))
                    .unwrap();

                let persist_file: IPersistFile = shell_link.cast().unwrap();
                persist_file.Save(PCWSTR(wide_lnk.as_ptr()), true).unwrap();
            }
        }

        let meta = resolve_shortcut(lnk_path.to_str().unwrap()).unwrap();
        assert!(meta.target.is_some());
        assert!(meta.target.unwrap().to_lowercase().contains("notepad.exe"));
        assert_eq!(
            meta.arguments,
            Some(vec!["--test-arg".to_string(), "value".to_string()])
        );
        assert_eq!(
            meta.description.as_deref(),
            Some("Test shortcut description")
        );
        assert!(!meta.is_broken);

        let _ = fs::remove_dir_all(&temp_dir);
    }
}
