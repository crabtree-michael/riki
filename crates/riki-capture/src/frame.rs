//! A whole frame in main memory, and how one is read off disk.
//!
//! **This type is not on the seam.** [`crate::backend::CaptureBackend`] never hands a frame out,
//! because a real backend never has one in main memory to hand: on `ScreenCaptureKit` the frame is
//! an `IOSurface` and on WGC a D3D11 texture, and the crop happens before the readback. `Frame`
//! exists for the backends that genuinely do work on the CPU — the replay backend, and any future
//! test double — and for the fixture loader below.

use crate::geometry::{PixelRect, WindowGeometry};

/// An RGBA8 image.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    width: u32,
    height: u32,
    pixels: Vec<u8>,
}

/// Why a fixture frame could not be read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrameError {
    /// What was wrong with the file.
    pub detail: String,
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.detail)
    }
}

impl std::error::Error for FrameError {}

impl Frame {
    /// Wrap an RGBA8 buffer.
    ///
    /// # Errors
    ///
    /// When `pixels` is not exactly `width * height * 4` bytes.
    pub fn new(width: u32, height: u32, pixels: Vec<u8>) -> Result<Self, FrameError> {
        let expected = (width as usize) * (height as usize) * 4;
        if pixels.len() != expected {
            return Err(FrameError {
                detail: format!(
                    "expected {expected} bytes for {width}x{height} RGBA, got {}",
                    pixels.len()
                ),
            });
        }
        Ok(Self {
            width,
            height,
            pixels,
        })
    }

    /// The frame's size, as a window geometry.
    #[must_use]
    pub const fn geometry(&self) -> WindowGeometry {
        WindowGeometry::new(self.width, self.height)
    }

    /// Copy out a sub-rectangle as RGBA8.
    ///
    /// The rectangle is expected to be inside the frame — `geometry::resolve` is what guarantees
    /// that — but rows are clipped defensively rather than indexed blindly, because a panic here
    /// would take down a supervised process for a bug in arithmetic.
    #[must_use]
    pub fn crop(&self, rect: PixelRect) -> Vec<u8> {
        let mut out = Vec::with_capacity((rect.w as usize) * (rect.h as usize) * 4);
        for row in 0..rect.h {
            let y = rect.y + row;
            if y >= self.height {
                break;
            }
            let start = ((y as usize) * (self.width as usize) + (rect.x as usize)) * 4;
            let available = (self.width.saturating_sub(rect.x)).min(rect.w) as usize;
            let end = start + available * 4;
            if end <= self.pixels.len() {
                out.extend_from_slice(&self.pixels[start..end]);
            }
        }
        out
    }

    /// Read a binary PPM (`P6`).
    ///
    /// PPM because it needs no decoder: `fixtures/frames/` is meant for hand-labelled screenshots
    /// in git-lfs, and pulling an image crate into the sidecar to read a synthetic test frame
    /// would put a decoder in the shipped binary for the benefit of tests alone.
    ///
    /// # Errors
    ///
    /// When the magic, the header or the payload length is wrong.
    pub fn from_ppm(bytes: &[u8]) -> Result<Self, FrameError> {
        let mut cursor = 0_usize;
        let magic = next_token(bytes, &mut cursor)?;
        if magic != "P6" {
            return Err(FrameError {
                detail: format!("expected a binary PPM (P6), found {magic}"),
            });
        }
        let width = parse_dimension(&next_token(bytes, &mut cursor)?)?;
        let height = parse_dimension(&next_token(bytes, &mut cursor)?)?;
        let max = parse_dimension(&next_token(bytes, &mut cursor)?)?;
        if max != 255 {
            return Err(FrameError {
                detail: format!("only 8-bit PPM is supported, found maxval {max}"),
            });
        }
        // Exactly one whitespace byte separates the header from the payload.
        cursor += 1;

        let expected = (width as usize) * (height as usize) * 3;
        let rgb = bytes
            .get(cursor..cursor + expected)
            .ok_or_else(|| FrameError {
                detail: format!(
                    "truncated PPM: {width}x{height} needs {expected} bytes, found {}",
                    bytes.len().saturating_sub(cursor)
                ),
            })?;

        let mut pixels = Vec::with_capacity(expected / 3 * 4);
        for chunk in rgb.chunks_exact(3) {
            pixels.extend_from_slice(&[chunk[0], chunk[1], chunk[2], 255]);
        }
        Self::new(width, height, pixels)
    }
}

fn next_token(bytes: &[u8], cursor: &mut usize) -> Result<String, FrameError> {
    let mut token = String::new();
    while *cursor < bytes.len() {
        let byte = bytes[*cursor];
        if byte == b'#' {
            while *cursor < bytes.len() && bytes[*cursor] != b'\n' {
                *cursor += 1;
            }
            continue;
        }
        if byte.is_ascii_whitespace() {
            if token.is_empty() {
                *cursor += 1;
                continue;
            }
            break;
        }
        token.push(char::from(byte));
        *cursor += 1;
    }
    if token.is_empty() {
        return Err(FrameError {
            detail: "unexpected end of PPM header".to_owned(),
        });
    }
    Ok(token)
}

fn parse_dimension(token: &str) -> Result<u32, FrameError> {
    token.parse::<u32>().map_err(|_| FrameError {
        detail: format!("PPM header field is not a number: {token}"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `P6 2x2`, red green / blue white.
    fn tiny_ppm() -> Vec<u8> {
        let mut bytes = b"P6\n# a comment\n2 2\n255\n".to_vec();
        bytes.extend_from_slice(&[255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);
        bytes
    }

    #[test]
    fn reads_a_ppm_including_its_comment() {
        let frame = Frame::from_ppm(&tiny_ppm()).expect("valid ppm");
        assert_eq!(frame.geometry(), WindowGeometry::new(2, 2));
        // Alpha is synthesised as opaque: PPM has no alpha channel and a zero one would make
        // every fixture frame look transparent to anything that reads it later.
        assert_eq!(
            &frame.crop(PixelRect {
                x: 0,
                y: 0,
                w: 1,
                h: 1
            }),
            &[255, 0, 0, 255]
        );
    }

    #[test]
    fn a_truncated_ppm_is_an_error_rather_than_a_panic() {
        let mut bytes = b"P6\n2 2\n255\n".to_vec();
        bytes.extend_from_slice(&[255, 0, 0]);
        let error = Frame::from_ppm(&bytes).expect_err("payload is short");
        assert!(error.detail.contains("truncated"), "{}", error.detail);
    }

    #[test]
    fn rejects_a_format_it_cannot_read_by_name() {
        let error = Frame::from_ppm(b"P3\n1 1\n255\n0 0 0\n").expect_err("ascii ppm");
        assert!(error.detail.contains("P3"), "{}", error.detail);
    }

    #[test]
    fn crops_the_requested_rows_and_columns() {
        let frame = Frame::from_ppm(&tiny_ppm()).expect("valid ppm");
        let bottom_row = frame.crop(PixelRect {
            x: 0,
            y: 1,
            w: 2,
            h: 1,
        });
        assert_eq!(bottom_row, vec![0, 0, 255, 255, 255, 255, 255, 255]);
    }

    #[test]
    fn a_crop_that_overruns_the_frame_clips_instead_of_panicking() {
        // Not reachable through `geometry::resolve`, which is the point: a supervised process
        // must not die of an arithmetic slip somewhere upstream.
        let frame = Frame::from_ppm(&tiny_ppm()).expect("valid ppm");
        let out = frame.crop(PixelRect {
            x: 1,
            y: 1,
            w: 8,
            h: 8,
        });
        assert_eq!(out, vec![255, 255, 255, 255]);
    }

    #[test]
    fn a_buffer_of_the_wrong_length_is_refused() {
        assert!(Frame::new(2, 2, vec![0; 8]).is_err());
    }
}
