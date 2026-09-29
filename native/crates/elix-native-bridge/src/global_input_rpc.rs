//! RPC adapter for ELIX Phase 18B system-wide explicit hotkeys.
//!
//! This provider deliberately uses the documented RegisterHotKey / WM_HOTKEY
//! contract. It does not install a low-level keyboard hook and therefore does
//! not observe unrelated user typing.

use crate::protocol::{BridgeRequest, BridgeResponse};
use elix_native_core::error::NativeError;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{HashMap, VecDeque};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicI32, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{SystemTime, UNIX_EPOCH};
use windows::Win32::Foundation::{LPARAM, WPARAM};
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    RegisterHotKey, UnregisterHotKey, HOT_KEY_MODIFIERS, MOD_ALT, MOD_CONTROL, MOD_NOREPEAT,
    MOD_SHIFT, MOD_WIN,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetMessageW, PeekMessageW, PostThreadMessageW, MSG, PM_NOREMOVE, WM_HOTKEY, WM_QUIT,
};

const MAX_QUEUED_EVENTS: usize = 256;
const MAX_BINDING_ID_LEN: usize = 128;
const MAX_NATIVE_HOTKEY_ID: i32 = 0xBFFF;
const HRESULT_HOTKEY_ALREADY_REGISTERED: u32 = 0x8007_0581;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeGlobalHotkeyModifiers {
    pub alt: bool,
    pub control: bool,
    pub shift: bool,
    pub win: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeGlobalHotkeyBinding {
    pub id: String,
    pub key: String,
    pub virtual_key: u32,
    pub modifiers: NativeGlobalHotkeyModifiers,
    pub no_repeat: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeGlobalHotkeyRegistration {
    pub binding_id: String,
    pub native_id: i32,
    pub binding: NativeGlobalHotkeyBinding,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeGlobalHotkeyEvent {
    pub binding_id: String,
    pub key: String,
    pub virtual_key: u32,
    pub modifiers: NativeGlobalHotkeyModifiers,
    pub sequence: u64,
    pub captured_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeGlobalInputSnapshot {
    pub provider: String,
    pub registrations: Vec<NativeGlobalHotkeyRegistration>,
}

struct ActiveRegistration {
    registration: NativeGlobalHotkeyRegistration,
    thread_id: u32,
    worker: JoinHandle<()>,
}

struct GlobalInputManager {
    registrations: Mutex<HashMap<String, ActiveRegistration>>,
    events: Arc<Mutex<VecDeque<NativeGlobalHotkeyEvent>>>,
    next_native_id: AtomicI32,
    sequence: Arc<AtomicU64>,
}

impl GlobalInputManager {
    fn new() -> Self {
        Self {
            registrations: Mutex::new(HashMap::new()),
            events: Arc::new(Mutex::new(VecDeque::new())),
            next_native_id: AtomicI32::new(1),
            sequence: Arc::new(AtomicU64::new(0)),
        }
    }

    fn register(
        &self,
        binding: NativeGlobalHotkeyBinding,
    ) -> Result<NativeGlobalHotkeyRegistration, NativeError> {
        validate_binding(&binding)?;

        {
            let registrations = self.registrations.lock().map_err(lock_error)?;
            if let Some(existing) = registrations.get(&binding.id) {
                if existing.registration.binding == binding {
                    return Ok(existing.registration.clone());
                }
                return Err(global_input_error(
                    "DUPLICATE_BINDING_ID",
                    format!("Global hotkey id '{}' is already registered", binding.id),
                    false,
                ));
            }
        }

        let native_id = self.next_native_id.fetch_add(1, Ordering::Relaxed);
        if native_id <= 0 || native_id > MAX_NATIVE_HOTKEY_ID {
            return Err(NativeError::resource_exhausted(
                "Global hotkey native-id range is exhausted",
            ));
        }

        let worker_binding = binding.clone();
        let events = Arc::clone(&self.events);
        let sequence = Arc::clone(&self.sequence);
        let (startup_tx, startup_rx) = mpsc::sync_channel::<Result<u32, NativeError>>(1);

        let worker = thread::Builder::new()
            .name(format!("elix-hotkey-{}", native_id))
            .spawn(move || {
                let thread_id = unsafe { GetCurrentThreadId() };

                // Win32 creates a thread message queue lazily. PeekMessage establishes it before
                // the thread id is published, so later PostThreadMessage(WM_QUIT) is reliable.
                let mut message = MSG::default();
                unsafe {
                    let _ = PeekMessageW(&mut message, None, 0, 0, PM_NOREMOVE);
                }

                let register_result = unsafe {
                    RegisterHotKey(
                        None,
                        native_id,
                        hotkey_modifiers(&worker_binding),
                        worker_binding.virtual_key,
                    )
                };

                if let Err(error) = register_result {
                    let _ = startup_tx.send(Err(map_register_error(error, &worker_binding)));
                    return;
                }

                if startup_tx.send(Ok(thread_id)).is_err() {
                    let _ = unsafe { UnregisterHotKey(None, native_id) };
                    return;
                }

                loop {
                    let result = unsafe { GetMessageW(&mut message, None, 0, 0) };
                    if result.0 <= 0 {
                        break;
                    }

                    if message.message == WM_HOTKEY && message.wParam.0 as i32 == native_id {
                        let event = NativeGlobalHotkeyEvent {
                            binding_id: worker_binding.id.clone(),
                            key: worker_binding.key.clone(),
                            virtual_key: worker_binding.virtual_key,
                            modifiers: worker_binding.modifiers.clone(),
                            sequence: sequence.fetch_add(1, Ordering::Relaxed) + 1,
                            captured_at: now_millis(),
                        };
                        if let Ok(mut queue) = events.lock() {
                            if queue.len() >= MAX_QUEUED_EVENTS {
                                queue.pop_front();
                            }
                            queue.push_back(event);
                        }
                    }
                }

                let _ = unsafe { UnregisterHotKey(None, native_id) };
            })
            .map_err(|error| NativeError::io_error(error, "Failed to start global hotkey thread"))?;

        let thread_id = match startup_rx.recv() {
            Ok(Ok(thread_id)) => thread_id,
            Ok(Err(error)) => {
                let _ = worker.join();
                return Err(error);
            }
            Err(error) => {
                let _ = worker.join();
                return Err(global_input_error(
                    "HOTKEY_THREAD_START_FAILED",
                    format!("Global hotkey worker exited during startup: {}", error),
                    true,
                ));
            }
        };

        let registration = NativeGlobalHotkeyRegistration {
            binding_id: binding.id.clone(),
            native_id,
            binding,
        };
        let mut registrations = self.registrations.lock().map_err(lock_error)?;
        registrations.insert(
            registration.binding_id.clone(),
            ActiveRegistration {
                registration: registration.clone(),
                thread_id,
                worker,
            },
        );
        Ok(registration)
    }

    fn unregister(&self, binding_id: &str) -> Result<bool, NativeError> {
        let thread_id = {
            let registrations = self.registrations.lock().map_err(lock_error)?;
            match registrations.get(binding_id) {
                Some(active) => active.thread_id,
                None => return Ok(false),
            }
        };

        unsafe {
            PostThreadMessageW(thread_id, WM_QUIT, WPARAM(0), LPARAM(0)).map_err(|error| {
                NativeError::from_windows_error(error, "Failed to stop global hotkey thread")
            })?;
        }

        let active = self
            .registrations
            .lock()
            .map_err(lock_error)?
            .remove(binding_id);
        if let Some(active) = active {
            active.worker.join().map_err(|_| {
                global_input_error(
                    "HOTKEY_THREAD_JOIN_FAILED",
                    format!("Global hotkey worker '{}' panicked during shutdown", binding_id),
                    false,
                )
            })?;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    fn snapshot(&self) -> Result<NativeGlobalInputSnapshot, NativeError> {
        let registrations = self.registrations.lock().map_err(lock_error)?;
        let mut values: Vec<_> = registrations
            .values()
            .map(|active| active.registration.clone())
            .collect();
        values.sort_by(|left, right| left.binding_id.cmp(&right.binding_id));
        Ok(NativeGlobalInputSnapshot {
            provider: "win32-register-hot-key".to_string(),
            registrations: values,
        })
    }

    fn drain_events(&self) -> Result<Vec<NativeGlobalHotkeyEvent>, NativeError> {
        let mut events = self.events.lock().map_err(lock_error)?;
        Ok(events.drain(..).collect())
    }

    fn dispose_all(&self) {
        let binding_ids: Vec<String> = match self.registrations.lock() {
            Ok(registrations) => registrations.keys().cloned().collect(),
            Err(_) => return,
        };
        for binding_id in binding_ids {
            let _ = self.unregister(&binding_id);
        }
        if let Ok(mut events) = self.events.lock() {
            events.clear();
        }
    }
}

static GLOBAL_INPUT: OnceLock<GlobalInputManager> = OnceLock::new();

fn manager() -> &'static GlobalInputManager {
    GLOBAL_INPUT.get_or_init(GlobalInputManager::new)
}

/// Returns whether a method belongs to the dedicated Phase 18B global-input namespace.
pub fn handles(method: &str) -> bool {
    matches!(
        method,
        "globalInput/register"
            | "globalInput/unregister"
            | "globalInput/snapshot"
            | "globalInput/drainEvents"
            | "globalInput/disposeAll"
    )
}

/// Dispatches one global-input request behind an isolated panic boundary.
pub fn dispatch(request: BridgeRequest) -> BridgeResponse {
    let id = request.id;
    let result = catch_unwind(AssertUnwindSafe(|| handle_method(&request.method, request.params)));
    match result {
        Ok(Ok(value)) => BridgeResponse::success(id, value),
        Ok(Err(error)) => BridgeResponse::error(id, error),
        Err(payload) => {
            let message = if let Some(message) = payload.downcast_ref::<&str>() {
                (*message).to_string()
            } else if let Some(message) = payload.downcast_ref::<String>() {
                message.clone()
            } else {
                "Unknown global-input backend panic".to_string()
            };
            BridgeResponse::error(id, NativeError::panic_error(message))
        }
    }
}

pub fn dispose_all() {
    if let Some(manager) = GLOBAL_INPUT.get() {
        manager.dispose_all();
    }
}

fn handle_method(
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, NativeError> {
    match method {
        "globalInput/register" => {
            let binding_value = params
                .get("binding")
                .cloned()
                .ok_or_else(|| NativeError::invalid_argument("Missing global-input 'binding'"))?;
            let binding: NativeGlobalHotkeyBinding = serde_json::from_value(binding_value).map_err(|error| {
                NativeError::invalid_argument(format!("Invalid global hotkey binding: {}", error))
            })?;
            Ok(json!(manager().register(binding)?))
        }
        "globalInput/unregister" => {
            let binding_id = params
                .get("bindingId")
                .and_then(|value| value.as_str())
                .ok_or_else(|| NativeError::invalid_argument("Missing global-input 'bindingId'"))?;
            Ok(json!({ "unregistered": manager().unregister(binding_id)? }))
        }
        "globalInput/snapshot" => Ok(json!(manager().snapshot()?)),
        "globalInput/drainEvents" => Ok(json!({ "events": manager().drain_events()? })),
        "globalInput/disposeAll" => {
            manager().dispose_all();
            Ok(json!({ "disposed": true }))
        }
        _ => Err(NativeError::new(
            "bridge",
            "METHOD_NOT_FOUND",
            format!("Unrecognized global-input RPC method: '{}'", method),
        )),
    }
}

fn validate_binding(binding: &NativeGlobalHotkeyBinding) -> Result<(), NativeError> {
    let id = binding.id.trim();
    if id.is_empty() || id.len() > MAX_BINDING_ID_LEN {
        return Err(NativeError::invalid_argument(
            "Global hotkey binding id must contain 1-128 characters",
        ));
    }
    if binding.virtual_key == 0 || binding.virtual_key > 0xFF {
        return Err(NativeError::invalid_argument(format!(
            "Global hotkey '{}' has invalid virtualKey {}",
            binding.id, binding.virtual_key
        )));
    }
    if !binding.modifiers.alt
        && !binding.modifiers.control
        && !binding.modifiers.shift
        && !binding.modifiers.win
    {
        return Err(NativeError::invalid_argument(format!(
            "Global hotkey '{}' must contain at least one modifier",
            binding.id
        )));
    }
    Ok(())
}

fn hotkey_modifiers(binding: &NativeGlobalHotkeyBinding) -> HOT_KEY_MODIFIERS {
    let mut flags = 0u32;
    if binding.modifiers.alt {
        flags |= MOD_ALT.0;
    }
    if binding.modifiers.control {
        flags |= MOD_CONTROL.0;
    }
    if binding.modifiers.shift {
        flags |= MOD_SHIFT.0;
    }
    if binding.modifiers.win {
        flags |= MOD_WIN.0;
    }
    if binding.no_repeat {
        flags |= MOD_NOREPEAT.0;
    }
    HOT_KEY_MODIFIERS(flags)
}

fn map_register_error(
    error: windows::core::Error,
    binding: &NativeGlobalHotkeyBinding,
) -> NativeError {
    if error.code().0 as u32 == HRESULT_HOTKEY_ALREADY_REGISTERED {
        return global_input_error(
            "HOTKEY_CONFLICT",
            format!(
                "Global hotkey '{}' ({}) is already registered by Windows or another process",
                binding.id, binding.key
            ),
            false,
        );
    }
    NativeError::from_windows_error(error, "RegisterHotKey failed")
}

fn global_input_error(code: &str, message: impl Into<String>, retryable: bool) -> NativeError {
    let mut error = NativeError::new("global-input", code, message);
    error.retryable = Some(retryable);
    error
}

fn lock_error<T>(error: std::sync::PoisonError<T>) -> NativeError {
    global_input_error(
        "GLOBAL_INPUT_STATE_POISONED",
        format!("Global Input state lock was poisoned: {}", error),
        false,
    )
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn binding(id: &str, virtual_key: u32) -> NativeGlobalHotkeyBinding {
        NativeGlobalHotkeyBinding {
            id: id.to_string(),
            key: "Test".to_string(),
            virtual_key,
            modifiers: NativeGlobalHotkeyModifiers {
                alt: true,
                control: true,
                shift: true,
                win: false,
            },
            no_repeat: true,
        }
    }

    #[test]
    fn recognizes_only_global_input_namespace_contracts() {
        assert!(handles("globalInput/register"));
        assert!(handles("globalInput/drainEvents"));
        assert!(!handles("spaces/shellSwitch"));
        assert!(!handles("globalInput/unknown"));
    }

    #[test]
    fn validates_binding_shape_before_windows_access() {
        let mut invalid = binding("", 0x41);
        assert_eq!(
            validate_binding(&invalid).expect_err("empty id").code,
            "INVALID_ARGUMENT"
        );
        invalid.id = "valid".to_string();
        invalid.virtual_key = 0;
        assert_eq!(
            validate_binding(&invalid).expect_err("zero virtual key").code,
            "INVALID_ARGUMENT"
        );
    }

    #[test]
    fn no_repeat_modifier_is_enabled_by_default_binding_contract() {
        let value = binding("test", 0x41);
        let flags = hotkey_modifiers(&value);
        assert_ne!(flags.0 & MOD_NOREPEAT.0, 0);
        assert_ne!(flags.0 & MOD_ALT.0, 0);
        assert_ne!(flags.0 & MOD_CONTROL.0, 0);
        assert_ne!(flags.0 & MOD_SHIFT.0, 0);
    }
}
