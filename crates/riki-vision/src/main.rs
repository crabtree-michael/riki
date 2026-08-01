//! The sidecar binary: supervisor-friendly, stdio protocol.
//!
//! Runs as a separate process so a crash in capture or CV cannot take the agent down
//! (state capture design §3). Perf budget: ≤3% of one CPU core average, with no measurable
//! FPS delta in Dota (§1). Capture is GPU-side, region-limited, and adaptive.
//!
//! Skeleton only — no implementation yet.

fn main() {
    // The real entry point speaks the stdio protocol defined in packages/protocol and
    // handshakes a version before anything else (REPO_SKELETON.md §4).
}
