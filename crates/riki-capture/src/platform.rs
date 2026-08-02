//! Which backend this build has, per platform.
//!
//! # Status: macOS captures; Linux and Windows do not
//!
//! **macOS** resolves to [`crate::macos::ScreenCaptureKitBackend`], which is real
//! ([ADR-0033](../../../docs/adr/0033-screencapturekit-is-the-shipping-backend.md)). It has never
//! run — this repository's development box is headless Linux — so it is *compile-verified* for
//! `aarch64-apple-darwin` and nothing stronger. What still needs a Mac is listed in that ADR.
//!
//! **Linux and Windows** resolve to [`UnavailableBackend`], which fails every call with
//! [`CaptureError::BackendUnavailable`] and a message naming what is missing. That is deliberate
//! and it is not a placeholder for something that was forgotten — it is what an honest report of
//! this build looks like, and the sidecar surfaces it as a `backend_unavailable` problem over the
//! protocol rather than pretending to capture and emitting nothing.
//!
//! The Linux reason is worth writing down, because the next agent will hit it too. The design
//! (dota2 §2.2) names `PipeWire` via the `org.freedesktop.portal.ScreenCast` portal, and the box
//! this was written on has:
//!
//! - no `DBUS_SESSION_BUS_ADDRESS`, so the portal cannot be reached;
//! - no `PipeWire` daemon and no compositor, so there is nothing to negotiate with;
//! - no `clang`, so `pipewire-sys` — which is `bindgen` over `libpipewire` — does not even
//!   compile.
//!
//! `ashpd` (the pure-Rust portal client) does compile there, so the *portal* half is buildable;
//! the stream half is not, and half a backend that always fails at the last step is harder to
//! finish than none.
//!
//! # What each platform still needs
//!
//! - **Linux — `PipeWire`.** `SelectSources` with `types = WINDOW` and `multiple = false`, then
//!   `Start`, then `OpenPipeWireRemote` for the fd, then a `pw_stream` consuming it. The
//!   window-only restriction is the privacy requirement (dota2 §7) and belongs in the
//!   `SelectSources` call, not in a filter applied afterwards.
//! - **Windows — WGC.** `GraphicsCaptureItem` from the Dota 2 `HWND`; frames stay on the GPU as
//!   D3D11 textures. [`crate::window_match`] and [`crate::pixels`] are platform-neutral and are
//!   meant to be reused there rather than reimplemented.

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
/// macOS returns the real [`crate::macos::ScreenCaptureKitBackend`]. Linux and Windows return an
/// [`UnavailableBackend`] that names what is missing — see the module header.
#[must_use]
pub fn default_backend() -> Box<dyn CaptureBackend> {
    native()
}

/// The rate the backend assumes until `capture.configure` tells it otherwise.
///
/// Only a starting value: [`CaptureBackend::set_frame_interval`] is called with the configured
/// interval before the window is acquired, which is before any stream exists.
#[cfg(target_os = "macos")]
const ASSUMED_INTERVAL: std::time::Duration = std::time::Duration::from_millis(200);

#[cfg(target_os = "macos")]
fn native() -> Box<dyn CaptureBackend> {
    Box::new(crate::macos::ScreenCaptureKitBackend::new(ASSUMED_INTERVAL))
}

#[cfg(not(target_os = "macos"))]
fn native() -> Box<dyn CaptureBackend> {
    Box::new(unavailable())
}

#[cfg(target_os = "linux")]
fn unavailable() -> UnavailableBackend {
    UnavailableBackend::new(
        "pipewire",
        false,
        "PipeWire portal capture is not implemented in this build. Run the sidecar with \
         `--backend replay --frames <dir>` to exercise the pipeline against recorded frames.",
    )
}

#[cfg(target_os = "windows")]
fn unavailable() -> UnavailableBackend {
    UnavailableBackend::new(
        "wgc",
        false,
        "Windows.Graphics.Capture is not implemented in this build. Run the sidecar with \
         `--backend replay --frames <dir>` to exercise the pipeline against recorded frames.",
    )
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn unavailable() -> UnavailableBackend {
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
    fn the_default_backend_names_itself_for_the_handshake() {
        // The name is reported in the handshake whether or not the backend works, so the app can
        // say "vision is unavailable on this build" before asking for a frame.
        let backend = default_backend();
        assert!(!backend.info().name.is_empty());

        #[cfg(target_os = "macos")]
        {
            assert!(backend.info().available);
            assert_eq!(backend.info().name, "screencapturekit");
        }
        #[cfg(not(target_os = "macos"))]
        assert!(!backend.info().available);
    }

    #[test]
    fn an_unavailable_backend_becomes_a_named_problem_and_not_silence() {
        // The whole reason this type exists: dota2 §9's rule is to degrade loudly to the
        // developer, and a backend that returned `Ok(vec![])` would degrade silently instead.
        // Built directly rather than through `default_backend`, which on macOS now captures.
        let mut backend = UnavailableBackend::new("pipewire", false, "no portal in this build");
        let error = backend.acquire(&target()).expect_err("nothing to capture");

        let mut health = CaptureHealth::new(false);
        let diagnosis = health.observe_error(&error).expect("first sighting");
        assert_eq!(diagnosis.kind, ProblemKind::BackendUnavailable);
        assert!(!diagnosis.message.is_empty());
    }

    #[test]
    fn only_macos_reads_black_frames_as_a_denied_permission() {
        // The policy is a fact about the platform rather than about the backend, which is what
        // lets `health` tell the Screen Recording story on a machine with no macOS. Blaming the
        // permission on Linux or Windows would send the user to a settings pane that does not
        // exist there.
        #[cfg(target_os = "macos")]
        assert!(default_backend().info().black_frames_mean_permission_denied);
        #[cfg(not(target_os = "macos"))]
        assert!(!default_backend().info().black_frames_mean_permission_denied);
    }
}
