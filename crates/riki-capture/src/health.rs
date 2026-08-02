//! Turning a run of failed or blank captures into a named problem.
//!
//! This module is the reason the macOS behaviour can be correct on a machine with no macOS. The
//! two failures that matter most — the Screen Recording permission and exclusive fullscreen — are
//! both invisible from inside a single capture call:
//!
//! - **Permission denied on macOS returns black frames, not an error** (dota2 §2.2). One black
//!   frame is also what a loading screen looks like. A *run* of them, from a backend that has
//!   declared black frames meaningful, is the permission.
//! - **Exclusive fullscreen** takes the window out from under the capture API. From here that
//!   looks like `WindowNotFound` — but so does "Dota is not running". The two are told apart by
//!   whether the window was ever acquired: a window that existed and then stopped existing while
//!   we were capturing it is the fullscreen signature, and dota2 §9 wants that prompt exactly once.
//!
//! Both thresholds exist to stop a single frame becoming a user-facing prompt, and both report
//! **once per streak** rather than once per pass, because a problem repeated at the capture rate
//! is noise the app would have to de-duplicate anyway.

use riki_ipc::ProblemKind;

use crate::backend::CaptureError;

/// Consecutive all-black passes before the permission is blamed.
///
/// Four passes at the 200 ms the app configures is 800 ms, which is longer than any single frame
/// of a loading transition and short enough that a user who forgot to grant permission is told
/// before they have finished alt-tabbing back.
pub const BLACK_STREAK_THRESHOLD: u32 = 4;

/// Consecutive missing-window passes before the window is called gone.
pub const MISSING_STREAK_THRESHOLD: u32 = 3;

/// What the monitor concluded. `None` means "nothing new to say".
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Diagnosis {
    /// Which named failure this is.
    pub kind: ProblemKind,
    /// Developer-facing detail. Never contains pixels.
    pub message: String,
}

/// Watches a sequence of capture passes for the failures that only a sequence can reveal.
#[derive(Debug)]
pub struct CaptureHealth {
    black_frames_mean_permission_denied: bool,
    black_streak: u32,
    missing_streak: u32,
    ever_acquired: bool,
    reported: Option<ProblemKind>,
}

impl CaptureHealth {
    /// A monitor for a backend with the given black-frame policy (see `BackendInfo`).
    #[must_use]
    pub const fn new(black_frames_mean_permission_denied: bool) -> Self {
        Self {
            black_frames_mean_permission_denied,
            black_streak: 0,
            missing_streak: 0,
            ever_acquired: false,
            reported: None,
        }
    }

    /// Note that a window was successfully acquired.
    ///
    /// This is what later lets a missing window be read as exclusive fullscreen rather than as a
    /// game that was never started.
    pub fn acquired(&mut self) {
        self.ever_acquired = true;
        self.missing_streak = 0;
        self.reported = None;
    }

    /// Record a successful pass.
    ///
    /// `any_light` is false when every region came back black. Returns a diagnosis on the pass
    /// that crosses the threshold, and nothing on the passes after it.
    pub fn observe_pass(&mut self, any_light: bool) -> Option<Diagnosis> {
        self.missing_streak = 0;

        if any_light {
            self.black_streak = 0;
            // Recovery: whatever we reported is no longer true, so the next occurrence is news
            // again rather than a duplicate.
            self.reported = None;
            return None;
        }

        self.black_streak += 1;
        if !self.black_frames_mean_permission_denied || self.black_streak < BLACK_STREAK_THRESHOLD {
            return None;
        }
        self.report(
            ProblemKind::PermissionDenied,
            format!(
                "every captured region has been black for {} consecutive passes, which on this \
                 platform means screen capture was never permitted rather than that the screen is \
                 dark",
                self.black_streak
            ),
        )
    }

    /// Record a failed pass.
    pub fn observe_error(&mut self, error: &CaptureError) -> Option<Diagnosis> {
        match error {
            CaptureError::WindowNotFound => {
                self.black_streak = 0;
                self.missing_streak += 1;
                if self.missing_streak < MISSING_STREAK_THRESHOLD {
                    return None;
                }
                if self.ever_acquired {
                    self.report(
                        ProblemKind::ExclusiveFullscreen,
                        "the window was being captured and then stopped being visible to the \
                         capture API, which is what exclusive fullscreen looks like"
                            .to_owned(),
                    )
                } else {
                    self.report(
                        ProblemKind::WindowNotFound,
                        "no window has matched the capture target since capture started".to_owned(),
                    )
                }
            }

            // The rest are unambiguous: the platform has told us what is wrong, and there is no
            // streak to accumulate before believing it.
            CaptureError::PermissionDenied => {
                self.report(ProblemKind::PermissionDenied, error.summary())
            }
            CaptureError::ExclusiveFullscreen => {
                self.report(ProblemKind::ExclusiveFullscreen, error.summary())
            }
            CaptureError::BackendUnavailable { .. } => {
                self.report(ProblemKind::BackendUnavailable, error.summary())
            }
            CaptureError::Failed { .. } => self.report(ProblemKind::CaptureFailed, error.summary()),
        }
    }

    /// Report a kind unless it is the one already outstanding.
    fn report(&mut self, kind: ProblemKind, message: String) -> Option<Diagnosis> {
        if self.reported == Some(kind) {
            return None;
        }
        self.reported = Some(kind);
        Some(Diagnosis { kind, message })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A backend that behaves like `ScreenCaptureKit`.
    fn macos() -> CaptureHealth {
        CaptureHealth::new(true)
    }

    /// A backend where black really does mean black.
    fn other() -> CaptureHealth {
        CaptureHealth::new(false)
    }

    #[test]
    fn a_run_of_black_frames_on_macos_is_the_permission_and_not_a_cv_failure() {
        let mut health = macos();
        for _ in 1..BLACK_STREAK_THRESHOLD {
            assert_eq!(health.observe_pass(false), None, "reported too early");
        }
        let diagnosis = health.observe_pass(false).expect("threshold reached");
        assert_eq!(diagnosis.kind, ProblemKind::PermissionDenied);
    }

    #[test]
    fn the_permission_is_reported_once_per_streak_and_not_once_per_frame() {
        let mut health = macos();
        for _ in 0..BLACK_STREAK_THRESHOLD {
            let _ = health.observe_pass(false);
        }
        for _ in 0..20 {
            assert_eq!(health.observe_pass(false), None, "duplicate report");
        }
    }

    #[test]
    fn a_light_frame_clears_the_streak_so_a_later_failure_is_news_again() {
        let mut health = macos();
        for _ in 0..BLACK_STREAK_THRESHOLD {
            let _ = health.observe_pass(false);
        }
        assert_eq!(health.observe_pass(true), None);

        for _ in 1..BLACK_STREAK_THRESHOLD {
            assert_eq!(health.observe_pass(false), None);
        }
        assert!(
            health.observe_pass(false).is_some(),
            "recovery was not reset"
        );
    }

    #[test]
    fn black_frames_are_not_a_permission_problem_where_the_platform_does_not_say_so() {
        // Nothing on Linux or Windows returns black for a denied capture; blaming the permission
        // there would send the user to a settings pane that does not exist.
        let mut health = other();
        for _ in 0..BLACK_STREAK_THRESHOLD * 3 {
            assert_eq!(health.observe_pass(false), None);
        }
    }

    #[test]
    fn a_window_that_never_existed_is_not_blamed_on_fullscreen() {
        let mut health = macos();
        for _ in 1..MISSING_STREAK_THRESHOLD {
            assert_eq!(health.observe_error(&CaptureError::WindowNotFound), None);
        }
        let diagnosis = health
            .observe_error(&CaptureError::WindowNotFound)
            .expect("threshold reached");
        assert_eq!(diagnosis.kind, ProblemKind::WindowNotFound);
    }

    #[test]
    fn a_window_that_vanished_mid_capture_is_read_as_exclusive_fullscreen() {
        let mut health = macos();
        health.acquired();
        for _ in 1..MISSING_STREAK_THRESHOLD {
            assert_eq!(health.observe_error(&CaptureError::WindowNotFound), None);
        }
        let diagnosis = health
            .observe_error(&CaptureError::WindowNotFound)
            .expect("threshold reached");
        assert_eq!(diagnosis.kind, ProblemKind::ExclusiveFullscreen);
    }

    #[test]
    fn an_explicit_platform_error_is_believed_immediately() {
        let mut health = macos();
        let diagnosis = health
            .observe_error(&CaptureError::PermissionDenied)
            .expect("no streak needed");
        assert_eq!(diagnosis.kind, ProblemKind::PermissionDenied);
    }

    #[test]
    fn an_unavailable_backend_is_reported_once_rather_than_at_the_capture_rate() {
        let mut health = other();
        let error = CaptureError::BackendUnavailable {
            detail: "no PipeWire portal in this build".to_owned(),
        };
        assert!(health.observe_error(&error).is_some());
        for _ in 0..10 {
            assert_eq!(health.observe_error(&error), None);
        }
    }
}
