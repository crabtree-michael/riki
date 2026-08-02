//! Which backend this build has, per platform — and, today, the fact that it has none.
//!
//! # Status: no live backend is implemented yet
//!
//! Every platform below resolves to [`UnavailableBackend`], which fails every call with
//! [`CaptureError::BackendUnavailable`] and a message naming what is missing. That is deliberate
//! and it is not a placeholder for something that was forgotten — it is what an honest report of
//! this build looks like, and the sidecar surfaces it as a `backend_unavailable` problem over the
//! protocol rather than pretending to capture and emitting nothing.
//!
//! The reason is worth writing down, because the next agent will hit it too. The development box
//! for this repository is headless Linux, and the design (dota2 §2.2) names `PipeWire` via the
//! `org.freedesktop.portal.ScreenCast` portal as the Linux backend. That box has:
//!
//! - no `DBUS_SESSION_BUS_ADDRESS`, so the portal cannot be reached;
//! - no `PipeWire` daemon and no compositor, so there is nothing to negotiate with;
//! - no `clang`, so `pipewire-sys` — which is `bindgen` over `libpipewire` — does not even
//!   compile.
//!
//! `ashpd` (the pure-Rust portal client) does compile there, so the *portal* half is buildable;
//! the stream half is not, and half a backend that always fails at the last step is harder to
//! finish than none. What could be verified was built instead: the seam, the crop-first pipeline,
//! the change gate and the failure diagnosis, all against `ReplayBackend`.
//!
//! # What each platform needs
//!
//! - **macOS — `ScreenCaptureKit`, the shipping backend.** An `SCContentFilter` restricted to the
//!   Dota 2 `SCWindow`, frames as `IOSurface`-backed `CVPixelBuffer`s, and the crop as a Metal
//!   pass before any readback. Requires macOS 12.3+ and the Screen Recording permission, which
//!   returns black frames rather than an error when denied — which is why
//!   `black_frames_mean_permission_denied` is true here and why `crate::health` can already tell
//!   that story on a machine with no macOS.
//! - **Linux — `PipeWire`.** `SelectSources` with `types = WINDOW` and `multiple = false`, then
//!   `Start`, then `OpenPipeWireRemote` for the fd, then a `pw_stream` consuming it. The
//!   window-only restriction is the privacy requirement (dota2 §7) and belongs in the
//!   `SelectSources` call, not in a filter applied afterwards.
//! - **Windows — WGC.** `GraphicsCaptureItem` from the Dota 2 `HWND`; frames stay on the GPU as
//!   D3D11 textures.

use riki_ipc::{CaptureRegion, WindowTarget};

use crate::backend::{BackendInfo, CaptureBackend, CaptureError, CapturedRegion};
use crate::geometry::WindowGeometry;

/// A backend that cannot capture, and says exactly why.
#[derive(Debug, Clone)]
pub struct UnavailableBackend {
    name: &'static str,
    black_frames_mean_permission_denied: bool,
    detail: String,
}

impl UnavailableBackend {
    /// Name it the way the real backend will be named, so the handshake and the logs do not change
    /// meaning on the day it lands.
    ///
    /// `detail` is owned rather than static because this type is also how a *configured* backend
    /// reports that it could not be built — an unreadable fixture directory, say. A sidecar that
    /// exits on a bad path is a crash loop; one that starts, handshakes and says why is a
    /// diagnosis the user can act on.
    #[must_use]
    pub fn new(
        name: &'static str,
        black_frames_mean_permission_denied: bool,
        detail: impl Into<String>,
    ) -> Self {
        Self {
            name,
            black_frames_mean_permission_denied,
            detail: detail.into(),
        }
    }

    fn error(&self) -> CaptureError {
        CaptureError::BackendUnavailable {
            detail: self.detail.clone(),
        }
    }
}

impl CaptureBackend for UnavailableBackend {
    fn info(&self) -> BackendInfo {
        BackendInfo {
            name: self.name,
            available: false,
            black_frames_mean_permission_denied: self.black_frames_mean_permission_denied,
        }
    }

    fn acquire(&mut self, _target: &WindowTarget) -> Result<WindowGeometry, CaptureError> {
        Err(self.error())
    }

    fn capture(&mut self, _regions: &[CaptureRegion]) -> Result<Vec<CapturedRegion>, CaptureError> {
        Err(self.error())
    }

    fn release(&mut self) {}
}

/// The backend for the platform this build targets.
///
/// Returns an [`UnavailableBackend`] on every platform today — see the module header.
#[must_use]
pub fn default_backend() -> Box<dyn CaptureBackend> {
    Box::new(native())
}

#[cfg(target_os = "macos")]
fn native() -> UnavailableBackend {
    UnavailableBackend::new(
        "screencapturekit",
        // Not a claim about this build: it is what macOS does when Screen Recording is denied, and
        // `crate::health` needs to know it whether or not there is a backend behind it yet.
        true,
        "ScreenCaptureKit capture is not implemented in this build. Run the sidecar with \
         `--backend replay --frames <dir>` to exercise the pipeline against recorded frames.",
    )
}

#[cfg(target_os = "linux")]
fn native() -> UnavailableBackend {
    UnavailableBackend::new(
        "pipewire",
        false,
        "PipeWire portal capture is not implemented in this build. Run the sidecar with \
         `--backend replay --frames <dir>` to exercise the pipeline against recorded frames.",
    )
}

#[cfg(target_os = "windows")]
fn native() -> UnavailableBackend {
    UnavailableBackend::new(
        "wgc",
        false,
        "Windows.Graphics.Capture is not implemented in this build. Run the sidecar with \
         `--backend replay --frames <dir>` to exercise the pipeline against recorded frames.",
    )
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn native() -> UnavailableBackend {
    UnavailableBackend::new(
        "none",
        false,
        "no capture backend exists for this platform.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::health::CaptureHealth;
    use riki_ipc::ProblemKind;

    fn target() -> WindowTarget {
        WindowTarget {
            process_name: "dota2".to_owned(),
            title_contains: "Dota 2".to_owned(),
        }
    }

    #[test]
    fn the_default_backend_reports_itself_as_unavailable_rather_than_capturing_nothing() {
        let backend = default_backend();
        assert!(!backend.info().available);
        // Named for the backend it will be, so the handshake does not change meaning later.
        assert!(!backend.info().name.is_empty());
    }

    #[test]
    fn an_unavailable_backend_becomes_a_named_problem_and_not_silence() {
        // The whole reason this type exists: dota2 §9's rule is to degrade loudly to the
        // developer, and a backend that returned `Ok(vec![])` would degrade silently instead.
        let mut backend = default_backend();
        let error = backend.acquire(&target()).expect_err("nothing to capture");

        let mut health = CaptureHealth::new(false);
        let diagnosis = health.observe_error(&error).expect("first sighting");
        assert_eq!(diagnosis.kind, ProblemKind::BackendUnavailable);
        assert!(!diagnosis.message.is_empty());
    }

    #[test]
    fn macos_keeps_its_black_frame_policy_even_with_no_backend_behind_it() {
        // The policy is a fact about the platform, not about whether we have implemented it. It
        // is what lets `health` tell the Screen Recording story on a machine with no macOS.
        #[cfg(target_os = "macos")]
        assert!(default_backend().info().black_frames_mean_permission_denied);
        #[cfg(not(target_os = "macos"))]
        assert!(!default_backend().info().black_frames_mean_permission_denied);
    }
}
