//! The seam. Frames in, cropped regions out — and nothing platform-specific above it.
//!
//! The `vision-sidecar` skill puts two requirements on this trait, and both are visible in its
//! shape rather than in its documentation:
//!
//! - **There is no method that returns a screen, a display, or a whole frame.** A backend is
//!   handed a [`WindowTarget`] and a region list and returns crops. dota2 §7 makes window-scoped
//!   capture the privacy story; a trait that cannot express "give me the desktop" keeps that
//!   promise without anyone having to remember it.
//! - **Cropping belongs to the backend, not to its caller.** On `ScreenCaptureKit` the frame is an
//!   `IOSurface` and the crop is a Metal pass; on WGC it is a D3D11 texture. Reading back N small
//!   crops instead of a 4K frame is roughly a 50× cut in `PCIe` traffic (dota2 §2.2), and that
//!   ordering only holds if the crop happens before the readback — which is to say, inside the
//!   backend, where the frame still lives on the GPU.

use riki_ipc::{CaptureRegion, RegionId, WindowTarget};

use crate::geometry::{PixelRect, WindowGeometry};

/// What a backend is and what its silence means.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BackendInfo {
    /// Wire name, reported in the handshake: `"screencapturekit"`, `"pipewire"`, `"replay"`.
    pub name: &'static str,
    /// False when this build cannot capture at all — see [`CaptureError::BackendUnavailable`].
    pub available: bool,
    /// Whether an all-black capture means "permission denied" on this platform.
    ///
    /// macOS returns black frames rather than an error when the Screen Recording permission has
    /// not been granted (dota2 §2.2). That is indistinguishable from a CV failure from the inside,
    /// so the platform declares the meaning here and `crate::health` acts on it. Keeping the
    /// *policy* above the seam is what lets the macOS behaviour be tested on a machine that has
    /// no macOS.
    pub black_frames_mean_permission_denied: bool,
}

/// Why a capture pass produced nothing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CaptureError {
    /// No window matched the target. Also what a minimised window looks like.
    WindowNotFound,
    /// The platform told us, in as many words, that we may not capture.
    PermissionDenied,
    /// The window exists but is not capturable, which is what exclusive fullscreen looks like.
    ExclusiveFullscreen,
    /// This build has no working backend for this platform.
    BackendUnavailable {
        /// What is missing, and what would have to be built or installed.
        detail: String,
    },
    /// Anything else, including a transient failure worth retrying.
    Failed {
        /// Backend-specific detail. Never contains pixels.
        detail: String,
    },
}

impl CaptureError {
    /// A short, stable phrase for a problem message.
    #[must_use]
    pub fn summary(&self) -> String {
        match self {
            Self::WindowNotFound => "no window matched the capture target".to_owned(),
            Self::PermissionDenied => "the platform refused screen capture".to_owned(),
            Self::ExclusiveFullscreen => {
                "the window is present but not capturable (exclusive fullscreen)".to_owned()
            }
            Self::BackendUnavailable { detail } | Self::Failed { detail } => detail.clone(),
        }
    }
}

/// One cropped region, as it comes back from the GPU.
#[derive(Debug, Clone, PartialEq)]
pub struct CapturedRegion {
    /// Which region this is.
    pub id: RegionId,
    /// Where it was taken from, after clamping to the window.
    pub rect: PixelRect,
    /// How much of the requested rectangle this covers, 0..1. See `geometry::ResolvedRect`.
    pub coverage: f32,
    /// RGBA8, `rect.w * rect.h * 4` bytes.
    pub pixels: Vec<u8>,
}

impl CapturedRegion {
    /// Number of pixels, for the hash and the mean.
    #[must_use]
    pub const fn pixel_count(&self) -> usize {
        (self.rect.w as usize) * (self.rect.h as usize)
    }
}

/// A source of window-scoped cropped regions.
///
/// Implementations are not required to be cheap to construct, but `capture` runs on a timer and is
/// on the budget: ≤3% of one core, no measurable frame-time delta.
pub trait CaptureBackend {
    /// What this backend is. Constant for the life of the process.
    fn info(&self) -> BackendInfo;

    /// Find the window and start a capture session on it.
    ///
    /// # Errors
    ///
    /// [`CaptureError::WindowNotFound`] when nothing matches, [`CaptureError::PermissionDenied`]
    /// when the platform says so outright, [`CaptureError::BackendUnavailable`] when this build
    /// cannot capture on this platform at all.
    fn acquire(&mut self, target: &WindowTarget) -> Result<WindowGeometry, CaptureError>;

    /// Crop and read back one pass.
    ///
    /// # Errors
    ///
    /// Any [`CaptureError`]. A backend that has lost its window should say
    /// [`CaptureError::WindowNotFound`] rather than returning an empty vector: "nothing changed"
    /// and "the window is gone" are different facts and only one of them is a problem.
    fn capture(&mut self, regions: &[CaptureRegion]) -> Result<Vec<CapturedRegion>, CaptureError>;

    /// Tear the session down. Called on `capture.stop` and before exit.
    fn release(&mut self);
}

/// Forwarding impl so a backend chosen at run time is still a `CaptureBackend`.
///
/// `riki-vision` picks between the platform backend and the replay backend from a command-line
/// flag, so what it holds is a `Box<dyn CaptureBackend>`. Without this, `CapturePipeline<B>` would
/// have to be generic over a trait object it cannot name, or the binary would need a second
/// dispatch layer of its own.
impl<T: CaptureBackend + ?Sized> CaptureBackend for Box<T> {
    fn info(&self) -> BackendInfo {
        (**self).info()
    }

    fn acquire(&mut self, target: &WindowTarget) -> Result<WindowGeometry, CaptureError> {
        (**self).acquire(target)
    }

    fn capture(&mut self, regions: &[CaptureRegion]) -> Result<Vec<CapturedRegion>, CaptureError> {
        (**self).capture(regions)
    }

    fn release(&mut self) {
        (**self).release();
    }
}
