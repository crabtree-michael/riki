//! The sidecar binary: supervisor-friendly, stdio protocol.
//!
//! Runs as a separate process so a crash in capture or CV cannot take the agent down
//! (state capture design §3). Perf budget: ≤3% of one CPU core average, with no measurable
//! FPS delta in Dota (§1). Capture is GPU-side, region-limited, and adaptive.
//!
//! # Read-only observation (ADR-0003)
//!
//! This process reads pixels from one window. It does not read game memory, inject, hook, draw
//! into the game, or synthesise input, and it has no code path that could: the capture seam takes
//! a window target and returns crops, and that is the entire surface it has on the machine.
//!
//! # What this file owns
//!
//! Threads, a clock, and two file descriptors. Everything with a decision in it lives in
//! [`session::Session`], which is generic over its writer and its backend and is therefore a unit
//! test rather than something you have to run a process to observe.
//!
//! # Behaving under a supervisor
//!
//! Three things, all of which the app's supervisor depends on
//! (`apps/desktop/src/main/sidecar`):
//!
//! - **stdout is protocol only.** Every human-readable line goes to stderr. A stray `println!`
//!   here is an undecodable message there.
//! - **A closed stdin is a shutdown.** If the app dies, our stdin closes; the loop ends and the
//!   process exits rather than lingering as an orphan holding a capture session.
//! - **Exit codes mean something.** `0` clean, `2` protocol version mismatch, `3` bad arguments.
//!   Distinct from a panic's `101`, so a supervisor's log line says which happened.

mod cli;
mod session;

use std::io::{self, BufRead, Write};
use std::path::Path;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;

use riki_capture::{
    default_backend, CaptureBackend, CapturePipeline, Frame, ReplayBackend, UnavailableBackend,
};
use riki_ipc::{LineTransport, SidecarIdentity};

use crate::cli::{BackendChoice, Options, Parsed};
use crate::session::{MonotonicClock, Session, EXIT_OK};

/// Bad arguments. Distinct from a protocol mismatch so a supervisor can tell them apart.
const EXIT_USAGE: i32 = 3;

fn main() {
    let code = run();
    // `std::process::exit` rather than falling off the end of main: the stdin reader thread is
    // parked on a blocking read that will never return, and waiting for it would hang the quit
    // that the app's kill grace period is counting on.
    std::process::exit(code);
}

fn run() -> i32 {
    let options = match cli::parse(std::env::args().skip(1)) {
        Parsed::Run(options) => *options,
        Parsed::Print(text) => {
            print!("{text}");
            return EXIT_OK;
        }
        Parsed::Usage(message) => {
            eprintln!("riki-vision: {message}\n\n{}", cli::HELP);
            return EXIT_USAGE;
        }
    };

    let backend = build_backend(&options);
    let identity = identity_of(backend.as_ref());
    eprintln!(
        "riki-vision {} on {}: backend {} ({})",
        identity.version,
        identity.platform,
        identity.backend,
        if identity.backend_available {
            "available"
        } else {
            "unavailable — see --help"
        }
    );

    let mut session = Session::new(
        identity,
        CapturePipeline::new(backend),
        LineTransport::new(io::stdout().lock()),
        Box::new(MonotonicClock::new()),
    );

    let lines = spawn_stdin_reader();

    let exit = loop {
        match lines.recv_timeout(session.tick_interval()) {
            Ok(line) => {
                if let Some(code) = session.on_line(&line) {
                    break code;
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                if let Some(code) = session.tick() {
                    break code;
                }
            }
            // stdin closed: the app is gone. Exiting here is what keeps a crashed app from
            // leaving a sidecar behind holding a capture session.
            Err(RecvTimeoutError::Disconnected) => break EXIT_OK,
        }
    };

    session.shutdown();
    let _ = io::stdout().flush();
    exit
}

/// Reads stdin on its own thread so the loop can also run on a timer.
///
/// A line-oriented blocking read cannot be combined with a capture interval in one thread without
/// non-blocking I/O, which on three platforms is three implementations. A thread and a channel is
/// the same thing in fifteen lines, and the channel disconnecting *is* the EOF signal.
fn spawn_stdin_reader() -> mpsc::Receiver<String> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        for line in io::stdin().lock().lines() {
            match line {
                Ok(line) if line.trim().is_empty() => {}
                Ok(line) => {
                    if tx.send(line).is_err() {
                        return;
                    }
                }
                Err(error) => {
                    eprintln!("riki-vision: stdin read failed ({error}); treating as shutdown");
                    return;
                }
            }
        }
    });
    rx
}

fn identity_of(backend: &dyn CaptureBackend) -> SidecarIdentity {
    let info = backend.info();
    SidecarIdentity {
        name: env!("CARGO_PKG_NAME").to_owned(),
        version: env!("CARGO_PKG_VERSION").to_owned(),
        platform: std::env::consts::OS.to_owned(),
        backend: info.name.to_owned(),
        // Reported in the handshake rather than discovered on the first failed capture: the app
        // can tell the user "vision is unavailable on this build" before it has asked for a
        // single frame.
        backend_available: info.available,
    }
}

fn build_backend(options: &Options) -> Box<dyn CaptureBackend> {
    match options.backend {
        BackendChoice::Native => default_backend(),
        BackendChoice::Replay => {
            let dir = options
                .frames
                .as_deref()
                .unwrap_or_else(|| Path::new("fixtures/frames"));
            match load_frames(dir) {
                Ok(frames) => {
                    eprintln!(
                        "riki-vision: replaying {} frame(s) from {}",
                        frames.len(),
                        dir.display()
                    );
                    Box::new(ReplayBackend::new(frames))
                }
                // Not an exit: a sidecar that dies on a bad path is a restart loop, and the app
                // learns nothing from it. Starting and saying why is a diagnosis the user can act
                // on.
                Err(detail) => Box::new(UnavailableBackend::new("replay", false, detail)),
            }
        }
    }
}

/// Read every `.ppm` in a directory, in name order.
fn load_frames(dir: &Path) -> Result<Vec<Frame>, String> {
    let entries = std::fs::read_dir(dir)
        .map_err(|error| format!("cannot read {}: {error}", dir.display()))?;

    let mut paths: Vec<_> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "ppm"))
        .collect();
    // Deterministic order: readdir order is filesystem-dependent, and a replay whose frames
    // arrive in a different order on another machine is a fixture that proves nothing.
    paths.sort();

    if paths.is_empty() {
        return Err(format!("no .ppm frames in {}", dir.display()));
    }

    let mut frames = Vec::with_capacity(paths.len());
    for path in paths {
        let bytes = std::fs::read(&path)
            .map_err(|error| format!("cannot read {}: {error}", path.display()))?;
        let frame =
            Frame::from_ppm(&bytes).map_err(|error| format!("{}: {error}", path.display()))?;
        frames.push(frame);
    }
    Ok(frames)
}
