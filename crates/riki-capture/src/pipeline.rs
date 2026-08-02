//! Crop → hash → gate, and the diagnosis that comes with it.
//!
//! The ordering here is the performance story from dota2 §2.2, and it is the reason this is a
//! type rather than a loop in the binary: the crop happens inside the backend while the frame is
//! still on the GPU, the hash happens on the small buffer that comes back, and recognition — when
//! there is any — happens only on the regions whose hash moved.
//!
//! Nothing here talks to the protocol. A [`RegionDigest`] is a fact about pixels; turning it into
//! a `CvFact` with a detector id and a timestamp is `riki-vision`'s job, because that is where the
//! clock lives and where the process boundary is.

use riki_ipc::{CaptureRegion, RegionId, WindowTarget};

use crate::backend::CaptureBackend;
use crate::geometry::{PixelRect, WindowGeometry};
use crate::hash::{mean_luma, region_hash, ChangeGate};
use crate::health::{CaptureHealth, Diagnosis};

/// What one region looked like on one pass.
#[derive(Debug, Clone, PartialEq)]
pub struct RegionDigest {
    /// Which region.
    pub id: RegionId,
    /// Where it was cropped from, after clamping.
    pub rect: PixelRect,
    /// Fraction of the requested rectangle actually captured, 0..1.
    pub coverage: f32,
    /// 64-bit region hash.
    pub hash: u64,
    /// Mean luminance, 0..1.
    pub mean_luma: f32,
    /// False when the hash matched the previous pass for this region.
    pub changed: bool,
}

/// The result of one capture pass.
#[derive(Debug, Clone, PartialEq)]
pub struct Pass {
    /// One entry per region that was actually captured. Empty when the pass failed.
    pub digests: Vec<RegionDigest>,
    /// A newly-diagnosed problem, at most once per streak. See [`crate::health`].
    pub diagnosis: Option<Diagnosis>,
    /// Whether the backend returned at all.
    ///
    /// Distinct from `digests.is_empty()`, and the distinction matters to the caller: a pass whose
    /// regions all fell outside the window succeeded and should not cost the session its window,
    /// while a pass that failed means the session has to be re-acquired before the next one.
    pub captured: bool,
}

/// The result of trying to start a session.
#[derive(Debug, Clone, PartialEq)]
pub struct Acquisition {
    /// The window's size, when one was found.
    pub geometry: Option<WindowGeometry>,
    /// Why not, when one was not.
    pub diagnosis: Option<Diagnosis>,
}

/// A backend, plus the two pieces of state that only make sense across passes.
#[derive(Debug)]
pub struct CapturePipeline<B: CaptureBackend> {
    backend: B,
    gate: ChangeGate,
    health: CaptureHealth,
}

impl<B: CaptureBackend> CapturePipeline<B> {
    /// Wrap a backend. The black-frame policy comes from the backend rather than from the caller.
    pub fn new(backend: B) -> Self {
        let health = CaptureHealth::new(backend.info().black_frames_mean_permission_denied);
        Self {
            backend,
            gate: ChangeGate::new(),
            health,
        }
    }

    /// The wrapped backend, for its `info()`.
    pub const fn backend(&self) -> &B {
        &self.backend
    }

    /// Find the window and start capturing it.
    pub fn acquire(&mut self, target: &WindowTarget) -> Acquisition {
        // A new session invalidates every remembered hash: the same region of a window that has
        // changed resolution is not the same pixels, and a stale hash would suppress the first
        // real change after a reacquire.
        self.gate.reset();
        match self.backend.acquire(target) {
            Ok(geometry) => {
                self.health.acquired();
                Acquisition {
                    geometry: Some(geometry),
                    diagnosis: None,
                }
            }
            Err(error) => Acquisition {
                geometry: None,
                diagnosis: self.health.observe_error(&error),
            },
        }
    }

    /// Run one pass over the configured regions.
    pub fn pass(&mut self, regions: &[CaptureRegion]) -> Pass {
        let captured = match self.backend.capture(regions) {
            Ok(captured) => captured,
            Err(error) => {
                return Pass {
                    digests: Vec::new(),
                    diagnosis: self.health.observe_error(&error),
                    captured: false,
                }
            }
        };

        let mut digests = Vec::with_capacity(captured.len());
        let mut any_light = false;
        for region in captured {
            let hash = region_hash(&region.pixels);
            let luma = mean_luma(&region.pixels);
            if luma > 0.0 {
                any_light = true;
            }
            digests.push(RegionDigest {
                id: region.id,
                rect: region.rect,
                coverage: region.coverage,
                hash,
                mean_luma: luma,
                changed: self.gate.observe(region.id, hash),
            });
        }

        // A pass that captured nothing at all is not evidence of a black screen — there was no
        // screen to be black. Feeding it to the black-frame streak would eventually blame the
        // macOS permission for a region list that fell outside the window.
        let diagnosis = if digests.is_empty() {
            None
        } else {
            self.health.observe_pass(any_light)
        };

        Pass {
            digests,
            diagnosis,
            captured: true,
        }
    }

    /// Stop capturing.
    pub fn release(&mut self) {
        self.backend.release();
        self.gate.reset();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame::Frame;
    use crate::replay::ReplayBackend;
    use riki_ipc::{NormalizedRect, ProblemKind};

    fn solid(value: u8) -> Frame {
        Frame::new(8, 8, vec![value; 8 * 8 * 4]).expect("well-formed")
    }

    fn target() -> WindowTarget {
        WindowTarget {
            process_name: "dota2".to_owned(),
            title_contains: "Dota 2".to_owned(),
        }
    }

    fn whole(id: RegionId) -> CaptureRegion {
        CaptureRegion {
            id,
            rect: NormalizedRect {
                x: 0.0,
                y: 0.0,
                w: 1.0,
                h: 1.0,
            },
        }
    }

    #[test]
    fn the_first_pass_is_a_change_and_an_identical_second_pass_is_not() {
        // This is the whole point of the gate: the scoreboard costs nothing for the 95% of a
        // match it is closed.
        let mut pipeline = CapturePipeline::new(ReplayBackend::new(vec![solid(90), solid(90)]));
        pipeline.acquire(&target());

        let first = pipeline.pass(&[whole(RegionId::Scoreboard)]);
        let second = pipeline.pass(&[whole(RegionId::Scoreboard)]);

        assert!(first.digests[0].changed);
        assert!(!second.digests[0].changed);
        assert_eq!(first.digests[0].hash, second.digests[0].hash);
    }

    #[test]
    fn a_changed_frame_is_reported_as_changed() {
        let mut pipeline = CapturePipeline::new(ReplayBackend::new(vec![solid(90), solid(91)]));
        pipeline.acquire(&target());

        let first = pipeline.pass(&[whole(RegionId::Minimap)]);
        let second = pipeline.pass(&[whole(RegionId::Minimap)]);

        assert!(second.digests[0].changed);
        assert_ne!(first.digests[0].hash, second.digests[0].hash);
    }

    #[test]
    fn a_digest_carries_the_coverage_the_geometry_resolved() {
        let mut pipeline = CapturePipeline::new(ReplayBackend::new(vec![solid(90)]));
        pipeline.acquire(&target());

        let pass = pipeline.pass(&[CaptureRegion {
            id: RegionId::TopBar,
            // Half of this falls off the right-hand edge.
            rect: NormalizedRect {
                x: 0.75,
                y: 0.0,
                w: 0.5,
                h: 0.25,
            },
        }]);

        assert!(
            (pass.digests[0].coverage - 0.5).abs() < 0.01,
            "coverage was {}",
            pass.digests[0].coverage
        );
    }

    #[test]
    fn reacquiring_forgets_the_previous_hashes() {
        // A window that changed resolution has the same region id and entirely different pixels;
        // a remembered hash would suppress the first real change after the reacquire.
        let mut pipeline = CapturePipeline::new(ReplayBackend::new(vec![solid(90)]));
        pipeline.acquire(&target());
        let first = pipeline.pass(&[whole(RegionId::Minimap)]);
        assert!(first.digests[0].changed);

        pipeline.acquire(&target());
        let after = pipeline.pass(&[whole(RegionId::Minimap)]);
        assert!(after.digests[0].changed);
    }

    #[test]
    fn a_failed_pass_yields_no_digests_and_eventually_a_diagnosis() {
        let mut pipeline = CapturePipeline::new(ReplayBackend::new(Vec::new()));
        let acquisition = pipeline.acquire(&target());
        assert!(acquisition.geometry.is_none());

        let mut diagnoses = Vec::new();
        for _ in 0..crate::health::MISSING_STREAK_THRESHOLD + 2 {
            let pass = pipeline.pass(&[whole(RegionId::Minimap)]);
            assert!(pass.digests.is_empty());
            if let Some(diagnosis) = pass.diagnosis {
                diagnoses.push(diagnosis);
            }
        }

        // Never acquired, so this is a missing window rather than exclusive fullscreen — and it is
        // said once, not once per pass.
        assert_eq!(diagnoses.len(), 1, "{diagnoses:?}");
        assert_eq!(diagnoses[0].kind, ProblemKind::WindowNotFound);
    }

    #[test]
    fn regions_that_all_fall_outside_the_window_are_not_mistaken_for_a_black_screen() {
        let mut pipeline = CapturePipeline::new(ReplayBackend::new(vec![
            solid(90),
            solid(90),
            solid(90),
            solid(90),
            solid(90),
            solid(90),
        ]));
        pipeline.acquire(&target());

        let offscreen = CaptureRegion {
            id: RegionId::Chat,
            rect: NormalizedRect {
                x: 1.0,
                y: 1.0,
                w: 0.1,
                h: 0.1,
            },
        };
        for _ in 0..6 {
            let pass = pipeline.pass(std::slice::from_ref(&offscreen));
            assert!(pass.digests.is_empty());
            assert_eq!(pass.diagnosis, None, "there was no screen to be black");
        }
    }
}
