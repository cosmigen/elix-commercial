//! Native process creation, packaged application activation, and raw process snapshots.
//!
//! Process snapshots expose operating-system facts only. App ownership and lifecycle
//! interpretation remain outside Native Core.

use crate::error::{NativeError, NativeResult};
use crate::runtime::apartment::SafeHandle;
use crate::runtime::paths::{normalize_canonical_path, to_wide, to_win32_path};
use serde::{Deserialize, Serialize};
use std::mem::size_of;
use std::time::{SystemTime, UNIX_EPOCH};
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, FILETIME, HANDLE};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
    TH32CS_SNAPPROCESS,
};
use windows::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
use windows::Win32::System::Threading::{
    CreateProcessW, GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, DETACHED_PROCESS,
    PROCESS_INFORMATION, PROCESS_NAME_FORMAT, PROCESS_QUERY_LIMITED_INFORMATION, STARTUPINFOW,
};

/// Win32 application launch specification.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Win32LaunchSpec {
    pub executable_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arguments: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub working_directory: Option<String>,
}

/// Packaged application launch specification.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackagedLaunchSpec {
    pub aumid: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arguments: Option<Vec<String>>,
}

/// Result of process launch attempt.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProcessLaunchResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Raw operating-system facts for one currently observed process.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeProcessEntry {
    pub process_id: u32,
    pub parent_process_id: u32,
    /// Windows FILETIME creation timestamp. Zero means the process could not be opened.
    pub process_creation_time: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub executable_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub executable_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub package_full_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aumid: Option<String>,
}

/// Point-in-time raw process snapshot. Ordering is deterministic by PID.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeProcessSnapshot {
    pub processes: Vec<NativeProcessEntry>,
    pub captured_at: u64,
}

/// Escapes a command-line argument for Windows CommandLineToArgvW compatibility.
pub fn escape_windows_arg(arg: &str) -> String {
    if arg.is_empty() {
        return "\"\"".to_string();
    }
    if !arg.contains(' ') && !arg.contains('\t') && !arg.contains('"') {
        return arg.to_string();
    }

    let mut result = String::from("\"");
    let mut backslashes = 0;

    for c in arg.chars() {
        match c {
            '\\' => backslashes += 1,
            '"' => {
                result.push_str(&"\\".repeat(backslashes * 2 + 1));
                result.push('"');
                backslashes = 0;
            }
            _ => {
                if backslashes > 0 {
                    result.push_str(&"\\".repeat(backslashes));
                    backslashes = 0;
                }
                result.push(c);
            }
        }
    }

    if backslashes > 0 {
        result.push_str(&"\\".repeat(backslashes * 2));
    }
    result.push('"');
    result
}

/// Captures all processes visible to the current Windows session.
///
/// Access-denied processes remain represented using ToolHelp PID/parent/name facts;
/// unavailable creation/path/package metadata is left empty instead of failing the snapshot.
pub fn capture_process_snapshot() -> NativeResult<NativeProcessSnapshot> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }.map_err(|error| {
        NativeError::new(
            "process-observation",
            "PROCESS_SNAPSHOT_FAILED",
            format!("CreateToolhelp32Snapshot failed: {error}"),
        )
    })?;
    let _snapshot_guard = SafeHandle::new(snapshot);

    let mut entry = PROCESSENTRY32W::default();
    entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
    let mut processes = Vec::new();

    if unsafe { Process32FirstW(snapshot, &mut entry) }.is_ok() {
        loop {
            let pid = entry.th32ProcessID;
            if pid != 0 {
                processes.push(inspect_process_entry(
                    pid,
                    entry.th32ParentProcessID,
                    wide_to_string(&entry.szExeFile),
                ));
            }

            entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
            if unsafe { Process32NextW(snapshot, &mut entry) }.is_err() {
                break;
            }
        }
    }

    processes.sort_by_key(|process| process.process_id);
    Ok(NativeProcessSnapshot {
        processes,
        captured_at: now_ms(),
    })
}

fn inspect_process_entry(pid: u32, parent_pid: u32, toolhelp_name: String) -> NativeProcessEntry {
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) };
    let Ok(handle) = handle else {
        return NativeProcessEntry {
            process_id: pid,
            parent_process_id: parent_pid,
            process_creation_time: 0,
            executable_path: None,
            executable_name: non_empty(toolhelp_name),
            package_full_name: None,
            aumid: None,
        };
    };

    let creation_time = query_creation_time(handle);
    let executable_path = query_executable_path(handle);
    let executable_name = executable_path
        .as_ref()
        .and_then(|path| std::path::Path::new(path).file_name())
        .and_then(|name| name.to_str())
        .map(str::to_string)
        .or_else(|| non_empty(toolhelp_name));
    let (package_full_name, aumid) = query_package_info(handle);
    let _ = unsafe { CloseHandle(handle) };

    NativeProcessEntry {
        process_id: pid,
        parent_process_id: parent_pid,
        process_creation_time: creation_time,
        executable_path,
        executable_name,
        package_full_name,
        aumid,
    }
}

fn query_creation_time(handle: HANDLE) -> u64 {
    let mut creation = FILETIME::default();
    let mut exit = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    if unsafe { GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) }.is_err() {
        return 0;
    }
    (creation.dwLowDateTime as u64) | ((creation.dwHighDateTime as u64) << 32)
}

fn query_executable_path(handle: HANDLE) -> Option<String> {
    let mut path_buf = [0u16; 32768];
    let mut path_len = path_buf.len() as u32;
    if unsafe {
        QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_FORMAT(0),
            PWSTR(path_buf.as_mut_ptr()),
            &mut path_len,
        )
    }
    .is_err()
        || path_len == 0
    {
        return None;
    }
    Some(normalize_canonical_path(&wide_to_string(
        &path_buf[..path_len as usize],
    )))
}

fn query_package_info(handle: HANDLE) -> (Option<String>, Option<String>) {
    unsafe {
        let Ok(kernel32) = GetModuleHandleW(windows::core::w!("kernel32.dll")) else {
            return (None, None);
        };

        type GetPkgNameFn = unsafe extern "system" fn(HANDLE, *mut u32, *mut u16) -> i32;
        type GetAumidFn = unsafe extern "system" fn(HANDLE, *mut u32, *mut u16) -> i32;

        let pkg_fn: Option<GetPkgNameFn> =
            std::mem::transmute(GetProcAddress(kernel32, windows::core::s!("GetPackageFullName")));
        let aumid_fn: Option<GetAumidFn> = std::mem::transmute(GetProcAddress(
            kernel32,
            windows::core::s!("GetApplicationUserModelId"),
        ));

        (query_dynamic_string(handle, pkg_fn), query_dynamic_string(handle, aumid_fn))
    }
}

unsafe fn query_dynamic_string(
    handle: HANDLE,
    function: Option<unsafe extern "system" fn(HANDLE, *mut u32, *mut u16) -> i32>,
) -> Option<String> {
    let function = function?;
    let mut len = 0u32;
    let _ = function(handle, &mut len, std::ptr::null_mut());
    if len == 0 {
        return None;
    }
    let mut buffer = vec![0u16; len as usize];
    if function(handle, &mut len, buffer.as_mut_ptr()) != 0 {
        return None;
    }
    non_empty(wide_to_string(&buffer))
}

fn non_empty(value: String) -> Option<String> {
    if value.is_empty() { None } else { Some(value) }
}

fn wide_to_string(buffer: &[u16]) -> String {
    let length = buffer
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(buffer.len());
    String::from_utf16_lossy(&buffer[..length])
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// Launches a Win32 executable directly using CreateProcessW without a shell.
pub fn launch_win32_process(spec: &Win32LaunchSpec) -> NativeResult<ProcessLaunchResult> {
    let win32_exe = to_win32_path(&spec.executable_path);
    let mut cmd_line = escape_windows_arg(&win32_exe);
    if let Some(args) = &spec.arguments {
        for arg in args {
            cmd_line.push(' ');
            cmd_line.push_str(&escape_windows_arg(arg));
        }
    }

    let mut wide_cmd_line = to_wide(&cmd_line);
    let wide_cwd = spec.working_directory.as_ref().map(|cwd| {
        let win_cwd = to_win32_path(cwd);
        to_wide(&win_cwd)
    });

    unsafe {
        let startup_info: STARTUPINFOW = std::mem::zeroed();
        let mut process_info: PROCESS_INFORMATION = std::mem::zeroed();
        let cwd_ptr = wide_cwd
            .as_ref()
            .map(|value| PCWSTR(value.as_ptr()))
            .unwrap_or(PCWSTR::null());

        let result = CreateProcessW(
            None,
            Some(PWSTR(wide_cmd_line.as_mut_ptr())),
            None,
            None,
            false,
            DETACHED_PROCESS,
            None,
            cwd_ptr,
            &startup_info,
            &mut process_info,
        );

        match result {
            Ok(_) => {
                let _process_guard = SafeHandle::new(process_info.hProcess);
                let _thread_guard = SafeHandle::new(process_info.hThread);
                Ok(ProcessLaunchResult {
                    success: true,
                    pid: Some(process_info.dwProcessId),
                    error: None,
                })
            }
            Err(error) => Ok(ProcessLaunchResult {
                success: false,
                pid: None,
                error: Some(format!("{}: {}", error.code().0 as u32, error.message())),
            }),
        }
    }
}

/// Launches a packaged Windows Store / MSIX application via the shell AppsFolder protocol.
pub fn launch_packaged_app(spec: &PackagedLaunchSpec) -> NativeResult<ProcessLaunchResult> {
    let aumid = spec.aumid.trim();
    if aumid.is_empty() {
        return Ok(ProcessLaunchResult {
            success: false,
            pid: None,
            error: Some("Missing required AUMID for packaged app launch".to_string()),
        });
    }

    let target_uri = format!("shell:AppsFolder\\{}", aumid);
    let win32_spec = Win32LaunchSpec {
        executable_path: "explorer.exe".to_string(),
        arguments: {
            let mut args = vec![target_uri];
            if let Some(extra) = &spec.arguments {
                args.extend(extra.clone());
            }
            Some(args)
        },
        working_directory: None,
    };

    launch_win32_process(&win32_spec)
}
