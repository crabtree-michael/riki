//! Command line, hand-rolled.
//!
//! No argument-parsing crate: the sidecar has four flags, and the dependency budget for a process
//! that runs alongside a game is one of the few things entirely under our control. If this grows
//! past a handful of options, that is the moment to reconsider — not before.

use std::path::PathBuf;

/// Which capture backend to build.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackendChoice {
    /// The platform backend for this build (`crate::platform::default_backend`).
    Native,
    /// Fixture frames from a directory. What makes the pipeline runnable with no display.
    Replay,
}

/// Parsed options.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Options {
    /// Which backend was asked for.
    pub backend: BackendChoice,
    /// Where the replay frames are.
    pub frames: Option<PathBuf>,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            backend: BackendChoice::Native,
            frames: None,
        }
    }
}

/// What `parse` decided.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Parsed {
    /// Run with these options.
    Run(Box<Options>),
    /// Print this and exit 0.
    Print(String),
    /// Print this to stderr and exit non-zero.
    Usage(String),
}

/// The `--help` text, which is also the documentation of the flags.
pub const HELP: &str = "\
riki-vision — Riki's screen capture and CV sidecar.

Speaks the newline-delimited JSON protocol from packages/protocol over stdin and stdout.
stdout is protocol only; everything human-readable goes to stderr.

USAGE:
    riki-vision [OPTIONS]

OPTIONS:
    --backend <native|replay>  Capture backend. Default: native.
    --frames <DIR>             Directory of .ppm frames, required by --backend replay.
    -h, --help                 Print this help.
    -V, --version              Print the version.

READ-ONLY OBSERVATION (ADR-0003): this process reads pixels from one window and nothing else.
It does not read game memory, inject, hook, or synthesise input, and it never captures the
desktop or any window other than the one the app names.
";

/// Parse arguments, excluding the program name.
///
/// # Errors
///
/// Returns [`Parsed::Usage`] rather than exiting, so the caller owns the exit code and tests do
/// not have to spawn a process to check a message.
#[must_use]
pub fn parse<I: IntoIterator<Item = String>>(args: I) -> Parsed {
    let mut options = Options::default();
    let mut iter = args.into_iter();

    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "-h" | "--help" => return Parsed::Print(HELP.to_owned()),
            "-V" | "--version" => {
                return Parsed::Print(format!("riki-vision {}\n", env!("CARGO_PKG_VERSION")))
            }
            "--backend" => {
                let Some(value) = iter.next() else {
                    return Parsed::Usage("--backend needs a value".to_owned());
                };
                options.backend = match value.as_str() {
                    "native" => BackendChoice::Native,
                    "replay" => BackendChoice::Replay,
                    other => {
                        return Parsed::Usage(format!(
                            "unknown backend `{other}` (expected native or replay)"
                        ))
                    }
                };
            }
            "--frames" => {
                let Some(value) = iter.next() else {
                    return Parsed::Usage("--frames needs a directory".to_owned());
                };
                options.frames = Some(PathBuf::from(value));
            }
            other => return Parsed::Usage(format!("unknown argument `{other}`")),
        }
    }

    if options.backend == BackendChoice::Replay && options.frames.is_none() {
        return Parsed::Usage("--backend replay needs --frames <DIR>".to_owned());
    }

    Parsed::Run(Box::new(options))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_args(args: &[&str]) -> Parsed {
        parse(args.iter().map(|s| (*s).to_owned()))
    }

    #[test]
    fn defaults_to_the_platform_backend() {
        assert_eq!(
            parse_args(&[]),
            Parsed::Run(Box::new(Options {
                backend: BackendChoice::Native,
                frames: None
            }))
        );
    }

    #[test]
    fn replay_needs_somewhere_to_replay_from() {
        // Caught here rather than at run time: a replay backend with no frames would start,
        // handshake and then report a window it could never have found, which reads like a
        // capture failure instead of a missing flag.
        let Parsed::Usage(message) = parse_args(&["--backend", "replay"]) else {
            panic!("replay without frames is a usage error");
        };
        assert!(message.contains("--frames"), "{message}");
    }

    #[test]
    fn accepts_a_replay_backend_with_frames() {
        assert_eq!(
            parse_args(&[
                "--backend",
                "replay",
                "--frames",
                "fixtures/frames/synthetic"
            ]),
            Parsed::Run(Box::new(Options {
                backend: BackendChoice::Replay,
                frames: Some(PathBuf::from("fixtures/frames/synthetic")),
            }))
        );
    }

    #[test]
    fn an_unknown_backend_names_what_it_expected() {
        let Parsed::Usage(message) = parse_args(&["--backend", "screencapturekit"]) else {
            panic!("not a backend this build has");
        };
        assert!(message.contains("native or replay"), "{message}");
    }

    #[test]
    fn a_flag_missing_its_value_is_a_usage_error_and_not_a_silent_default() {
        assert!(matches!(parse_args(&["--frames"]), Parsed::Usage(_)));
    }

    #[test]
    fn help_says_what_this_process_will_not_do() {
        let Parsed::Print(text) = parse_args(&["--help"]) else {
            panic!("--help prints");
        };
        // ADR-0003 is the product's most load-bearing constraint and the sidecar is where someone
        // would look for it. It costs six lines of help text.
        assert!(text.contains("ADR-0003"));
        assert!(text.contains("does not read game memory"));
    }
}
