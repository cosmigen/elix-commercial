//! Native Windows directory change watcher using ReadDirectoryChangesW.
//!
//! Provides non-blocking, interrupt-driven directory observation with cancellation,
//! buffer overflow detection, and strict RAII handle management.

use crate::error::{NativeError, NativeResult};
use crate::runtime::apartment::SafeHandle;
use crate::runtime::paths::{from_wide_slice, normalize_canonical_path, to_wide, to_win32_path};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{
    GetLastError, ERROR_IO_PENDING, ERROR_NOTIFY_ENUM_DIR, ERROR_OPERATION_ABORTED, HANDLE,
    WAIT_OBJECT_0,
};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, ReadDirectoryChangesW, FILE_ACTION_ADDED, FILE_ACTION_MODIFIED,
    FILE_ACTION_REMOVED, FILE_ACTION_RENAMED_NEW_NAME, FILE_ACTION_RENAMED_OLD_NAME,
    FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OVERLAPPED, FILE_LIST_DIRECTORY,
    FILE_NOTIFY_CHANGE_ATTRIBUTES, FILE_NOTIFY_CHANGE_DIR_NAME, FILE_NOTIFY_CHANGE_FILE_NAME,
    FILE_NOTIFY_CHANGE_LAST_WRITE, FILE_NOTIFY_CHANGE_SIZE, FILE_NOTIFY_INFORMATION,
    FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
};
use windows::Win32::System::Threading::{
    CreateEventW, ResetEvent, SetEvent, WaitForMultipleObjects,
};
use windows::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};

/// Maximum number of queued events across all active watchers before native-host saturation kicks in.
pub const DEFAULT_GLOBAL_EVENT_BUDGET: usize = 2048;

/// Maximum number of in-flight events for any single container before it saturates.
pub const DEFAULT_PER_CONTAINER_EVENT_LIMIT: usize = 128;

/// Maximum number of simultaneous active watchers before rejecting new registrations.
/// Bounds process thread count and memory (256 * 64 KiB = 16 MiB max buffer memory).
pub const DEFAULT_MAX_ACTIVE_WATCHERS: usize = 256;

/// Fixed buffer size allocated per directory watcher (64 KiB).
pub const WATCHER_BUFFER_SIZE: usize = 64 * 1024;

/// The requested container may be a reparse point; CreateFileW follows its target.
pub const WATCHER_FOLLOWS_CONTAINER_REPARSE_POINTS: bool = true;

/// Directory observation is intentionally limited to direct children.
pub const WATCHER_WATCHES_SUBTREE: bool = false;

/// Normalized directory change event types.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ChangeType {
    Added,
    Removed,
    Modified,
    Renamed,
    BufferOverflow,
    ContainerInvalidated,
}

/// A filesystem change event emitted by the native watcher.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WatcherEvent {
    pub subscription_id: u64,
    pub container_path: String,
    pub change_type: ChangeType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_file_name: Option<String>,
}

/// Callback type for watcher events.
pub type WatcherCallback = Arc<dyn Fn(WatcherEvent) + Send + Sync + 'static>;

/// Represents an active single-container watcher running on its own thread.
struct ActiveWatch {
    #[allow(dead_code)]
    container_path: String,
    stop_event: SafeHandle,
    dir_handle: SafeHandle,
    thread_handle: Option<JoinHandle<()>>,
    is_active: Arc<AtomicBool>,
    is_invalidated: Arc<AtomicBool>,
    pending_invalidation: Arc<AtomicBool>,
    precision_epoch: Arc<AtomicU64>,
    container_event_count: Arc<AtomicUsize>,
    callback: WatcherCallback,
}

fn discard_rename_from_older_precision_epoch(
    pending_old_name: &mut Option<String>,
    observed_epoch: &mut u64,
    current_epoch: u64,
) {
    if *observed_epoch != current_epoch {
        *pending_old_name = None;
        *observed_epoch = current_epoch;
    }
}

#[derive(Clone, Copy, Default)]
struct WatcherWorkerTestHooks {
    fail_initialization: bool,
    fail_after_startup: bool,
}

/// Global native watcher registry.
pub struct NativeNamespaceWatcher {
    next_id: AtomicU64,
    watches: Mutex<HashMap<u64, ActiveWatch>>,
    global_event_count: Arc<AtomicUsize>,
}

impl NativeNamespaceWatcher {
    pub fn new() -> Self {
        Self {
            next_id: AtomicU64::new(1),
            watches: Mutex::new(HashMap::new()),
            global_event_count: Arc::new(AtomicUsize::new(0)),
        }
    }

    /// Returns the current total in-flight event count across all watchers.
    pub fn global_event_count(&self) -> usize {
        self.global_event_count.load(Ordering::Relaxed)
    }

    /// Starts watching a directory container.
    pub fn watch(&self, container_path: &str, callback: WatcherCallback) -> NativeResult<u64> {
        self.watch_with_hooks(container_path, callback, WatcherWorkerTestHooks::default())
    }

    fn watch_with_hooks(
        &self,
        container_path: &str,
        callback: WatcherCallback,
        test_hooks: WatcherWorkerTestHooks,
    ) -> NativeResult<u64> {
        {
            let watches = self.watches.lock();
            if watches.len() >= DEFAULT_MAX_ACTIVE_WATCHERS {
                return Err(NativeError::resource_exhausted(format!(
                    "Maximum concurrent directory watchers ({}) exceeded",
                    DEFAULT_MAX_ACTIVE_WATCHERS
                )));
            }
        }

        let canonical = normalize_canonical_path(container_path);
        let win32_path = to_win32_path(&canonical);
        let wide_path = to_wide(&win32_path);

        unsafe {
            // Open directory for asynchronous overlapping directory change observation
            let dir_raw = CreateFileW(
                PCWSTR(wide_path.as_ptr()),
                FILE_LIST_DIRECTORY.0,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                None,
                OPEN_EXISTING,
                // Omitting FILE_FLAG_OPEN_REPARSE_POINT follows a container link to its target.
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OVERLAPPED,
                None,
            )
            .map_err(|err| {
                NativeError::from_windows_error(
                    err,
                    &format!("Failed to open directory for watching: {}", container_path),
                )
            })?;

            let dir_handle = SafeHandle::new(dir_raw).ok_or_else(|| {
                NativeError::new(
                    "watcher",
                    "INVALID_HANDLE",
                    "Failed to obtain valid directory handle",
                )
            })?;

            // Create manual-reset stop event
            let stop_raw = CreateEventW(None, true, false, None).map_err(|err| {
                NativeError::from_windows_error(err, "Failed to create watcher stop event")
            })?;
            let stop_handle = SafeHandle::new(stop_raw).ok_or_else(|| {
                NativeError::new(
                    "watcher",
                    "INVALID_HANDLE",
                    "Failed to create valid stop event handle",
                )
            })?;

            let subscription_id = self.next_id.fetch_add(1, Ordering::SeqCst);
            let is_active = Arc::new(AtomicBool::new(true));
            let is_invalidated = Arc::new(AtomicBool::new(false));
            let pending_invalidation = Arc::new(AtomicBool::new(false));
            let precision_epoch = Arc::new(AtomicU64::new(0));
            let container_event_count = Arc::new(AtomicUsize::new(0));

            let thread_dir_raw = dir_handle.raw().0 as isize;
            let thread_stop_raw = stop_handle.raw().0 as isize;
            let thread_active = Arc::clone(&is_active);
            let thread_invalidated = Arc::clone(&is_invalidated);
            let thread_pending_invalidation = Arc::clone(&pending_invalidation);
            let thread_precision_epoch = Arc::clone(&precision_epoch);
            let thread_container_count = Arc::clone(&container_event_count);
            let thread_global_count = Arc::clone(&self.global_event_count);
            let thread_callback = Arc::clone(&callback);
            let thread_canonical = canonical.clone();
            let (ready_tx, ready_rx) = std::sync::mpsc::channel::<NativeResult<()>>();

            let thread_handle = thread::spawn(move || {
                let thread_dir_handle = HANDLE(thread_dir_raw as *mut _);
                let thread_stop_handle = HANDLE(thread_stop_raw as *mut _);

                if test_hooks.fail_initialization {
                    let _ = ready_tx.send(Err(NativeError::new(
                        "watcher",
                        "WATCHER_INITIALIZATION_FAILED",
                        "Injected watcher worker initialization failure",
                    )));
                    thread_active.store(false, Ordering::SeqCst);
                    return;
                }

                // Create manual-reset overlapped event inside the worker thread
                let ovl_raw = match CreateEventW(None, true, false, None) {
                    Ok(h) => h,
                    Err(error) => {
                        let _ = ready_tx.send(Err(NativeError::from_windows_error(
                            error,
                            "Failed to create watcher overlapped event",
                        )));
                        thread_active.store(false, Ordering::SeqCst);
                        return;
                    }
                };
                let ovl_guard = match SafeHandle::new(ovl_raw) {
                    Some(g) => g,
                    None => {
                        let _ = ready_tx.send(Err(NativeError::new(
                            "watcher",
                            "INVALID_HANDLE",
                            "Failed to create valid watcher overlapped event handle",
                        )));
                        thread_active.store(false, Ordering::SeqCst);
                        return;
                    }
                };
                let thread_ovl_handle = ovl_guard.raw();

                // Buffer for ReadDirectoryChangesW (fixed 64 KiB)
                let mut buffer = vec![0u8; WATCHER_BUFFER_SIZE];
                let notify_filter = FILE_NOTIFY_CHANGE_FILE_NAME
                    | FILE_NOTIFY_CHANGE_DIR_NAME
                    | FILE_NOTIFY_CHANGE_ATTRIBUTES
                    | FILE_NOTIFY_CHANGE_SIZE
                    | FILE_NOTIFY_CHANGE_LAST_WRITE;

                let wait_handles = [thread_ovl_handle, thread_stop_handle];

                let mut pending_old_name: Option<String> = None;
                let mut observed_precision_epoch = 0;

                let mark_degraded = |change_type: ChangeType| {
                    thread_invalidated.store(true, Ordering::SeqCst);
                    if !thread_pending_invalidation.swap(true, Ordering::SeqCst) {
                        thread_precision_epoch.fetch_add(1, Ordering::SeqCst);
                        thread_callback(WatcherEvent {
                            subscription_id,
                            container_path: thread_canonical.clone(),
                            change_type,
                            file_name: None,
                            old_file_name: None,
                        });
                    }
                };

                let emit_event = |change_type: ChangeType,
                                  file_name: Option<String>,
                                  old_file_name: Option<String>|
                 -> bool {
                    if change_type == ChangeType::ContainerInvalidated
                        || change_type == ChangeType::BufferOverflow
                    {
                        mark_degraded(change_type);
                        return true;
                    }

                    if thread_invalidated.load(Ordering::SeqCst) {
                        // Dropping fine-grained event: container is in degraded/invalidated state
                        return true;
                    }

                    let current_global = thread_global_count.load(Ordering::Relaxed);
                    let current_container = thread_container_count.load(Ordering::Relaxed);

                    if current_global >= DEFAULT_GLOBAL_EVENT_BUDGET
                        || current_container >= DEFAULT_PER_CONTAINER_EVENT_LIMIT
                    {
                        // Saturation reached: transition container to invalidated state
                        mark_degraded(ChangeType::ContainerInvalidated);
                        return true;
                    }

                    thread_global_count.fetch_add(1, Ordering::SeqCst);
                    thread_container_count.fetch_add(1, Ordering::SeqCst);

                    thread_callback(WatcherEvent {
                        subscription_id,
                        container_path: thread_canonical.clone(),
                        change_type,
                        file_name,
                        old_file_name,
                    });
                    false
                };

                let mut is_first_iteration = true;

                while thread_active.load(Ordering::SeqCst) {
                    discard_rename_from_older_precision_epoch(
                        &mut pending_old_name,
                        &mut observed_precision_epoch,
                        thread_precision_epoch.load(Ordering::SeqCst),
                    );
                    let mut overlapped: OVERLAPPED = std::mem::zeroed();
                    overlapped.hEvent = thread_ovl_handle;

                    let mut bytes_returned = 0u32;
                    let queue_res = ReadDirectoryChangesW(
                        thread_dir_handle,
                        buffer.as_mut_ptr() as _,
                        buffer.len() as u32,
                        WATCHER_WATCHES_SUBTREE,
                        notify_filter,
                        Some(&mut bytes_returned),
                        Some(&mut overlapped),
                        None,
                    );

                    let queue_error = match queue_res {
                        Ok(()) => None,
                        Err(ref error)
                            if (error.code().0 as u32 & 0xFFFF) == ERROR_IO_PENDING.0 =>
                        {
                            None
                        }
                        Err(error) => Some(NativeError::from_windows_error(
                            error,
                            "Failed to queue ReadDirectoryChangesW",
                        )),
                    };

                    if is_first_iteration {
                        is_first_iteration = false;
                        if let Some(error) = queue_error {
                            let _ = ready_tx.send(Err(error));
                            thread_active.store(false, Ordering::SeqCst);
                            return;
                        }
                        let _ = ready_tx.send(Ok(()));
                        if test_hooks.fail_after_startup {
                            mark_degraded(ChangeType::ContainerInvalidated);
                            break;
                        }
                    } else if queue_error.is_some() {
                        mark_degraded(ChangeType::ContainerInvalidated);
                        break;
                    }

                    // Wait for either the I/O completion or the stop event
                    let wait_result = WaitForMultipleObjects(&wait_handles, false, 0xFFFFFFFF);

                    if wait_result.0 == WAIT_OBJECT_0.0 + 1 {
                        // Stop event signaled! Cancel pending I/O and exit
                        let _ = CancelIoEx(thread_dir_handle, Some(&overlapped));
                        break;
                    } else if wait_result == WAIT_OBJECT_0 {
                        // Overlapped event signaled
                        let mut transferred = 0u32;
                        let get_res = GetOverlappedResult(
                            thread_dir_handle,
                            &overlapped,
                            &mut transferred,
                            false,
                        );

                        let _ = ResetEvent(thread_ovl_handle);
                        discard_rename_from_older_precision_epoch(
                            &mut pending_old_name,
                            &mut observed_precision_epoch,
                            thread_precision_epoch.load(Ordering::SeqCst),
                        );

                        if get_res.is_err() {
                            let err = GetLastError();
                            if err == ERROR_OPERATION_ABORTED {
                                break;
                            }
                            if err == ERROR_NOTIFY_ENUM_DIR {
                                pending_old_name = None;
                                emit_event(ChangeType::BufferOverflow, None, None);
                                continue;
                            }
                            mark_degraded(ChangeType::ContainerInvalidated);
                            break;
                        }

                        if transferred == 0 {
                            // 0 bytes transferred can indicate buffer overflow
                            pending_old_name = None;
                            emit_event(ChangeType::BufferOverflow, None, None);
                            continue;
                        }

                        // Walk the FILE_NOTIFY_INFORMATION structures
                        let mut offset = 0usize;
                        while offset < transferred as usize {
                            let info_ptr =
                                buffer.as_ptr().add(offset) as *const FILE_NOTIFY_INFORMATION;
                            let info = &*info_ptr;

                            let name_len = (info.FileNameLength as usize) / 2;
                            let name_slice =
                                std::slice::from_raw_parts(info.FileName.as_ptr(), name_len);
                            let file_name = from_wide_slice(name_slice);

                            match info.Action {
                                FILE_ACTION_ADDED => {
                                    if emit_event(ChangeType::Added, Some(file_name), None) {
                                        pending_old_name = None;
                                    }
                                }
                                FILE_ACTION_REMOVED => {
                                    if emit_event(ChangeType::Removed, Some(file_name), None) {
                                        pending_old_name = None;
                                    }
                                }
                                FILE_ACTION_MODIFIED => {
                                    if emit_event(ChangeType::Modified, Some(file_name), None) {
                                        pending_old_name = None;
                                    }
                                }
                                FILE_ACTION_RENAMED_OLD_NAME => {
                                    pending_old_name = Some(file_name);
                                }
                                FILE_ACTION_RENAMED_NEW_NAME => {
                                    let old = pending_old_name.take();
                                    if emit_event(ChangeType::Renamed, Some(file_name), old) {
                                        pending_old_name = None;
                                    }
                                }
                                _ => {}
                            }

                            if info.NextEntryOffset == 0 {
                                break;
                            }
                            offset += info.NextEntryOffset as usize;
                        }
                    } else {
                        mark_degraded(ChangeType::ContainerInvalidated);
                        break;
                    }
                }
                thread_active.store(false, Ordering::SeqCst);
            });

            // Wait for worker thread to queue its initial ReadDirectoryChangesW overlapped I/O request
            let startup = ready_rx.recv_timeout(std::time::Duration::from_millis(500));
            if let Err(error) = startup.unwrap_or_else(|recv_error| {
                Err(NativeError::new(
                    "watcher",
                    "WATCHER_START_TIMEOUT",
                    format!("Watcher worker did not become ready: {}", recv_error),
                ))
            }) {
                is_active.store(false, Ordering::SeqCst);
                let _ = SetEvent(stop_handle.raw());
                let _ = CancelIoEx(dir_handle.raw(), None);
                let _ = thread_handle.join();
                return Err(error);
            }

            let active_watch = ActiveWatch {
                container_path: canonical,
                stop_event: stop_handle,
                dir_handle,
                thread_handle: Some(thread_handle),
                is_active,
                is_invalidated,
                pending_invalidation,
                precision_epoch,
                container_event_count,
                callback,
            };

            self.watches.lock().insert(subscription_id, active_watch);
            Ok(subscription_id)
        }
    }

    /// Simulates queue saturation and container invalidation for testing.
    pub fn simulate_overflow(&self, subscription_id: u64) -> NativeResult<()> {
        let watches = self.watches.lock();
        if let Some(watch) = watches.get(&subscription_id) {
            watch.is_invalidated.store(true, Ordering::SeqCst);
            if !watch.pending_invalidation.swap(true, Ordering::SeqCst) {
                watch.precision_epoch.fetch_add(1, Ordering::SeqCst);
                (watch.callback)(WatcherEvent {
                    subscription_id,
                    container_path: watch.container_path.clone(),
                    change_type: ChangeType::ContainerInvalidated,
                    file_name: None,
                    old_file_name: None,
                });
            }
            Ok(())
        } else {
            Err(NativeError::new(
                "watcher",
                "SUBSCRIPTION_NOT_FOUND",
                format!("Subscription {} not found", subscription_id),
            ))
        }
    }

    /// Called when an event has been transmitted to decrement in-flight counts.
    pub fn event_consumed(&self, subscription_id: u64) {
        let _ = self
            .global_event_count
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |x| {
                if x > 0 {
                    Some(x - 1)
                } else {
                    Some(0)
                }
            });
        let watches = self.watches.lock();
        if let Some(watch) = watches.get(&subscription_id) {
            let _ =
                watch
                    .container_event_count
                    .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |x| {
                        if x > 0 {
                            Some(x - 1)
                        } else {
                            Some(0)
                        }
                    });
        }
    }

    /// Rearms an invalidated container, clearing degraded state once reconciled.
    pub fn rearm_container(&self, subscription_id: u64) -> bool {
        let watches = self.watches.lock();
        if let Some(watch) = watches.get(&subscription_id) {
            if !watch.is_active.load(Ordering::SeqCst) {
                return false;
            }
            watch.container_event_count.store(0, Ordering::SeqCst);
            watch.is_invalidated.store(false, Ordering::SeqCst);
            watch.pending_invalidation.store(false, Ordering::SeqCst);
            true
        } else {
            false
        }
    }

    /// Returns the current in-flight event count for a specific subscription.
    pub fn container_event_count(&self, subscription_id: u64) -> usize {
        let watches = self.watches.lock();
        watches
            .get(&subscription_id)
            .map(|w| w.container_event_count.load(Ordering::Relaxed))
            .unwrap_or(0)
    }

    /// Returns whether the container is currently in an invalidated/degraded state.
    pub fn is_container_invalidated(&self, subscription_id: u64) -> bool {
        let watches = self.watches.lock();
        watches
            .get(&subscription_id)
            .map(|w| w.is_invalidated.load(Ordering::Relaxed))
            .unwrap_or(false)
    }

    /// Returns whether the watcher worker is still observing its directory.
    pub fn is_watcher_alive(&self, subscription_id: u64) -> bool {
        let watches = self.watches.lock();
        watches
            .get(&subscription_id)
            .map(|watch| watch.is_active.load(Ordering::Relaxed))
            .unwrap_or(false)
    }

    /// Stops watching a specific subscription and releases its OS handles.
    pub fn unwatch(&self, subscription_id: u64) -> bool {
        let mut watch_opt = self.watches.lock().remove(&subscription_id);
        if let Some(mut watch) = watch_opt.take() {
            watch.is_active.store(false, Ordering::SeqCst);
            unsafe {
                let _ = SetEvent(watch.stop_event.raw());
                let _ = CancelIoEx(watch.dir_handle.raw(), None);
            }
            if let Some(th) = watch.thread_handle.take() {
                let _ = th.join();
            }
            true
        } else {
            false
        }
    }

    /// Stops all active directory watchers and releases all resources.
    pub fn dispose(&self) {
        let mut watches: HashMap<u64, ActiveWatch> = std::mem::take(&mut *self.watches.lock());
        for (_, mut watch) in watches.drain() {
            watch.is_active.store(false, Ordering::SeqCst);
            unsafe {
                let _ = SetEvent(watch.stop_event.raw());
                let _ = CancelIoEx(watch.dir_handle.raw(), None);
            }
            if let Some(th) = watch.thread_handle.take() {
                let _ = th.join();
            }
        }
    }
}

impl Default for NativeNamespaceWatcher {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for NativeNamespaceWatcher {
    fn drop(&mut self) {
        self.dispose();
    }
}

unsafe impl Send for NativeNamespaceWatcher {}
unsafe impl Sync for NativeNamespaceWatcher {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn initialization_failure_never_registers_a_watcher() {
        let watcher = NativeNamespaceWatcher::new();
        let result = watcher.watch_with_hooks(
            ".",
            Arc::new(|_| {}),
            WatcherWorkerTestHooks {
                fail_initialization: true,
                fail_after_startup: false,
            },
        );

        assert_eq!(result.unwrap_err().code, "WATCHER_INITIALIZATION_FAILED");
        assert!(watcher.watches.lock().is_empty());
    }

    #[test]
    fn precision_epoch_discards_a_pre_overflow_rename_half() {
        let mut pending_old_name = Some("before.txt".to_string());
        let mut observed_epoch = 7;

        discard_rename_from_older_precision_epoch(&mut pending_old_name, &mut observed_epoch, 8);

        assert_eq!(pending_old_name, None);
        assert_eq!(observed_epoch, 8);
    }

    #[test]
    fn fatal_runtime_failure_invalidates_and_cannot_be_rearmed() {
        let watcher = NativeNamespaceWatcher::new();
        let (event_tx, event_rx) = mpsc::channel();
        let subscription_id = watcher
            .watch_with_hooks(
                ".",
                Arc::new(move |event| {
                    let _ = event_tx.send(event);
                }),
                WatcherWorkerTestHooks {
                    fail_initialization: false,
                    fail_after_startup: true,
                },
            )
            .unwrap();

        let event = event_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(event.change_type, ChangeType::ContainerInvalidated);
        assert!(watcher.is_container_invalidated(subscription_id));
        assert!(!watcher.is_watcher_alive(subscription_id));
        assert!(!watcher.rearm_container(subscription_id));
        assert!(watcher.unwatch(subscription_id));
    }
}
