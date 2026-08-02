//! Screen capture: `ScreenCaptureKit` (macOS), `PipeWire` portal (Linux), WGC (Windows); GPU crop,
//! downscale, region hashing.
//!
//! # The two rules this crate exists to keep
//!
//! **Window-scoped, never full-desktop.** [`backend::CaptureBackend`] takes a `WindowTarget` and
//! returns crops. There is no method on it that yields a display, a desktop, or a whole frame, so
//! the privacy promise in dota2 §7 is a property of the type rather than of everyone's memory.
//! The player's other windows are structurally out of reach.
//!
//! **Crop first, on the GPU, then read back.** Reading back N small crops instead of a 4K frame is
//! roughly a 50× cut in `PCIe` traffic (dota2 §2.2), and it only holds if the crop happens inside
//! the backend where the frame still lives on the GPU. [`pipeline::CapturePipeline`] then hashes
//! each small buffer and drops it when it has not changed, which is what makes the scoreboard cost
//! nothing for the 95% of a match it is closed.
//!
//! # What is here and what is not
//!
//! Everything above the seam — geometry, cropping, hashing, the change gate, and the failure
//! diagnosis that turns a run of black frames into "the Screen Recording permission was never
//! granted" — is implemented and tested against [`replay::ReplayBackend`], with no platform
//! involved. That is the arrangement `dota2-state-capture-design.md` §2.2 asks for, because the
//! primary backend cannot be built on the development platform.
//!
//! No live backend is implemented yet. [`platform::default_backend`] returns one that reports
//! itself unavailable by name, and its module header records what each platform still needs and
//! why the Linux one could not be finished on the box this was written on.

pub mod backend;
pub mod frame;
pub mod geometry;
pub mod hash;
pub mod health;
#[cfg(target_os = "macos")]
pub mod macos;
pub mod pipeline;
pub mod pixels;
pub mod platform;
pub mod replay;
pub mod window_match;

pub use backend::{BackendInfo, CaptureBackend, CaptureError, CapturedRegion};
pub use frame::{Frame, FrameError};
pub use geometry::{resolve, PixelRect, ResolvedRect, WindowGeometry};
pub use hash::{format_hash, mean_luma, region_hash, ChangeGate};
pub use health::{CaptureHealth, Diagnosis};
#[cfg(target_os = "macos")]
pub use macos::ScreenCaptureKitBackend;
pub use pipeline::{Acquisition, CapturePipeline, Pass, RegionDigest};
pub use pixels::crop_bgra_to_rgba;
pub use platform::{default_backend, UnavailableBackend};
pub use replay::ReplayBackend;
pub use window_match::{select as select_window, WindowCandidate};
