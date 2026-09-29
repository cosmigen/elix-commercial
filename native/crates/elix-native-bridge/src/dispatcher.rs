//! Request dispatcher with panic boundaries for ELIX Native Bridge.

#[path = "spaces.rs"]
mod spaces;
#[path = "window_control.rs"]
mod window_control;

use crate::outbound::StickyPrioritySender;
use crate::protocol::{BridgeEvent, BridgeRequest, BridgeResponse, HandshakeResult};
use crossbeam_channel::Sender;
use elix_native_core::app_bar::{AppBarManager, AppBarSpec};
use elix_native_core::error::NativeError;
use elix_native_core::icons::resolve_shell_icon;
use elix_native_core::identity::identify_file;
use elix_native_core::known_folders::{
    resolve_all_known_folders, resolve_known_folder, KnownFolderId,
};
use elix_native_core::process::{
    capture_process_snapshot, launch_packaged_app, launch_win32_process, PackagedLaunchSpec,
    Win32LaunchSpec,
};
use elix_native_core::shortcuts::{resolve_shortcut, resolve_shortcut_batch};
use elix_native_core::surface::{
    check_webview2_runtime, PhysicalBounds, SurfaceCreateSpec, SurfaceManager, SurfaceRendererSpec,
    SurfaceZOrderPolicy,
};
use elix_native_core::watcher::NativeNamespaceWatcher;
use elix_native_core::window_registry::WindowRegistryObserver;
use elix_native_core::windows_context::WindowsContextObserver;
use serde_json::json;
use spaces::{
    move_window_to_space, query_window_space, shell_create_space, shell_move_window_to_space,
    shell_notification_status, shell_remove_space, shell_rename_space, shell_snapshot,
    shell_switch_space, NativeShellCreateSpaceRequest, NativeShellRemoveSpaceRequest,
    NativeShellRenameSpaceRequest, NativeShellSpaceRequest, NativeSpacesMoveRequest,
    NativeSpacesWindowRequest,
};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use window_control::{execute_window_control, NativeWindowControlRequest};

const WINDOWS_CONTEXT_CHANGE_EVENT_KEY: u64 = u64::MAX;
const WINDOWS_CONTEXT_FAULT_EVENT_KEY: u64 = u64::MAX - 1;
const WINDOW_REGISTRY_CHANGE_EVENT_KEY: u64 = u64::MAX - 2;
const WINDOW_REGISTRY_FAULT_EVENT_KEY: u64 = u64::MAX - 3;

/// Dispatches RPC requests to native implementations with panic boundaries.
pub struct Dispatcher {
    watcher: Arc<NativeNamespaceWatcher>,
    windows_context: Arc<WindowsContextObserver>,
    window_registry: Arc<WindowRegistryObserver>,
    surface_manager: Option<Arc<SurfaceManager>>,
    app_bar_manager: Option<Arc<AppBarManager>>,
    priority_event_tx: StickyPrioritySender,
    droppable_event_tx: Sender<BridgeEvent>,
}

impl Dispatcher {
    pub fn new(
        priority_event_tx: StickyPrioritySender,
        droppable_event_tx: Sender<BridgeEvent>,
    ) -> Self {
        Self::with_watcher(
            Arc::new(NativeNamespaceWatcher::new()),
            priority_event_tx,
            droppable_event_tx,
        )
    }

    pub fn with_watcher(
        watcher: Arc<NativeNamespaceWatcher>,
        priority_event_tx: StickyPrioritySender,
        droppable_event_tx: Sender<BridgeEvent>,
    ) -> Self {
        let change_tx = priority_event_tx.clone();
        let fault_tx = priority_event_tx.clone();
        let windows_context = Arc::new(WindowsContextObserver::new(
            Arc::new(move |change| {
                change_tx.send_latest(
                    WINDOWS_CONTEXT_CHANGE_EVENT_KEY,
                    BridgeEvent {
                        event: "windowsContext/change".to_string(),
                        payload: json!(change),
                        subscription_id: None,
                    },
                );
            }),
            Arc::new(move |error| {
                fault_tx.send_latest(
                    WINDOWS_CONTEXT_FAULT_EVENT_KEY,
                    BridgeEvent {
                        event: "windowsContext/fault".to_string(),
                        payload: json!(error),
                        subscription_id: None,
                    },
                );
            }),
        ));

        let window_registry_tx = priority_event_tx.clone();
        let window_registry_fault_tx = priority_event_tx.clone();
        let window_registry = Arc::new(WindowRegistryObserver::new(
            Arc::new(move |change| {
                // Every change carries a complete authoritative snapshot, so only the newest
                // pending registry state is required while stdout is backpressured.
                window_registry_tx.send_latest(
                    WINDOW_REGISTRY_CHANGE_EVENT_KEY,
                    BridgeEvent {
                        event: "windowRegistry/change".to_string(),
                        payload: json!(change),
                        subscription_id: None,
                    },
                );
            }),
            Arc::new(move |error| {
                window_registry_fault_tx.send_latest(
                    WINDOW_REGISTRY_FAULT_EVENT_KEY,
                    BridgeEvent {
                        event: "windowRegistry/fault".to_string(),
                        payload: json!(error),
                        subscription_id: None,
                    },
                );
            }),
        ));

        let surface_tx = priority_event_tx.clone();
        let surface_manager = SurfaceManager::new(Arc::new(move |ev| {
            static NEXT_SURFACE_EVENT_KEY: std::sync::atomic::AtomicU64 =
                std::sync::atomic::AtomicU64::new(100_000_000);
            let key = NEXT_SURFACE_EVENT_KEY.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            surface_tx.send_latest(
                key,
                BridgeEvent {
                    event: "surface/event".to_string(),
                    payload: json!(ev),
                    subscription_id: None,
                },
            );
        }))
        .ok()
        .map(Arc::new);

        let app_bar_manager = AppBarManager::new().ok().map(Arc::new);

        Self {
            watcher,
            windows_context,
            window_registry,
            surface_manager,
            app_bar_manager,
            priority_event_tx,
            droppable_event_tx,
        }
    }

    fn surface_mgr(&self) -> Result<&Arc<SurfaceManager>, NativeError> {
        self.surface_manager.as_ref().ok_or_else(|| {
            NativeError::new(
                "surface",
                "SURFACE_MANAGER_UNAVAILABLE",
                "Native SurfaceManager failed to initialize or is unavailable",
            )
        })
    }

    fn app_bar_mgr(&self) -> Result<&Arc<AppBarManager>, NativeError> {
        self.app_bar_manager.as_ref().ok_or_else(|| {
            NativeError::new(
                "app-bar",
                "APP_BAR_MANAGER_UNAVAILABLE",
                "Native AppBarManager failed to initialize or is unavailable",
            )
        })
    }

    pub fn watcher(&self) -> &Arc<NativeNamespaceWatcher> {
        &self.watcher
    }

    /// Dispatches a single BridgeRequest to its corresponding handler.
    pub fn dispatch(&self, request: BridgeRequest) -> BridgeResponse {
        let id = request.id;
        let method = request.method.as_str();

        let result = catch_unwind(AssertUnwindSafe(|| {
            self.handle_method(method, request.params)
        }));

        match result {
            Ok(Ok(val)) => BridgeResponse::success(id, val),
            Ok(Err(err)) => BridgeResponse::error(id, err),
            Err(panic_err) => {
                let msg = if let Some(s) = panic_err.downcast_ref::<&str>() {
                    s.to_string()
                } else if let Some(s) = panic_err.downcast_ref::<String>() {
                    s.clone()
                } else {
                    "Unknown native panic".to_string()
                };
                BridgeResponse::error(id, NativeError::panic_error(msg))
            }
        }
    }

    fn handle_method(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, NativeError> {
        match method {
            // Handshake & Telemetry
            "bridge/handshake" => {
                let client_protocol = params
                    .get("protocolVersion")
                    .and_then(|value| value.as_u64())
                    .ok_or_else(|| {
                        NativeError::invalid_argument("Missing numeric 'protocolVersion' parameter")
                    })?;
                if client_protocol != elix_native_core::PROTOCOL_VERSION as u64 {
                    let mut err = NativeError::new(
                        "bridge",
                        "INCOMPATIBLE_PROTOCOL",
                        format!(
                            "Client protocol version '{}' is incompatible with native protocol version '{}'",
                            client_protocol, elix_native_core::PROTOCOL_VERSION
                        ),
                    );
                    err.retryable = Some(false);
                    return Err(err);
                }
                Ok(json!(HandshakeResult::default()))
            }

            "bridge/ping" => {
                let ms = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                Ok(json!({ "timestamp": ms }))
            }

            "bridge/delay" => {
                let ms = params.get("ms").and_then(|v| v.as_u64()).unwrap_or(100);
                std::thread::sleep(std::time::Duration::from_millis(ms));
                Ok(json!({ "delayed": ms }))
            }

            "bridge/shutdown" => {
                self.watcher.dispose();
                self.windows_context.stop()?;
                self.window_registry.stop()?;
                if let Some(m) = &self.surface_manager {
                    m.dispose();
                }
                if let Some(a) = &self.app_bar_manager {
                    a.dispose();
                }
                Ok(json!({ "ok": true }))
            }

            "bridge/crash" => {
                std::process::exit(42);
            }

            // Known Folders
            "knownFolders/resolve" => {
                let id_str = params
                    .get("id")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| NativeError::invalid_argument("Missing 'id' parameter"))?;

                let kf_id = KnownFolderId::parse(id_str).ok_or_else(|| {
                    NativeError::invalid_argument(format!("Unknown KnownFolderId: {}", id_str))
                })?;

                let res = resolve_known_folder(kf_id)?;
                Ok(json!(res))
            }

            "knownFolders/resolveAll" => Ok(json!(resolve_all_known_folders())),

            // File Identity
            "files/identify" => {
                let path = params
                    .get("path")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| NativeError::invalid_argument("Missing 'path' parameter"))?;
                Ok(json!(identify_file(path)?))
            }

            // Shell Links
            "shortcuts/resolve" => {
                let path = params
                    .get("path")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| NativeError::invalid_argument("Missing 'path' parameter"))?;

                Ok(json!(resolve_shortcut(path)?))
            }

            "shortcuts/resolveBatch" => {
                let paths_val = params
                    .get("paths")
                    .and_then(|v| v.as_array())
                    .ok_or_else(|| NativeError::invalid_argument("Missing 'paths' array"))?;

                if paths_val.len() > crate::protocol::MAX_SHORTCUT_BATCH_ITEMS {
                    return Err(NativeError::invalid_argument(format!(
                        "Shortcut batch contains {} items; maximum is {}",
                        paths_val.len(),
                        crate::protocol::MAX_SHORTCUT_BATCH_ITEMS
                    )));
                }

                let paths: Vec<String> = paths_val
                    .iter()
                    .enumerate()
                    .map(|(index, value)| {
                        value.as_str().map(String::from).ok_or_else(|| {
                            NativeError::invalid_argument(format!(
                                "Shortcut batch item {} must be a string",
                                index
                            ))
                        })
                    })
                    .collect::<Result<_, _>>()?;

                Ok(json!(resolve_shortcut_batch(&paths)))
            }

            // Shell Icons
            "icons/resolve" => {
                let path = params
                    .get("path")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| NativeError::invalid_argument("Missing 'path' parameter"))?;
                let is_dir = params
                    .get("isDirectory")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                Ok(json!(resolve_shell_icon(path, is_dir)?))
            }

            "icons/queryPeCount" => {
                let path = params
                    .get("path")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| NativeError::invalid_argument("Missing 'path' parameter"))?;
                let count = elix_native_core::icons::query_pe_icon_count(path);
                Ok(json!({ "count": count }))
            }

            // Watcher
            "watcher/watch" => {
                let container_path = params
                    .get("containerPath")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| {
                        NativeError::invalid_argument("Missing 'containerPath' parameter")
                    })?;

                let watcher_ref = Arc::clone(&self.watcher);
                let prio_tx = self.priority_event_tx.clone();
                let drop_tx = self.droppable_event_tx.clone();

                let sub_id = self.watcher.watch(
                    container_path,
                    Arc::new(move |ev| {
                        let is_priority = ev.change_type
                            == elix_native_core::watcher::ChangeType::ContainerInvalidated
                            || ev.change_type
                                == elix_native_core::watcher::ChangeType::BufferOverflow;
                        let sub_id = ev.subscription_id;

                        let bridge_ev = BridgeEvent {
                            event: "watcher/change".to_string(),
                            payload: json!(ev),
                            subscription_id: if is_priority { None } else { Some(sub_id) },
                        };

                        if is_priority {
                            prio_tx.send(sub_id, bridge_ev);
                        } else {
                            match drop_tx.try_send(bridge_ev) {
                                Ok(()) => {}
                                Err(crossbeam_channel::TrySendError::Full(_)) => {
                                    watcher_ref.event_consumed(sub_id);
                                    let _ = watcher_ref.simulate_overflow(sub_id);
                                }
                                Err(crossbeam_channel::TrySendError::Disconnected(_)) => {
                                    watcher_ref.event_consumed(sub_id);
                                }
                            }
                        }
                    }),
                )?;

                Ok(json!({ "subscriptionId": sub_id }))
            }

            "watcher/unwatch" => {
                let sub_id = params
                    .get("subscriptionId")
                    .and_then(|v| v.as_u64())
                    .ok_or_else(|| {
                        NativeError::invalid_argument("Missing 'subscriptionId' parameter")
                    })?;
                let unwatched = self.watcher.unwatch(sub_id);
                self.priority_event_tx.remove(sub_id);
                Ok(json!({ "unwatched": unwatched }))
            }

            "watcher/rearm" => {
                let sub_id = params
                    .get("subscriptionId")
                    .and_then(|v| v.as_u64())
                    .ok_or_else(|| {
                        NativeError::invalid_argument("Missing 'subscriptionId' parameter")
                    })?;
                Ok(json!({ "rearmed": self.watcher.rearm_container(sub_id) }))
            }

            "watcher/getStats" => {
                let sub_id = params
                    .get("subscriptionId")
                    .and_then(|v| v.as_u64())
                    .ok_or_else(|| {
                        NativeError::invalid_argument("Missing 'subscriptionId' parameter")
                    })?;
                Ok(json!({
                    "containerEventCount": self.watcher.container_event_count(sub_id),
                    "isInvalidated": self.watcher.is_container_invalidated(sub_id),
                    "isAlive": self.watcher.is_watcher_alive(sub_id)
                }))
            }

            "watcher/invalidate" | "watcher/simulateOverflow" => {
                let sub_id = params
                    .get("subscriptionId")
                    .and_then(|v| v.as_u64())
                    .ok_or_else(|| {
                        NativeError::invalid_argument("Missing 'subscriptionId' parameter")
                    })?;
                self.watcher.simulate_overflow(sub_id)?;
                Ok(json!({ "overflowSimulated": true }))
            }

            // Windows Context
            "windowsContext/getSnapshot" => Ok(json!(self.windows_context.get_snapshot()?)),
            "windowsContext/start" => {
                let (snapshot, already_started) = self.windows_context.start()?;
                Ok(json!({ "snapshot": snapshot, "alreadyStarted": already_started }))
            }
            "windowsContext/stop" => Ok(json!({ "stopped": self.windows_context.stop()? })),
            "windowsContext/refresh" => Ok(json!(self.windows_context.refresh()?)),
            "windowsContext/status" => Ok(json!(self.windows_context.status())),
            "windowsContext/testFailNextStart" => {
                self.windows_context.fail_next_start_for_test();
                Ok(json!({ "armed": true }))
            }
            "windowsContext/testFailRuntime" => {
                self.windows_context.fail_runtime_for_test()?;
                Ok(json!({ "triggered": true }))
            }

            // Window Registry
            "windowRegistry/getSnapshot" => Ok(json!(self.window_registry.get_snapshot()?)),
            "windowRegistry/start" => {
                let (snapshot, already_started) = self.window_registry.start()?;
                Ok(json!({ "snapshot": snapshot, "alreadyStarted": already_started }))
            }
            "windowRegistry/stop" => Ok(json!({ "stopped": self.window_registry.stop()? })),
            "windowRegistry/refresh" => Ok(json!(self.window_registry.refresh()?)),
            "windowRegistry/status" => Ok(json!(self.window_registry.status())),
            "windowRegistry/testFailNextStart" => {
                self.window_registry.fail_next_start_for_test();
                Ok(json!({ "armed": true }))
            }
            "windowRegistry/testFailRuntime" => {
                self.window_registry.fail_runtime_for_test()?;
                Ok(json!({ "triggered": true }))
            }

            // Spaces: stable public membership plus runtime-probed Shell control.
            "spaces/queryWindow" => {
                let request: NativeSpacesWindowRequest =
                    serde_json::from_value(params).map_err(|err| {
                        NativeError::invalid_argument(format!(
                            "Invalid NativeSpacesWindowRequest parameters: {}",
                            err
                        ))
                    })?;
                Ok(json!(query_window_space(&request)?))
            }
            "spaces/moveWindow" => {
                let request: NativeSpacesMoveRequest =
                    serde_json::from_value(params).map_err(|err| {
                        NativeError::invalid_argument(format!(
                            "Invalid NativeSpacesMoveRequest parameters: {}",
                            err
                        ))
                    })?;
                Ok(json!(move_window_to_space(&request)?))
            }
            "spaces/shellSnapshot" => Ok(json!(shell_snapshot()?)),
            "spaces/shellNotificationStatus" => Ok(json!(shell_notification_status()?)),
            "spaces/shellSwitch" => {
                let request: NativeShellSpaceRequest = serde_json::from_value(params).map_err(|err| {
                    NativeError::invalid_argument(format!(
                        "Invalid NativeShellSpaceRequest parameters: {}",
                        err
                    ))
                })?;
                Ok(json!(shell_switch_space(&request)?))
            }
            "spaces/shellCreate" => {
                let request: NativeShellCreateSpaceRequest =
                    serde_json::from_value(params).map_err(|err| {
                        NativeError::invalid_argument(format!(
                            "Invalid NativeShellCreateSpaceRequest parameters: {}",
                            err
                        ))
                    })?;
                Ok(json!(shell_create_space(&request)?))
            }
            "spaces/shellRemove" => {
                let request: NativeShellRemoveSpaceRequest =
                    serde_json::from_value(params).map_err(|err| {
                        NativeError::invalid_argument(format!(
                            "Invalid NativeShellRemoveSpaceRequest parameters: {}",
                            err
                        ))
                    })?;
                Ok(json!(shell_remove_space(&request)?))
            }
            "spaces/shellRename" => {
                let request: NativeShellRenameSpaceRequest =
                    serde_json::from_value(params).map_err(|err| {
                        NativeError::invalid_argument(format!(
                            "Invalid NativeShellRenameSpaceRequest parameters: {}",
                            err
                        ))
                    })?;
                Ok(json!(shell_rename_space(&request)?))
            }
            "spaces/shellMoveWindow" => {
                let request: NativeSpacesMoveRequest =
                    serde_json::from_value(params).map_err(|err| {
                        NativeError::invalid_argument(format!(
                            "Invalid NativeSpacesMoveRequest parameters: {}",
                            err
                        ))
                    })?;
                Ok(json!(shell_move_window_to_space(&request)?))
            }

            // Window Control
            "windowControl/execute" => {
                let request: NativeWindowControlRequest =
                    serde_json::from_value(params).map_err(|err| {
                        NativeError::invalid_argument(format!(
                            "Invalid NativeWindowControlRequest parameters: {}",
                            err
                        ))
                    })?;
                Ok(json!(execute_window_control(&request)?))
            }

            // Process Observation + Launch
            "process/getSnapshot" => Ok(json!(capture_process_snapshot()?)),
            "process/launchWin32" => {
                let spec: Win32LaunchSpec = serde_json::from_value(params).map_err(|err| {
                    NativeError::invalid_argument(format!(
                        "Invalid Win32LaunchSpec parameters: {}",
                        err
                    ))
                })?;
                Ok(json!(launch_win32_process(&spec)?))
            }

            "process/launchPackaged" => {
                let spec: PackagedLaunchSpec = serde_json::from_value(params).map_err(|err| {
                    NativeError::invalid_argument(format!(
                        "Invalid PackagedLaunchSpec parameters: {}",
                        err
                    ))
                })?;
                Ok(json!(launch_packaged_app(&spec)?))
            }

            // Surface Core
            "surface/create" => {
                let spec: SurfaceCreateSpec = serde_json::from_value(params).map_err(|err| {
                    NativeError::invalid_argument(format!(
                        "Invalid SurfaceCreateSpec parameters: {}",
                        err
                    ))
                })?;
                Ok(json!(self.surface_mgr()?.create_surface(spec)?))
            }
            "surface/show" => {
                let id = params
                    .get("id")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| NativeError::invalid_argument("Missing 'id' parameter"))?;
                Ok(json!(self.surface_mgr()?.show_surface(id)?))
            }
            "surface/hide" => {
                let id = params
                    .get("id")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| NativeError::invalid_argument("Missing 'id' parameter"))?;
                Ok(json!(self.surface_mgr()?.hide_surface(id)?))
            }
            "surface/setBounds" => {
                let id = params
                    .get("id")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| NativeError::invalid_argument("Missing 'id' parameter"))?;
                let bounds_val = params
                    .get("bounds")
                    .cloned()
                    .ok_or_else(|| NativeError::invalid_argument("Missing 'bounds' parameter"))?;
                let bounds: PhysicalBounds = serde_json::from_value(bounds_val).map_err(|err| {
                    NativeError::invalid_argument(format!("Invalid PhysicalBounds: {}", err))
                })?;
                Ok(json!(self.surface_mgr()?.set_bounds(id, bounds)?))
            }
            "surface/setZOrder" => {
                let id = params
                    .get("id")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| NativeError::invalid_argument("Missing 'id' parameter"))?;
                let policy_val = params
                    .get("policy")
                    .or_else(|| params.get("zOrderPolicy"))
                    .cloned()
                    .ok_or_else(|| NativeError::invalid_argument("Missing 'policy' parameter"))?;
                let policy: SurfaceZOrderPolicy =
                    serde_json::from_value(policy_val).map_err(|err| {
                        NativeError::invalid_argument(format!(
                            "Invalid SurfaceZOrderPolicy: {}",
                            err
                        ))
                    })?;
                Ok(json!(self.surface_mgr()?.set_z_order(id, policy)?))
            }
            "surface/navigate" => {
                let id = params
                    .get("id")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| NativeError::invalid_argument("Missing 'id' parameter"))?;
                let renderer_val = if let Some(r) = params.get("renderer") {
                    r.clone()
                } else if let Some(url) = params.get("url") {
                    json!({ "type": "url", "target": url })
                } else {
                    return Err(NativeError::invalid_argument(
                        "Missing 'renderer' or 'url' parameter",
                    ));
                };
                let renderer: SurfaceRendererSpec =
                    serde_json::from_value(renderer_val).map_err(|err| {
                        NativeError::invalid_argument(format!(
                            "Invalid SurfaceRendererSpec: {}",
                            err
                        ))
                    })?;
                Ok(json!(self.surface_mgr()?.navigate(id, renderer)?))
            }
            "surface/reload" => {
                let id = params
                    .get("id")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| NativeError::invalid_argument("Missing 'id' parameter"))?;
                Ok(json!(self.surface_mgr()?.reload(id)?))
            }
            "surface/markReady" => {
                let id = params
                    .get("id")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| NativeError::invalid_argument("Missing 'id' parameter"))?;
                Ok(json!(self.surface_mgr()?.mark_ready(id)?))
            }
            "surface/destroy" => {
                let id = params
                    .get("id")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| NativeError::invalid_argument("Missing 'id' parameter"))?;
                Ok(json!({ "destroyed": self.surface_mgr()?.destroy_surface(id)? }))
            }
            "surface/query" => {
                let id = params
                    .get("id")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| NativeError::invalid_argument("Missing 'id' parameter"))?;
                Ok(json!(self.surface_mgr()?.query_surface(id)?))
            }
            "surface/getFocusState" => {
                let id = params
                    .get("id")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| NativeError::invalid_argument("Missing 'id' parameter"))?;
                Ok(json!(self.surface_mgr()?.get_focus_state(id)?))
            }
            "surface/getForegroundHwnd" => {
                Ok(json!({ "hwnd": SurfaceManager::get_foreground_hwnd() }))
            }
            "surface/list" => Ok(json!(self.surface_mgr()?.list_surfaces()?)),
            "surface/postMessage" => {
                let id = params
                    .get("id")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| NativeError::invalid_argument("Missing 'id' parameter"))?;
                let message = if let Some(msg_str) = params.get("message").and_then(|v| v.as_str())
                {
                    msg_str.to_string()
                } else if let Some(msg_val) = params.get("message") {
                    serde_json::to_string(msg_val).unwrap_or_default()
                } else {
                    return Err(NativeError::invalid_argument("Missing 'message' parameter"));
                };
                Ok(json!({ "posted": self.surface_mgr()?.post_web_message(id, &message)? }))
            }
            "surface/runtimeStatus" => match check_webview2_runtime() {
                Ok(version) => Ok(json!({ "available": true, "version": version })),
                Err(err) => Ok(json!({ "available": false, "error": err })),
            },

            // AppBar
            "appBar/register" => {
                let spec: AppBarSpec = serde_json::from_value(params).map_err(|err| {
                    NativeError::invalid_argument(format!("Invalid AppBarSpec: {}", err))
                })?;
                Ok(json!(self.app_bar_mgr()?.register_or_update(spec)?))
            }
            "appBar/unregister" => {
                let id = params
                    .get("id")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| NativeError::invalid_argument("Missing 'id' parameter"))?;
                Ok(json!({ "unregistered": self.app_bar_mgr()?.unregister(id)? }))
            }
            "appBar/getRegistered" => Ok(json!(self.app_bar_mgr()?.get_registered()?)),

            _ => Err(NativeError::new(
                "bridge",
                "METHOD_NOT_FOUND",
                format!("Unrecognized RPC method: '{}'", method),
            )),
        }
    }

    pub fn dispose(&self) {
        self.watcher.dispose();
        let _ = self.windows_context.stop();
        let _ = self.window_registry.stop();
        if let Some(m) = &self.surface_manager {
            m.dispose();
        }
        if let Some(a) = &self.app_bar_manager {
            a.dispose();
        }
    }
}

unsafe impl Send for Dispatcher {}
unsafe impl Sync for Dispatcher {}
