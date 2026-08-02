//! Region hashing and the change gate.
//!
//! Hashing before CV is the second half of the performance story (dota2 §2.2): the scoreboard
//! region costs nothing for the 95% of a match it is closed, because an unchanged hash means no
//! recognition work at all.
//!
//! FNV-1a rather than a cryptographic hash: this is a change detector, not a signature, and the
//! adversary is a moving mouse cursor rather than an attacker. It is a single multiply-xor per
//! byte with no table and no allocation, which is what keeps it off the budget.

use std::collections::HashMap;

use riki_ipc::RegionId;

const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

/// 64-bit FNV-1a over a region's pixels.
#[must_use]
pub fn region_hash(pixels: &[u8]) -> u64 {
    let mut hash = FNV_OFFSET;
    for byte in pixels {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash
}

/// Lower-case hex, the form the protocol carries.
#[must_use]
pub fn format_hash(hash: u64) -> String {
    format!("{hash:016x}")
}

/// Mean luminance over an RGBA8 buffer, 0..1.
///
/// Rec. 601 weights, which is what a UI renders against and close enough for "is this black".
/// Returns 0.0 for an empty buffer, which is the same answer a black crop gives — deliberately,
/// because both mean "there is nothing here to recognise".
#[must_use]
// The sum is f64 for accuracy over a large region; the result is f32 because a luminance is a
// display quantity and nothing downstream needs more than seven digits of it.
#[allow(clippy::cast_precision_loss, clippy::cast_possible_truncation)]
pub fn mean_luma(pixels: &[u8]) -> f32 {
    if pixels.len() < 4 {
        return 0.0;
    }
    let mut total = 0.0_f64;
    let mut count = 0_u64;
    for pixel in pixels.chunks_exact(4) {
        let r = f64::from(pixel[0]);
        let g = f64::from(pixel[1]);
        let b = f64::from(pixel[2]);
        total += 0.299 * r + 0.587 * g + 0.114 * b;
        count += 1;
    }
    if count == 0 {
        return 0.0;
    }
    ((total / count as f64) / 255.0).clamp(0.0, 1.0) as f32
}

/// Remembers the last hash per region so an unchanged region can be skipped.
#[derive(Debug, Default)]
pub struct ChangeGate {
    seen: HashMap<RegionId, u64>,
}

impl ChangeGate {
    /// A gate that has seen nothing.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Record a hash and say whether it differs from the last one for this region.
    ///
    /// The first sighting of a region counts as a change: there is no previous state to compare
    /// against, and reporting it is what gives the app a baseline.
    pub fn observe(&mut self, region: RegionId, hash: u64) -> bool {
        self.seen.insert(region, hash) != Some(hash)
    }

    /// Forget everything. Called when capture stops or the window is re-acquired — a region's
    /// previous hash means nothing across a resolution change.
    pub fn reset(&mut self) {
        self.seen.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_pixels_hash_identically_and_different_pixels_do_not() {
        let a = vec![7_u8; 256];
        let mut b = a.clone();
        b[128] = 8;

        assert_eq!(region_hash(&a), region_hash(&a.clone()));
        assert_ne!(region_hash(&a), region_hash(&b));
    }

    #[test]
    fn a_single_changed_byte_changes_the_hash() {
        // The gate's whole value rests on this: a scoreboard opening changes some pixels, and if
        // one byte can hide, so can a digit.
        let base = vec![0_u8; 4096];
        for index in [0, 1, 2047, 4095] {
            let mut altered = base.clone();
            altered[index] = 1;
            assert_ne!(region_hash(&base), region_hash(&altered), "index {index}");
        }
    }

    #[test]
    fn hex_is_sixteen_lower_case_digits() {
        // The protocol's regex is `^[0-9a-f]{16}$`; a hash that lost its leading zeros fails it.
        let formatted = format_hash(0x0000_0000_0000_00ff);
        assert_eq!(formatted, "00000000000000ff");
        assert_eq!(formatted.len(), 16);
    }

    #[test]
    fn black_pixels_have_zero_luma_and_white_pixels_have_one() {
        assert!((mean_luma(&[0, 0, 0, 255]) - 0.0).abs() < 1e-6);
        assert!((mean_luma(&[255, 255, 255, 255]) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn luma_ignores_the_alpha_channel() {
        // A fully transparent white pixel is still white. Alpha carrying into luminance would
        // make a compositor's window shadow look like a black frame, which is the one thing the
        // permission check must not mistake.
        assert!((mean_luma(&[255, 255, 255, 0]) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn the_first_sighting_of_a_region_counts_as_a_change() {
        let mut gate = ChangeGate::new();
        assert!(gate.observe(RegionId::Minimap, 1));
        assert!(!gate.observe(RegionId::Minimap, 1));
        assert!(gate.observe(RegionId::Minimap, 2));
    }

    #[test]
    fn regions_do_not_share_a_slot() {
        let mut gate = ChangeGate::new();
        assert!(gate.observe(RegionId::Minimap, 42));
        assert!(gate.observe(RegionId::Scoreboard, 42));
    }

    #[test]
    fn a_reset_makes_everything_new_again() {
        let mut gate = ChangeGate::new();
        gate.observe(RegionId::Minimap, 1);
        gate.reset();
        assert!(gate.observe(RegionId::Minimap, 1));
    }
}
