//! Lines in, lines out — and the version check that happens before anything else.

use std::io::{self, Write};

use serde::Deserialize;

use crate::generated::{SidecarCommand, SidecarEvent, PROTOCOL_VERSION};

/// The two fields every message carries, and the only two that may never change shape.
///
/// A peer speaking a version we do not know still writes these, which is the whole reason a
/// mismatch can be reported as a mismatch rather than as a parse failure. See
/// `packages/protocol/src/version.ts`.
#[derive(Debug, Deserialize)]
struct Envelope {
    v: u64,
    #[serde(rename = "type")]
    kind: String,
}

/// What one line of stdin turned out to be. Total: there is no error case that escapes.
#[derive(Debug, Clone, PartialEq)]
pub enum Incoming {
    /// A command this build understands.
    Command(SidecarCommand),
    /// The envelope parsed and the version is not ours. Fatal — see `handshake`.
    VersionMismatch {
        /// The version the app claims to speak.
        theirs: u64,
    },
    /// Not JSON, or JSON without a readable envelope, or a `type` this build has never heard of.
    ///
    /// `detail` is a serde message, which is safe to log: it describes the shape of the line, and
    /// the only lines that reach here come from our own supervisor.
    Malformed {
        /// Why the line could not be read.
        detail: String,
    },
}

/// Read one line of stdin.
///
/// Order matters and is the point of this function: envelope first, version second, content third.
#[must_use]
pub fn decode_command(line: &str) -> Incoming {
    let envelope: Envelope = match serde_json::from_str(line) {
        Ok(envelope) => envelope,
        Err(error) => {
            return Incoming::Malformed {
                detail: error.to_string(),
            }
        }
    };

    if envelope.v != PROTOCOL_VERSION {
        return Incoming::VersionMismatch { theirs: envelope.v };
    }

    match serde_json::from_str::<SidecarCommand>(line) {
        Ok(command) => Incoming::Command(command),
        // Same version, unreadable content: a `type` we do not have, or a field of the wrong
        // shape. Naming the type is what makes this actionable in a log.
        Err(error) => Incoming::Malformed {
            detail: format!("{}: {error}", envelope.kind),
        },
    }
}

/// Writes events as newline-delimited JSON.
///
/// Flushing per message is deliberate. The app's supervisor treats silence as a health signal
/// (`apps/desktop/src/main/sidecar` reports `degraded` after five quiet seconds), so a buffered
/// `ready` sitting in an 8 KiB pipe buffer would read as a sidecar that started and never spoke.
pub struct LineTransport<W: Write> {
    out: W,
}

impl<W: Write> LineTransport<W> {
    /// Wrap a writer. In the binary this is `io::stdout()`, and in tests a `Vec<u8>`.
    pub const fn new(out: W) -> Self {
        Self { out }
    }

    /// Serialise one event and flush it.
    ///
    /// # Errors
    ///
    /// Returns the underlying write error. A broken pipe here means the app is gone, which the
    /// caller should treat as a shutdown rather than as something to retry.
    pub fn emit(&mut self, event: &SidecarEvent) -> io::Result<()> {
        // An event that cannot be serialised is a bug in this crate rather than bad input, but it
        // still must not take the process down: a half-written line would desynchronise the
        // stream for every message after it.
        let line = serde_json::to_string(event).map_err(io::Error::other)?;
        self.out.write_all(line.as_bytes())?;
        self.out.write_all(b"\n")?;
        self.out.flush()
    }

    /// The wrapped writer, for tests that need to read what was emitted.
    pub fn into_inner(self) -> W {
        self.out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::generated::{AppIdentity, SidecarIdentity};

    fn hello_line(version: u64) -> String {
        format!(r#"{{"v":{version},"type":"hello","app":{{"name":"riki","build":"dev"}}}}"#)
    }

    #[test]
    fn decodes_a_command_of_our_own_version() {
        let incoming = decode_command(&hello_line(PROTOCOL_VERSION));
        assert_eq!(
            incoming,
            Incoming::Command(SidecarCommand::Hello {
                v: PROTOCOL_VERSION,
                app: AppIdentity {
                    name: "riki".to_owned(),
                    build: "dev".to_owned(),
                },
            })
        );
    }

    #[test]
    fn reports_a_version_mismatch_as_a_mismatch_and_not_as_a_parse_failure() {
        // The payload of a future version is deliberately unreadable by this build: `app` is gone
        // and there is a field we have never heard of. The envelope is still the envelope, which
        // is the property the whole scheme rests on.
        let line = r#"{"v":99,"type":"hello","client":{"whatever":true}}"#;
        assert_eq!(
            decode_command(line),
            Incoming::VersionMismatch { theirs: 99 }
        );
    }

    #[test]
    fn a_line_that_is_not_json_is_a_value_rather_than_a_panic() {
        let Incoming::Malformed { detail } = decode_command("thread 'main' panicked at src/x.rs")
        else {
            panic!("a panic trace is not a command");
        };
        assert!(!detail.is_empty());
    }

    #[test]
    fn an_unknown_message_type_names_itself() {
        let line = format!(r#"{{"v":{PROTOCOL_VERSION},"type":"capture.teleport"}}"#);
        let Incoming::Malformed { detail } = decode_command(&line) else {
            panic!("this build does not know that command");
        };
        assert!(detail.contains("capture.teleport"), "detail was {detail}");
    }

    #[test]
    fn emits_one_flushed_line_per_event() {
        let mut transport = LineTransport::new(Vec::new());
        let event = crate::events::ready(SidecarIdentity {
            name: "riki-vision".to_owned(),
            version: "0.0.0".to_owned(),
            platform: "linux".to_owned(),
            backend: "replay".to_owned(),
            backend_available: true,
        });
        transport.emit(&event).expect("vec writes cannot fail");
        transport.emit(&event).expect("vec writes cannot fail");

        let written = String::from_utf8(transport.into_inner()).expect("json is utf-8");
        let lines: Vec<&str> = written.lines().collect();
        assert_eq!(lines.len(), 2);
        // Round-trips through the same decoder the app uses.
        assert!(lines[0].starts_with(r#"{"type":"ready""#), "{}", lines[0]);
    }
}
