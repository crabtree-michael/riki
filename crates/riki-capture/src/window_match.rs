//! Choosing the game's window out of everything the platform will show us.
//!
//! This module is deliberately **not** behind a `cfg`. Picking the right window is the part of a
//! platform backend most likely to be wrong — Dota 2 owns more than one window, the launcher and
//! the game share an application name, and a title match alone will happily select a tooltip — and
//! it is also the part that needs no platform at all to decide. Reduced to
//! [`WindowCandidate`], the choice is ordinary data, so it has unit tests that run on the Linux
//! development box and will keep running there long after `ScreenCaptureKit` exists.
//!
//! The macOS backend fills these candidates from `SCShareableContent`; a future WGC backend will
//! fill them from `EnumWindows`. Neither should reimplement the rules below.

use riki_ipc::WindowTarget;

/// One window the platform is offering, reduced to what the choice actually depends on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowCandidate {
    /// The platform's handle for this window, passed back to the platform unchanged.
    ///
    /// `CGWindowID` on macOS. Opaque here on purpose: nothing in this module may depend on what a
    /// window id means, or the rules stop being portable.
    pub id: u32,
    /// The owning application's name, as the platform reports it (`"dota2"`).
    pub application: String,
    /// The owning application's bundle identifier, where the platform has one.
    ///
    /// macOS reports `"com.valvesoftware.dota2"`. This is the strongest signal available and the
    /// only one a user cannot change, which is why it is checked first.
    pub bundle_id: Option<String>,
    /// The window's title (`"Dota 2"`).
    pub title: String,
    /// Width in pixels.
    pub width: u32,
    /// Height in pixels.
    pub height: u32,
    /// Whether the platform considers the window currently on screen.
    pub on_screen: bool,
}

impl WindowCandidate {
    /// Area in pixels, used to prefer the game window over the small ones around it.
    #[must_use]
    pub const fn area(&self) -> u64 {
        (self.width as u64) * (self.height as u64)
    }

    /// Whether this window could be the target at all.
    ///
    /// Both halves have to match: an application match alone selects Dota's tiny helper windows,
    /// and a title match alone would select a browser tab called "Dota 2" — which, under a filter
    /// that captures whatever window it is given, is a privacy failure rather than a cosmetic one.
    fn matches(&self, target: &WindowTarget) -> bool {
        self.on_screen
            && self.area() > 0
            && self.matches_application(&target.process_name)
            && self.matches_title(&target.title_contains)
    }

    fn matches_application(&self, process_name: &str) -> bool {
        if process_name.is_empty() {
            return true;
        }
        let wanted = process_name.to_ascii_lowercase();

        // The bundle id is checked as a trailing component rather than a substring: matching
        // `"dota2"` anywhere in a reverse-DNS name would also accept `com.example.dota2cheat`.
        if let Some(bundle) = &self.bundle_id {
            let bundle = bundle.to_ascii_lowercase();
            if bundle == wanted || bundle.rsplit('.').next() == Some(wanted.as_str()) {
                return true;
            }
        }

        // Application names vary by platform in ways the caller should not have to know:
        // `SCRunningApplication` reports `"dota2"`, and a Windows process is `"dota2.exe"`.
        let application = self.application.to_ascii_lowercase();
        application == wanted
            || application.strip_suffix(".exe") == Some(wanted.as_str())
            || application.split_whitespace().next() == Some(wanted.as_str())
    }

    fn matches_title(&self, title_contains: &str) -> bool {
        if title_contains.is_empty() {
            return true;
        }
        self.title
            .to_ascii_lowercase()
            .contains(&title_contains.to_ascii_lowercase())
    }
}

/// Pick the window to capture, or nothing.
///
/// Returns the **largest** matching window. Dota 2 owns several — the game, and on macOS a handful
/// of zero-sized or utility windows that share its application name — and the game is reliably the
/// biggest of them. Ties are broken by the platform's own ordering, which is front-to-back on
/// macOS, so the frontmost of two equally-sized windows wins.
///
/// A target that names nothing at all matches nothing. Each field on its own may be empty — naming
/// only the process is a legitimate way to ask for "whatever window Dota has" — but a target with
/// both fields blank would otherwise select the largest window on the machine, which is the
/// full-desktop capture this crate exists to make unreachable (dota2 §7).
#[must_use]
pub fn select<'a>(
    candidates: &'a [WindowCandidate],
    target: &WindowTarget,
) -> Option<&'a WindowCandidate> {
    if target.process_name.is_empty() && target.title_contains.is_empty() {
        return None;
    }
    candidates
        .iter()
        .filter(|candidate| candidate.matches(target))
        // `max_by_key` returns the *last* maximum, which would be the backmost window; the
        // reversal makes it the frontmost.
        .rev()
        .max_by_key(|candidate| candidate.area())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target() -> WindowTarget {
        WindowTarget {
            process_name: "dota2".to_owned(),
            title_contains: "Dota 2".to_owned(),
        }
    }

    fn candidate(id: u32, application: &str, title: &str, w: u32, h: u32) -> WindowCandidate {
        WindowCandidate {
            id,
            application: application.to_owned(),
            bundle_id: None,
            title: title.to_owned(),
            width: w,
            height: h,
            on_screen: true,
        }
    }

    fn dota(id: u32, w: u32, h: u32) -> WindowCandidate {
        let mut window = candidate(id, "dota2", "Dota 2", w, h);
        window.bundle_id = Some("com.valvesoftware.dota2".to_owned());
        window
    }

    #[test]
    fn finds_the_game_window_among_the_desktop() {
        let windows = vec![
            candidate(1, "Safari", "Dota 2 build guides", 1200, 800),
            dota(2, 1920, 1080),
            candidate(3, "Terminal", "riki", 900, 600),
        ];
        let chosen = select(&windows, &target()).expect("dota is there");
        assert_eq!(chosen.id, 2);
    }

    #[test]
    fn a_browser_tab_named_after_the_game_is_not_the_game() {
        // The whole reason both halves are required. A filter is handed whatever window it is
        // given, so selecting the wrong one is a privacy failure and not a cosmetic one — this is
        // the dota2 §7 promise at its most concrete.
        let windows = vec![candidate(1, "Safari", "Dota 2 build guides", 2560, 1440)];
        assert!(select(&windows, &target()).is_none());
    }

    #[test]
    fn prefers_the_largest_of_the_applications_own_windows() {
        // Dota owns utility windows that share its application name and title prefix; the game is
        // reliably the biggest.
        let windows = vec![dota(1, 1, 1), dota(2, 1920, 1080), dota(3, 320, 240)];
        assert_eq!(select(&windows, &target()).expect("largest").id, 2);
    }

    #[test]
    fn a_window_that_is_not_on_screen_is_not_a_candidate() {
        // A minimised window is still shareable content on macOS, and capturing it yields black
        // frames — which `health` would then read as a denied Screen Recording permission.
        let mut hidden = dota(1, 1920, 1080);
        hidden.on_screen = false;
        assert!(select(&[hidden], &target()).is_none());
    }

    #[test]
    fn a_zero_sized_window_is_not_a_candidate() {
        assert!(select(&[dota(1, 0, 0)], &target()).is_none());
    }

    #[test]
    fn matches_the_bundle_id_when_the_application_name_does_not() {
        // What a localised or renamed application looks like. The bundle id is the one identifier
        // the user cannot change.
        let mut window = candidate(1, "Dota 2 Beta", "Dota 2", 1920, 1080);
        window.bundle_id = Some("com.valvesoftware.dota2".to_owned());
        assert!(select(&[window], &target()).is_some());
    }

    #[test]
    fn a_lookalike_bundle_id_is_refused() {
        // `dota2` appears in this name, so a substring test would accept it.
        let mut window = candidate(1, "helper", "Dota 2", 1920, 1080);
        window.bundle_id = Some("com.example.dota2cheat".to_owned());
        assert!(select(&[window], &target()).is_none());
    }

    #[test]
    fn matches_a_windows_style_executable_name() {
        let windows = vec![candidate(1, "dota2.exe", "Dota 2", 1920, 1080)];
        assert!(select(&windows, &target()).is_some());
    }

    #[test]
    fn matching_ignores_case_in_both_halves() {
        let windows = vec![candidate(
            1,
            "DOTA2",
            "dota 2 — ranked all pick",
            1920,
            1080,
        )];
        assert!(select(&windows, &target()).is_some());
    }

    #[test]
    fn an_empty_target_does_not_match_everything_on_the_desktop() {
        // A `WindowTarget` with both fields empty would otherwise select the largest window on the
        // machine, which is exactly the full-desktop capture this crate is built to make
        // impossible. The app always sends both fields; this is the belt to that braces.
        let empty = WindowTarget {
            process_name: String::new(),
            title_contains: String::new(),
        };
        let windows = vec![candidate(1, "Safari", "not the game", 2560, 1440)];
        assert!(select(&windows, &empty).is_none());
    }

    #[test]
    fn naming_only_the_process_is_still_a_usable_target() {
        // Half an empty target is legitimate: "whatever window Dota has" is a real request, and
        // the window is still scoped to one application.
        let by_process = WindowTarget {
            process_name: "dota2".to_owned(),
            title_contains: String::new(),
        };
        let windows = vec![
            dota(1, 1920, 1080),
            candidate(2, "Safari", "news", 2560, 1440),
        ];
        assert_eq!(select(&windows, &by_process).expect("dota").id, 1);
    }

    #[test]
    fn nothing_matches_when_the_game_is_not_running() {
        let windows = vec![candidate(1, "Safari", "news", 1200, 800)];
        assert!(select(&windows, &target()).is_none());
    }
}
