//! COM and WinRT apartment lifecycle management.
//!
//! Provides RAII guards ensuring strict COM/WinRT initialization policy.
//! Centralizes threading model enforcement (STA vs MTA) and prevents leaked apartments.

use crate::error::{NativeError, NativeResult};
use windows::core::HRESULT;
use windows::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
use windows::Win32::System::Com::{
    CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
    COINIT_MULTITHREADED,
};
use windows::Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED};

/// COM Apartment threading model.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApartmentType {
    /// Single-Threaded Apartment (STA). Required for OLE/DDE and shell link persistence.
    Sta,
    /// Multi-Threaded Apartment (MTA). Recommended for background worker pools.
    Mta,
}

/// RAII Guard for COM initialization on the current thread.
pub struct ComApartment {
    /// Whether this guard was the one that successfully initialized COM and owns cleanup.
    owns_uninit: bool,
    #[allow(dead_code)]
    apt_type: ApartmentType,
}

impl ComApartment {
    /// Initializes COM on the calling thread with the requested apartment model.
    ///
    /// If COM is already initialized in a compatible or existing mode (RPC_E_CHANGED_MODE),
    /// the guard succeeds without transferring uninitialization ownership.
    pub fn init(apt_type: ApartmentType) -> NativeResult<Self> {
        let flags = match apt_type {
            ApartmentType::Sta => COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE,
            ApartmentType::Mta => COINIT_MULTITHREADED | COINIT_DISABLE_OLE1DDE,
        };

        unsafe {
            let hr = CoInitializeEx(None, flags);
            if hr.is_ok() {
                // S_OK (new init) or S_FALSE (already initialized in matching mode)
                Ok(Self {
                    owns_uninit: true,
                    apt_type,
                })
            } else if hr == HRESULT(0x80010106_u32 as i32) {
                // RPC_E_CHANGED_MODE: Already initialized on this thread in an incompatible mode
                Err(NativeError::new(
                    "runtime",
                    "APARTMENT_MODE_MISMATCH",
                    format!(
                        "Cannot initialize COM as {:?}: thread is already initialized in a different apartment mode (RPC_E_CHANGED_MODE)",
                        apt_type
                    ),
                ))
            } else {
                Err(NativeError::from_hresult(
                    hr,
                    "Failed to initialize COM apartment",
                ))
            }
        }
    }

    /// Initializes a Single-Threaded Apartment (STA) on the current thread.
    pub fn sta() -> NativeResult<Self> {
        Self::init(ApartmentType::Sta)
    }

    /// Initializes a Multi-Threaded Apartment (MTA) on the current thread.
    pub fn mta() -> NativeResult<Self> {
        Self::init(ApartmentType::Mta)
    }
}

impl Drop for ComApartment {
    fn drop(&mut self) {
        if self.owns_uninit {
            unsafe {
                CoUninitialize();
            }
        }
    }
}

/// Executes a closure inside a dedicated, deliberately initialized Single-Threaded Apartment (STA) thread.
///
/// Guarantees strict COM apartment isolation: the caller thread retains its own threading model (e.g. MTA),
/// while the closure executes in a freshly initialized STA environment with guaranteed CoInitializeEx / CoUninitialize lifecycle.
pub fn run_in_sta<F, R>(f: F) -> NativeResult<R>
where
    F: FnOnce() -> NativeResult<R> + Send + 'static,
    R: Send + 'static,
{
    let handle = std::thread::Builder::new()
        .name("elix-sta-worker".to_string())
        .spawn(move || {
            let _sta = ComApartment::sta()?;
            f()
        })
        .map_err(|err| {
            NativeError::new(
                "runtime",
                "THREAD_SPAWN_FAILED",
                format!("Failed to spawn STA worker thread: {}", err),
            )
        })?;

    match handle.join() {
        Ok(res) => res,
        Err(_) => Err(NativeError::new(
            "runtime",
            "STA_EXECUTION_PANIC",
            "STA worker thread panicked during execution",
        )),
    }
}

/// RAII Guard for WinRT initialization on the current thread.
pub struct WinRtApartment {
    owns_uninit: bool,
}

impl WinRtApartment {
    /// Initializes the WinRT runtime on the calling thread.
    pub fn init() -> NativeResult<Self> {
        unsafe {
            match RoInitialize(RO_INIT_MULTITHREADED) {
                Ok(()) => Ok(Self { owns_uninit: true }),
                Err(err) => {
                    if err.code() == HRESULT(0x80010106_u32 as i32) {
                        // RPC_E_CHANGED_MODE: already initialized
                        Ok(Self { owns_uninit: false })
                    } else {
                        Err(NativeError::from_windows_error(
                            err,
                            "Failed to initialize WinRT",
                        ))
                    }
                }
            }
        }
    }
}

impl Drop for WinRtApartment {
    fn drop(&mut self) {
        if self.owns_uninit {
            unsafe {
                RoUninitialize();
            }
        }
    }
}

/// RAII wrapper for a Win32 HANDLE ensuring it is closed via CloseHandle on drop.
#[derive(Debug)]
pub struct SafeHandle(pub HANDLE);

impl SafeHandle {
    pub fn new(handle: HANDLE) -> Option<Self> {
        if handle.is_invalid() || handle.0.is_null() || handle == INVALID_HANDLE_VALUE {
            None
        } else {
            Some(Self(handle))
        }
    }

    pub fn raw(&self) -> HANDLE {
        self.0
    }
}

impl Drop for SafeHandle {
    fn drop(&mut self) {
        if !self.0.is_invalid() && !self.0 .0.is_null() && self.0 != INVALID_HANDLE_VALUE {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
}
