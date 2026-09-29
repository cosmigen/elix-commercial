//! Dedicated Win32 Single-Threaded Apartment (STA) UI thread for Surface Core.

use crate::error::{NativeError, NativeResult};
use crate::runtime::apartment::ComApartment;
use crate::surface::surface_instance::{NativeSurface, SendCom};
use crate::surface::types::{
    PhysicalBounds, SurfaceCreateSpec, SurfaceEvent, SurfaceFocusState, SurfaceLifecycleState,
    SurfaceRendererSpec, SurfaceSnapshot, SurfaceZOrderPolicy,
};
use crate::surface::webview::{create_controller_async, create_environment_async};
use crossbeam_channel::{bounded, unbounded, Receiver, Sender};
use std::collections::HashMap;
use std::sync::Arc;
use std::thread::JoinHandle;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2Controller, ICoreWebView2Environment,
};
use windows::Win32::Foundation::{LPARAM, WPARAM};
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, GetMessageW, PeekMessageW, PostQuitMessage, PostThreadMessageW,
    TranslateMessage, MSG, PM_NOREMOVE, WM_APP, WM_USER,
};

const WM_DISPATCH_COMMAND: u32 = WM_APP + 42;

/// Surface commands dispatched from any thread to the dedicated STA UI thread.
pub enum SurfaceCommand {
    Create {
        spec: SurfaceCreateSpec,
        reply: Sender<NativeResult<SurfaceSnapshot>>,
    },
    Show {
        id: String,
        reply: Sender<NativeResult<SurfaceSnapshot>>,
    },
    Hide {
        id: String,
        reply: Sender<NativeResult<SurfaceSnapshot>>,
    },
    SetBounds {
        id: String,
        bounds: PhysicalBounds,
        reply: Sender<NativeResult<SurfaceSnapshot>>,
    },
    SetZOrder {
        id: String,
        policy: SurfaceZOrderPolicy,
        reply: Sender<NativeResult<SurfaceSnapshot>>,
    },
    Navigate {
        id: String,
        renderer: SurfaceRendererSpec,
        reply: Sender<NativeResult<SurfaceSnapshot>>,
    },
    Reload {
        id: String,
        reply: Sender<NativeResult<SurfaceSnapshot>>,
    },
    MarkReady {
        id: String,
        reply: Sender<NativeResult<SurfaceSnapshot>>,
    },
    Destroy {
        id: String,
        reply: Sender<NativeResult<bool>>,
    },
    PostMessage {
        id: String,
        message: String,
        reply: Sender<NativeResult<bool>>,
    },
    Query {
        id: String,
        reply: Sender<NativeResult<SurfaceSnapshot>>,
    },
    GetFocusState {
        id: String,
        reply: Sender<NativeResult<SurfaceFocusState>>,
    },
    List {
        reply: Sender<NativeResult<Vec<SurfaceSnapshot>>>,
    },
    Shutdown {
        reply: Sender<NativeResult<()>>,
    },
    InternalAttachController {
        id: String,
        controller: SendCom<ICoreWebView2Controller>,
        renderer: Option<SurfaceRendererSpec>,
    },
    InternalAttachEnv {
        env: SendCom<ICoreWebView2Environment>,
    },
    InternalAttachFault {
        id: String,
        error: NativeError,
    },
    InternalRendererReady {
        id: String,
    },
    InternalProcessFailed {
        id: String,
        kind: i32,
    },
    #[cfg(test)]
    TestHangLoop {
        hang_flag: std::sync::Arc<std::sync::atomic::AtomicBool>,
    },
}

#[inline]
fn post_internal_cmd(thread_id: u32, cmd_tx: &Sender<SurfaceCommand>, cmd: SurfaceCommand) {
    if cmd_tx.send(cmd).is_ok() {
        unsafe {
            let _ = PostThreadMessageW(thread_id, WM_DISPATCH_COMMAND, WPARAM(0), LPARAM(0));
        }
    }
}

/// Default bounded timeout for dispatching commands to the dedicated STA UI thread.
pub const DEFAULT_DISPATCH_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(3500);

/// Handle to the dedicated Surface UI Thread.
pub struct SurfaceUiThread {
    pub thread_id: u32,
    pub cmd_tx: Sender<SurfaceCommand>,
    join_handle: parking_lot::Mutex<Option<JoinHandle<()>>>,
}

impl SurfaceUiThread {
    /// Spawns the dedicated STA UI thread and waits for message queue readiness.
    pub fn spawn(event_sink: Arc<dyn Fn(SurfaceEvent) + Send + Sync>) -> NativeResult<Self> {
        let (ready_tx, ready_rx) = bounded(1);
        let (cmd_tx, cmd_rx) = unbounded::<SurfaceCommand>();
        let cmd_tx_thread = cmd_tx.clone();

        let join_handle = std::thread::Builder::new()
            .name("elix-surface-ui".to_string())
            .spawn(move || {
                let _sta_guard = match ComApartment::sta() {
                    Ok(guard) => guard,
                    Err(err) => {
                        let _ = ready_tx.send(Err(err));
                        return;
                    }
                };

                // Force creation of Win32 message queue for this thread
                let mut msg = MSG::default();
                unsafe {
                    let _ = PeekMessageW(&mut msg, None, WM_USER, WM_USER, PM_NOREMOVE);
                }
                let thread_id = unsafe { GetCurrentThreadId() };

                if ready_tx.send(Ok(thread_id)).is_err() {
                    return;
                }

                run_ui_loop(cmd_rx, cmd_tx_thread, event_sink, thread_id);
            })
            .map_err(|e| {
                NativeError::new(
                    "surface",
                    "THREAD_SPAWN_FAILED",
                    format!("Failed to spawn Surface UI thread: {}", e),
                )
            })?;

        let thread_id = ready_rx.recv().map_err(|_| {
            NativeError::new(
                "surface",
                "UI_THREAD_INIT_FAILED",
                "Surface UI thread failed to report readiness",
            )
        })??;

        Ok(Self {
            thread_id,
            cmd_tx,
            join_handle: parking_lot::Mutex::new(Some(join_handle)),
        })
    }

    /// Dispatches a command onto the UI thread and waits for the result with default bounded timeout.
    pub fn dispatch<T: Send + 'static>(
        &self,
        create_cmd: impl FnOnce(Sender<NativeResult<T>>) -> SurfaceCommand,
    ) -> NativeResult<T> {
        self.dispatch_timeout(create_cmd, DEFAULT_DISPATCH_TIMEOUT)
    }

    /// Dispatches a command onto the UI thread and waits for the result with explicit bounded timeout.
    pub fn dispatch_timeout<T: Send + 'static>(
        &self,
        create_cmd: impl FnOnce(Sender<NativeResult<T>>) -> SurfaceCommand,
        timeout: std::time::Duration,
    ) -> NativeResult<T> {
        let (reply_tx, reply_rx) = bounded(1);
        let cmd = create_cmd(reply_tx);

        self.cmd_tx.send(cmd).map_err(|_| {
            NativeError::new(
                "surface",
                "THREAD_DISCONNECTED",
                "Surface UI thread command channel is disconnected",
            )
        })?;

        unsafe {
            let _ = PostThreadMessageW(self.thread_id, WM_DISPATCH_COMMAND, WPARAM(0), LPARAM(0));
        }

        reply_rx
            .recv_timeout(timeout)
            .map_err(|recv_err| match recv_err {
                crossbeam_channel::RecvTimeoutError::Timeout => {
                    let mut err = NativeError::new(
                        "surface",
                        "DISPATCH_TIMEOUT",
                        format!(
                            "Surface UI thread command dispatch timed out after {:?}",
                            timeout
                        ),
                    );
                    err.native_code = Some(121); // ERROR_SEM_TIMEOUT
                    err.retryable = Some(true);
                    err
                }
                crossbeam_channel::RecvTimeoutError::Disconnected => NativeError::new(
                    "surface",
                    "REPLY_DROPPED",
                    "Surface UI thread dropped command response",
                ),
            })?
    }

    /// Shuts down the UI thread with an explicit bounded timeout.
    ///
    /// Dispatches a shutdown command to the STA UI thread, then polls `handle.is_finished()`
    /// until the thread terminates or the timeout expires. If the deadline expires without
    /// completion, returns a structured `SHUTDOWN_TIMEOUT` error without blocking indefinitely.
    pub fn shutdown_timeout(&self, timeout: std::time::Duration) -> NativeResult<()> {
        let handle_opt = self.join_handle.lock().take();
        let handle = match handle_opt {
            Some(h) => h,
            None => return Ok(()),
        };

        let start = std::time::Instant::now();

        // Attempt graceful shutdown command dispatch with a portion of the timeout
        let dispatch_timeout = timeout.min(std::time::Duration::from_millis(500));
        let _ = self.dispatch_timeout(|reply| SurfaceCommand::Shutdown { reply }, dispatch_timeout);

        while !handle.is_finished() {
            if start.elapsed() >= timeout {
                return Err(NativeError::new(
                    "surface",
                    "SHUTDOWN_TIMEOUT",
                    format!(
                        "Surface UI thread failed to terminate within bounded timeout of {:?}",
                        timeout
                    ),
                ));
            }
            std::thread::sleep(std::time::Duration::from_millis(15));
        }

        let _ = handle.join();
        Ok(())
    }

    /// Shuts down the UI thread with a default bounded timeout of 2000ms.
    pub fn shutdown(&self) -> NativeResult<()> {
        self.shutdown_timeout(std::time::Duration::from_millis(2000))
    }

    /// Asynchronously posts an internal or fire-and-forget command onto the UI thread queue.
    pub fn post_command(&self, cmd: SurfaceCommand) -> NativeResult<()> {
        self.cmd_tx.send(cmd).map_err(|_| {
            NativeError::new(
                "surface",
                "THREAD_DISCONNECTED",
                "Surface UI thread command channel is disconnected",
            )
        })?;

        unsafe {
            let _ = PostThreadMessageW(self.thread_id, WM_DISPATCH_COMMAND, WPARAM(0), LPARAM(0));
        }

        Ok(())
    }
}

impl Drop for SurfaceUiThread {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}

/// Main Win32 message loop on the dedicated STA Surface UI thread.
fn run_ui_loop(
    cmd_rx: Receiver<SurfaceCommand>,
    cmd_tx: Sender<SurfaceCommand>,
    event_sink: Arc<dyn Fn(SurfaceEvent) + Send + Sync>,
    thread_id: u32,
) {
    let mut surfaces: HashMap<String, NativeSurface> = HashMap::new();
    let mut cached_env: Option<SendCom<ICoreWebView2Environment>> = None;
    let mut is_creating_env = false;
    let mut pending_webview_surfaces: Vec<(String, Option<SurfaceRendererSpec>)> = Vec::new();

    let mut msg = MSG::default();

    loop {
        // Pump all messages
        let ret = unsafe { GetMessageW(&mut msg, None, 0, 0) };
        if ret.0 <= 0 {
            // WM_QUIT received or error
            break;
        }

        if msg.message == WM_DISPATCH_COMMAND {
            // Drain all available commands
            while let Ok(cmd) = cmd_rx.try_recv() {
                match cmd {
                    SurfaceCommand::Create { spec, reply } => {
                        let id = spec.id.clone();
                        if surfaces.contains_key(&id) {
                            let _ = reply.send(Err(NativeError::new(
                                "surface",
                                "DUPLICATE_SURFACE_ID",
                                format!("Surface with ID '{}' already exists", id),
                            )));
                            continue;
                        }

                        let renderer = spec.renderer.clone();
                        match NativeSurface::create(&spec, Some(event_sink.clone())) {
                            Ok(surface) => {
                                let snapshot = surface.snapshot();
                                event_sink(SurfaceEvent::Created {
                                    snapshot: snapshot.clone(),
                                });
                                event_sink(SurfaceEvent::NativeReady {
                                    id: id.clone(),
                                    hwnd: snapshot.hwnd,
                                });

                                surfaces.insert(id.clone(), surface);
                                let _ = reply.send(Ok(snapshot));

                                // Initiate WebView2 attachment
                                if let Some(env) = cached_env.clone() {
                                    attach_webview_to_surface(
                                        id,
                                        &env.0,
                                        &surfaces,
                                        renderer,
                                        cmd_tx.clone(),
                                        thread_id,
                                    );
                                } else {
                                    pending_webview_surfaces.push((id.clone(), renderer));
                                    if !is_creating_env {
                                        is_creating_env = true;
                                        let cmd_tx_env = cmd_tx.clone();

                                        let env_res = create_environment_async(
                                            spec.user_data_folder.as_deref(),
                                            move |env_result| match env_result {
                                                Ok(env) => {
                                                    post_internal_cmd(
                                                        thread_id,
                                                        &cmd_tx_env,
                                                        SurfaceCommand::InternalAttachEnv {
                                                            env: SendCom(env),
                                                        },
                                                    );
                                                }
                                                Err(err) => {
                                                    post_internal_cmd(
                                                        thread_id,
                                                        &cmd_tx_env,
                                                        SurfaceCommand::InternalAttachFault {
                                                            id: "__ENV_FAIL__".to_string(),
                                                            error: err,
                                                        },
                                                    );
                                                }
                                            },
                                        );

                                        if let Err(err) = env_res {
                                            is_creating_env = false;
                                            let pending =
                                                std::mem::take(&mut pending_webview_surfaces);
                                            for (pending_id, _) in pending {
                                                if let Some(surface) = surfaces.get_mut(&pending_id)
                                                {
                                                    surface.state = SurfaceLifecycleState::Faulted;
                                                }
                                                event_sink(SurfaceEvent::Fault {
                                                    id: pending_id,
                                                    error: err.clone(),
                                                });
                                            }
                                        }
                                    }
                                }
                            }
                            Err(err) => {
                                let _ = reply.send(Err(err));
                            }
                        }
                    }

                    SurfaceCommand::Show { id, reply } => {
                        let res = if let Some(surface) = surfaces.get_mut(&id) {
                            surface.show()
                        } else {
                            Err(NativeError::new(
                                "surface",
                                "SURFACE_NOT_FOUND",
                                format!("Surface '{}' not found", id),
                            ))
                        };
                        let _ = reply.send(res);
                    }

                    SurfaceCommand::Hide { id, reply } => {
                        let res = if let Some(surface) = surfaces.get_mut(&id) {
                            surface.hide()
                        } else {
                            Err(NativeError::new(
                                "surface",
                                "SURFACE_NOT_FOUND",
                                format!("Surface '{}' not found", id),
                            ))
                        };
                        let _ = reply.send(res);
                    }

                    SurfaceCommand::SetBounds { id, bounds, reply } => {
                        let res = if let Some(surface) = surfaces.get_mut(&id) {
                            surface.set_bounds(bounds)
                        } else {
                            Err(NativeError::new(
                                "surface",
                                "SURFACE_NOT_FOUND",
                                format!("Surface '{}' not found", id),
                            ))
                        };
                        let _ = reply.send(res);
                    }

                    SurfaceCommand::SetZOrder { id, policy, reply } => {
                        let res = if let Some(surface) = surfaces.get_mut(&id) {
                            surface.set_z_order(policy)
                        } else {
                            Err(NativeError::new(
                                "surface",
                                "SURFACE_NOT_FOUND",
                                format!("Surface '{}' not found", id),
                            ))
                        };
                        let _ = reply.send(res);
                    }

                    SurfaceCommand::Navigate {
                        id,
                        renderer,
                        reply,
                    } => {
                        let res = if let Some(surface) = surfaces.get_mut(&id) {
                            surface.navigate(&renderer)
                        } else {
                            Err(NativeError::new(
                                "surface",
                                "SURFACE_NOT_FOUND",
                                format!("Surface '{}' not found", id),
                            ))
                        };
                        let _ = reply.send(res);
                    }

                    SurfaceCommand::Reload { id, reply } => {
                        let res = if let Some(surface) = surfaces.get_mut(&id) {
                            surface.reload()
                        } else {
                            Err(NativeError::new(
                                "surface",
                                "SURFACE_NOT_FOUND",
                                format!("Surface '{}' not found", id),
                            ))
                        };
                        let _ = reply.send(res);
                    }

                    SurfaceCommand::MarkReady { id, reply } => {
                        let res = if let Some(surface) = surfaces.get_mut(&id) {
                            surface.mark_ready().map(|_| surface.snapshot())
                        } else {
                            Err(NativeError::new(
                                "surface",
                                "SURFACE_NOT_FOUND",
                                format!("Surface '{}' not found", id),
                            ))
                        };
                        let _ = reply.send(res);
                    }

                    SurfaceCommand::Destroy { id, reply } => {
                        pending_webview_surfaces.retain(|(pending_id, _)| pending_id != &id);
                        let found = if let Some(mut surface) = surfaces.remove(&id) {
                            surface.destroy();
                            true
                        } else {
                            false
                        };
                        let _ = reply.send(Ok(found));
                    }

                    SurfaceCommand::PostMessage { id, message, reply } => {
                        let res = if let Some(surface) = surfaces.get(&id) {
                            surface.post_web_message(&message).map(|_| true)
                        } else {
                            Err(NativeError::new(
                                "surface",
                                "SURFACE_NOT_FOUND",
                                format!("Surface '{}' not found", id),
                            ))
                        };
                        let _ = reply.send(res);
                    }

                    SurfaceCommand::Query { id, reply } => {
                        let res = if let Some(surface) = surfaces.get(&id) {
                            Ok(surface.snapshot())
                        } else {
                            Err(NativeError::new(
                                "surface",
                                "SURFACE_NOT_FOUND",
                                format!("Surface '{}' not found", id),
                            ))
                        };
                        let _ = reply.send(res);
                    }

                    SurfaceCommand::GetFocusState { id, reply } => {
                        let res = if let Some(surface) = surfaces.get(&id) {
                            Ok(surface.focus_state())
                        } else {
                            Err(NativeError::new(
                                "surface",
                                "SURFACE_NOT_FOUND",
                                format!("Surface '{}' not found", id),
                            ))
                        };
                        let _ = reply.send(res);
                    }

                    SurfaceCommand::List { reply } => {
                        let list = surfaces.values().map(|s| s.snapshot()).collect();
                        let _ = reply.send(Ok(list));
                    }

                    SurfaceCommand::Shutdown { reply } => {
                        for (_, mut surface) in surfaces.drain() {
                            surface.destroy();
                        }
                        cached_env = None;
                        let _ = reply.send(Ok(()));
                        unsafe {
                            PostQuitMessage(0);
                        }
                        break;
                    }

                    SurfaceCommand::InternalAttachController {
                        id,
                        controller,
                        renderer,
                    } => {
                        if let Some(surface) = surfaces.get_mut(&id) {
                            let cmd_tx_ready = cmd_tx.clone();
                            let id_ready = id.clone();
                            let cmd_tx_failed = cmd_tx.clone();
                            let id_failed = id.clone();
                            let attach_res = surface.attach_controller(
                                controller.0,
                                renderer.as_ref(),
                                Some(Box::new(move || {
                                    post_internal_cmd(
                                        thread_id,
                                        &cmd_tx_ready,
                                        SurfaceCommand::InternalRendererReady {
                                            id: id_ready.clone(),
                                        },
                                    );
                                })),
                                Some(Box::new(move |kind| {
                                    post_internal_cmd(
                                        thread_id,
                                        &cmd_tx_failed,
                                        SurfaceCommand::InternalProcessFailed {
                                            id: id_failed.clone(),
                                            kind,
                                        },
                                    );
                                })),
                            );
                            if let Err(err) = attach_res {
                                surface.state = SurfaceLifecycleState::Faulted;
                                event_sink(SurfaceEvent::Fault {
                                    id: id.clone(),
                                    error: err,
                                });
                            }
                        } else {
                            unsafe {
                                let _ = controller.0.Close();
                            }
                        }
                    }

                    SurfaceCommand::InternalProcessFailed { id, kind } => {
                        if let Some(surface) = surfaces.get_mut(&id) {
                            unsafe {
                                let _ = windows::Win32::UI::WindowsAndMessaging::ShowWindow(
                                    surface.hwnd,
                                    windows::Win32::UI::WindowsAndMessaging::SW_HIDE,
                                );
                            }
                            surface.visible = false;
                            surface.desired_visible = false;
                            surface.state = SurfaceLifecycleState::Faulted;
                            surface.invalidate_renderer();
                            event_sink(SurfaceEvent::Fault {
                                id: id.clone(),
                                error: NativeError::new(
                                    "surface",
                                    "RENDERER_PROCESS_FAILED",
                                    format!(
                                        "WebView2 renderer process failed (kind code: {})",
                                        kind
                                    ),
                                ),
                            });
                        }
                    }

                    #[cfg(test)]
                    SurfaceCommand::TestHangLoop { hang_flag } => {
                        while hang_flag.load(std::sync::atomic::Ordering::SeqCst) {
                            std::thread::sleep(std::time::Duration::from_millis(15));
                        }
                    }

                    SurfaceCommand::InternalRendererReady { id } => {
                        if let Some(surface) = surfaces.get_mut(&id) {
                            let _ = surface.mark_ready();
                        }
                    }

                    SurfaceCommand::InternalAttachEnv { env } => {
                        is_creating_env = false;
                        let env_ref = env.clone();
                        cached_env = Some(env);

                        let pending = std::mem::take(&mut pending_webview_surfaces);
                        for (id, renderer) in pending {
                            attach_webview_to_surface(
                                id,
                                &env_ref.0,
                                &surfaces,
                                renderer,
                                cmd_tx.clone(),
                                thread_id,
                            );
                        }
                    }

                    SurfaceCommand::InternalAttachFault { id, error } => {
                        if id == "__ENV_FAIL__" {
                            is_creating_env = false;
                            let pending = std::mem::take(&mut pending_webview_surfaces);
                            for (pending_id, _) in pending {
                                if let Some(surface) = surfaces.get_mut(&pending_id) {
                                    surface.state = SurfaceLifecycleState::Faulted;
                                }
                                event_sink(SurfaceEvent::Fault {
                                    id: pending_id,
                                    error: error.clone(),
                                });
                            }
                        } else if let Some(surface) = surfaces.get_mut(&id) {
                            surface.state = SurfaceLifecycleState::Faulted;
                            event_sink(SurfaceEvent::Fault { id, error });
                        }
                    }
                }
            }
        } else {
            unsafe {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
    }

    // Teardown any remaining surfaces on thread exit
    for (_, mut surface) in surfaces.drain() {
        surface.destroy();
    }
}

fn attach_webview_to_surface(
    id: String,
    env: &ICoreWebView2Environment,
    surfaces: &HashMap<String, NativeSurface>,
    renderer: Option<SurfaceRendererSpec>,
    cmd_tx: Sender<SurfaceCommand>,
    thread_id: u32,
) {
    if let Some(surface) = surfaces.get(&id) {
        let hwnd = surface.hwnd;
        let id_clone = id.clone();
        let cmd_tx_clone = cmd_tx.clone();

        let res = create_controller_async(env, hwnd, move |ctrl_res| match ctrl_res {
            Ok(ctrl) => {
                post_internal_cmd(
                    thread_id,
                    &cmd_tx_clone,
                    SurfaceCommand::InternalAttachController {
                        id: id_clone,
                        controller: SendCom(ctrl),
                        renderer,
                    },
                );
            }
            Err(err) => {
                post_internal_cmd(
                    thread_id,
                    &cmd_tx_clone,
                    SurfaceCommand::InternalAttachFault {
                        id: id_clone,
                        error: err,
                    },
                );
            }
        });

        if let Err(err) = res {
            post_internal_cmd(
                thread_id,
                &cmd_tx,
                SurfaceCommand::InternalAttachFault { id, error: err },
            );
        }
    }
}
