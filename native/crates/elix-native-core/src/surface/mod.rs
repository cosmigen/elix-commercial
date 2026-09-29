//! ELIX Native Surface Core subsystem.
//!
//! Provides authoritative native Win32 window ownership and WebView2 hosting
//! for ELIX OS visual surfaces.

pub mod manager;
pub mod surface_instance;
pub mod types;
pub mod ui_thread;
pub mod webview;
pub mod wnd_class;
pub mod wndproc;

pub use manager::SurfaceManager;
pub use surface_instance::NativeSurface;
pub use types::*;
pub use webview::check_webview2_runtime;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::{NativeError, NativeResult};
    use crate::surface::ui_thread::{SurfaceCommand, SurfaceUiThread};
    use parking_lot::Mutex;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Arc;

    #[test]
    fn test_physical_bounds_validation() {
        let valid = PhysicalBounds::new(100, 200, 800, 600);
        assert!(valid.validate().is_ok());

        let zero_width = PhysicalBounds::new(0, 0, 0, 600);
        assert!(zero_width.validate().is_err());

        let neg_height = PhysicalBounds::new(10, 10, 400, -50);
        assert!(neg_height.validate().is_err());

        let overflow = PhysicalBounds::new(0, 0, 50000, 50000);
        assert!(overflow.validate().is_err());
    }

    #[test]
    fn test_surface_spec_validation() {
        let valid_spec = SurfaceCreateSpec {
            id: "surface:test-spec".to_string(),
            bounds: PhysicalBounds::new(50, 50, 640, 480),
            renderer: None,
            monitor_id: None,
            focus_policy: SurfaceFocusPolicy::Normal,
            z_order_policy: SurfaceZOrderPolicy::Normal,
            skip_taskbar: true,
            transparent: false,
            visible: false,
            user_data_folder: None,
        };
        assert!(valid_spec.validate().is_ok());

        let mut empty_id = valid_spec.clone();
        empty_id.id = "   ".to_string();
        assert!(empty_id.validate().is_err());
    }

    #[test]
    fn test_renderer_spec_security_validation() {
        // Allowed safe loopback destinations
        assert!(
            SurfaceRendererSpec::Url("http://localhost:5173".to_string())
                .validate()
                .is_ok()
        );
        assert!(
            SurfaceRendererSpec::Url("http://127.0.0.1:8080/app".to_string())
                .validate()
                .is_ok()
        );
        assert!(
            SurfaceRendererSpec::Url("https://localhost:8443/secure".to_string())
                .validate()
                .is_ok()
        );
        assert!(
            SurfaceRendererSpec::Url("https://127.0.0.1:8443".to_string())
                .validate()
                .is_ok()
        );
        assert!(SurfaceRendererSpec::Url("http://[::1]:3000".to_string())
            .validate()
            .is_ok());
        assert!(SurfaceRendererSpec::Url("about:blank".to_string())
            .validate()
            .is_ok());
        assert!(SurfaceRendererSpec::Html("<div>Content</div>".to_string())
            .validate()
            .is_ok());

        // Adversarial URL validation (Blocker E: no prefix checks, no userinfo tricks)
        assert!(
            SurfaceRendererSpec::Url("http://localhost.evil.example/".to_string())
                .validate()
                .is_err()
        );
        assert!(
            SurfaceRendererSpec::Url("https://localhost.evil.example/".to_string())
                .validate()
                .is_err()
        );
        assert!(
            SurfaceRendererSpec::Url("http://localhost@evil.example/".to_string())
                .validate()
                .is_err()
        );
        assert!(
            SurfaceRendererSpec::Url("https://localhost@evil.example/".to_string())
                .validate()
                .is_err()
        );
        assert!(
            SurfaceRendererSpec::Url("http://127.0.0.1.evil.com/".to_string())
                .validate()
                .is_err()
        );
        assert!(
            SurfaceRendererSpec::Url("http://127.0.0.2:8080/".to_string())
                .validate()
                .is_err()
        );
        assert!(
            SurfaceRendererSpec::Url("http://localhost:99999/".to_string())
                .validate()
                .is_err()
        );
        assert!(SurfaceRendererSpec::Url("http://localhost:0/".to_string())
            .validate()
            .is_err());

        // Gated/deferred file:// and data: URLs
        assert!(
            SurfaceRendererSpec::Url("file:///C:/elix/index.html".to_string())
                .validate()
                .is_err()
        );
        assert!(
            SurfaceRendererSpec::Url("data:text/html,<h1>Hi</h1>".to_string())
                .validate()
                .is_err()
        );

        // Prohibited external web destinations & script schemes
        assert!(SurfaceRendererSpec::Url("https://google.com".to_string())
            .validate()
            .is_err());
        assert!(
            SurfaceRendererSpec::Url("http://attacker.com/exploit".to_string())
                .validate()
                .is_err()
        );
        assert!(SurfaceRendererSpec::Url("javascript:alert(1)".to_string())
            .validate()
            .is_err());
        assert!(SurfaceRendererSpec::Url("   ".to_string())
            .validate()
            .is_err());
        assert!(SurfaceRendererSpec::Html("".to_string())
            .validate()
            .is_err());
        assert!(SurfaceRendererSpec::Html("   ".to_string())
            .validate()
            .is_err());
    }

    #[test]
    fn test_lifecycle_state_invariants() {
        assert!(SurfaceLifecycleState::Allocated.is_alive());
        assert!(SurfaceLifecycleState::NativeCreated.is_alive());
        assert!(!SurfaceLifecycleState::Allocated.is_ready());
        assert!(!SurfaceLifecycleState::NativeCreated.is_ready());
        assert!(SurfaceLifecycleState::Ready.is_ready());
        assert!(SurfaceLifecycleState::Visible.is_ready());
        assert!(SurfaceLifecycleState::Hidden.is_ready());
        assert!(!SurfaceLifecycleState::Faulted.is_alive());
        assert!(!SurfaceLifecycleState::Faulted.is_ready());
        assert!(!SurfaceLifecycleState::Destroying.is_alive());
        assert!(!SurfaceLifecycleState::Disposed.is_alive());
    }

    #[test]
    fn test_webview2_runtime_discovery_live() {
        let res = check_webview2_runtime();
        assert!(
            res.is_ok(),
            "WebView2 Runtime must be discoverable: {:?}",
            res.err()
        );
        let version = res.unwrap();
        assert!(!version.is_empty());
    }

    #[test]
    fn test_surface_manager_lifecycle_and_hwnd_operations() {
        let event_count = Arc::new(AtomicUsize::new(0));
        let count_clone = event_count.clone();

        let event_sink = Arc::new(move |_ev: SurfaceEvent| {
            count_clone.fetch_add(1, Ordering::SeqCst);
        });

        let manager = SurfaceManager::new(event_sink).expect("Failed to create SurfaceManager");

        let spec = SurfaceCreateSpec {
            id: "test:unit-surface-1".to_string(),
            bounds: PhysicalBounds::new(100, 100, 500, 400),
            renderer: None,
            monitor_id: Some("MONITOR:PRIMARY".to_string()),
            focus_policy: SurfaceFocusPolicy::NoActivate,
            z_order_policy: SurfaceZOrderPolicy::Normal,
            skip_taskbar: true,
            transparent: false,
            visible: false,
            user_data_folder: None,
        };

        let snapshot = manager
            .create_surface(spec.clone())
            .expect("Failed to create surface");
        assert_eq!(snapshot.id, "test:unit-surface-1");
        assert_ne!(snapshot.hwnd, 0);
        assert_eq!(snapshot.bounds, PhysicalBounds::new(100, 100, 500, 400));
        assert_eq!(snapshot.focus_policy, SurfaceFocusPolicy::NoActivate);

        // Duplicate ID must be rejected
        let dup_res = manager.create_surface(spec);
        assert!(dup_res.is_err());
        assert_eq!(dup_res.err().unwrap().code, "DUPLICATE_SURFACE_ID");

        // Query state
        let queried = manager
            .query_surface("test:unit-surface-1")
            .expect("Query failed");
        assert_eq!(queried.hwnd, snapshot.hwnd);

        // Resize / move
        let new_bounds = PhysicalBounds::new(150, 120, 600, 450);
        let moved = manager
            .set_bounds("test:unit-surface-1", new_bounds)
            .expect("Move failed");
        assert_eq!(moved.bounds, new_bounds);

        // Change z-order
        let z_order = manager
            .set_z_order("test:unit-surface-1", SurfaceZOrderPolicy::Topmost)
            .expect("Set z-order failed");
        assert_eq!(z_order.z_order_policy, SurfaceZOrderPolicy::Topmost);

        // Ready-before-show: show() before readiness records intent but does NOT show unready surface
        let pending_show = manager
            .show_surface("test:unit-surface-1")
            .expect("Show failed");
        assert!(
            !pending_show.visible,
            "Surface must not become visible before ready"
        );

        // Mark ready: now surface fulfills ready-before-show and becomes visible
        let ready = manager
            .mark_ready("test:unit-surface-1")
            .expect("Mark ready failed");
        assert!(ready.visible, "Surface must become visible after ready");

        // Hide (idempotent)
        let hidden = manager
            .hide_surface("test:unit-surface-1")
            .expect("Hide failed");
        assert!(!hidden.visible);

        // Show after ready is immediately visible
        let shown = manager
            .show_surface("test:unit-surface-1")
            .expect("Show failed");
        assert!(shown.visible);

        // List active surfaces
        let list = manager.list_surfaces().expect("List failed");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "test:unit-surface-1");

        // Destroy
        let destroyed = manager
            .destroy_surface("test:unit-surface-1")
            .expect("Destroy failed");
        assert!(destroyed);

        // Second destroy returns false (idempotent)
        let destroy_again = manager
            .destroy_surface("test:unit-surface-1")
            .expect("Second destroy failed");
        assert!(!destroy_again);

        // Query now fails
        assert!(manager.query_surface("test:unit-surface-1").is_err());

        // List now empty
        let list_empty = manager.list_surfaces().expect("List failed");
        assert_eq!(list_empty.len(), 0);

        // Clean shutdown
        manager.dispose();
    }

    #[test]
    fn test_deterministic_multi_monitor_and_dpi_geometry() {
        let event_sink = Arc::new(|_ev: SurfaceEvent| {});
        let manager = SurfaceManager::new(event_sink).expect("SurfaceManager creation failed");

        // 1. Secondary monitor left of primary with negative X (-1920 to 0)
        let left_monitor_bounds = PhysicalBounds::new(-1920 + 100, 100, 1200, 800);
        let left_spec = SurfaceCreateSpec {
            id: "surface:left-display".to_string(),
            bounds: left_monitor_bounds,
            renderer: None,
            monitor_id: Some("MONITOR:LEFT_SECONDARY".to_string()),
            focus_policy: SurfaceFocusPolicy::Normal,
            z_order_policy: SurfaceZOrderPolicy::Normal,
            skip_taskbar: true,
            transparent: false,
            visible: false,
            user_data_folder: None,
        };
        let left_surface = manager
            .create_surface(left_spec)
            .expect("Create left surface");
        assert_eq!(left_surface.bounds.x, -1820);
        assert_eq!(left_surface.bounds.width, 1200);

        // 2. Secondary monitor above primary with negative Y (-1080 to 0)
        let top_monitor_bounds = PhysicalBounds::new(100, -1080 + 50, 1000, 700);
        let top_spec = SurfaceCreateSpec {
            id: "surface:top-display".to_string(),
            bounds: top_monitor_bounds,
            renderer: None,
            monitor_id: Some("MONITOR:TOP_SECONDARY".to_string()),
            focus_policy: SurfaceFocusPolicy::NoActivate,
            z_order_policy: SurfaceZOrderPolicy::Bottom,
            skip_taskbar: true,
            transparent: false,
            visible: false,
            user_data_folder: None,
        };
        let top_surface = manager
            .create_surface(top_spec)
            .expect("Create top surface");
        assert_eq!(top_surface.bounds.y, -1030);
        assert_eq!(top_surface.bounds.height, 700);

        // 3. Move surface from primary (96 DPI / 100%) to secondary 144 DPI (150%)
        // Physical bounds should scale proportionally when adapted to 150%
        let _primary_bounds = PhysicalBounds::new(100, 100, 800, 600);
        let scaled_150_bounds = PhysicalBounds::new(-1500, 150, 1200, 900); // 800 * 1.5 = 1200, 600 * 1.5 = 900
        let moved = manager
            .set_bounds("surface:left-display", scaled_150_bounds)
            .expect("Move across mixed DPI displays");
        assert_eq!(moved.bounds, scaled_150_bounds);

        // 4. Clean destruction of multi-monitor simulated surfaces
        assert!(manager
            .destroy_surface("surface:left-display")
            .expect("Destroy left"));
        assert!(manager
            .destroy_surface("surface:top-display")
            .expect("Destroy top"));

        manager.dispose();
    }

    #[test]
    fn test_dispatch_timeout_structured_error_and_clean_disposal() {
        let event_sink = Arc::new(|_ev: SurfaceEvent| {});
        let thread = SurfaceUiThread::spawn(event_sink).expect("Spawn UI thread");

        // Deliberately dispatch with a tiny timeout to simulate a stalled command.
        // We hold the reply sender in a local channel so the receiver doesn't see Disconnected.
        let (hold_tx, hold_rx) = crossbeam_channel::bounded(1);
        let timeout = std::time::Duration::from_millis(50);
        let res: NativeResult<SurfaceSnapshot> = thread.dispatch_timeout(
            |reply| {
                let _ = hold_tx.send(reply);
                SurfaceCommand::InternalRendererReady {
                    id: "non-existent".to_string(),
                }
            },
            timeout,
        );

        assert!(res.is_err());
        let err = res.unwrap_err();
        assert_eq!(err.code, "DISPATCH_TIMEOUT");
        assert_eq!(err.native_code, Some(121));
        assert_eq!(err.retryable, Some(true));

        drop(hold_rx);

        // Ensure shutdown succeeds cleanly without deadlock
        assert!(thread.shutdown().is_ok());
    }

    #[test]
    fn test_environment_failure_propagates_fault_to_all_pending_surfaces() {
        let faults = Arc::new(Mutex::new(Vec::new()));
        let faults_clone = faults.clone();
        let event_sink = Arc::new(move |ev: SurfaceEvent| {
            if let SurfaceEvent::Fault { id, error } = ev {
                faults_clone.lock().push((id, error.code));
            }
        });

        let manager = SurfaceManager::new(event_sink).expect("SurfaceManager");

        // Invalid user_data_folder path causes create_environment_async to fail deterministically
        let invalid_folder = Some("C:\\Windows\\System32\\cmd.exe\\invalid_dir".to_string());

        let spec1 = SurfaceCreateSpec {
            id: "surf:env-fault-1".to_string(),
            bounds: PhysicalBounds::new(100, 100, 400, 300),
            renderer: None,
            monitor_id: None,
            focus_policy: SurfaceFocusPolicy::Normal,
            z_order_policy: SurfaceZOrderPolicy::Normal,
            skip_taskbar: true,
            transparent: false,
            visible: false,
            user_data_folder: invalid_folder.clone(),
        };
        let _ = manager.create_surface(spec1).expect("Create surf 1");

        // Surface 2 created after environment failure: verifies is_creating_env is reset so retry/failure works
        let spec2 = SurfaceCreateSpec {
            id: "surf:env-fault-2".to_string(),
            bounds: PhysicalBounds::new(200, 200, 400, 300),
            renderer: None,
            monitor_id: None,
            focus_policy: SurfaceFocusPolicy::Normal,
            z_order_policy: SurfaceZOrderPolicy::Normal,
            skip_taskbar: true,
            transparent: false,
            visible: false,
            user_data_folder: invalid_folder,
        };
        let _ = manager.create_surface(spec2).expect("Create surf 2");

        let start = std::time::Instant::now();
        while faults.lock().len() < 2 && start.elapsed() < std::time::Duration::from_secs(1) {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }

        let recorded = faults.lock().clone();
        let fault_ids: Vec<String> = recorded.into_iter().map(|(id, _)| id).collect();
        assert!(
            fault_ids.contains(&"surf:env-fault-1".to_string()),
            "Surface 1 must receive typed fault"
        );
        assert!(
            fault_ids.contains(&"surf:env-fault-2".to_string()),
            "Surface 2 must receive typed fault"
        );

        let s1 = manager.query_surface("surf:env-fault-1").expect("query 1");
        assert_eq!(s1.state, SurfaceLifecycleState::Faulted);
        let s2 = manager.query_surface("surf:env-fault-2").expect("query 2");
        assert_eq!(s2.state, SurfaceLifecycleState::Faulted);

        manager.dispose();
    }

    #[test]
    fn test_attach_controller_failure_emits_typed_fault() {
        let faults = Arc::new(Mutex::new(Vec::new()));
        let faults_clone = faults.clone();
        let event_sink = Arc::new(move |ev: SurfaceEvent| {
            if let SurfaceEvent::Fault { id, error } = ev {
                faults_clone.lock().push((id, error.code));
            }
        });

        let manager = SurfaceManager::new(event_sink).expect("SurfaceManager");

        let spec = SurfaceCreateSpec {
            id: "surf:ctrl-fault".to_string(),
            bounds: PhysicalBounds::new(100, 100, 400, 300),
            renderer: None,
            monitor_id: None,
            focus_policy: SurfaceFocusPolicy::Normal,
            z_order_policy: SurfaceZOrderPolicy::Normal,
            skip_taskbar: true,
            transparent: false,
            visible: false,
            user_data_folder: None,
        };
        let _ = manager.create_surface(spec).expect("Create surf");

        // Inject controller attach fault for this surface
        let thread = manager.get_ui_thread().expect("get thread");
        let cmd = SurfaceCommand::InternalAttachFault {
            id: "surf:ctrl-fault".to_string(),
            error: NativeError::new(
                "surface",
                "ATTACH_FAILED",
                "Injected controller attach failure",
            ),
        };
        thread.post_command(cmd).expect("send attach fail");

        let start = std::time::Instant::now();
        while faults.lock().is_empty() && start.elapsed() < std::time::Duration::from_secs(1) {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }

        let recorded = faults.lock().clone();
        assert_eq!(recorded.len(), 1);
        assert_eq!(recorded[0].0, "surf:ctrl-fault");
        assert_eq!(recorded[0].1, "ATTACH_FAILED");

        let s = manager.query_surface("surf:ctrl-fault").expect("query");
        assert_eq!(s.state, SurfaceLifecycleState::Faulted);

        manager.dispose();
    }

    #[test]
    fn test_process_failed_transitions_native_state_to_faulted_and_rejects_operations() {
        let faults = Arc::new(Mutex::new(Vec::new()));
        let faults_clone = faults.clone();
        let event_sink = Arc::new(move |ev: SurfaceEvent| {
            if let SurfaceEvent::Fault { id, error } = ev {
                faults_clone.lock().push((id, error.code));
            }
        });

        let manager = SurfaceManager::new(event_sink).expect("SurfaceManager");

        let spec = SurfaceCreateSpec {
            id: "surf:proc-fail".to_string(),
            bounds: PhysicalBounds::new(100, 100, 400, 300),
            renderer: None,
            monitor_id: None,
            focus_policy: SurfaceFocusPolicy::Normal,
            z_order_policy: SurfaceZOrderPolicy::Normal,
            skip_taskbar: true,
            transparent: false,
            visible: false,
            user_data_folder: None,
        };
        let _ = manager.create_surface(spec).expect("Create surf");

        // Dispatch authoritative InternalProcessFailed command onto STA UI thread
        let thread = manager.get_ui_thread().expect("get thread");
        let cmd = SurfaceCommand::InternalProcessFailed {
            id: "surf:proc-fail".to_string(),
            kind: 1, // COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED
        };
        thread.post_command(cmd).expect("send process failed");

        let start = std::time::Instant::now();
        while faults.lock().is_empty() && start.elapsed() < std::time::Duration::from_secs(1) {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }

        // 1. Authoritative fault event emitted
        let recorded = faults.lock().clone();
        assert_eq!(recorded.len(), 1);
        assert_eq!(recorded[0].0, "surf:proc-fail");
        assert_eq!(recorded[0].1, "RENDERER_PROCESS_FAILED");

        // 2. Authoritative native state transition to Faulted
        let s = manager.query_surface("surf:proc-fail").expect("query");
        assert_eq!(s.state, SurfaceLifecycleState::Faulted);
        assert!(!s.visible);

        // 3. Subsequent native operations reject deterministically with SURFACE_FAULTED
        let show_err = manager.show_surface("surf:proc-fail").unwrap_err();
        assert_eq!(show_err.code, "SURFACE_FAULTED");

        let hide_err = manager.hide_surface("surf:proc-fail").unwrap_err();
        assert_eq!(hide_err.code, "SURFACE_FAULTED");

        let bounds_err = manager
            .set_bounds("surf:proc-fail", PhysicalBounds::new(200, 200, 500, 400))
            .unwrap_err();
        assert_eq!(bounds_err.code, "SURFACE_FAULTED");

        let zorder_err = manager
            .set_z_order("surf:proc-fail", SurfaceZOrderPolicy::Topmost)
            .unwrap_err();
        assert_eq!(zorder_err.code, "SURFACE_FAULTED");

        let nav_err = manager
            .navigate(
                "surf:proc-fail",
                SurfaceRendererSpec::Url("about:blank".to_string()),
            )
            .unwrap_err();
        assert_eq!(nav_err.code, "SURFACE_FAULTED");

        let reload_err = manager.reload("surf:proc-fail").unwrap_err();
        assert_eq!(reload_err.code, "SURFACE_FAULTED");

        let ready_err = manager.mark_ready("surf:proc-fail").unwrap_err();
        assert_eq!(ready_err.code, "SURFACE_FAULTED");

        manager.dispose();
    }

    #[test]
    fn test_data_url_navigation_starting_allowance_and_adversarial_blocking() {
        // Test 1: spec with HTML arms initial single-use allowance
        let spec_html = SurfaceCreateSpec {
            id: "surf:html-allowance".to_string(),
            bounds: PhysicalBounds::new(100, 100, 400, 300),
            renderer: Some(SurfaceRendererSpec::Html("<div>Hello</div>".to_string())),
            monitor_id: None,
            focus_policy: SurfaceFocusPolicy::Normal,
            z_order_policy: SurfaceZOrderPolicy::Normal,
            skip_taskbar: true,
            transparent: false,
            visible: false,
            user_data_folder: None,
        };
        let surface = NativeSurface::create(&spec_html, None).expect("create surface");
        let allowance = surface.internal_html_allowance();
        assert!(
            allowance.load(Ordering::SeqCst),
            "Initial HTML spec must arm the allowance"
        );

        // First internal NavigateToString consumes the allowance
        assert!(
            allowance.swap(false, Ordering::SeqCst),
            "First consumption must succeed"
        );

        // Subsequent consumption returns false: allowance is single-use
        assert!(
            !allowance.swap(false, Ordering::SeqCst),
            "Second consumption must fail: single-use contract"
        );

        // Adversarial data: URL is rejected by validate_renderer_url
        let adv_data_url = "data:text/html;charset=utf-8,<h1>Exploit</h1>";
        let validation = validate_renderer_url(adv_data_url);
        assert!(
            validation.is_err(),
            "validate_renderer_url must strictly reject data: URLs"
        );

        // Test 2: navigate with URL does not arm allowance
        let surface_url = NativeSurface::create(
            &SurfaceCreateSpec {
                id: "surf:url-no-allowance".to_string(),
                bounds: PhysicalBounds::new(100, 100, 400, 300),
                renderer: Some(SurfaceRendererSpec::Url("about:blank".to_string())),
                monitor_id: None,
                focus_policy: SurfaceFocusPolicy::Normal,
                z_order_policy: SurfaceZOrderPolicy::Normal,
                skip_taskbar: true,
                transparent: false,
                visible: false,
                user_data_folder: None,
            },
            None,
        )
        .expect("create surface url");
        assert!(
            !surface_url.internal_html_allowance().load(Ordering::SeqCst),
            "URL renderer must not arm HTML allowance"
        );
    }

    #[test]
    fn test_shutdown_timeout_when_ui_thread_stalled() {
        let event_sink = Arc::new(|_ev: SurfaceEvent| {});
        let thread = SurfaceUiThread::spawn(event_sink).expect("spawn UI thread");

        let hang_flag = Arc::new(AtomicBool::new(true));
        thread
            .post_command(SurfaceCommand::TestHangLoop {
                hang_flag: hang_flag.clone(),
            })
            .expect("post hang loop");

        // Allow UI thread to enter the test hang loop
        std::thread::sleep(std::time::Duration::from_millis(30));

        // Call shutdown_timeout with a short 150ms timeout; must return SHUTDOWN_TIMEOUT error
        let shutdown_res = thread.shutdown_timeout(std::time::Duration::from_millis(150));
        assert!(
            shutdown_res.is_err(),
            "Stalled UI thread must return timeout error"
        );
        let err = shutdown_res.unwrap_err();
        assert_eq!(err.code, "SHUTDOWN_TIMEOUT");

        // Release hang flag so the background thread exits cleanly without hanging the test process
        hang_flag.store(false, Ordering::SeqCst);
    }
}
