//! The backend that keeps everything above the seam testable with no platform at all.
//!
//! `dota2-state-capture-design.md` §2.2 states the constraint plainly: the primary backend
//! (`ScreenCaptureKit`) cannot be built or run on the development platform, so everything above
//! the seam has to be exercisable against recorded frames with no backend. This is that backend.
//!
//! It is not only a test double. `riki-vision --backend replay --frames <dir>` runs the real
//! protocol loop, the real crop, the real hash and the real change gate over fixture frames, which
//! is what makes the capture-to-protocol path something an agent can run and watch rather than
//! something that only works on hardware nobody in the loop owns.

use riki_ipc::{CaptureRegion, WindowTarget};

use crate::backend::{BackendInfo, CaptureBackend, CaptureError, CapturedRegion};
use crate::frame::Frame;
use crate::geometry::{resolve, WindowGeometry};

/// Serves frames in order, looping, cropping on the CPU.
#[derive(Debug)]
pub struct ReplayBackend {
    frames: Vec<Frame>,
    next: usize,
    acquired: bool,
}

impl ReplayBackend {
    /// A backend over the given frames. An empty list is allowed and fails at `acquire`, which is
    /// where an empty fixture directory should be reported rather than at construction.
    #[must_use]
    pub const fn new(frames: Vec<Frame>) -> Self {
        Self {
            frames,
            next: 0,
            acquired: false,
        }
    }

    /// How many frames are in the loop.
    #[must_use]
    pub fn len(&self) -> usize {
        self.frames.len()
    }

    /// True when there is nothing to replay.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.frames.is_empty()
    }

    fn advance(&mut self) -> Option<&Frame> {
        if self.frames.is_empty() {
            return None;
        }
        let index = self.next % self.frames.len();
        self.next = self.next.wrapping_add(1);
        self.frames.get(index)
    }
}

impl CaptureBackend for ReplayBackend {
    fn info(&self) -> BackendInfo {
        BackendInfo {
            name: "replay",
            available: true,
            // A recorded frame that is black is black. Reading it as a permission failure would
            // make every dark fixture look like an ungranted macOS prompt.
            black_frames_mean_permission_denied: false,
        }
    }

    fn acquire(&mut self, _target: &WindowTarget) -> Result<WindowGeometry, CaptureError> {
        // The target is deliberately ignored and deliberately still required: replay is a stand-in
        // for a window, and a caller that forgets to name one has a bug that would only appear on
        // a machine with a real backend.
        let first = self.frames.first().ok_or(CaptureError::WindowNotFound)?;
        self.acquired = true;
        Ok(first.geometry())
    }

    fn capture(&mut self, regions: &[CaptureRegion]) -> Result<Vec<CapturedRegion>, CaptureError> {
        if !self.acquired {
            return Err(CaptureError::WindowNotFound);
        }
        let Some(frame) = self.advance().cloned() else {
            return Err(CaptureError::WindowNotFound);
        };
        let geometry = frame.geometry();

        let mut out = Vec::with_capacity(regions.len());
        for region in regions {
            // A region that falls entirely outside the window is dropped rather than reported
            // empty — see `geometry::resolve`.
            let Some(resolved) = resolve(&region.rect, geometry) else {
                continue;
            };
            out.push(CapturedRegion {
                id: region.id,
                rect: resolved.rect,
                coverage: resolved.coverage,
                pixels: frame.crop(resolved.rect),
            });
        }
        Ok(out)
    }

    fn release(&mut self) {
        self.acquired = false;
        self.next = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use riki_ipc::{NormalizedRect, RegionId};

    fn solid(width: u32, height: u32, value: u8) -> Frame {
        Frame::new(
            width,
            height,
            vec![value; (width as usize) * (height as usize) * 4],
        )
        .expect("well-formed")
    }

    fn target() -> WindowTarget {
        WindowTarget {
            process_name: "dota2".to_owned(),
            title_contains: "Dota 2".to_owned(),
        }
    }

    fn minimap() -> CaptureRegion {
        CaptureRegion {
            id: RegionId::Minimap,
            rect: NormalizedRect {
                x: 0.0,
                y: 0.5,
                w: 0.5,
                h: 0.5,
            },
        }
    }

    #[test]
    fn will_not_capture_before_a_window_has_been_acquired() {
        // The ordering is the contract every backend shares: no session, no pixels.
        let mut backend = ReplayBackend::new(vec![solid(4, 4, 1)]);
        assert_eq!(
            backend.capture(&[minimap()]),
            Err(CaptureError::WindowNotFound)
        );
    }

    #[test]
    fn an_empty_fixture_directory_fails_at_acquire_rather_than_silently_capturing_nothing() {
        let mut backend = ReplayBackend::new(Vec::new());
        assert_eq!(
            backend.acquire(&target()),
            Err(CaptureError::WindowNotFound)
        );
    }

    #[test]
    fn crops_each_region_out_of_the_frame() {
        let mut backend = ReplayBackend::new(vec![solid(8, 8, 200)]);
        let geometry = backend.acquire(&target()).expect("one frame");
        assert_eq!(geometry, WindowGeometry::new(8, 8));

        let captured = backend.capture(&[minimap()]).expect("acquired");
        assert_eq!(captured.len(), 1);
        assert_eq!(captured[0].id, RegionId::Minimap);
        assert_eq!(captured[0].rect.w, 4);
        assert_eq!(captured[0].rect.h, 4);
        assert_eq!(captured[0].pixels.len(), 4 * 4 * 4);
    }

    #[test]
    fn advances_one_frame_per_pass_and_loops() {
        let mut backend = ReplayBackend::new(vec![solid(4, 4, 10), solid(4, 4, 20)]);
        backend.acquire(&target()).expect("frames");

        let whole = CaptureRegion {
            id: RegionId::SelfHud,
            rect: NormalizedRect {
                x: 0.0,
                y: 0.0,
                w: 1.0,
                h: 1.0,
            },
        };
        let first = backend
            .capture(std::slice::from_ref(&whole))
            .expect("pass 1");
        let second = backend
            .capture(std::slice::from_ref(&whole))
            .expect("pass 2");
        let third = backend
            .capture(std::slice::from_ref(&whole))
            .expect("pass 3 loops");

        assert_eq!(first[0].pixels[0], 10);
        assert_eq!(second[0].pixels[0], 20);
        assert_eq!(third[0].pixels[0], 10);
    }

    #[test]
    fn a_region_outside_the_window_is_omitted_rather_than_reported_empty() {
        let mut backend = ReplayBackend::new(vec![solid(4, 4, 1)]);
        backend.acquire(&target()).expect("frames");

        let offscreen = CaptureRegion {
            id: RegionId::Chat,
            rect: NormalizedRect {
                x: 1.0,
                y: 1.0,
                w: 0.1,
                h: 0.1,
            },
        };
        assert!(backend.capture(&[offscreen]).expect("pass").is_empty());
    }

    #[test]
    fn release_ends_the_session() {
        let mut backend = ReplayBackend::new(vec![solid(4, 4, 1)]);
        backend.acquire(&target()).expect("frames");
        backend.release();
        assert_eq!(
            backend.capture(&[minimap()]),
            Err(CaptureError::WindowNotFound)
        );
    }
}
