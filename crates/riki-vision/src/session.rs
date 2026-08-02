//! The protocol loop, with no I/O of its own.
//!
//! `Session` owns everything that happens between a line arriving and an event going out, and it
//! is generic over the writer and the backend so that all of it is a unit test: the handshake, the
//! command ordering, the shape of a detections message, and what happens when capture fails. The
//! binary's job is reduced to threads, a clock and two file descriptors.

use std::io::Write;
use std::time::{Duration, Instant};

use riki_capture::{format_hash, CaptureBackend, CapturePipeline, Diagnosis};
use riki_ipc::{
    decode_command, events, CaptureConfig, CvFact, DetectionPayload, Handshake, HandshakeOutcome,
    LineTransport, ProblemKind, SidecarCommand, SidecarEvent, SidecarIdentity, PROTOCOL_VERSION,
};

/// Provenance carried by every fact this build emits.
///
/// Versioned in its own right: when the digest gains a field or changes how coverage is computed,
/// facts recorded under the old detector must not silently become facts under the new one.
pub const DETECTOR: &str = "region-digest/v1";

/// How often the loop wakes when it is not capturing.
///
/// Only to notice a closed stdin promptly; nothing else happens on an idle tick. Two wakeups a
/// second is not measurable against the ≤3% of one core budget, and the alternative — blocking
/// forever on stdin — makes the shutdown path depend on the reader thread rather than the loop.
pub const IDLE_TICK: Duration = Duration::from_millis(500);

/// Clean exit: `shutdown`, or the app closed our stdin.
pub const EXIT_OK: i32 = 0;

/// A monotonic clock, injected so a test can assert timestamps.
pub trait Clock {
    /// Milliseconds since some fixed point in this process. Never wall-clock.
    fn now_ms(&self) -> f64;
}

/// `Instant`-based, which is monotonic on every platform we target.
#[derive(Debug)]
pub struct MonotonicClock {
    start: Instant,
}

impl MonotonicClock {
    /// Starts now.
    #[must_use]
    pub fn new() -> Self {
        Self {
            start: Instant::now(),
        }
    }
}

impl Default for MonotonicClock {
    fn default() -> Self {
        Self::new()
    }
}

impl Clock for MonotonicClock {
    fn now_ms(&self) -> f64 {
        self.start.elapsed().as_secs_f64() * 1000.0
    }
}

/// The sidecar's state between messages.
pub struct Session<W: Write, B: CaptureBackend> {
    handshake: Handshake,
    transport: LineTransport<W>,
    pipeline: CapturePipeline<B>,
    clock: Box<dyn Clock>,
    config: Option<CaptureConfig>,
    capturing: bool,
    acquired: bool,
    write_failed: bool,
}

impl<W: Write, B: CaptureBackend> Session<W, B> {
    /// Assemble a session. Nothing is emitted until the first line arrives.
    pub fn new(
        identity: SidecarIdentity,
        pipeline: CapturePipeline<B>,
        transport: LineTransport<W>,
        clock: Box<dyn Clock>,
    ) -> Self {
        Self {
            handshake: Handshake::new(identity),
            transport,
            pipeline,
            clock,
            config: None,
            capturing: false,
            acquired: false,
            write_failed: false,
        }
    }

    /// How long the caller should wait for the next line before calling [`Self::tick`].
    #[must_use]
    pub fn tick_interval(&self) -> Duration {
        match (&self.config, self.capturing) {
            (Some(config), true) => Duration::from_millis(config.interval_ms),
            _ => IDLE_TICK,
        }
    }

    /// Handle one line of stdin. `Some(code)` means the process should exit with that code.
    pub fn on_line(&mut self, line: &str) -> Option<i32> {
        match self.handshake.admit(decode_command(line)) {
            HandshakeOutcome::Reply(event) => {
                self.emit(&event);
                self.exit_if_broken()
            }
            HandshakeOutcome::Fatal(event, code) => {
                self.emit(&event);
                // The problem goes out before the exit, which is the whole point of reporting a
                // version mismatch rather than dying on a parse error.
                Some(code)
            }
            HandshakeOutcome::Execute(command) => self.execute(command),
        }
    }

    /// Run one capture pass, if capturing.
    pub fn tick(&mut self) -> Option<i32> {
        if !self.capturing {
            return self.exit_if_broken();
        }
        let Some(config) = self.config.clone() else {
            return self.exit_if_broken();
        };

        if !self.acquired {
            // Before `acquire`, not after: a pushing backend fixes its frame interval when it
            // builds its stream, and this is the first moment the configured rate is known.
            self.pipeline
                .set_frame_interval(Duration::from_millis(config.interval_ms));
            let acquisition = self.pipeline.acquire(&config.target);
            if let Some(diagnosis) = acquisition.diagnosis {
                self.report(&diagnosis);
            }
            if acquisition.geometry.is_none() {
                // Keep trying on the next tick: Dota may simply not be open yet, and a sidecar
                // that gave up would need the app to notice and respawn it.
                return self.exit_if_broken();
            }
            self.acquired = true;
        }

        let captured_at = self.clock.now_ms();
        let pass = self.pipeline.pass(&config.regions);
        if !pass.captured {
            // The session is gone, not just this pass. Re-acquire before the next one.
            self.acquired = false;
        }
        if let Some(diagnosis) = pass.diagnosis {
            self.report(&diagnosis);
        }

        if !pass.digests.is_empty() {
            let facts: Vec<CvFact> = pass
                .digests
                .iter()
                .map(|digest| CvFact {
                    region_id: digest.id,
                    detector: DETECTOR.to_owned(),
                    // Coverage is the confidence: a region that was clipped by the window edge is
                    // a weaker claim than one that was not, and dota2 §4 rule 3 wants that
                    // difference to survive rather than be rounded to "fine".
                    confidence: f64::from(digest.coverage),
                    captured_at_mono_ms: captured_at,
                    payload: DetectionPayload::RegionDigest {
                        hash: format_hash(digest.hash),
                        width: u64::from(digest.rect.w),
                        height: u64::from(digest.rect.h),
                        mean_luma: f64::from(digest.mean_luma),
                        changed: digest.changed,
                    },
                })
                .collect();

            // Unchanged regions are reported too, with `changed: false`. The gate exists to skip
            // *recognition*, not to go quiet: the app treats silence as a health signal, and a
            // sidecar that says nothing while the scoreboard is closed is indistinguishable from
            // one that has wedged.
            self.emit(&SidecarEvent::CvDetections {
                v: PROTOCOL_VERSION,
                emitted_at_mono_ms: self.clock.now_ms(),
                facts,
            });
        }

        self.exit_if_broken()
    }

    /// Release the capture session. Called before exit.
    pub fn shutdown(&mut self) {
        self.pipeline.release();
        self.capturing = false;
        self.acquired = false;
    }

    fn execute(&mut self, command: SidecarCommand) -> Option<i32> {
        match command {
            SidecarCommand::CaptureConfigure { config, .. } => {
                self.config = Some(config);
                // A new region list against an old session would hash regions of a window we are
                // no longer sure about; drop the session and let the next tick re-acquire.
                if self.capturing {
                    self.pipeline.release();
                    self.acquired = false;
                }
            }

            SidecarCommand::CaptureStart { .. } => {
                if self.config.is_none() {
                    self.emit(&events::degraded(
                        ProblemKind::CaptureFailed,
                        "capture.start arrived before capture.configure; there is no window to \
                         capture and no regions to crop",
                    ));
                    return self.exit_if_broken();
                }
                self.capturing = true;
                self.acquired = false;
                // Capture immediately rather than after one interval: the first pass is also the
                // app's first evidence that the sidecar works, and making it wait makes a healthy
                // sidecar look slow to start.
                return self.tick();
            }

            SidecarCommand::CaptureStop { .. } => {
                self.pipeline.release();
                self.capturing = false;
                self.acquired = false;
            }

            SidecarCommand::Shutdown { .. } => {
                self.shutdown();
                return Some(EXIT_OK);
            }

            // Answered by the handshake before it ever reaches here.
            SidecarCommand::Hello { .. } => {}
        }
        self.exit_if_broken()
    }

    fn report(&mut self, diagnosis: &Diagnosis) {
        self.emit(&events::degraded(diagnosis.kind, diagnosis.message.clone()));
    }

    fn emit(&mut self, event: &SidecarEvent) {
        if self.write_failed {
            return;
        }
        if let Err(error) = self.transport.emit(event) {
            // A broken pipe means the app is gone. There is nowhere left to report it, so it goes
            // to stderr — which the supervisor forwards while it still exists — and the loop ends.
            eprintln!("riki-vision: stdout is gone ({error}); exiting");
            self.write_failed = true;
        }
    }

    const fn exit_if_broken(&self) -> Option<i32> {
        if self.write_failed {
            Some(EXIT_OK)
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use riki_capture::{Frame, ReplayBackend};
    use riki_ipc::{
        AppIdentity, CaptureRegion, NormalizedRect, RegionId, WindowTarget, EXIT_PROTOCOL_MISMATCH,
    };
    use std::cell::Cell;
    use std::rc::Rc;

    /// A clock that advances by a fixed step on every read, so timestamps are assertable.
    struct StepClock {
        next: Cell<f64>,
        step: f64,
    }

    impl Clock for StepClock {
        fn now_ms(&self) -> f64 {
            let value = self.next.get();
            self.next.set(value + self.step);
            value
        }
    }

    /// Collects emitted lines where a test can read them.
    #[derive(Clone, Default)]
    struct Sink(Rc<std::cell::RefCell<Vec<u8>>>);

    impl Write for Sink {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.borrow_mut().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    struct Harness {
        session: Session<Sink, ReplayBackend>,
        sink: Sink,
    }

    fn frame(value: u8) -> Frame {
        Frame::new(8, 8, vec![value; 8 * 8 * 4]).expect("well-formed")
    }

    fn harness(frames: Vec<Frame>) -> Harness {
        let sink = Sink::default();
        let session = Session::new(
            SidecarIdentity {
                name: "riki-vision".to_owned(),
                version: "0.0.0".to_owned(),
                platform: "test".to_owned(),
                backend: "replay".to_owned(),
                backend_available: true,
            },
            CapturePipeline::new(ReplayBackend::new(frames)),
            LineTransport::new(sink.clone()),
            Box::new(StepClock {
                next: Cell::new(1000.0),
                step: 5.0,
            }),
        );
        Harness { session, sink }
    }

    impl Harness {
        fn send(&mut self, command: &SidecarCommand) -> Option<i32> {
            let line = serde_json::to_string(command).expect("commands serialise");
            self.session.on_line(&line)
        }

        fn events(&self) -> Vec<SidecarEvent> {
            let bytes = self.sink.0.borrow().clone();
            String::from_utf8(bytes)
                .expect("utf-8")
                .lines()
                .map(|line| serde_json::from_str(line).expect("we wrote it, we can read it"))
                .collect()
        }
    }

    fn hello() -> SidecarCommand {
        SidecarCommand::Hello {
            v: PROTOCOL_VERSION,
            app: AppIdentity {
                name: "riki".to_owned(),
                build: "test".to_owned(),
            },
        }
    }

    fn configure() -> SidecarCommand {
        SidecarCommand::CaptureConfigure {
            v: PROTOCOL_VERSION,
            config: CaptureConfig {
                target: WindowTarget {
                    process_name: "dota2".to_owned(),
                    title_contains: "Dota 2".to_owned(),
                },
                regions: vec![CaptureRegion {
                    id: RegionId::Minimap,
                    rect: NormalizedRect {
                        x: 0.0,
                        y: 0.5,
                        w: 0.5,
                        h: 0.5,
                    },
                }],
                interval_ms: 200,
            },
        }
    }

    #[test]
    fn the_first_thing_it_says_is_ready() {
        let mut harness = harness(vec![frame(90)]);
        assert_eq!(harness.send(&hello()), None);

        let events = harness.events();
        assert_eq!(events.len(), 1);
        assert!(matches!(events[0], SidecarEvent::Ready { .. }));
    }

    #[test]
    fn captures_and_emits_a_fact_with_confidence_provenance_and_a_timestamp() {
        let mut harness = harness(vec![frame(90)]);
        harness.send(&hello());
        harness.send(&configure());
        harness.send(&SidecarCommand::CaptureStart {
            v: PROTOCOL_VERSION,
        });

        let events = harness.events();
        let SidecarEvent::CvDetections {
            facts,
            emitted_at_mono_ms,
            ..
        } = events.last().expect("something was emitted")
        else {
            panic!("expected detections, got {events:?}");
        };

        assert_eq!(facts.len(), 1);
        let fact = &facts[0];
        assert_eq!(fact.region_id, RegionId::Minimap);
        assert_eq!(fact.detector, DETECTOR);
        assert!(fact.confidence > 0.99, "{}", fact.confidence);
        // The two timestamps are sidecar-local and only their difference crosses the boundary;
        // an emit that predates its capture would make that difference negative.
        assert!(
            *emitted_at_mono_ms >= fact.captured_at_mono_ms,
            "{emitted_at_mono_ms} < {}",
            fact.captured_at_mono_ms
        );

        // `let ... else` rather than an irrefutable binding: `DetectionPayload` gained a
        // `minimap.hero` variant for `FakeVisionSidecar` to emit (ADR-0035), and this crate has no
        // atlas to produce one with — so a pass that reported anything but a digest is a bug here,
        // and saying so beats failing to compile the next time the protocol grows a detector.
        let DetectionPayload::RegionDigest {
            hash,
            width,
            height,
            changed,
            ..
        } = &fact.payload
        else {
            panic!("this crate has no recogniser; every fact it emits is a region digest");
        };
        assert_eq!(hash.len(), 16);
        assert_eq!((*width, *height), (4, 4));
        assert!(changed, "the first sighting of a region is a change");
    }

    #[test]
    fn a_second_identical_pass_is_reported_as_unchanged_rather_than_going_quiet() {
        // Silence is the app's health signal. The gate skips recognition, not reporting.
        let mut harness = harness(vec![frame(90), frame(90)]);
        harness.send(&hello());
        harness.send(&configure());
        harness.send(&SidecarCommand::CaptureStart {
            v: PROTOCOL_VERSION,
        });
        harness.session.tick();

        let detections: Vec<_> = harness
            .events()
            .into_iter()
            .filter_map(|event| match event {
                SidecarEvent::CvDetections { facts, .. } => Some(facts),
                _ => None,
            })
            .collect();

        assert_eq!(detections.len(), 2);
        let DetectionPayload::RegionDigest { changed, .. } = &detections[1][0].payload else {
            panic!("this crate has no recogniser; every fact it emits is a region digest");
        };
        assert!(!changed);
    }

    #[test]
    fn refuses_to_start_capturing_before_it_has_been_configured() {
        let mut harness = harness(vec![frame(90)]);
        harness.send(&hello());
        harness.send(&SidecarCommand::CaptureStart {
            v: PROTOCOL_VERSION,
        });

        let events = harness.events();
        let SidecarEvent::Problem { problem, .. } = events.last().expect("a problem") else {
            panic!("expected a problem, got {events:?}");
        };
        assert_eq!(problem.kind, ProblemKind::CaptureFailed);
        assert!(!problem.fatal, "a missing configure is not fatal");
    }

    #[test]
    fn a_version_mismatch_reports_itself_and_then_exits() {
        let mut harness = harness(vec![frame(90)]);
        let code = harness
            .session
            .on_line(r#"{"v":99,"type":"hello","app":{"name":"riki","build":"x"}}"#);

        assert_eq!(code, Some(EXIT_PROTOCOL_MISMATCH));
        let events = harness.events();
        let SidecarEvent::Problem { problem, .. } = &events[0] else {
            panic!("expected a problem, got {events:?}");
        };
        assert_eq!(problem.kind, ProblemKind::ProtocolVersionMismatch);
        assert!(problem.fatal);
    }

    #[test]
    fn stop_ends_capture_and_a_later_tick_emits_nothing() {
        let mut harness = harness(vec![frame(90), frame(91)]);
        harness.send(&hello());
        harness.send(&configure());
        harness.send(&SidecarCommand::CaptureStart {
            v: PROTOCOL_VERSION,
        });
        harness.send(&SidecarCommand::CaptureStop {
            v: PROTOCOL_VERSION,
        });
        let before = harness.events().len();
        harness.session.tick();

        assert_eq!(harness.events().len(), before);
    }

    #[test]
    fn shutdown_exits_cleanly() {
        let mut harness = harness(vec![frame(90)]);
        harness.send(&hello());
        assert_eq!(
            harness.send(&SidecarCommand::Shutdown {
                v: PROTOCOL_VERSION
            }),
            Some(EXIT_OK)
        );
    }

    #[test]
    fn the_tick_interval_follows_the_configured_rate_and_idles_otherwise() {
        let mut harness = harness(vec![frame(90)]);
        assert_eq!(harness.session.tick_interval(), IDLE_TICK);

        harness.send(&hello());
        harness.send(&configure());
        harness.send(&SidecarCommand::CaptureStart {
            v: PROTOCOL_VERSION,
        });
        assert_eq!(harness.session.tick_interval(), Duration::from_millis(200));
    }

    #[test]
    fn an_unusable_backend_is_reported_as_a_problem_rather_than_as_silence() {
        // An empty replay directory stands in for every backend that cannot capture — including
        // the platform ones, which is the state every platform is in today.
        let mut harness = harness(Vec::new());
        harness.send(&hello());
        harness.send(&configure());
        harness.send(&SidecarCommand::CaptureStart {
            v: PROTOCOL_VERSION,
        });
        for _ in 0..4 {
            harness.session.tick();
        }

        let problems: Vec<_> = harness
            .events()
            .into_iter()
            .filter_map(|event| match event {
                SidecarEvent::Problem { problem, .. } => Some(problem),
                _ => None,
            })
            .collect();

        assert_eq!(problems.len(), 1, "reported once, not once per tick");
        assert_eq!(problems[0].kind, ProblemKind::WindowNotFound);
        assert!(problems[0].remedy.is_some(), "the user can act on this one");
    }

    #[test]
    fn a_malformed_line_is_reported_and_the_session_carries_on() {
        let mut harness = harness(vec![frame(90)]);
        harness.send(&hello());
        assert_eq!(harness.session.on_line("not json at all"), None);

        harness.send(&configure());
        harness.send(&SidecarCommand::CaptureStart {
            v: PROTOCOL_VERSION,
        });
        assert!(
            harness
                .events()
                .iter()
                .any(|event| matches!(event, SidecarEvent::CvDetections { .. })),
            "one bad line must not end the session"
        );
    }
}
