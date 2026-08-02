//! The sidecar side of `packages/protocol` — generated types plus handwritten transport.
//!
//! # The wire
//!
//! Newline-delimited JSON over stdin and stdout, one message per line. stdout carries protocol
//! and nothing else; **anything a human should read goes to stderr**, because a stray `println!`
//! in this process is a malformed message in the app rather than a log line.
//!
//! Line-delimited JSON rather than a length-prefixed binary frame is a deliberate trade: a
//! developer can pipe the sidecar by hand and read what it says, and `apps/desktop` already
//! buffers the child's stdout into lines. The cost is a JSON parse per message, which at the
//! 1–5 Hz this protocol runs at is not measurable against the ≤3% of one core budget.
//!
//! # Version before content
//!
//! [`decode_command`] reads `v` and `type` out of the line *before* attempting the real parse. The
//! app and the sidecar are routinely different builds during development (`REPO_SKELETON.md` §4),
//! and a v2 message parsed as v1 fails somewhere deep in serde with a message about a missing
//! field. Checking the version first is what turns that into "the sidecar speaks 1, you sent 2".
//!
//! # Nothing here panics on input
//!
//! Every decode path is total: a malformed line, an unknown message type and a version mismatch
//! are all values, not errors, and none of them unwinds. The sidecar is supervised and will be
//! restarted, but a crash loop triggered by one bad line is a much worse failure than a reported
//! problem — and `panic = "abort"` in the release profile means there is no unwinding to catch it.

mod generated;
mod handshake;
mod transport;

pub use generated::*;
pub use handshake::{Handshake, HandshakeOutcome, EXIT_PROTOCOL_MISMATCH};
pub use transport::{decode_command, Incoming, LineTransport};

/// Convenience constructors for the events the sidecar sends most.
///
/// These exist so that no caller assembles a [`Problem`] by hand and forgets `fatal`, and so the
/// remedy text for the user-visible failures lives in exactly one place.
pub mod events {
    use crate::generated::{Problem, ProblemKind, SidecarEvent, SidecarIdentity, PROTOCOL_VERSION};

    /// The handshake reply.
    #[must_use]
    pub fn ready(sidecar: SidecarIdentity) -> SidecarEvent {
        SidecarEvent::Ready {
            v: PROTOCOL_VERSION,
            sidecar,
        }
    }

    /// A problem the sidecar can keep running through.
    #[must_use]
    pub fn degraded(kind: ProblemKind, message: impl Into<String>) -> SidecarEvent {
        problem(kind, false, message)
    }

    /// A problem the sidecar is about to exit on.
    #[must_use]
    pub fn fatal(kind: ProblemKind, message: impl Into<String>) -> SidecarEvent {
        problem(kind, true, message)
    }

    fn problem(kind: ProblemKind, fatal: bool, message: impl Into<String>) -> SidecarEvent {
        SidecarEvent::Problem {
            v: PROTOCOL_VERSION,
            problem: Problem {
                kind,
                fatal,
                message: message.into(),
                remedy: remedy_for(kind).map(str::to_owned),
            },
        }
    }

    /// What the user can actually do about it, for the failures where that is a real question.
    ///
    /// dota2 §9's response column, as data. A problem with no remedy is one the user cannot act
    /// on, and offering them a step anyway is worse than saying nothing.
    fn remedy_for(kind: ProblemKind) -> Option<&'static str> {
        match kind {
            ProblemKind::PermissionDenied => Some(
                "Grant Riki the Screen Recording permission in System Settings > Privacy & \
                 Security, then restart Riki.",
            ),
            ProblemKind::ExclusiveFullscreen => Some(
                "Set Dota 2 to Borderless Window in Settings > Video. Exclusive fullscreen \
                 cannot be captured.",
            ),
            ProblemKind::WindowNotFound => Some("Start Dota 2, or check that it is not minimised."),
            _ => None,
        }
    }
}
