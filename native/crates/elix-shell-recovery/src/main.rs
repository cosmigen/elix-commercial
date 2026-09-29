//! Minimal independent Windows-shell recovery executable for ELIX.
//!
//! This binary deliberately has no dependency on the main ELIX host, renderer,
//! plugin graph, themes, or application database. Its only Windows mutation is
//! conservative restoration: make Explorer taskbar windows reachable again.
//! It can also watch one process ID and restore when that process exits.

use std::env;
use std::process::ExitCode;

const EXIT_OK: u8 = 0;
const EXIT_USAGE: u8 = 2;
const EXIT_RECOVERY_FAILED: u8 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Command {
    Restore,
    Check,
    Watch(u32),
}

fn parse_command<I>(args: I) -> Result<Command, String>
where
    I: IntoIterator<Item = String>,
{
    let mut args = args.into_iter();
    let _program = args.next();
    match args.next().as_deref() {
        None | Some("restore") => {
            if args.next().is_some() {
                return Err("restore does not accept extra arguments".to_string());
            }
            Ok(Command::Restore)
        }
        Some("check") => {
            if args.next().is_some() {
                return Err("check does not accept extra arguments".to_string());
            }
            Ok(Command::Check)
        }
        Some("watch") => {
            let raw_pid = args
                .next()
                .ok_or_else(|| "watch requires a process ID".to_string())?;
            if args.next().is_some() {
                return Err("watch accepts exactly one process ID".to_string());
            }
            let pid = raw_pid
                .parse::<u32>()
                .map_err(|_| format!("invalid process ID: {raw_pid}"))?;
            if pid == 0 {
                return Err("process ID must be greater than zero".to_string());
            }
            Ok(Command::Watch(pid))
        }
        Some(other) => Err(format!("unknown command: {other}")),
    }
}

fn is_taskbar_class(class_name: &str) -> bool {
    matches!(class_name, "Shell_TrayWnd" | "Shell_SecondaryTrayWnd")
}

#[cfg(windows)]
mod platform {
    use super::is_taskbar_class;
    use std::ffi::c_void;
    use std::process::Command;
    use std::thread;
    use std::time::Duration;

    const SW_SHOWNOACTIVATE: i32 = 4;
    const DESKTOP_READOBJECTS: u32 = 0x0001;
    const DEFAULT_DESKTOP_NAME: [u16; 8] = [100, 101, 102, 97, 117, 108, 116, 0];
    const SYNCHRONIZE: u32 = 0x0010_0000;
    const WAIT_OBJECT_0: u32 = 0x0000_0000;
    const WAIT_TIMEOUT: u32 = 0x0000_0102;
    const WAIT_FAILED: u32 = 0xFFFF_FFFF;

    #[link(name = "user32")]
    unsafe extern "system" {
        fn EnumWindows(
            callback: Option<unsafe extern "system" fn(isize, isize) -> i32>,
            param: isize,
        ) -> i32;
        fn EnumDesktopWindows(
            desktop: *mut c_void,
            callback: Option<unsafe extern "system" fn(isize, isize) -> i32>,
            param: isize,
        ) -> i32;
        fn OpenDesktopW(
            desktop: *const u16,
            flags: u32,
            inherit: i32,
            desired_access: u32,
        ) -> *mut c_void;
        fn CloseDesktop(desktop: *mut c_void) -> i32;
        fn GetClassNameW(hwnd: isize, buffer: *mut u16, max_count: i32) -> i32;
        fn IsWindowVisible(hwnd: isize) -> i32;
        fn ShowWindow(hwnd: isize, command: i32) -> i32;
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn OpenProcess(desired_access: u32, inherit_handle: i32, process_id: u32) -> *mut c_void;
        fn WaitForSingleObject(handle: *mut c_void, milliseconds: u32) -> u32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }

    #[derive(Debug, Clone, Copy)]
    pub struct TaskbarWindow {
        pub hwnd: isize,
        pub visible: bool,
    }

    unsafe extern "system" fn enumerate_taskbars(hwnd: isize, param: isize) -> i32 {
        let windows = &mut *(param as *mut Vec<TaskbarWindow>);
        let mut class_buffer = [0_u16; 128];
        let length = GetClassNameW(hwnd, class_buffer.as_mut_ptr(), class_buffer.len() as i32);
        if length <= 0 {
            return 1;
        }

        let class_name = String::from_utf16_lossy(&class_buffer[..length as usize]);
        if is_taskbar_class(&class_name) {
            windows.push(TaskbarWindow {
                hwnd,
                visible: IsWindowVisible(hwnd) != 0,
            });
        }
        1
    }

    pub fn taskbars() -> Vec<TaskbarWindow> {
        let mut windows = Vec::new();
        unsafe {
            let pointer = &mut windows as *mut Vec<TaskbarWindow> as isize;
            let default_desktop =
                OpenDesktopW(DEFAULT_DESKTOP_NAME.as_ptr(), 0, 0, DESKTOP_READOBJECTS);
            if default_desktop.is_null() {
                let _ = EnumWindows(Some(enumerate_taskbars), pointer);
            } else {
                let _ = EnumDesktopWindows(default_desktop, Some(enumerate_taskbars), pointer);
                let _ = CloseDesktop(default_desktop);
            }
        }
        windows
    }

    fn start_explorer_if_missing() {
        if !taskbars().is_empty() {
            return;
        }

        let _ = Command::new("explorer.exe").spawn();
        for _ in 0..10 {
            thread::sleep(Duration::from_millis(250));
            if !taskbars().is_empty() {
                break;
            }
        }
    }

    pub fn restore_taskbars() -> Result<usize, String> {
        start_explorer_if_missing();
        let windows = taskbars();
        if windows.is_empty() {
            return Err(
                "Explorer taskbar was not found in the current Windows session".to_string(),
            );
        }

        for window in &windows {
            unsafe {
                // SW_SHOWNOACTIVATE keeps recovery from stealing foreground focus.
                let _ = ShowWindow(window.hwnd, SW_SHOWNOACTIVATE);
            }
        }

        // Verify the restoration rather than assuming ShowWindow succeeded.
        for _ in 0..8 {
            let current = taskbars();
            if !current.is_empty() && current.iter().all(|window| window.visible) {
                return Ok(current.len());
            }
            thread::sleep(Duration::from_millis(125));
        }

        Err("one or more Explorer taskbars remained hidden after restoration".to_string())
    }

    pub fn taskbar_status() -> (usize, usize) {
        let windows = taskbars();
        let visible = windows.iter().filter(|window| window.visible).count();
        (windows.len(), visible)
    }

    pub fn wait_for_process_exit(process_id: u32) -> Result<(), String> {
        unsafe {
            let handle = OpenProcess(SYNCHRONIZE, 0, process_id);
            if handle.is_null() {
                // If the process vanished before the watcher opened it, recovery should run now.
                return Ok(());
            }

            loop {
                match WaitForSingleObject(handle, 1_000) {
                    WAIT_OBJECT_0 => {
                        let _ = CloseHandle(handle);
                        return Ok(());
                    }
                    WAIT_TIMEOUT => continue,
                    WAIT_FAILED => {
                        let _ = CloseHandle(handle);
                        return Err(format!("failed while waiting for process {process_id}"));
                    }
                    other => {
                        let _ = CloseHandle(handle);
                        return Err(format!(
                            "unexpected wait result 0x{other:08x} for process {process_id}",
                        ));
                    }
                }
            }
        }
    }
}

#[cfg(not(windows))]
mod platform {
    pub fn restore_taskbars() -> Result<usize, String> {
        Err("ELIX shell recovery is only supported on Windows".to_string())
    }

    pub fn taskbar_status() -> (usize, usize) {
        (0, 0)
    }

    pub fn wait_for_process_exit(_process_id: u32) -> Result<(), String> {
        Err("ELIX shell recovery watch mode is only supported on Windows".to_string())
    }
}

fn print_usage() {
    eprintln!("Usage:");
    eprintln!("  elix-shell-recovery restore");
    eprintln!("  elix-shell-recovery check");
    eprintln!("  elix-shell-recovery watch <pid>");
}

fn main() -> ExitCode {
    let command = match parse_command(env::args()) {
        Ok(command) => command,
        Err(error) => {
            eprintln!("{error}");
            print_usage();
            return ExitCode::from(EXIT_USAGE);
        }
    };

    match command {
        Command::Check => {
            let (total, visible) = platform::taskbar_status();
            println!("taskbars={total} visible={visible}");
            if total > 0 && total == visible {
                ExitCode::from(EXIT_OK)
            } else {
                ExitCode::from(EXIT_RECOVERY_FAILED)
            }
        }
        Command::Restore => match platform::restore_taskbars() {
            Ok(count) => {
                println!("restored_taskbars={count}");
                ExitCode::from(EXIT_OK)
            }
            Err(error) => {
                eprintln!("recovery failed: {error}");
                ExitCode::from(EXIT_RECOVERY_FAILED)
            }
        },
        Command::Watch(process_id) => {
            println!("watching_pid={process_id}");
            if let Err(error) = platform::wait_for_process_exit(process_id) {
                eprintln!("watch failed: {error}");
                return ExitCode::from(EXIT_RECOVERY_FAILED);
            }
            match platform::restore_taskbars() {
                Ok(count) => {
                    println!("process_exited={process_id} restored_taskbars={count}");
                    ExitCode::from(EXIT_OK)
                }
                Err(error) => {
                    eprintln!("process_exited={process_id} recovery failed: {error}");
                    ExitCode::from(EXIT_RECOVERY_FAILED)
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{is_taskbar_class, parse_command, Command};

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn recognizes_primary_and_secondary_taskbar_classes_only() {
        assert!(is_taskbar_class("Shell_TrayWnd"));
        assert!(is_taskbar_class("Shell_SecondaryTrayWnd"));
        assert!(!is_taskbar_class("Progman"));
        assert!(!is_taskbar_class("WorkerW"));
    }

    #[test]
    fn parses_restore_check_and_watch_commands() {
        assert_eq!(
            parse_command(args(&["recovery"])).unwrap(),
            Command::Restore
        );
        assert_eq!(
            parse_command(args(&["recovery", "restore"])).unwrap(),
            Command::Restore,
        );
        assert_eq!(
            parse_command(args(&["recovery", "check"])).unwrap(),
            Command::Check,
        );
        assert_eq!(
            parse_command(args(&["recovery", "watch", "42"])).unwrap(),
            Command::Watch(42),
        );
    }

    #[test]
    fn rejects_invalid_watch_process_ids_and_extra_arguments() {
        assert!(parse_command(args(&["recovery", "watch"])).is_err());
        assert!(parse_command(args(&["recovery", "watch", "0"])).is_err());
        assert!(parse_command(args(&["recovery", "watch", "abc"])).is_err());
        assert!(parse_command(args(&["recovery", "restore", "extra"])).is_err());
    }
}
