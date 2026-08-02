//! The real binary, spawned, spoken to over real pipes.
//!
//! Everything the sidecar decides is already covered by unit tests in `session.rs`. What only a
//! process can show is the part `apps/desktop/src/main/sidecar` actually depends on: that stdout
//! carries protocol and nothing else, that a closed stdin is a shutdown, and that the exit codes a
//! supervisor logs mean what they say.
//!
//! No display, no GPU, no Dota: the binary runs against `fixtures/frames/synthetic`, which is why
//! this is a test an agent can run rather than a thing somebody once watched happen.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdout, Command, Stdio};
use std::time::Duration;

const HELLO: &str = r#"{"v":1,"type":"hello","app":{"name":"riki","build":"test"}}"#;
const START: &str = r#"{"v":1,"type":"capture.start"}"#;
const SHUTDOWN: &str = r#"{"v":1,"type":"shutdown"}"#;

fn configure() -> String {
    // A minimap-shaped region in the bottom-left corner, at 20 Hz so the test does not sleep.
    r#"{"v":1,"type":"capture.configure","config":{"target":{"processName":"dota2",
       "titleContains":"Dota 2"},"regions":[{"id":"minimap","rect":{"x":0.0,"y":0.75,
       "w":0.18,"h":0.25}}],"intervalMs":50}}"#
        .replace(['\n', ' '], "")
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|crates| crates.parent())
        .expect("crates/riki-vision is two levels below the repo root")
        .to_path_buf()
}

struct Sidecar {
    child: Child,
    out: BufReader<ChildStdout>,
}

impl Sidecar {
    fn spawn(args: &[&str]) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_riki-vision"))
            .args(args)
            .current_dir(repo_root())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // Inherited so a panic trace lands in the test output rather than in a pipe nobody
            // reads. stderr is not protocol.
            .stderr(Stdio::inherit())
            .spawn()
            .expect("the binary was just built");
        let out = BufReader::new(child.stdout.take().expect("piped"));
        Self { child, out }
    }

    fn replay() -> Self {
        Self::spawn(&[
            "--backend",
            "replay",
            "--frames",
            "fixtures/frames/synthetic",
        ])
    }

    fn send(&mut self, line: &str) {
        let stdin = self.child.stdin.as_mut().expect("piped");
        writeln!(stdin, "{line}").expect("the sidecar is alive");
        stdin.flush().expect("the sidecar is alive");
    }

    /// Read one line of protocol. Blocks; the process is killed by `Drop` if the test fails.
    fn next_message(&mut self) -> serde_json::Value {
        let mut line = String::new();
        let read = self.out.read_line(&mut line).expect("stdout is readable");
        assert!(read > 0, "the sidecar closed stdout without answering");
        serde_json::from_str(&line)
            .unwrap_or_else(|error| panic!("stdout must be protocol only, got {line:?} ({error})"))
    }

    /// Close stdin, wait, and return the exit code.
    fn wait(&mut self) -> i32 {
        drop(self.child.stdin.take());
        self.child
            .wait()
            .expect("the sidecar exits")
            .code()
            .expect("the sidecar is not killed by a signal")
    }
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn completes_the_handshake_before_anything_else() {
    let mut sidecar = Sidecar::replay();
    sidecar.send(HELLO);

    let ready = sidecar.next_message();
    assert_eq!(ready["type"], "ready");
    assert_eq!(ready["v"], 1);
    assert_eq!(ready["sidecar"]["backend"], "replay");
    assert_eq!(ready["sidecar"]["backendAvailable"], true);
    assert_eq!(ready["sidecar"]["platform"], std::env::consts::OS);
}

#[test]
fn captures_a_real_region_and_reports_it_with_confidence_provenance_and_a_timestamp() {
    let mut sidecar = Sidecar::replay();
    sidecar.send(HELLO);
    sidecar.send(&configure());
    sidecar.send(START);

    assert_eq!(sidecar.next_message()["type"], "ready");
    let detections = sidecar.next_message();
    assert_eq!(detections["type"], "cv.detections");

    let fact = &detections["facts"][0];
    assert_eq!(fact["regionId"], "minimap");
    // No bare facts: REPO_SKELETON.md §4 makes these three non-optional, and this is the assertion
    // that says the sidecar actually fills them rather than the schema merely requiring them.
    assert_eq!(fact["detector"], "region-digest/v1");
    assert!(fact["confidence"].as_f64().expect("a number") > 0.0);
    assert!(fact["capturedAtMonoMs"].as_f64().expect("a number") >= 0.0);

    // A real crop of a real fixture frame: 160x90, so the bottom-left 18%x25% is 29x23 pixels.
    let payload = &fact["payload"];
    assert_eq!(payload["kind"], "region.digest");
    assert_eq!(payload["width"], 29);
    assert_eq!(payload["height"], 23);
    assert_eq!(
        payload["hash"].as_str().expect("a string").len(),
        16,
        "a 64-bit hash in hex"
    );
    // The fixture frames are not black, so a zero here would mean the crop missed the frame.
    assert!(payload["meanLuma"].as_f64().expect("a number") > 0.0);
}

#[test]
fn a_protocol_version_mismatch_is_reported_and_then_exits_with_its_own_code() {
    let mut sidecar = Sidecar::replay();
    sidecar.send(r#"{"v":99,"type":"hello","app":{"name":"riki","build":"future"}}"#);

    let problem = sidecar.next_message();
    assert_eq!(problem["type"], "problem");
    assert_eq!(problem["problem"]["kind"], "protocol_version_mismatch");
    assert_eq!(problem["problem"]["fatal"], true);
    // Distinct from a panic's 101 and from a clean 0, so the supervisor's log says which happened.
    assert_eq!(sidecar.wait(), 2);
}

#[test]
fn a_closed_stdin_shuts_the_sidecar_down() {
    // The orphan case: if Electron dies, nothing sends `shutdown`, and a sidecar that waited for
    // one would sit holding a capture session with nobody listening.
    let mut sidecar = Sidecar::replay();
    sidecar.send(HELLO);
    assert_eq!(sidecar.next_message()["type"], "ready");

    assert_eq!(sidecar.wait(), 0);
}

#[test]
fn shutdown_exits_cleanly_while_capturing() {
    let mut sidecar = Sidecar::replay();
    sidecar.send(HELLO);
    sidecar.send(&configure());
    sidecar.send(START);
    assert_eq!(sidecar.next_message()["type"], "ready");
    assert_eq!(sidecar.next_message()["type"], "cv.detections");

    sidecar.send(SHUTDOWN);
    assert_eq!(sidecar.wait(), 0);
}

#[test]
fn a_line_of_rubbish_is_reported_without_ending_the_session() {
    let mut sidecar = Sidecar::replay();
    sidecar.send(HELLO);
    assert_eq!(sidecar.next_message()["type"], "ready");

    sidecar.send("thread 'main' panicked at src/main.rs:1:1");
    let problem = sidecar.next_message();
    assert_eq!(problem["problem"]["kind"], "malformed_message");
    assert_eq!(problem["problem"]["fatal"], false);

    // Still alive and still able to work.
    sidecar.send(&configure());
    sidecar.send(START);
    assert_eq!(sidecar.next_message()["type"], "cv.detections");
}

#[test]
fn a_command_before_the_handshake_is_refused_rather_than_obeyed() {
    let mut sidecar = Sidecar::replay();
    sidecar.send(&configure());
    sidecar.send(START);

    let problem = sidecar.next_message();
    assert_eq!(problem["problem"]["kind"], "handshake_required");
    assert!(problem["problem"]["message"]
        .as_str()
        .expect("a string")
        .contains("capture.configure"));
}

#[test]
fn the_platform_backend_says_it_cannot_capture_instead_of_going_quiet() {
    // Today every platform's backend is unavailable (`riki_capture::platform`). The behaviour that
    // matters is that the app is *told*, in the handshake and again as a problem, rather than
    // waiting for detections that will never come.
    let mut sidecar = Sidecar::spawn(&[]);
    sidecar.send(HELLO);

    let ready = sidecar.next_message();
    assert_eq!(ready["sidecar"]["backendAvailable"], false);

    sidecar.send(&configure());
    sidecar.send(START);
    let problem = sidecar.next_message();
    assert_eq!(problem["problem"]["kind"], "backend_unavailable");
    // Not fatal: the app decides whether to keep a useless sidecar alive, and a self-terminating
    // one would just be restarted by the supervisor in a loop.
    assert_eq!(problem["problem"]["fatal"], false);
}

#[test]
fn bad_arguments_exit_with_a_usage_code_rather_than_starting_a_session() {
    let output = Command::new(env!("CARGO_BIN_EXE_riki-vision"))
        .arg("--backend")
        .arg("telepathy")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("the binary was just built");

    assert_eq!(output.status.code(), Some(3));
    assert!(output.stdout.is_empty(), "usage errors are not protocol");
}

#[test]
fn keeps_capturing_across_several_intervals_without_being_asked_again() {
    let mut sidecar = Sidecar::replay();
    sidecar.send(HELLO);
    sidecar.send(&configure());
    sidecar.send(START);
    assert_eq!(sidecar.next_message()["type"], "ready");

    let mut seen = 0;
    for _ in 0..3 {
        assert_eq!(sidecar.next_message()["type"], "cv.detections");
        seen += 1;
    }
    assert_eq!(seen, 3);

    // And it is still responsive to a command while the timer is running.
    sidecar.send(SHUTDOWN);
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(sidecar.wait(), 0);
}
