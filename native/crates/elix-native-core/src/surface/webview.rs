//! Microsoft Edge WebView2 hosting and lifecycle adapter for ELIX surfaces.

use crate::error::{NativeError, NativeResult};
use crate::runtime::paths::to_wide;
use crate::surface::types::SurfaceRendererSpec;
use std::path::PathBuf;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    CreateCoreWebView2EnvironmentWithOptions, GetAvailableCoreWebView2BrowserVersionString,
    ICoreWebView2, ICoreWebView2AcceleratorKeyPressedEventArgs,
    ICoreWebView2AcceleratorKeyPressedEventHandler,
    ICoreWebView2AcceleratorKeyPressedEventHandler_Impl, ICoreWebView2Controller,
    ICoreWebView2Controller2, ICoreWebView2Environment, ICoreWebView2EnvironmentOptions,
    ICoreWebView2NavigationCompletedEventArgs, ICoreWebView2NavigationCompletedEventHandler,
    ICoreWebView2NavigationCompletedEventHandler_Impl, ICoreWebView2NavigationStartingEventArgs,
    ICoreWebView2NavigationStartingEventHandler, ICoreWebView2NavigationStartingEventHandler_Impl,
    ICoreWebView2NewWindowRequestedEventArgs, ICoreWebView2NewWindowRequestedEventHandler,
    ICoreWebView2NewWindowRequestedEventHandler_Impl, ICoreWebView2ProcessFailedEventArgs,
    ICoreWebView2ProcessFailedEventHandler, ICoreWebView2ProcessFailedEventHandler_Impl,
    ICoreWebView2WebMessageReceivedEventArgs, ICoreWebView2WebMessageReceivedEventHandler,
    ICoreWebView2WebMessageReceivedEventHandler_Impl, COREWEBVIEW2_COLOR,
    COREWEBVIEW2_KEY_EVENT_KIND, COREWEBVIEW2_PROCESS_FAILED_KIND, COREWEBVIEW2_WEB_ERROR_STATUS,
};
use webview2_com::{
    CreateCoreWebView2ControllerCompletedHandler, CreateCoreWebView2EnvironmentCompletedHandler,
};
use windows::core::{Interface, BOOL, PCWSTR, PWSTR};
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::System::Com::CoTaskMemFree;
use windows::Win32::UI::WindowsAndMessaging::GetClientRect;

/// Checks whether Microsoft Edge WebView2 Runtime is available on the machine.
pub fn check_webview2_runtime() -> NativeResult<String> {
    unsafe {
        let mut version_ptr = PWSTR::null();
        let hr = GetAvailableCoreWebView2BrowserVersionString(PCWSTR::null(), &mut version_ptr);
        if hr.is_err() || version_ptr.is_null() {
            return Err(NativeError::new(
                "surface",
                "WEBVIEW2_NOT_AVAILABLE",
                "Microsoft Edge WebView2 Runtime is not installed or available on this system.",
            ));
        }

        let version = version_ptr.to_string().map_err(|_| {
            NativeError::new(
                "surface",
                "WEBVIEW2_VERSION_ERROR",
                "Failed to parse WebView2 runtime version string.",
            )
        })?;

        CoTaskMemFree(Some(version_ptr.as_ptr() as _));
        Ok(version)
    }
}

/// Computes the default user data directory for ELIX WebView2 profiles.
pub fn default_user_data_directory() -> PathBuf {
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        PathBuf::from(local_app_data).join("ELIX").join("WebView2")
    } else {
        std::env::temp_dir().join("ELIX_WebView2")
    }
}

/// Asynchronously initiates WebView2 environment creation on the calling UI thread.
pub fn create_environment_async<F>(
    user_data_folder: Option<&str>,
    on_completed: F,
) -> NativeResult<()>
where
    F: FnOnce(NativeResult<ICoreWebView2Environment>) + 'static,
{
    // First ensure runtime is present
    let _ = check_webview2_runtime()?;

    let data_dir = user_data_folder
        .map(PathBuf::from)
        .unwrap_or_else(default_user_data_directory);
    std::fs::create_dir_all(&data_dir).map_err(|e| {
        NativeError::new(
            "surface",
            "ENV_DIR_CREATE_FAILED",
            format!("Failed to create user data folder: {}", e),
        )
    })?;
    let data_dir_wide = to_wide(data_dir.to_string_lossy().as_ref());

    let handler = CreateCoreWebView2EnvironmentCompletedHandler::create(Box::new(
        move |result, environment| {
            if let Err(err) = result {
                on_completed(Err(NativeError::from_windows_error(
                    err,
                    "Failed to create CoreWebView2Environment",
                )));
            } else if let Some(env) = environment {
                on_completed(Ok(env));
            } else {
                on_completed(Err(NativeError::new(
                    "surface",
                    "WEBVIEW2_ENV_NULL",
                    "CoreWebView2Environment was null after creation",
                )));
            }
            Ok(())
        },
    ));

    let options: Option<&ICoreWebView2EnvironmentOptions> = None;

    unsafe {
        CreateCoreWebView2EnvironmentWithOptions(
            PCWSTR::null(),
            PCWSTR::from_raw(data_dir_wide.as_ptr()),
            options,
            &handler,
        )
        .map_err(|err| {
            NativeError::from_windows_error(
                err,
                "Failed to call CreateCoreWebView2EnvironmentWithOptions",
            )
        })
    }
}

/// Asynchronously creates a WebView2 controller attached to the given HWND.
pub fn create_controller_async<F>(
    environment: &ICoreWebView2Environment,
    hwnd: HWND,
    on_completed: F,
) -> NativeResult<()>
where
    F: FnOnce(NativeResult<ICoreWebView2Controller>) + 'static,
{
    let handler = CreateCoreWebView2ControllerCompletedHandler::create(Box::new(
        move |result, controller| {
            if let Err(err) = result {
                on_completed(Err(NativeError::from_windows_error(
                    err,
                    "Failed to create CoreWebView2Controller",
                )));
            } else if let Some(ctrl) = controller {
                on_completed(Ok(ctrl));
            } else {
                on_completed(Err(NativeError::new(
                    "surface",
                    "WEBVIEW2_CONTROLLER_NULL",
                    "CoreWebView2Controller was null after creation",
                )));
            }
            Ok(())
        },
    ));

    unsafe {
        environment
            .CreateCoreWebView2Controller(hwnd, &handler)
            .map_err(|err| {
                NativeError::from_windows_error(
                    err,
                    "Failed to call CreateCoreWebView2Controller on environment",
                )
            })
    }
}

#[windows_core::implement(ICoreWebView2NavigationCompletedEventHandler)]
struct NavigationCompletedCallback<F>(F)
where
    F: Fn(u64, bool, i32) + 'static;

impl<F> ICoreWebView2NavigationCompletedEventHandler_Impl for NavigationCompletedCallback_Impl<F>
where
    F: Fn(u64, bool, i32) + 'static,
{
    fn Invoke(
        &self,
        _sender: windows_core::Ref<ICoreWebView2>,
        args: windows_core::Ref<ICoreWebView2NavigationCompletedEventArgs>,
    ) -> windows_core::Result<()> {
        let mut navigation_id: u64 = 0;
        let mut is_success = BOOL(0);
        let mut web_status = COREWEBVIEW2_WEB_ERROR_STATUS(0);
        if let Some(args_ref) = args.as_ref() {
            unsafe {
                let _ = args_ref.NavigationId(&mut navigation_id);
                let _ = args_ref.IsSuccess(&mut is_success);
                let _ = args_ref.WebErrorStatus(&mut web_status);
            }
        }
        (self.0)(navigation_id, is_success.as_bool(), web_status.0);
        Ok(())
    }
}

/// Attaches a NavigationCompleted handler to the webview.
pub fn attach_navigation_completed<F>(webview: &ICoreWebView2, callback: F) -> NativeResult<i64>
where
    F: Fn(u64, bool, i32) + 'static,
{
    let handler: ICoreWebView2NavigationCompletedEventHandler =
        NavigationCompletedCallback(callback).into();
    let mut token: i64 = 0;
    unsafe {
        webview
            .add_NavigationCompleted(&handler, &mut token)
            .map_err(|err| {
                NativeError::from_windows_error(
                    err,
                    "Failed to add NavigationCompleted event handler",
                )
            })?;
    }
    Ok(token)
}

/// Removes a previously registered NavigationCompleted handler.
pub fn remove_navigation_completed(webview: &ICoreWebView2, token: i64) {
    unsafe {
        let _ = webview.remove_NavigationCompleted(token);
    }
}

#[windows_core::implement(ICoreWebView2NavigationStartingEventHandler)]
struct NavigationStartingCallback<F>(F)
where
    F: Fn(&str, u64) -> bool + 'static;

impl<F> ICoreWebView2NavigationStartingEventHandler_Impl for NavigationStartingCallback_Impl<F>
where
    F: Fn(&str, u64) -> bool + 'static,
{
    fn Invoke(
        &self,
        _sender: windows_core::Ref<ICoreWebView2>,
        args: windows_core::Ref<ICoreWebView2NavigationStartingEventArgs>,
    ) -> windows_core::Result<()> {
        if let Some(args_ref) = args.as_ref() {
            unsafe {
                let mut uri_ptr = PWSTR::null();
                let mut navigation_id: u64 = 0;
                let _ = args_ref.NavigationId(&mut navigation_id);
                if args_ref.Uri(&mut uri_ptr).is_ok() && !uri_ptr.is_null() {
                    let uri_str = uri_ptr.to_string().unwrap_or_default();
                    CoTaskMemFree(Some(uri_ptr.as_ptr() as _));
                    let is_allowed = (self.0)(&uri_str, navigation_id);
                    if !is_allowed {
                        let _ = args_ref.SetCancel(true);
                    }
                }
            }
        }
        Ok(())
    }
}

/// Attaches a NavigationStarting handler to enforce runtime navigation security policy.
pub fn attach_navigation_starting<F>(webview: &ICoreWebView2, callback: F) -> NativeResult<i64>
where
    F: Fn(&str, u64) -> bool + 'static,
{
    let handler: ICoreWebView2NavigationStartingEventHandler =
        NavigationStartingCallback(callback).into();
    let mut token: i64 = 0;
    unsafe {
        webview
            .add_NavigationStarting(&handler, &mut token)
            .map_err(|err| {
                NativeError::from_windows_error(
                    err,
                    "Failed to add NavigationStarting event handler",
                )
            })?;
    }
    Ok(token)
}

/// Removes a previously registered NavigationStarting handler.
pub fn remove_navigation_starting(webview: &ICoreWebView2, token: i64) {
    unsafe {
        let _ = webview.remove_NavigationStarting(token);
    }
}

#[windows_core::implement(ICoreWebView2NewWindowRequestedEventHandler)]
struct NewWindowRequestedCallback<F>(F)
where
    F: Fn(&str) + 'static;

impl<F> ICoreWebView2NewWindowRequestedEventHandler_Impl for NewWindowRequestedCallback_Impl<F>
where
    F: Fn(&str) + 'static,
{
    fn Invoke(
        &self,
        _sender: windows_core::Ref<ICoreWebView2>,
        args: windows_core::Ref<ICoreWebView2NewWindowRequestedEventArgs>,
    ) -> windows_core::Result<()> {
        if let Some(args_ref) = args.as_ref() {
            unsafe {
                // Shell surfaces block popup/new-window navigation
                let _ = args_ref.SetHandled(true);
                let mut uri_ptr = PWSTR::null();
                if args_ref.Uri(&mut uri_ptr).is_ok() && !uri_ptr.is_null() {
                    let uri_str = uri_ptr.to_string().unwrap_or_default();
                    CoTaskMemFree(Some(uri_ptr.as_ptr() as _));
                    (self.0)(&uri_str);
                }
            }
        }
        Ok(())
    }
}

/// Attaches a NewWindowRequested handler to intercept pop-up windows on shell surfaces.
pub fn attach_new_window_requested<F>(webview: &ICoreWebView2, callback: F) -> NativeResult<i64>
where
    F: Fn(&str) + 'static,
{
    let handler: ICoreWebView2NewWindowRequestedEventHandler =
        NewWindowRequestedCallback(callback).into();
    let mut token: i64 = 0;
    unsafe {
        webview
            .add_NewWindowRequested(&handler, &mut token)
            .map_err(|err| {
                NativeError::from_windows_error(
                    err,
                    "Failed to add NewWindowRequested event handler",
                )
            })?;
    }
    Ok(token)
}

/// Removes a previously registered NewWindowRequested handler.
pub fn remove_new_window_requested(webview: &ICoreWebView2, token: i64) {
    unsafe {
        let _ = webview.remove_NewWindowRequested(token);
    }
}

#[windows_core::implement(ICoreWebView2ProcessFailedEventHandler)]
struct ProcessFailedCallback<F>(F)
where
    F: Fn(i32) + 'static;

impl<F> ICoreWebView2ProcessFailedEventHandler_Impl for ProcessFailedCallback_Impl<F>
where
    F: Fn(i32) + 'static,
{
    fn Invoke(
        &self,
        _sender: windows_core::Ref<ICoreWebView2>,
        args: windows_core::Ref<ICoreWebView2ProcessFailedEventArgs>,
    ) -> windows_core::Result<()> {
        let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND(0);
        if let Some(args_ref) = args.as_ref() {
            unsafe {
                let _ = args_ref.ProcessFailedKind(&mut kind);
            }
        }
        (self.0)(kind.0);
        Ok(())
    }
}

/// Attaches a ProcessFailed handler to observe renderer process crashes or exits.
pub fn attach_process_failed<F>(webview: &ICoreWebView2, callback: F) -> NativeResult<i64>
where
    F: Fn(i32) + 'static,
{
    let handler: ICoreWebView2ProcessFailedEventHandler = ProcessFailedCallback(callback).into();
    let mut token: i64 = 0;
    unsafe {
        webview
            .add_ProcessFailed(&handler, &mut token)
            .map_err(|err| {
                NativeError::from_windows_error(err, "Failed to add ProcessFailed event handler")
            })?;
    }
    Ok(token)
}

/// Removes a previously registered ProcessFailed handler.
pub fn remove_process_failed(webview: &ICoreWebView2, token: i64) {
    unsafe {
        let _ = webview.remove_ProcessFailed(token);
    }
}

/// Configures restrictive security settings appropriate for native shell surfaces.
pub fn configure_security_settings(webview: &ICoreWebView2, dev_tools: bool) -> NativeResult<()> {
    unsafe {
        let settings = webview.Settings().map_err(|e| {
            NativeError::from_windows_error(e, "Failed to get ICoreWebView2Settings")
        })?;

        let _ = settings.SetAreDefaultContextMenusEnabled(dev_tools);
        let _ = settings.SetAreDevToolsEnabled(dev_tools);
        let _ = settings.SetIsStatusBarEnabled(false);
        let _ = settings.SetIsZoomControlEnabled(false);
        let _ = settings.SetIsBuiltInErrorPageEnabled(true);
        let _ = settings.SetIsScriptEnabled(true);
    }
    Ok(())
}

/// Configures controller bounds and background transparency.
pub fn setup_controller_visuals(
    controller: &ICoreWebView2Controller,
    hwnd: HWND,
    transparent: bool,
) -> NativeResult<()> {
    unsafe {
        let mut client_rect = RECT::default();
        let _ = GetClientRect(hwnd, &mut client_rect);
        controller
            .SetBounds(client_rect)
            .map_err(|e| NativeError::from_windows_error(e, "Failed to set controller bounds"))?;

        if transparent {
            if let Ok(ctrl2) = controller.cast::<ICoreWebView2Controller2>() {
                // Set default background color to fully transparent RGBA(0, 0, 0, 0)
                let transparent_color = COREWEBVIEW2_COLOR {
                    A: 0,
                    R: 0,
                    G: 0,
                    B: 0,
                };
                let _ = ctrl2.SetDefaultBackgroundColor(transparent_color);
            }
        }

        // Keep invisible until ready-before-show proves readiness
        let _ = controller.SetIsVisible(false);
    }
    Ok(())
}

/// Navigates the webview to the specified renderer specification.
pub fn navigate_renderer(
    webview: &ICoreWebView2,
    renderer: &SurfaceRendererSpec,
) -> NativeResult<()> {
    unsafe {
        match renderer {
            SurfaceRendererSpec::Url(url) => {
                let wide_url = to_wide(url);
                webview
                    .Navigate(PCWSTR::from_raw(wide_url.as_ptr()))
                    .map_err(|e| {
                        NativeError::from_windows_error(
                            e,
                            &format!("Failed to navigate to URL: {}", url),
                        )
                    })
            }
            SurfaceRendererSpec::Html(html) => {
                let wide_html = to_wide(html);
                webview
                    .NavigateToString(PCWSTR::from_raw(wide_html.as_ptr()))
                    .map_err(|e| {
                        NativeError::from_windows_error(e, "Failed to navigate to HTML string")
                    })
            }
        }
    }
}

#[windows_core::implement(ICoreWebView2AcceleratorKeyPressedEventHandler)]
struct AcceleratorKeyPressedCallback<F>(F)
where
    F: Fn(u32, u32) + 'static;

impl<F> ICoreWebView2AcceleratorKeyPressedEventHandler_Impl
    for AcceleratorKeyPressedCallback_Impl<F>
where
    F: Fn(u32, u32) + 'static,
{
    fn Invoke(
        &self,
        _sender: windows_core::Ref<ICoreWebView2Controller>,
        args: windows_core::Ref<ICoreWebView2AcceleratorKeyPressedEventArgs>,
    ) -> windows_core::Result<()> {
        if let Some(args_ref) = args.as_ref() {
            unsafe {
                let mut kind = COREWEBVIEW2_KEY_EVENT_KIND(0);
                let mut key: u32 = 0;
                if args_ref.KeyEventKind(&mut kind).is_ok() && args_ref.VirtualKey(&mut key).is_ok()
                {
                    (self.0)(kind.0 as u32, key);
                }
            }
        }
        Ok(())
    }
}

/// Attaches an AcceleratorKeyPressed handler to capture keyboard events (such as Escape).
pub fn attach_accelerator_key_pressed<F>(
    controller: &ICoreWebView2Controller,
    callback: F,
) -> NativeResult<i64>
where
    F: Fn(u32, u32) + 'static,
{
    let handler: ICoreWebView2AcceleratorKeyPressedEventHandler =
        AcceleratorKeyPressedCallback(callback).into();
    let mut token: i64 = 0;
    unsafe {
        controller
            .add_AcceleratorKeyPressed(&handler, &mut token)
            .map_err(|err| {
                NativeError::from_windows_error(
                    err,
                    "Failed to add AcceleratorKeyPressed event handler",
                )
            })?;
    }
    Ok(token)
}

/// Removes a previously registered AcceleratorKeyPressed handler.
pub fn remove_accelerator_key_pressed(controller: &ICoreWebView2Controller, token: i64) {
    unsafe {
        let _ = controller.remove_AcceleratorKeyPressed(token);
    }
}

#[windows_core::implement(ICoreWebView2WebMessageReceivedEventHandler)]
struct WebMessageReceivedCallback<F>(F)
where
    F: Fn(String) + 'static;

impl<F> ICoreWebView2WebMessageReceivedEventHandler_Impl for WebMessageReceivedCallback_Impl<F>
where
    F: Fn(String) + 'static,
{
    fn Invoke(
        &self,
        _sender: windows_core::Ref<ICoreWebView2>,
        args: windows_core::Ref<ICoreWebView2WebMessageReceivedEventArgs>,
    ) -> windows_core::Result<()> {
        if let Some(args_ref) = args.as_ref() {
            unsafe {
                let mut msg_ptr = PWSTR::null();
                let has_json =
                    args_ref.WebMessageAsJson(&mut msg_ptr).is_ok() && !msg_ptr.is_null();
                let has_str = if !has_json {
                    args_ref.TryGetWebMessageAsString(&mut msg_ptr).is_ok() && !msg_ptr.is_null()
                } else {
                    false
                };
                if has_json || has_str {
                    let msg_str = msg_ptr.to_string().unwrap_or_default();
                    CoTaskMemFree(Some(msg_ptr.as_ptr() as _));
                    (self.0)(msg_str);
                }
            }
        }
        Ok(())
    }
}

/// Attaches a WebMessageReceived handler to process messages from the hosted document.
pub fn attach_web_message_received<F>(webview: &ICoreWebView2, callback: F) -> NativeResult<i64>
where
    F: Fn(String) + 'static,
{
    let handler: ICoreWebView2WebMessageReceivedEventHandler =
        WebMessageReceivedCallback(callback).into();
    let mut token: i64 = 0;
    unsafe {
        webview
            .add_WebMessageReceived(&handler, &mut token)
            .map_err(|err| {
                NativeError::from_windows_error(
                    err,
                    "Failed to add WebMessageReceived event handler",
                )
            })?;
    }
    Ok(token)
}

/// Removes a previously registered WebMessageReceived handler.
pub fn remove_web_message_received(webview: &ICoreWebView2, token: i64) {
    unsafe {
        let _ = webview.remove_WebMessageReceived(token);
    }
}

/// Posts a message string or JSON into the hosted WebView2 renderer.
pub fn post_web_message(webview: &ICoreWebView2, message: &str) -> NativeResult<()> {
    let wide = to_wide(message);
    unsafe {
        if serde_json::from_str::<serde_json::Value>(message).is_ok()
            && webview
                .PostWebMessageAsJson(PCWSTR::from_raw(wide.as_ptr()))
                .is_ok()
        {
            return Ok(());
        }
        webview
            .PostWebMessageAsString(PCWSTR::from_raw(wide.as_ptr()))
            .map_err(|e| NativeError::from_windows_error(e, "Failed to post web message"))
    }
}
