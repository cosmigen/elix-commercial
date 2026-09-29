//! High-level SurfaceManager facade coordinating native surface creation and lifecycle.

use crate::error::NativeResult;
use crate::surface::types::{
    PhysicalBounds, SurfaceCreateSpec, SurfaceEvent, SurfaceFocusState, SurfaceRendererSpec,
    SurfaceSnapshot, SurfaceZOrderPolicy,
};
use crate::surface::ui_thread::{SurfaceCommand, SurfaceUiThread};
use parking_lot::Mutex;
use std::sync::Arc;

/// Authoritative native manager for ELIX OS Windows surfaces.
pub struct SurfaceManager {
    ui_thread: Mutex<Option<Arc<SurfaceUiThread>>>,
    #[allow(dead_code)]
    event_sink: Arc<dyn Fn(SurfaceEvent) + Send + Sync>,
}

impl SurfaceManager {
    /// Creates a new SurfaceManager, initializing the dedicated STA UI thread.
    pub fn new(event_sink: Arc<dyn Fn(SurfaceEvent) + Send + Sync>) -> NativeResult<Self> {
        let ui_thread = SurfaceUiThread::spawn(event_sink.clone())?;
        Ok(Self {
            ui_thread: Mutex::new(Some(Arc::new(ui_thread))),
            event_sink,
        })
    }

    /// Obtains an owned reference to the active SurfaceUiThread.
    ///
    /// Keeps mutex hold duration minimal so a stalled or timed-out dispatch
    /// never blocks disposal or concurrent surface operations.
    pub(crate) fn get_ui_thread(&self) -> NativeResult<Arc<SurfaceUiThread>> {
        let guard = self.ui_thread.lock();
        guard.as_ref().cloned().ok_or_else(|| {
            crate::error::NativeError::new(
                "surface",
                "MANAGER_DISPOSED",
                "SurfaceManager is disposed",
            )
        })
    }

    /// Creates and registers a new native surface.
    pub fn create_surface(&self, spec: SurfaceCreateSpec) -> NativeResult<SurfaceSnapshot> {
        let thread = self.get_ui_thread()?;
        thread.dispatch(|reply| SurfaceCommand::Create { spec, reply })
    }

    /// Shows a native surface. Ready-before-show is enforced.
    pub fn show_surface(&self, id: &str) -> NativeResult<SurfaceSnapshot> {
        let thread = self.get_ui_thread()?;
        thread.dispatch(|reply| SurfaceCommand::Show {
            id: id.to_string(),
            reply,
        })
    }

    /// Hides a native surface without releasing resources.
    pub fn hide_surface(&self, id: &str) -> NativeResult<SurfaceSnapshot> {
        let thread = self.get_ui_thread()?;
        thread.dispatch(|reply| SurfaceCommand::Hide {
            id: id.to_string(),
            reply,
        })
    }

    /// Updates physical-pixel bounds.
    pub fn set_bounds(&self, id: &str, bounds: PhysicalBounds) -> NativeResult<SurfaceSnapshot> {
        let thread = self.get_ui_thread()?;
        thread.dispatch(|reply| SurfaceCommand::SetBounds {
            id: id.to_string(),
            bounds,
            reply,
        })
    }

    /// Updates window z-order policy.
    pub fn set_z_order(
        &self,
        id: &str,
        policy: SurfaceZOrderPolicy,
    ) -> NativeResult<SurfaceSnapshot> {
        let thread = self.get_ui_thread()?;
        thread.dispatch(|reply| SurfaceCommand::SetZOrder {
            id: id.to_string(),
            policy,
            reply,
        })
    }

    /// Navigates the surface to a new renderer target.
    pub fn navigate(
        &self,
        id: &str,
        renderer: SurfaceRendererSpec,
    ) -> NativeResult<SurfaceSnapshot> {
        let thread = self.get_ui_thread()?;
        thread.dispatch(|reply| SurfaceCommand::Navigate {
            id: id.to_string(),
            renderer,
            reply,
        })
    }

    /// Reloads the surface's WebView2.
    pub fn reload(&self, id: &str) -> NativeResult<SurfaceSnapshot> {
        let thread = self.get_ui_thread()?;
        thread.dispatch(|reply| SurfaceCommand::Reload {
            id: id.to_string(),
            reply,
        })
    }

    /// Signals that renderer readiness has been established, fulfilling ready-before-show.
    pub fn mark_ready(&self, id: &str) -> NativeResult<SurfaceSnapshot> {
        let thread = self.get_ui_thread()?;
        thread.dispatch(|reply| SurfaceCommand::MarkReady {
            id: id.to_string(),
            reply,
        })
    }

    /// Destroys a native surface and releases its Win32/WebView2 resources.
    pub fn destroy_surface(&self, id: &str) -> NativeResult<bool> {
        let thread = self.get_ui_thread()?;
        thread.dispatch(|reply| SurfaceCommand::Destroy {
            id: id.to_string(),
            reply,
        })
    }

    /// Returns a snapshot of current surface state.
    pub fn query_surface(&self, id: &str) -> NativeResult<SurfaceSnapshot> {
        let thread = self.get_ui_thread()?;
        thread.dispatch(|reply| SurfaceCommand::Query {
            id: id.to_string(),
            reply,
        })
    }

    /// Queries real-time focus and foreground activation status for a surface.
    pub fn get_focus_state(&self, id: &str) -> NativeResult<SurfaceFocusState> {
        let thread = self.get_ui_thread()?;
        thread.dispatch(|reply| SurfaceCommand::GetFocusState {
            id: id.to_string(),
            reply,
        })
    }

    /// Returns the HWND of the current system-wide foreground window.
    pub fn get_foreground_hwnd() -> isize {
        unsafe { windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow().0 as isize }
    }

    /// Lists all active surfaces.
    pub fn list_surfaces(&self) -> NativeResult<Vec<SurfaceSnapshot>> {
        let thread = self.get_ui_thread()?;
        thread.dispatch(|reply| SurfaceCommand::List { reply })
    }

    /// Posts a web message to the hosted WebView2 renderer for a surface.
    pub fn post_web_message(&self, id: &str, message: &str) -> NativeResult<bool> {
        let thread = self.get_ui_thread()?;
        thread.dispatch(|reply| SurfaceCommand::PostMessage {
            id: id.to_string(),
            message: message.to_string(),
            reply,
        })
    }

    /// Gracefully tears down all surfaces and joins the UI thread.
    pub fn dispose(&self) {
        if let Some(thread) = self.ui_thread.lock().take() {
            let _ = thread.shutdown();
        }
    }
}

impl Drop for SurfaceManager {
    fn drop(&mut self) {
        self.dispose();
    }
}
