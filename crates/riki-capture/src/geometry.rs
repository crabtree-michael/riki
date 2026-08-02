//! Normalised rectangles against a real window, and what happens when they do not fit.

use riki_ipc::NormalizedRect;

/// The size of the captured window, in pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowGeometry {
    /// Window width in pixels.
    pub width: u32,
    /// Window height in pixels.
    pub height: u32,
}

impl WindowGeometry {
    /// A window of this size.
    #[must_use]
    pub const fn new(width: u32, height: u32) -> Self {
        Self { width, height }
    }
}

/// A crop rectangle in window pixels, guaranteed to lie inside the window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PixelRect {
    /// Left edge, in window pixels.
    pub x: u32,
    /// Top edge, in window pixels.
    pub y: u32,
    /// Width in pixels. Always at least 1.
    pub w: u32,
    /// Height in pixels. Always at least 1.
    pub h: u32,
}

/// A resolved crop, and how much of what was asked for it actually covers.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ResolvedRect {
    /// The clamped rectangle.
    pub rect: PixelRect,
    /// Area of `rect` over the area originally requested, 0..1.
    ///
    /// This becomes the confidence on the fact that comes out of the region, which is the point:
    /// a minimap crop that fell half outside the window is a weaker claim than one that did not,
    /// and dota2 §4 rule 3 says the difference has to survive to the agent rather than being
    /// rounded to "fine". The common cause is a stale calibration after a resolution change.
    pub coverage: f32,
}

/// Resolve a normalised rectangle against a window.
///
/// Returns `None` when nothing of the rectangle lands inside the window — a region that cannot be
/// captured at all is absent rather than present with a coverage of zero, because a zero-pixel
/// crop has no hash and no luminance and would be a fact about nothing.
#[must_use]
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]
pub fn resolve(rect: &NormalizedRect, geometry: WindowGeometry) -> Option<ResolvedRect> {
    if geometry.width == 0 || geometry.height == 0 {
        return None;
    }

    let width = f64::from(geometry.width);
    let height = f64::from(geometry.height);

    // Requested edges in pixels, before clamping. `w`/`h` are > 0 by schema, but `x + w` may run
    // off the right-hand edge and `x` itself may be anywhere in 0..1.
    let left = rect.x * width;
    let top = rect.y * height;
    let right = (rect.x + rect.w) * width;
    let bottom = (rect.y + rect.h) * height;

    let requested_area = (right - left) * (bottom - top);
    if requested_area <= 0.0 {
        return None;
    }

    let clamped_left = left.max(0.0).min(width);
    let clamped_top = top.max(0.0).min(height);
    let clamped_right = right.max(0.0).min(width);
    let clamped_bottom = bottom.max(0.0).min(height);

    // Round outward so a region never loses a pixel it was entitled to, then re-clamp.
    let x = clamped_left.floor() as u32;
    let y = clamped_top.floor() as u32;
    let w = (clamped_right.ceil() as u32)
        .saturating_sub(x)
        .min(geometry.width - x);
    let h = (clamped_bottom.ceil() as u32)
        .saturating_sub(y)
        .min(geometry.height - y);

    if w == 0 || h == 0 {
        return None;
    }

    // Coverage is measured on the *unrounded* clamp, so a rectangle fully inside the window is
    // exactly 1.0 rather than 1.02 because of outward rounding.
    let covered = (clamped_right - clamped_left).max(0.0) * (clamped_bottom - clamped_top).max(0.0);
    let coverage = (covered / requested_area).clamp(0.0, 1.0) as f32;

    Some(ResolvedRect {
        rect: PixelRect { x, y, w, h },
        coverage,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f64, y: f64, w: f64, h: f64) -> NormalizedRect {
        NormalizedRect { x, y, w, h }
    }

    const HD: WindowGeometry = WindowGeometry {
        width: 1920,
        height: 1080,
    };

    #[test]
    fn a_rectangle_inside_the_window_is_fully_covered() {
        let resolved = resolve(&rect(0.0, 0.75, 0.15, 0.25), HD).expect("inside the window");
        assert_eq!(
            resolved.rect,
            PixelRect {
                x: 0,
                y: 810,
                w: 288,
                h: 270
            }
        );
        assert!((resolved.coverage - 1.0).abs() < f32::EPSILON);
    }

    #[test]
    fn a_rectangle_running_off_the_edge_is_clamped_and_says_how_much_it_lost() {
        // Half of the width falls outside: 0.9 + 0.2 = 1.1.
        let resolved = resolve(&rect(0.9, 0.0, 0.2, 0.1), HD).expect("partly inside");
        assert_eq!(resolved.rect.x, 1728);
        assert_eq!(resolved.rect.x + resolved.rect.w, 1920);
        assert!(
            (resolved.coverage - 0.5).abs() < 0.01,
            "coverage was {}",
            resolved.coverage
        );
    }

    #[test]
    fn a_rectangle_entirely_outside_the_window_is_absent_rather_than_empty() {
        // Calibration that has gone stale after a resolution change looks exactly like this, and
        // a zero-pixel crop would be a fact about nothing.
        assert!(resolve(&rect(1.0, 1.0, 0.1, 0.1), HD).is_none());
    }

    #[test]
    fn a_window_with_no_area_yields_nothing() {
        // A minimised window reports 0x0 on more than one platform.
        assert!(resolve(&rect(0.0, 0.0, 1.0, 1.0), WindowGeometry::new(0, 0)).is_none());
    }

    #[test]
    fn a_sub_pixel_region_still_yields_at_least_one_pixel() {
        let tiny = resolve(&rect(0.5, 0.5, 0.0001, 0.0001), HD).expect("rounds outward");
        assert!(tiny.rect.w >= 1 && tiny.rect.h >= 1);
    }
}
