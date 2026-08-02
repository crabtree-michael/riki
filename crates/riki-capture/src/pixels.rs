//! Getting crop rectangles out of a platform frame buffer, in the one direction that is allowed.
//!
//! Like [`crate::window_match`], this is deliberately not behind a `cfg`. Every platform hands back
//! a padded, differently-ordered buffer — `ScreenCaptureKit` gives BGRA with a `bytesPerRow` that
//! is **not** `width * 4`, and WGC will give the same — and the arithmetic that turns that into the
//! crate's RGBA is exactly the sort of thing that is wrong by one row on real hardware and cannot
//! be found by reading it. Here it is ordinary data with unit tests.
//!
//! # Why the copy is per-region and not per-frame
//!
//! The performance rule (dota2 §2.2) is crop first, then read back. On macOS the frame arrives as
//! an `IOSurface`-backed `CVPixelBuffer`; mapping it is not a bus transfer, but *copying* it would
//! be, so the backend maps the surface once per delivered frame and calls [`crop_bgra_to_rgba`]
//! only for the configured regions. A 4K window is 33 MB and the four regions the app configures
//! are well under 1 MB of it, which is where the ~50× figure comes from. Nothing in this crate
//! ever materialises a whole platform frame — see [`crate::frame::Frame`], which is for fixtures.

use crate::geometry::PixelRect;

/// Bytes per pixel in every format this module handles.
const BGRA_BYTES_PER_PIXEL: usize = 4;

/// Copy one rectangle out of a BGRA8 buffer as RGBA8.
///
/// `bytes_per_row` is the buffer's stride, which on macOS is padded to a multiple of 64 and so is
/// routinely larger than `width * 4`. Rows and columns that fall outside the buffer are skipped
/// rather than indexed: `geometry::resolve` is what guarantees the rectangle is inside the window,
/// but a supervised process must not die of an arithmetic slip upstream of it, and a short buffer
/// is what a torn or partially-written surface looks like.
///
/// Returns `rect.w * rect.h * 4` bytes when the rectangle is fully inside the buffer, and fewer
/// when it is not — the caller reports coverage separately, so a short crop is visible as a weaker
/// claim rather than as silent black.
#[must_use]
pub fn crop_bgra_to_rgba(src: &[u8], bytes_per_row: usize, rect: PixelRect) -> Vec<u8> {
    let width = rect.w as usize;
    let height = rect.h as usize;
    let mut out = Vec::with_capacity(width * height * BGRA_BYTES_PER_PIXEL);

    for row in 0..height {
        let y = rect.y as usize + row;
        let row_start = y * bytes_per_row + (rect.x as usize) * BGRA_BYTES_PER_PIXEL;
        let row_end = row_start + width * BGRA_BYTES_PER_PIXEL;
        let Some(row_bytes) = src.get(row_start..row_end) else {
            // Past the end of the surface. Stop rather than wrap onto the next row, which would
            // produce a plausible-looking image made of the wrong pixels.
            break;
        };
        for pixel in row_bytes.chunks_exact(BGRA_BYTES_PER_PIXEL) {
            // 32BGRA is B, G, R, A in memory order. Alpha is carried through unchanged: a window
            // captured over a transparent desktop region legitimately has one.
            out.extend_from_slice(&[pixel[2], pixel[1], pixel[0], pixel[3]]);
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A `width * height` BGRA buffer with `padding` extra bytes on each row, where every pixel
    /// encodes its own coordinates: B = x, G = y, R = 200, A = 255.
    fn buffer(width: usize, height: usize, padding: usize) -> (Vec<u8>, usize) {
        let bytes_per_row = width * BGRA_BYTES_PER_PIXEL + padding;
        let mut bytes = vec![0_u8; bytes_per_row * height];
        for y in 0..height {
            for x in 0..width {
                let at = y * bytes_per_row + x * BGRA_BYTES_PER_PIXEL;
                bytes[at] = u8::try_from(x).expect("small fixture");
                bytes[at + 1] = u8::try_from(y).expect("small fixture");
                bytes[at + 2] = 200;
                bytes[at + 3] = 255;
            }
        }
        (bytes, bytes_per_row)
    }

    fn rect(x: u32, y: u32, w: u32, h: u32) -> PixelRect {
        PixelRect { x, y, w, h }
    }

    #[test]
    fn reorders_the_channels_from_bgra_to_rgba() {
        let (bytes, stride) = buffer(2, 2, 0);
        let out = crop_bgra_to_rgba(&bytes, stride, rect(1, 0, 1, 1));
        // Source pixel is B=1, G=0, R=200, A=255.
        assert_eq!(out, vec![200, 0, 1, 255]);
    }

    #[test]
    fn respects_a_stride_wider_than_the_image() {
        // The failure this module exists to prevent: macOS pads `bytesPerRow` to a multiple of 64,
        // so assuming `width * 4` shears the image progressively down the frame.
        let (bytes, stride) = buffer(3, 3, 48);
        assert_ne!(stride, 3 * BGRA_BYTES_PER_PIXEL, "fixture is padded");

        let out = crop_bgra_to_rgba(&bytes, stride, rect(0, 2, 3, 1));
        // Every pixel of the bottom row should report y = 2 in its green channel.
        let greens: Vec<u8> = out.chunks_exact(4).map(|pixel| pixel[1]).collect();
        assert_eq!(greens, vec![2, 2, 2]);
    }

    #[test]
    fn crops_the_requested_rectangle_and_nothing_around_it() {
        let (bytes, stride) = buffer(8, 8, 16);
        let out = crop_bgra_to_rgba(&bytes, stride, rect(2, 3, 4, 2));
        assert_eq!(out.len(), 4 * 2 * BGRA_BYTES_PER_PIXEL);

        let coordinates: Vec<(u8, u8)> = out
            .chunks_exact(4)
            .map(|pixel| (pixel[2], pixel[1]))
            .collect();
        assert_eq!(
            coordinates,
            vec![
                (2, 3),
                (3, 3),
                (4, 3),
                (5, 3),
                (2, 4),
                (3, 4),
                (4, 4),
                (5, 4)
            ]
        );
    }

    #[test]
    fn a_rectangle_running_past_the_end_of_the_surface_stops_rather_than_wrapping() {
        // A torn or partially-written surface looks exactly like this. Wrapping would produce an
        // image that looks plausible and is made of the wrong pixels, which is worse than short.
        let (bytes, stride) = buffer(4, 4, 0);
        let out = crop_bgra_to_rgba(&bytes, stride, rect(0, 3, 4, 4));
        assert_eq!(out.len(), 4 * BGRA_BYTES_PER_PIXEL, "only row 3 exists");
    }

    #[test]
    fn an_empty_buffer_yields_an_empty_crop_rather_than_panicking() {
        assert!(crop_bgra_to_rgba(&[], 0, rect(0, 0, 4, 4)).is_empty());
    }

    #[test]
    fn a_black_surface_stays_black_so_health_can_recognise_it() {
        // `CaptureHealth` reads a run of black passes as the Screen Recording permission. That
        // only works if a black BGRA surface converts to black RGBA rather than to opaque noise.
        let stride = 4 * BGRA_BYTES_PER_PIXEL;
        let bytes = vec![0_u8; stride * 4];
        let out = crop_bgra_to_rgba(&bytes, stride, rect(0, 0, 4, 4));
        assert!(out
            .chunks_exact(4)
            .all(|pixel| pixel[0] == 0 && pixel[1] == 0 && pixel[2] == 0));
    }
}
