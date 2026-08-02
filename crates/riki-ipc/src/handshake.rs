//! The gate every incoming line passes before it can mean anything.
//!
//! `REPO_SKELETON.md` §4 requires a version handshake before any other message. The rule this
//! module enforces is narrow and worth stating on its own: **nothing that arrives before a
//! matching `hello` is acted on.** A `capture.start` from a build that never introduced itself is
//! a build whose idea of `CaptureConfig` we have no reason to trust.

use crate::events;
use crate::generated::{ProblemKind, SidecarCommand, SidecarEvent, SidecarIdentity};
use crate::transport::Incoming;

/// Exit code for a protocol version mismatch.
///
/// Distinct from a panic (`101`) and from a clean exit so the supervisor's log line says which
/// happened. The supervisor restarts either way — a mismatch is not fixed by restarting, but
/// deciding that is the app's job, not ours.
pub const EXIT_PROTOCOL_MISMATCH: i32 = 2;

/// What the caller should do with a line.
#[derive(Debug, Clone, PartialEq)]
pub enum HandshakeOutcome {
    /// Emit this event and keep reading.
    Reply(SidecarEvent),
    /// Emit this event, then exit with this code.
    Fatal(SidecarEvent, i32),
    /// The handshake is done and this command is ours to run.
    Execute(SidecarCommand),
}

/// Tracks whether the peer has introduced itself.
#[derive(Debug, Clone)]
pub struct Handshake {
    identity: SidecarIdentity,
    established: bool,
}

impl Handshake {
    /// The identity this sidecar answers `hello` with.
    #[must_use]
    pub const fn new(identity: SidecarIdentity) -> Self {
        Self {
            identity,
            established: false,
        }
    }

    /// True once a matching `hello` has been answered.
    #[must_use]
    pub const fn established(&self) -> bool {
        self.established
    }

    /// Decide what one decoded line means.
    #[must_use]
    pub fn admit(&mut self, incoming: Incoming) -> HandshakeOutcome {
        match incoming {
            Incoming::VersionMismatch { theirs } => HandshakeOutcome::Fatal(
                events::fatal(
                    ProblemKind::ProtocolVersionMismatch,
                    format!(
                        "the app speaks protocol v{theirs}; this sidecar speaks v{ours}. \
                         Rebuild both from the same commit.",
                        ours = crate::generated::PROTOCOL_VERSION
                    ),
                ),
                EXIT_PROTOCOL_MISMATCH,
            ),

            // A line we cannot read is reported and dropped. It is never fatal: the sidecar is
            // supervised, and exiting on one bad line turns a cosmetic bug in the app into a
            // restart loop that also loses capture.
            Incoming::Malformed { detail } => {
                HandshakeOutcome::Reply(events::degraded(ProblemKind::MalformedMessage, detail))
            }

            // Answering a second `hello` rather than complaining about it: the reply is a pure
            // function of this build, so repeating it costs nothing and means an app that lost
            // track of the handshake can re-establish it instead of having to respawn us.
            Incoming::Command(SidecarCommand::Hello { .. }) => {
                self.established = true;
                HandshakeOutcome::Reply(events::ready(self.identity.clone()))
            }

            Incoming::Command(command) if !self.established => {
                HandshakeOutcome::Reply(events::degraded(
                    ProblemKind::HandshakeRequired,
                    format!("{} arrived before hello and was ignored", name_of(&command)),
                ))
            }

            Incoming::Command(command) => HandshakeOutcome::Execute(command),
        }
    }
}

/// The wire name of a command, for problem messages.
const fn name_of(command: &SidecarCommand) -> &'static str {
    match command {
        SidecarCommand::Hello { .. } => "hello",
        SidecarCommand::CaptureConfigure { .. } => "capture.configure",
        SidecarCommand::CaptureStart { .. } => "capture.start",
        SidecarCommand::CaptureStop { .. } => "capture.stop",
        SidecarCommand::Shutdown { .. } => "shutdown",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::generated::{AppIdentity, Problem, PROTOCOL_VERSION};

    fn handshake() -> Handshake {
        Handshake::new(SidecarIdentity {
            name: "riki-vision".to_owned(),
            version: "0.0.0".to_owned(),
            platform: "linux".to_owned(),
            backend: "replay".to_owned(),
            backend_available: true,
        })
    }

    fn hello() -> Incoming {
        Incoming::Command(SidecarCommand::Hello {
            v: PROTOCOL_VERSION,
            app: AppIdentity {
                name: "riki".to_owned(),
                build: "test".to_owned(),
            },
        })
    }

    fn problem_of(outcome: &HandshakeOutcome) -> &Problem {
        let (HandshakeOutcome::Reply(SidecarEvent::Problem { problem, .. })
        | HandshakeOutcome::Fatal(SidecarEvent::Problem { problem, .. }, _)) = outcome
        else {
            panic!("expected a problem, got {outcome:?}");
        };
        problem
    }

    #[test]
    fn answers_hello_with_ready() {
        let mut gate = handshake();
        assert!(!gate.established());

        let outcome = gate.admit(hello());

        assert!(gate.established());
        let HandshakeOutcome::Reply(SidecarEvent::Ready { sidecar, v }) = outcome else {
            panic!("hello is answered with ready");
        };
        assert_eq!(v, PROTOCOL_VERSION);
        assert_eq!(sidecar.backend, "replay");
    }

    #[test]
    fn refuses_to_act_on_a_command_that_arrived_before_hello() {
        let mut gate = handshake();

        let outcome = gate.admit(Incoming::Command(SidecarCommand::CaptureStart {
            v: PROTOCOL_VERSION,
        }));

        // Reported, not executed, and not fatal.
        let problem = problem_of(&outcome);
        assert_eq!(problem.kind, ProblemKind::HandshakeRequired);
        assert!(!problem.fatal);
        assert!(problem.message.contains("capture.start"));
    }

    #[test]
    fn runs_commands_once_the_handshake_is_established() {
        let mut gate = handshake();
        let _ = gate.admit(hello());

        let outcome = gate.admit(Incoming::Command(SidecarCommand::CaptureStart {
            v: PROTOCOL_VERSION,
        }));

        assert_eq!(
            outcome,
            HandshakeOutcome::Execute(SidecarCommand::CaptureStart {
                v: PROTOCOL_VERSION
            })
        );
    }

    #[test]
    fn a_version_mismatch_is_fatal_and_says_both_versions() {
        let mut gate = handshake();

        let outcome = gate.admit(Incoming::VersionMismatch { theirs: 99 });

        let problem = problem_of(&outcome);
        assert_eq!(problem.kind, ProblemKind::ProtocolVersionMismatch);
        assert!(problem.fatal);
        assert!(problem.message.contains("v99"), "{}", problem.message);
        assert!(
            problem.message.contains(&format!("v{PROTOCOL_VERSION}")),
            "{}",
            problem.message
        );
        assert!(matches!(
            outcome,
            HandshakeOutcome::Fatal(_, EXIT_PROTOCOL_MISMATCH)
        ));
    }

    #[test]
    fn a_malformed_line_is_reported_but_never_fatal() {
        let mut gate = handshake();
        let _ = gate.admit(hello());

        let outcome = gate.admit(Incoming::Malformed {
            detail: "expected value at line 1 column 1".to_owned(),
        });

        let problem = problem_of(&outcome);
        assert_eq!(problem.kind, ProblemKind::MalformedMessage);
        // One bad line must not become a restart loop that also loses capture.
        assert!(!problem.fatal);
    }
}
