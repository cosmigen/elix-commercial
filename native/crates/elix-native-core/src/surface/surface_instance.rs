//! Native surface instance managing HWND, WebView2, and lifecycle transitions.

use crate::error::{NativeError, NativeResult};
use crate::surface::types::{
    validate_renderer_url, PhysicalBounds, SurfaceCreateSpec, SurfaceEvent, SurfaceFocusPolicy,
    SurfaceFocusState, SurfaceLifecycleState, SurfaceRendererSpec, SurfaceSnapshot,
    SurfaceZOrderPolicy,
};
use crate::surface::webview::{
    attach_accelerator_key_pressed, attach_navigation_completed, attach_navigation_starting,
    attach_new_window_requested, attach_process_failed, attach_web_message_received,
    configure_security_settings, navigate_renderer, post_web_message,
    remove_accelerator_key_pressed, remove_navigation_completed, remove_navigation_starting,
    remove_new_window_requested, remove_process_failed, remove_web_message_received,
    setup_controller_visuals,
};
use crate::surface::wnd_class::{
    decrement_surface_class_ref, ensure_surface_class_registered, ELIX_SURFACE_CLASS_NAME,
};
use crate::surface::wndproc::{
    register_surface_wnd, unregister_surface_wnd, SurfaceMessageReceiver,
};
use parking_lot::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2, ICoreWebView2Controller, COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC,
};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{HINSTANCE, HWND, RECT};
use windows::Win32::Graphics::Dwm::{
    DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_DONOTROUND,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetFocus, SetActiveWindow, SetFocus};
use windows::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, CreateWindowExW, DestroyWindow, GetClientRect, GetForegroundWindow, IsChild,
    SetForegroundWindow, SetWindowPos, ShowWindow, HWND_BOTTOM, HWND_NOTOPMOST, HWND_TOPMOST,
    SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SW_HIDE, SW_SHOW, SW_SHOWNOACTIVATE,
    WS_CLIPCHILDREN, WS_CLIPSIBLINGS, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    WS_EX_TOPMOST, WS_POPUP,
};

/// Safe wrapper permitting COM interface references to cross internal threads
/// with the guarantee that COM methods are only invoked on the dedicated STA UI thread.
#[derive(Clone)]
pub struct SendCom<T>(pub T);
unsafe impl<T> Send for SendCom<T> {}
unsafe impl<T> Sync for SendCom<T> {}

/// Internal state shared between NativeSurface and its WndProc message receiver.
struct SurfaceSharedState {
    id: String,
    focus_policy: SurfaceFocusPolicy,
    bounds: PhysicalBounds,
    dpi: u32,
    scale_factor: f64,
    event_sink: Option<Arc<dyn Fn(SurfaceEvent) + Send + Sync>>,
}

/// Message receiver bridging Win32 messages into the shared surface state.
struct SurfaceWndReceiver {
    state: Arc<Mutex<SurfaceSharedState>>,
    controller: Arc<Mutex<Option<SendCom<ICoreWebView2Controller>>>>,
    hwnd: isize,
}

impl SurfaceMessageReceiver for SurfaceWndReceiver {
    fn id(&self) -> &str {
        ""
    }

    fn focus_policy(&self) -> SurfaceFocusPolicy {
        self.state.lock().focus_policy
    }

    fn on_resize(&self, width: i32, height: i32) {
        let (event_sink, id) = {
            let mut guard = self.state.lock();
            guard.bounds.width = width;
            guard.bounds.height = height;
            (guard.event_sink.clone(), guard.id.clone())
        };

        if let Some(ctrl_wrapper) = self.controller.lock().as_ref() {
            unsafe {
                let mut client_rect = RECT::default();
                let _ = GetClientRect(HWND(self.hwnd as _), &mut client_rect);
                let _ = ctrl_wrapper.0.SetBounds(client_rect);
            }
        }

        if let Some(sink) = event_sink {
            let bounds = self.state.lock().bounds;
            sink(SurfaceEvent::BoundsChanged { id, bounds });
        }
    }

    fn on_move(&self, x: i32, y: i32) {
        let (event_sink, id, bounds) = {
            let mut guard = self.state.lock();
            guard.bounds.x = x;
            guard.bounds.y = y;
            (guard.event_sink.clone(), guard.id.clone(), guard.bounds)
        };

        if let Some(sink) = event_sink {
            sink(SurfaceEvent::BoundsChanged { id, bounds });
        }
    }

    fn on_dpi_changed(&self, new_dpi: u32, suggested_bounds: PhysicalBounds) {
        let (event_sink, id, scale_factor) = {
            let mut guard = self.state.lock();
            guard.dpi = new_dpi;
            guard.scale_factor = new_dpi as f64 / 96.0;
            guard.bounds = suggested_bounds;
            (
                guard.event_sink.clone(),
                guard.id.clone(),
                guard.scale_factor,
            )
        };

        if let Some(ctrl_wrapper) = self.controller.lock().as_ref() {
            unsafe {
                let mut client_rect = RECT::default();
                let _ = GetClientRect(HWND(self.hwnd as _), &mut client_rect);
                let _ = ctrl_wrapper.0.SetBounds(client_rect);
            }
        }

        if let Some(sink) = event_sink {
            sink(SurfaceEvent::DpiChanged {
                id,
                dpi: new_dpi,
                scale_factor,
                suggested_bounds,
            });
        }
    }

    fn on_pointer_down(&self, x: i32, y: i32) {
        let (event_sink, id) = {
            let guard = self.state.lock();
            (guard.event_sink.clone(), guard.id.clone())
        };

        if let Some(sink) = event_sink {
            sink(SurfaceEvent::Pointer {
                id,
                action: "down".to_string(),
                x,
                y,
            });
        }
    }

    fn on_set_focus(&self) {
        if self.focus_policy() != SurfaceFocusPolicy::NoActivate {
            if let Some(ctrl_wrapper) = self.controller.lock().as_ref() {
                unsafe {
                    let _ = ctrl_wrapper
                        .0
                        .MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
                }
            }
        }
    }
}

#[derive(Debug, Clone)]
enum ExpectedNavigation {
    Url(String),
    Html,
    AnyAllowed,
}

#[derive(Debug, Clone)]
struct ActiveNavigation {
    id: u64,
    generation: u64,
    uri: String,
}

/// Fences WebView2 navigation completions so a canceled/superseded navigation cannot
/// fault or mark ready a newer renderer generation.
#[derive(Debug, Default)]
struct NavigationFence {
    generation: u64,
    pending: Option<ExpectedNavigation>,
    active: Option<ActiveNavigation>,
}

impl NavigationFence {
    fn next_generation(&mut self) -> u64 {
        self.generation = self.generation.wrapping_add(1);
        if self.generation == 0 {
            self.generation = 1;
        }
        self.generation
    }

    fn arm_renderer(&mut self, renderer: &SurfaceRendererSpec) {
        self.next_generation();
        self.pending = Some(match renderer {
            SurfaceRendererSpec::Url(url) => ExpectedNavigation::Url(url.clone()),
            SurfaceRendererSpec::Html(_) => ExpectedNavigation::Html,
        });
        self.active = None;
    }

    fn arm_reload(&mut self) {
        self.next_generation();
        self.pending = Some(ExpectedNavigation::AnyAllowed);
        self.active = None;
    }

    fn cancel_pending(&mut self) {
        self.pending = None;
    }

    fn observe_start(&mut self, uri: &str, navigation_id: u64) {
        if let Some(active) = self.active.as_mut() {
            if active.id == navigation_id {
                // Redirects keep the same WebView2 NavigationId. Keep the current
                // generation authoritative while updating diagnostics to the final URI.
                active.uri = uri.to_string();
                return;
            }
        }

        let matches_pending = match self.pending.as_ref() {
            Some(ExpectedNavigation::Url(expected)) => uri == expected,
            Some(ExpectedNavigation::Html) => {
                uri.starts_with("data:text/html") || uri.eq_ignore_ascii_case("about:blank")
            }
            Some(ExpectedNavigation::AnyAllowed) => true,
            None => true,
        };

        // A startup/about:blank navigation can still be draining when ELIX has
        // already armed a concrete renderer. Do not let it steal the armed generation.
        if self.pending.is_some() && !matches_pending {
            return;
        }

        if self.pending.is_some() {
            self.pending = None;
        } else {
            // Unsolicited but allowed page navigation: preserve the historical
            // behavior while still fencing any older completion.
            self.next_generation();
        }

        self.active = Some(ActiveNavigation {
            id: navigation_id,
            generation: self.generation,
            uri: uri.to_string(),
        });
    }

    fn complete(&mut self, navigation_id: u64) -> Option<ActiveNavigation> {
        if self.active.as_ref().map(|active| active.id) == Some(navigation_id) {
            self.active.take()
        } else {
            None
        }
    }

    fn reset(&mut self) {
        self.pending = None;
        self.active = None;
    }
}

/// Authoritative native Windows surface instance owning HWND, WebView2, and lifecycle state.
pub struct NativeSurface {
    pub id: String,
    pub hwnd: HWND,
    pub bounds: PhysicalBounds,
    pub state: SurfaceLifecycleState,
    pub visible: bool,
    pub desired_visible: bool,
    pub focus_policy: SurfaceFocusPolicy,
    pub z_order_policy: SurfaceZOrderPolicy,
    pub skip_taskbar: bool,
    pub transparent: bool,
    pub dpi: u32,
    pub scale_factor: f64,
    pub monitor_id: Option<String>,
    pub controller: Arc<Mutex<Option<SendCom<ICoreWebView2Controller>>>>,
    pub webview: Option<SendCom<ICoreWebView2>>,
    pub nav_completed_token: Option<i64>,
    pub nav_starting_token: Option<i64>,
    pub new_window_token: Option<i64>,
    pub process_failed_token: Option<i64>,
    pub accel_token: Option<i64>,
    pub web_message_token: Option<i64>,
    shared_state: Arc<Mutex<SurfaceSharedState>>,
    event_sink: Option<Arc<dyn Fn(SurfaceEvent) + Send + Sync>>,
    internal_html_allowance: Arc<AtomicBool>,
    navigation_fence: Arc<Mutex<NavigationFence>>,
    current_renderer: Option<SurfaceRendererSpec>,
}

impl NativeSurface {
    /// Allocates and creates the native HWND for a new surface.
    pub fn create(
        spec: &SurfaceCreateSpec,
        event_sink: Option<Arc<dyn Fn(SurfaceEvent) + Send + Sync>>,
    ) -> NativeResult<Self> {
        spec.validate()?;
        ensure_surface_class_registered()?;

        let hinstance: HINSTANCE = unsafe {
            GetModuleHandleW(None)
                .map(Into::into)
                .unwrap_or(HINSTANCE(std::ptr::null_mut()))
        };

        // Window styles: clean popup without standard application decorations
        let style = WS_POPUP | WS_CLIPCHILDREN | WS_CLIPSIBLINGS;

        let mut ex_style = windows::Win32::UI::WindowsAndMessaging::WINDOW_EX_STYLE(0);
        if spec.skip_taskbar {
            ex_style |= WS_EX_TOOLWINDOW;
        }
        if spec.focus_policy == SurfaceFocusPolicy::NoActivate {
            ex_style |= WS_EX_NOACTIVATE;
        }
        if spec.z_order_policy == SurfaceZOrderPolicy::Topmost {
            ex_style |= WS_EX_TOPMOST;
        }
        if spec.transparent {
            ex_style |= WS_EX_LAYERED;
        }

        let wide_title = crate::runtime::paths::to_wide(&format!("ELIX Surface [{}]", spec.id));
        let hwnd = unsafe {
            CreateWindowExW(
                ex_style,
                ELIX_SURFACE_CLASS_NAME,
                PCWSTR::from_raw(wide_title.as_ptr()),
                style,
                spec.bounds.x,
                spec.bounds.y,
                spec.bounds.width,
                spec.bounds.height,
                None,
                None,
                Some(hinstance),
                None,
            )
        }
        .map_err(|err| {
            decrement_surface_class_ref();
            NativeError::from_windows_error(
                err,
                &format!("Failed to create HWND for surface '{}'", spec.id),
            )
        })?;

        // Apply bottom z-order immediately if requested
        if spec.z_order_policy == SurfaceZOrderPolicy::Bottom {
            unsafe {
                let _ = SetWindowPos(
                    hwnd,
                    Some(HWND_BOTTOM),
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                );
            }
        }

        // Layered window attributes initialization to ensure proper DWM composition
        if spec.transparent {
            unsafe {
                use windows::Win32::Foundation::COLORREF;
                use windows::Win32::UI::WindowsAndMessaging::{
                    SetLayeredWindowAttributes, LWA_ALPHA,
                };
                let _ = SetLayeredWindowAttributes(hwnd, COLORREF(0), 255, LWA_ALPHA);
            }
        }

        // DWM Round corners attribute for clean presentation if supported
        unsafe {
            let preference = DWMWCP_DONOTROUND;
            let _ = DwmSetWindowAttribute(
                hwnd,
                DWMWA_WINDOW_CORNER_PREFERENCE,
                &preference as *const _ as _,
                std::mem::size_of_val(&preference) as u32,
            );
        }

        let dpi = unsafe { GetDpiForWindow(hwnd) };
        let dpi = if dpi == 0 { 96 } else { dpi };
        let scale_factor = dpi as f64 / 96.0;

        let shared_state = Arc::new(Mutex::new(SurfaceSharedState {
            id: spec.id.clone(),
            focus_policy: spec.focus_policy,
            bounds: spec.bounds,
            dpi,
            scale_factor,
            event_sink: event_sink.clone(),
        }));

        let controller_arc = Arc::new(Mutex::new(None));
        let receiver = Arc::new(SurfaceWndReceiver {
            state: shared_state.clone(),
            controller: controller_arc.clone(),
            hwnd: hwnd.0 as isize,
        });

        register_surface_wnd(hwnd, receiver);

        let has_initial_html = matches!(spec.renderer, Some(SurfaceRendererSpec::Html(_)));
        let internal_html_allowance = Arc::new(AtomicBool::new(has_initial_html));

        let surface = Self {
            id: spec.id.clone(),
            hwnd,
            bounds: spec.bounds,
            state: SurfaceLifecycleState::NativeCreated,
            visible: false,
            desired_visible: spec.visible,
            focus_policy: spec.focus_policy,
            z_order_policy: spec.z_order_policy,
            skip_taskbar: spec.skip_taskbar,
            transparent: spec.transparent,
            dpi,
            scale_factor,
            monitor_id: spec.monitor_id.clone(),
            controller: controller_arc,
            webview: None,
            nav_completed_token: None,
            nav_starting_token: None,
            new_window_token: None,
            process_failed_token: None,
            accel_token: None,
            web_message_token: None,
            shared_state,
            event_sink,
            internal_html_allowance,
            navigation_fence: Arc::new(Mutex::new(NavigationFence::default())),
            current_renderer: spec.renderer.clone(),
        };

        Ok(surface)
    }

    /// Associates an initialized WebView2 controller and initiates navigation.
    pub fn attach_controller(
        &mut self,
        controller: ICoreWebView2Controller,
        renderer: Option<&SurfaceRendererSpec>,
        on_ready: Option<Box<dyn Fn() + Send + Sync + 'static>>,
        on_process_failed: Option<Box<dyn Fn(i32) + Send + Sync + 'static>>,
    ) -> NativeResult<()> {
        if let Err(err) = setup_controller_visuals(&controller, self.hwnd, self.transparent) {
            unsafe {
                let _ = controller.Close();
            }
            self.state = SurfaceLifecycleState::Faulted;
            return Err(err);
        }

        let webview = match unsafe { controller.CoreWebView2() } {
            Ok(wv) => wv,
            Err(e) => {
                unsafe {
                    let _ = controller.Close();
                }
                self.state = SurfaceLifecycleState::Faulted;
                return Err(NativeError::from_windows_error(
                    e,
                    "Failed to get ICoreWebView2 from controller",
                ));
            }
        };

        if let Err(err) = configure_security_settings(&webview, false) {
            unsafe {
                let _ = controller.Close();
            }
            self.state = SurfaceLifecycleState::Faulted;
            return Err(err);
        }

        // 1. NavigationStarting hook: strictly enforce URL policy and bind the
        // authoritative WebView2 NavigationId for the current renderer generation.
        let id_for_starting = self.id.clone();
        let sink_for_starting = self.event_sink.clone();
        let allowance_hook = self.internal_html_allowance.clone();
        let fence_for_starting = self.navigation_fence.clone();
        let nav_starting_token =
            match attach_navigation_starting(&webview, move |uri, navigation_id| {
                let internal_html_armed = allowance_hook.load(Ordering::SeqCst);
                let is_internal_html = internal_html_armed
                    && (uri.starts_with("data:text/html")
                        || uri.eq_ignore_ascii_case("about:blank"));

                let is_allowed = if is_internal_html {
                    allowance_hook.store(false, Ordering::SeqCst);
                    true
                } else {
                    match validate_renderer_url(uri) {
                        Ok(()) => true,
                        Err(err) => {
                            if let Some(sink) = &sink_for_starting {
                                sink(SurfaceEvent::Fault {
                                    id: id_for_starting.clone(),
                                    error: NativeError::new(
                                        "surface",
                                        "NAVIGATION_BLOCKED",
                                        format!(
                                        "Navigation blocked by security policy for URL '{}': {}",
                                        uri, err.message
                                    ),
                                    ),
                                });
                            }
                            false
                        }
                    }
                };

                if is_allowed {
                    fence_for_starting.lock().observe_start(uri, navigation_id);
                }
                is_allowed
            }) {
                Ok(token) => token,
                Err(err) => {
                    unsafe {
                        let _ = controller.Close();
                    }
                    self.state = SurfaceLifecycleState::Faulted;
                    return Err(err);
                }
            };

        // 2. NewWindowRequested hook (Blocker F: block pop-up/new-window navigation)
        let id_for_new_win = self.id.clone();
        let sink_for_new_win = self.event_sink.clone();
        let new_window_token = match attach_new_window_requested(&webview, move |uri| {
            if let Some(sink) = &sink_for_new_win {
                sink(SurfaceEvent::Fault {
                    id: id_for_new_win.clone(),
                    error: NativeError::new(
                        "surface",
                        "NEW_WINDOW_BLOCKED",
                        format!(
                            "Pop-up or new window request blocked for shell surface (target: '{}')",
                            uri
                        ),
                    ),
                });
            }
        }) {
            Ok(token) => token,
            Err(err) => {
                remove_navigation_starting(&webview, nav_starting_token);
                unsafe {
                    let _ = controller.Close();
                }
                self.state = SurfaceLifecycleState::Faulted;
                return Err(err);
            }
        };

        // 3. ProcessFailed hook: notify STA UI thread for authoritative state transition
        let id_for_proc_failed = self.id.clone();
        let sink_for_proc_failed = self.event_sink.clone();
        let on_proc_failed_cb = on_process_failed;
        let process_failed_token = match attach_process_failed(&webview, move |kind| {
            if let Some(ref cb) = on_proc_failed_cb {
                cb(kind);
            } else if let Some(sink) = &sink_for_proc_failed {
                sink(SurfaceEvent::Fault {
                    id: id_for_proc_failed.clone(),
                    error: NativeError::new(
                        "surface",
                        "RENDERER_PROCESS_FAILED",
                        format!("WebView2 renderer process failed (kind code: {})", kind),
                    ),
                });
            }
        }) {
            Ok(token) => token,
            Err(err) => {
                remove_navigation_starting(&webview, nav_starting_token);
                remove_new_window_requested(&webview, new_window_token);
                unsafe {
                    let _ = controller.Close();
                }
                self.state = SurfaceLifecycleState::Faulted;
                return Err(err);
            }
        };

        // 4. NavigationCompleted hook. Only the completion matching the currently
        // authoritative NavigationId may transition readiness or emit a fatal fault.
        let id_for_nav = self.id.clone();
        let sink_for_nav = self.event_sink.clone();
        let fence_for_completed = self.navigation_fence.clone();
        let token = match attach_navigation_completed(
            &webview,
            move |navigation_id, is_success, status_code| {
                let Some(active_navigation) = fence_for_completed.lock().complete(navigation_id)
                else {
                    // Canceled/superseded startup or previous-generation completion.
                    return;
                };

                if is_success {
                    if let Some(sink) = &sink_for_nav {
                        sink(SurfaceEvent::RendererReady {
                            id: id_for_nav.clone(),
                        });
                    }
                    if let Some(ref cb) = on_ready {
                        cb();
                    }
                } else if let Some(sink) = &sink_for_nav {
                    sink(SurfaceEvent::Fault {
                        id: id_for_nav.clone(),
                        error: NativeError::new(
                            "surface",
                            "NAVIGATION_FAILED",
                            format!(
                                "WebView2 navigation failed (navigationId: {}, generation: {}, uri: '{}', status code: {})",
                                active_navigation.id,
                                active_navigation.generation,
                                active_navigation.uri,
                                status_code
                            ),
                        ),
                    });
                }
            },
        ) {
            Ok(token) => token,
            Err(err) => {
                remove_navigation_starting(&webview, nav_starting_token);
                remove_new_window_requested(&webview, new_window_token);
                remove_process_failed(&webview, process_failed_token);
                unsafe {
                    let _ = controller.Close();
                }
                self.state = SurfaceLifecycleState::Faulted;
                return Err(err);
            }
        };

        self.nav_completed_token = Some(token);
        self.nav_starting_token = Some(nav_starting_token);
        self.new_window_token = Some(new_window_token);
        self.process_failed_token = Some(process_failed_token);

        // 5. AcceleratorKeyPressed hook (VK_ESCAPE / 0x1B input key dismissal)
        let id_for_accel = self.id.clone();
        let sink_for_accel = self.event_sink.clone();
        let accel_token = match attach_accelerator_key_pressed(&controller, move |kind, key| {
            if (kind == 0 || kind == 2) && key == 0x1B {
                if let Some(sink) = &sink_for_accel {
                    sink(SurfaceEvent::InputKey {
                        id: id_for_accel.clone(),
                        key: "Escape".to_string(),
                    });
                }
            }
        }) {
            Ok(t) => t,
            Err(err) => {
                remove_navigation_completed(&webview, token);
                remove_navigation_starting(&webview, nav_starting_token);
                remove_new_window_requested(&webview, new_window_token);
                remove_process_failed(&webview, process_failed_token);
                unsafe {
                    let _ = controller.Close();
                }
                self.state = SurfaceLifecycleState::Faulted;
                return Err(err);
            }
        };

        // 6. WebMessageReceived hook
        let id_for_msg = self.id.clone();
        let sink_for_msg = self.event_sink.clone();
        let web_message_token = match attach_web_message_received(&webview, move |message| {
            if let Some(sink) = &sink_for_msg {
                sink(SurfaceEvent::Message {
                    id: id_for_msg.clone(),
                    message,
                });
            }
        }) {
            Ok(t) => t,
            Err(err) => {
                remove_accelerator_key_pressed(&controller, accel_token);
                remove_navigation_completed(&webview, token);
                remove_navigation_starting(&webview, nav_starting_token);
                remove_new_window_requested(&webview, new_window_token);
                remove_process_failed(&webview, process_failed_token);
                unsafe {
                    let _ = controller.Close();
                }
                self.state = SurfaceLifecycleState::Faulted;
                return Err(err);
            }
        };

        self.accel_token = Some(accel_token);
        self.web_message_token = Some(web_message_token);
        self.webview = Some(SendCom(webview.clone()));
        *self.controller.lock() = Some(SendCom(controller));
        self.state = SurfaceLifecycleState::WebviewCreated;

        if let Some(spec) = renderer {
            if let Err(err) = spec.validate() {
                self.state = SurfaceLifecycleState::Faulted;
                return Err(err);
            }
            self.navigation_fence.lock().arm_renderer(spec);
            self.state = SurfaceLifecycleState::Navigating;
            if let Err(err) = navigate_renderer(&webview, spec) {
                self.navigation_fence.lock().cancel_pending();
                self.state = SurfaceLifecycleState::Faulted;
                return Err(err);
            }
        } else {
            // If no renderer specified, surface is immediately ready
            if let Err(err) = self.mark_ready() {
                self.state = SurfaceLifecycleState::Faulted;
                return Err(err);
            }
        }

        Ok(())
    }

    /// Marks the surface ready, enforcing the ready-before-show contract.
    pub fn mark_ready(&mut self) -> NativeResult<()> {
        if !self.state.is_alive() {
            let code = if self.state == SurfaceLifecycleState::Faulted {
                "SURFACE_FAULTED"
            } else {
                "SURFACE_DISPOSED"
            };
            return Err(NativeError::new(
                "surface",
                code,
                format!("Cannot mark {} surface '{}' as ready", self.state, self.id),
            ));
        }

        if self.state != SurfaceLifecycleState::Ready
            && self.state != SurfaceLifecycleState::Visible
            && self.state != SurfaceLifecycleState::Hidden
        {
            self.state = SurfaceLifecycleState::Ready;
        }

        if self.desired_visible && !self.visible {
            self.show()?;
        } else if self.visible && self.focus_policy != SurfaceFocusPolicy::NoActivate {
            if let Some(ctrl_wrapper) = self.controller.lock().as_ref() {
                unsafe {
                    let _ = ctrl_wrapper
                        .0
                        .MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
                }
            }
        }

        Ok(())
    }

    /// Shows the surface on screen. Idempotent and ready-before-show enforced.
    pub fn show(&mut self) -> NativeResult<SurfaceSnapshot> {
        if !self.state.is_alive() {
            let code = if self.state == SurfaceLifecycleState::Faulted {
                "SURFACE_FAULTED"
            } else {
                "SURFACE_DISPOSED"
            };
            return Err(NativeError::new(
                "surface",
                code,
                format!("Cannot show {} surface '{}'", self.state, self.id),
            ));
        }

        self.desired_visible = true;

        if !self.state.is_ready() {
            // Ready-before-show: do not make visible until readiness is established
            return Ok(self.snapshot());
        }

        unsafe {
            if self.focus_policy == SurfaceFocusPolicy::NoActivate {
                let _ = ShowWindow(self.hwnd, SW_SHOWNOACTIVATE);
            } else {
                let _ = ShowWindow(self.hwnd, SW_SHOW);
                let _ = BringWindowToTop(self.hwnd);
                let _ = SetForegroundWindow(self.hwnd);
                let _ = SetActiveWindow(self.hwnd);
                let _ = SetFocus(Some(self.hwnd));
            }

            if let Some(ctrl_wrapper) = self.controller.lock().as_ref() {
                let _ = ctrl_wrapper.0.SetIsVisible(true);
                if self.focus_policy != SurfaceFocusPolicy::NoActivate {
                    let _ = ctrl_wrapper
                        .0
                        .MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
                }
            }
        }

        self.visible = true;
        self.state = SurfaceLifecycleState::Visible;

        if let Some(sink) = &self.event_sink {
            sink(SurfaceEvent::Shown {
                id: self.id.clone(),
            });
        }

        Ok(self.snapshot())
    }

    /// Returns authoritative real-time focus and foreground activation status for this surface.
    pub fn focus_state(&self) -> SurfaceFocusState {
        let fg_hwnd = unsafe { GetForegroundWindow() };
        let focused_hwnd = unsafe { GetFocus() };
        let has_keyboard_focus = focused_hwnd == self.hwnd
            || (!focused_hwnd.0.is_null() && unsafe { IsChild(self.hwnd, focused_hwnd).as_bool() });
        let is_foreground = fg_hwnd == self.hwnd;

        SurfaceFocusState {
            id: self.id.clone(),
            hwnd: self.hwnd.0 as isize,
            is_foreground,
            foreground_hwnd: fg_hwnd.0 as isize,
            has_keyboard_focus,
        }
    }

    /// Hides the surface without releasing resources. Idempotent.
    pub fn hide(&mut self) -> NativeResult<SurfaceSnapshot> {
        if !self.state.is_alive() {
            let code = if self.state == SurfaceLifecycleState::Faulted {
                "SURFACE_FAULTED"
            } else {
                "SURFACE_DISPOSED"
            };
            return Err(NativeError::new(
                "surface",
                code,
                format!("Cannot hide {} surface '{}'", self.state, self.id),
            ));
        }

        self.desired_visible = false;

        unsafe {
            let _ = ShowWindow(self.hwnd, SW_HIDE);
            if let Some(ctrl_wrapper) = self.controller.lock().as_ref() {
                let _ = ctrl_wrapper.0.SetIsVisible(false);
            }
        }

        self.visible = false;
        if self.state == SurfaceLifecycleState::Visible {
            self.state = SurfaceLifecycleState::Hidden;
        }

        if let Some(sink) = &self.event_sink {
            sink(SurfaceEvent::Hidden {
                id: self.id.clone(),
            });
        }

        Ok(self.snapshot())
    }

    /// Sets physical bounds, updating HWND and WebView2 controller.
    pub fn set_bounds(&mut self, bounds: PhysicalBounds) -> NativeResult<SurfaceSnapshot> {
        bounds.validate()?;
        if !self.state.is_alive() {
            let code = if self.state == SurfaceLifecycleState::Faulted {
                "SURFACE_FAULTED"
            } else {
                "SURFACE_DISPOSED"
            };
            return Err(NativeError::new(
                "surface",
                code,
                format!("Cannot set bounds on {} surface '{}'", self.state, self.id),
            ));
        }

        unsafe {
            let _ = SetWindowPos(
                self.hwnd,
                None,
                bounds.x,
                bounds.y,
                bounds.width,
                bounds.height,
                SWP_NOZORDER | SWP_NOACTIVATE,
            );

            if let Some(ctrl_wrapper) = self.controller.lock().as_ref() {
                let mut client_rect = RECT::default();
                let _ = GetClientRect(self.hwnd, &mut client_rect);
                let _ = ctrl_wrapper.0.SetBounds(client_rect);
            }
        }

        self.bounds = bounds;
        self.shared_state.lock().bounds = bounds;

        if let Some(sink) = &self.event_sink {
            sink(SurfaceEvent::BoundsChanged {
                id: self.id.clone(),
                bounds,
            });
        }

        Ok(self.snapshot())
    }

    /// Updates z-order policy.
    pub fn set_z_order(&mut self, policy: SurfaceZOrderPolicy) -> NativeResult<SurfaceSnapshot> {
        if !self.state.is_alive() {
            let code = if self.state == SurfaceLifecycleState::Faulted {
                "SURFACE_FAULTED"
            } else {
                "SURFACE_DISPOSED"
            };
            return Err(NativeError::new(
                "surface",
                code,
                format!("Cannot set z-order on {} surface '{}'", self.state, self.id),
            ));
        }

        let insert_after = match policy {
            SurfaceZOrderPolicy::Topmost => HWND_TOPMOST,
            SurfaceZOrderPolicy::Bottom => HWND_BOTTOM,
            SurfaceZOrderPolicy::Normal => HWND_NOTOPMOST,
        };

        unsafe {
            let _ = SetWindowPos(
                self.hwnd,
                Some(insert_after),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            );
        }

        self.z_order_policy = policy;
        Ok(self.snapshot())
    }

    /// Navigates the surface to a new renderer target.
    pub fn navigate(&mut self, renderer: &SurfaceRendererSpec) -> NativeResult<SurfaceSnapshot> {
        renderer.validate()?;
        if !self.state.is_alive() {
            let code = if self.state == SurfaceLifecycleState::Faulted {
                "SURFACE_FAULTED"
            } else {
                "SURFACE_DISPOSED"
            };
            return Err(NativeError::new(
                "surface",
                code,
                format!("Cannot navigate {} surface '{}'", self.state, self.id),
            ));
        }

        let webview_wrapper = self.webview.as_ref().ok_or_else(|| {
            NativeError::new(
                "surface",
                "WEBVIEW_NOT_READY",
                "Cannot navigate: WebView2 is not attached to this surface.",
            )
        })?;

        if matches!(renderer, SurfaceRendererSpec::Html(_)) {
            self.internal_html_allowance.store(true, Ordering::SeqCst);
        }

        self.current_renderer = Some(renderer.clone());
        self.navigation_fence.lock().arm_renderer(renderer);
        self.state = SurfaceLifecycleState::Navigating;
        if let Err(err) = navigate_renderer(&webview_wrapper.0, renderer) {
            self.navigation_fence.lock().cancel_pending();
            return Err(err);
        }

        Ok(self.snapshot())
    }

    /// Reloads the surface's WebView2 content.
    pub fn reload(&mut self) -> NativeResult<SurfaceSnapshot> {
        if !self.state.is_alive() {
            let code = if self.state == SurfaceLifecycleState::Faulted {
                "SURFACE_FAULTED"
            } else {
                "SURFACE_DISPOSED"
            };
            return Err(NativeError::new(
                "surface",
                code,
                format!("Cannot reload {} surface '{}'", self.state, self.id),
            ));
        }

        if matches!(self.current_renderer, Some(SurfaceRendererSpec::Html(_))) {
            self.internal_html_allowance.store(true, Ordering::SeqCst);
        }

        if let Some(webview_wrapper) = &self.webview {
            self.navigation_fence.lock().arm_reload();
            self.state = SurfaceLifecycleState::Navigating;
            if let Err(err) = unsafe { webview_wrapper.0.Reload() } {
                self.navigation_fence.lock().cancel_pending();
                return Err(NativeError::from_windows_error(
                    err,
                    "Failed to reload WebView2 surface",
                ));
            }
        }

        Ok(self.snapshot())
    }

    /// Posts a message string into the hosted WebView2 renderer.
    pub fn post_web_message(&self, message: &str) -> NativeResult<()> {
        if !self.state.is_alive() {
            return Err(NativeError::new(
                "surface",
                "SURFACE_NOT_ALIVE",
                format!(
                    "Cannot post web message to {} surface '{}'",
                    self.state, self.id
                ),
            ));
        }

        let webview_wrapper = self.webview.as_ref().ok_or_else(|| {
            NativeError::new(
                "surface",
                "WEBVIEW_NOT_READY",
                "Cannot post web message: WebView2 is not attached to this surface.",
            )
        })?;

        post_web_message(&webview_wrapper.0, message)
    }

    /// Invalidates and cleans up WebView2 controller resources following a renderer fault or crash.
    pub fn invalidate_renderer(&mut self) {
        self.navigation_fence.lock().reset();

        if let Some(webview_wrapper) = &self.webview {
            if let Some(token) = self.nav_completed_token.take() {
                remove_navigation_completed(&webview_wrapper.0, token);
            }
            if let Some(token) = self.nav_starting_token.take() {
                remove_navigation_starting(&webview_wrapper.0, token);
            }
            if let Some(token) = self.new_window_token.take() {
                remove_new_window_requested(&webview_wrapper.0, token);
            }
            if let Some(token) = self.process_failed_token.take() {
                remove_process_failed(&webview_wrapper.0, token);
            }
            if let Some(token) = self.web_message_token.take() {
                remove_web_message_received(&webview_wrapper.0, token);
            }
        } else {
            self.nav_completed_token = None;
            self.nav_starting_token = None;
            self.new_window_token = None;
            self.process_failed_token = None;
            self.web_message_token = None;
        }

        if let Some(ctrl_wrapper) = self.controller.lock().take() {
            if let Some(token) = self.accel_token.take() {
                remove_accelerator_key_pressed(&ctrl_wrapper.0, token);
            }
            unsafe {
                let _ = ctrl_wrapper.0.Close();
            }
        } else {
            self.accel_token = None;
        }

        self.webview = None;
    }

    /// Destroys the surface, releasing HWND and WebView2 controller resources cleanly.
    pub fn destroy(&mut self) {
        if self.state == SurfaceLifecycleState::Disposed {
            return;
        }

        self.state = SurfaceLifecycleState::Destroying;

        unregister_surface_wnd(self.hwnd);
        self.invalidate_renderer();

        unsafe {
            let _ = DestroyWindow(self.hwnd);
        }

        decrement_surface_class_ref();
        self.state = SurfaceLifecycleState::Disposed;
        self.visible = false;
        self.desired_visible = false;

        if let Some(sink) = &self.event_sink {
            sink(SurfaceEvent::Destroyed {
                id: self.id.clone(),
            });
        }
    }

    #[cfg(test)]
    pub fn internal_html_allowance(&self) -> Arc<AtomicBool> {
        self.internal_html_allowance.clone()
    }

    /// Returns an immutable snapshot of current surface state.
    pub fn snapshot(&self) -> SurfaceSnapshot {
        let guard = self.shared_state.lock();
        SurfaceSnapshot {
            id: self.id.clone(),
            hwnd: self.hwnd.0 as isize,
            bounds: guard.bounds,
            state: self.state,
            visible: self.visible,
            dpi: guard.dpi,
            scale_factor: guard.scale_factor,
            focus_policy: self.focus_policy,
            z_order_policy: self.z_order_policy,
            monitor_id: self.monitor_id.clone(),
        }
    }
}

impl Drop for NativeSurface {
    fn drop(&mut self) {
        self.destroy();
    }
}

#[cfg(test)]
mod navigation_fence_tests {
    use super::*;

    #[test]
    fn stale_completion_cannot_complete_newer_generation() {
        let mut fence = NavigationFence::default();
        let first = SurfaceRendererSpec::Url("http://127.0.0.1:4100/first".to_string());
        let second = SurfaceRendererSpec::Url("http://127.0.0.1:4100/second".to_string());

        fence.arm_renderer(&first);
        fence.observe_start("http://127.0.0.1:4100/first", 11);
        fence.arm_renderer(&second);
        fence.observe_start("http://127.0.0.1:4100/second", 12);

        assert!(fence.complete(11).is_none());
        let active = fence
            .complete(12)
            .expect("newer navigation must remain authoritative");
        assert_eq!(active.id, 12);
        assert_eq!(active.generation, 2);
    }

    #[test]
    fn unrelated_start_does_not_steal_armed_renderer() {
        let mut fence = NavigationFence::default();
        let renderer = SurfaceRendererSpec::Url("http://127.0.0.1:4200/home".to_string());

        fence.arm_renderer(&renderer);
        fence.observe_start("about:blank", 20);
        assert!(fence.complete(20).is_none());

        fence.observe_start("http://127.0.0.1:4200/home", 21);
        assert_eq!(fence.complete(21).map(|active| active.id), Some(21));
    }

    #[test]
    fn redirect_keeps_same_navigation_generation() {
        let mut fence = NavigationFence::default();
        let renderer = SurfaceRendererSpec::Url("http://127.0.0.1:4300/start".to_string());

        fence.arm_renderer(&renderer);
        fence.observe_start("http://127.0.0.1:4300/start", 30);
        fence.observe_start("http://127.0.0.1:4300/final", 30);

        let active = fence
            .complete(30)
            .expect("redirect must stay authoritative");
        assert_eq!(active.generation, 1);
        assert_eq!(active.uri, "http://127.0.0.1:4300/final");
    }
}
