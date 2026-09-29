//! Runtime and environment primitives for Windows execution.

pub mod apartment;
pub mod paths;

pub use apartment::{ApartmentType, ComApartment, SafeHandle, WinRtApartment};
pub use paths::*;
