//! The `ScreenCaptureKit` backend — the one that ships.
//!
//! # What this is
//!
//! A [`CaptureBackend`](crate::backend::CaptureBackend) over a single `SCStream` scoped to the Dota
//! 2 window by `SCContentFilter::initWithDesktopIndependentWindow:`. That initialiser is the whole
//! privacy story (dota2 §7, [ADR-0003]): the filter is constructed from one `SCWindow`, so the
//! stream is *incapable* of delivering the desktop or another application's window. There is no
//! display-scoped path in this file, and there must not be one.
//!
//! # The shape of the problem: `ScreenCaptureKit` pushes, the seam pulls
//!
//! `CaptureBackend::capture` is called on a timer and must return promptly. `SCStream` instead
//! calls a delegate on a dispatch queue whenever it has a frame. The adaptation is a shared slot:
//! the delegate crops each delivered frame and stores the crops, and `capture` takes whatever is
//! there.
//!
//! Two consequences are worth stating, because both look like bugs and are not:
//!
//! - **`capture` returns the last crops even when no new frame has arrived.** A static window stops
//!   producing frames — `SCFrameStatus` goes `Idle` and the sample buffer carries no image buffer —
//!   and in that case the previous crops are still an accurate description of the screen. The
//!   change gate then reports `changed: false`, which is exactly right. Returning an error would
//!   turn "nothing is happening" into a problem report at the capture rate.
//! - **The crop happens in the delegate, not in `capture`.** That is what keeps the copy
//!   region-sized. See [`crate::pixels`] for why the copy is per-region rather than per-frame.
//!
//! # Permission
//!
//! macOS gates this behind Screen Recording, and there are two distinct signals. The explicit one
//! is an error from `SCShareableContent` (`SCStreamErrorUserDeclined`), which this module maps
//! straight to [`CaptureError::PermissionDenied`]. The implicit one is a stream that starts and
//! delivers **black** frames, which is what a revoked-mid-session permission looks like; that one
//! is not detectable in a single call and is diagnosed above the seam by [`crate::health`], which
//! is why [`crate::backend::BackendInfo::black_frames_mean_permission_denied`] is true here.
//!
//! [ADR-0003]: ../../../docs/adr/0003-read-only-observation-only.md

// ScreenCaptureKit is an Objective-C API and every call into it is `unsafe`. The workspace lints
// `unsafe_code` at `warn` precisely so that its appearances are deliberate and confined; this
// module is the confinement. Nothing outside it in this crate contains an `unsafe` block, and the
// pixel arithmetic that would otherwise be the risky part is safe Rust in `crate::pixels`.
#![allow(unsafe_code)]

use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use block2::RcBlock;
use dispatch2::DispatchQueue;
use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2::{define_class, msg_send, AllocAnyThread, DefinedClass};
use objc2_core_graphics::{CGDisplayCopyDisplayMode, CGDisplayMode};
use objc2_core_media::CMSampleBuffer;
use objc2_core_video::{
    CVPixelBufferGetBaseAddress, CVPixelBufferGetBytesPerRow, CVPixelBufferGetHeight,
    CVPixelBufferGetPixelFormatType, CVPixelBufferGetWidth, CVPixelBufferLockBaseAddress,
    CVPixelBufferLockFlags, CVPixelBufferUnlockBaseAddress,
};
use objc2_foundation::{NSError, NSObject, NSObjectProtocol};
use objc2_screen_capture_kit::{
    SCContentFilter, SCShareableContent, SCStream, SCStreamConfiguration, SCStreamDelegate,
    SCStreamOutput, SCStreamOutputType, SCWindow,
};
use riki_ipc::{CaptureRegion, WindowTarget};

use crate::backend::{BackendInfo, CaptureBackend, CaptureError, CapturedRegion};
use crate::geometry::{resolve, WindowGeometry};
use crate::pixels::crop_bgra_to_rgba;
use crate::window_match::{select, WindowCandidate};

/// `kCVPixelFormatType_32BGRA`, the format this backend asks for and the only one it can read.
///
/// Spelled as the four-character code Apple documents rather than as a decimal, so it is greppable
/// against their headers.
const PIXEL_FORMAT_32_BGRA: u32 = u32::from_be_bytes(*b"BGRA");

/// How long to wait for `SCShareableContent`, which goes out to a system service.
const CONTENT_TIMEOUT: Duration = Duration::from_secs(5);

/// How long to wait for `startCapture` to come back.
const START_TIMEOUT: Duration = Duration::from_secs(5);

/// How long `acquire` waits for the first frame before giving up on the session.
///
/// Generous on purpose: the first frame after `startCapture` includes the compositor spinning up a
/// capture path for the window, and a too-eager failure here would show the user a capture problem
/// on a session that was about to work.
const FIRST_FRAME_TIMEOUT: Duration = Duration::from_secs(3);

/// `SCStreamErrorUserDeclined` — the Screen Recording permission was refused.
const SC_STREAM_ERROR_USER_DECLINED: isize = -3801;

/// Moves an Objective-C object between threads, and nothing else.
///
/// # Safety
///
/// The `Retained<T>` inside is **transferred**, never shared: it is created inside a completion
/// handler, sent down a channel, and received by a thread that then has sole ownership. The
/// channel provides the happens-before edge, so there is no moment at which two threads hold the
/// same pointer. Objective-C reference counting is itself atomic, so the retain and the release may
/// legitimately happen on different threads.
///
/// This exists because objc2 conservatively declines to mark framework classes `Send` — correctly,
/// since most of them are not safe to *use* concurrently. Transfer is the narrower claim.
struct Transfer<T>(T);

// SAFETY: see the type's documentation — transfer-only, with the channel as the synchronisation
// edge, and atomic refcounting underneath.
unsafe impl<T> Send for Transfer<T> {}

/// Why the session will produce no more frames.
///
/// The distinction matters at the seam. A stream that *ended* looks to [`crate::health`] like a
/// window that went away, which — once one has been acquired — is the exclusive-fullscreen
/// signature it is meant to report. A backend that refused the frames it was being given is not
/// that, and calling it `WindowNotFound` would send the user to alt-tab out of a fullscreen mode
/// they are not in.
#[derive(Debug, Clone)]
enum Stopped {
    /// `stream:didStopWithError:` fired. The window closed, went exclusive-fullscreen, or the
    /// system tore the session down.
    StreamEnded,
    /// This backend will not read what it is being handed.
    Internal(String),
}

/// What the delegate produced from one frame.
#[derive(Debug)]
struct Delivered {
    /// Which region list these crops were taken for. See [`Inner::generation`].
    generation: u64,
    /// The window's true size in pixels, as reported by the pixel buffer itself.
    geometry: WindowGeometry,
    /// One entry per region that landed inside the window.
    regions: Vec<CapturedRegion>,
}

/// State shared between the capture thread and the dispatch queue the delegate runs on.
#[derive(Debug, Default)]
struct Inner {
    /// The regions the delegate should crop. Written by `capture`, read by the delegate.
    regions: Vec<CaptureRegion>,
    /// Bumped whenever `regions` changes.
    ///
    /// Without this, a `capture` call that has just changed the region list would return the
    /// previous frame's crops — the right pixels cut to the wrong rectangles — and the change gate
    /// would compare hashes across two different meanings of the same `RegionId`.
    generation: u64,
    /// The most recent frame's crops.
    latest: Option<Delivered>,
    /// Why the session is over. A stream that has stopped will never produce another frame, so
    /// this has to become an error rather than a silence.
    stopped: Option<Stopped>,
}

/// The shared slot plus the channel the first frame is announced on.
#[derive(Debug)]
struct Shared {
    inner: Mutex<Inner>,
    /// Signalled once, when the first frame lands, so `acquire` can report a real geometry.
    first_frame: Mutex<Option<Sender<WindowGeometry>>>,
}

impl Shared {
    fn new() -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
            first_frame: Mutex::new(None),
        }
    }

    /// Take the region list to crop for, without holding the lock across the pixel copy.
    fn crop_plan(&self) -> (u64, Vec<CaptureRegion>) {
        let inner = self.inner.lock().unwrap_or_else(|poisoned| {
            // A panic in the delegate must not wedge capture for the rest of the session.
            self.inner.clear_poison();
            poisoned.into_inner()
        });
        (inner.generation, inner.regions.clone())
    }

    fn publish(&self, delivered: Delivered) {
        let geometry = delivered.geometry;
        if let Ok(mut inner) = self.inner.lock() {
            inner.latest = Some(delivered);
        }
        // Only the first frame is announced; later ones just replace `latest`.
        if let Ok(mut slot) = self.first_frame.lock() {
            if let Some(sender) = slot.take() {
                let _ = sender.send(geometry);
            }
        }
    }

    fn stopped(&self, reason: Stopped) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.stopped = Some(reason);
        }
    }
}

define_class!(
    // SAFETY: `NSObject` imposes no subclassing requirements, and this type does not implement
    // `Drop` — its only ivar is an `Arc`, which the generated `dealloc` drops for us.
    #[unsafe(super(NSObject))]
    #[name = "RikiScreenCaptureKitOutput"]
    #[ivars = Arc<Shared>]
    struct StreamOutput;

    unsafe impl NSObjectProtocol for StreamOutput {}

    unsafe impl SCStreamOutput for StreamOutput {
        #[unsafe(method(stream:didOutputSampleBuffer:ofType:))]
        fn stream_did_output(
            &self,
            _stream: &SCStream,
            buffer: &CMSampleBuffer,
            kind: SCStreamOutputType,
        ) {
            if kind != SCStreamOutputType::Screen {
                // The stream is configured without audio, so this should not happen; if the
                // configuration ever changes, silently cropping an audio buffer would be far worse
                // than ignoring it.
                return;
            }
            self.handle_frame(buffer);
        }
    }

    unsafe impl SCStreamDelegate for StreamOutput {
        #[unsafe(method(stream:didStopWithError:))]
        fn stream_did_stop(&self, _stream: &SCStream, error: &NSError) {
            // The commonest cause in practice is the window closing — Dota quitting, or going into
            // exclusive fullscreen, which takes the window out from under the capture API. The
            // message is for the log; the seam only needs to know the session is over.
            eprintln!(
                "riki-vision: the capture stream stopped: {}",
                describe(error)
            );
            self.ivars().stopped(Stopped::StreamEnded);
        }
    }
);

impl StreamOutput {
    fn new(shared: Arc<Shared>) -> Retained<Self> {
        let this = Self::alloc().set_ivars(shared);
        unsafe { msg_send![super(this), init] }
    }

    /// Crop one delivered frame into the shared slot.
    ///
    /// Runs on the dispatch queue, so it must not block on anything the capture thread holds.
    fn handle_frame(&self, buffer: &CMSampleBuffer) {
        // An `Idle` frame carries no image buffer. That is not a failure: the window simply has not
        // changed, and the crops already in the slot still describe it.
        // SAFETY: `buffer` is the live sample buffer the delegate was handed.
        let Some(image) = (unsafe { buffer.image_buffer() }) else {
            return;
        };

        let shared = self.ivars();
        let (generation, regions) = shared.crop_plan();

        // SAFETY: `image` is a live `CVPixelBuffer` owned by the sample buffer, which outlives this
        // call. The lock is read-only and released on every path below.
        let locked =
            unsafe { CVPixelBufferLockBaseAddress(&image, CVPixelBufferLockFlags::ReadOnly) };
        if locked != 0 {
            return;
        }

        let delivered = self.crop_locked(&image, generation, &regions);

        // SAFETY: paired with the successful lock above, same flags.
        unsafe {
            CVPixelBufferUnlockBaseAddress(&image, CVPixelBufferLockFlags::ReadOnly);
        }

        if let Some(delivered) = delivered {
            shared.publish(delivered);
        }
    }

    /// The pixel work, with the buffer already locked.
    fn crop_locked(
        &self,
        image: &objc2_core_video::CVPixelBuffer,
        generation: u64,
        regions: &[CaptureRegion],
    ) -> Option<Delivered> {
        if CVPixelBufferGetPixelFormatType(image) != PIXEL_FORMAT_32_BGRA {
            // The configuration asks for BGRA, so this would mean macOS silently substituted a
            // format. Reading it as BGRA would emit convincing garbage to the CV layer.
            self.ivars().stopped(Stopped::Internal(
                "the capture stream delivered a pixel format other than 32BGRA".to_owned(),
            ));
            return None;
        }

        let width = u32::try_from(CVPixelBufferGetWidth(image)).ok()?;
        let height = u32::try_from(CVPixelBufferGetHeight(image)).ok()?;
        let bytes_per_row = CVPixelBufferGetBytesPerRow(image);
        let base = CVPixelBufferGetBaseAddress(image);
        if base.is_null() || width == 0 || height == 0 {
            return None;
        }

        // SAFETY: the buffer is locked, so `base` points at `bytes_per_row * height` readable
        // bytes for the duration of this borrow. The slice is never held past the unlock.
        let bytes = unsafe {
            std::slice::from_raw_parts(base.cast::<u8>(), bytes_per_row * (height as usize))
        };

        let geometry = WindowGeometry::new(width, height);
        let mut cropped = Vec::with_capacity(regions.len());
        for region in regions {
            // A region entirely outside the window is absent rather than empty — see
            // `geometry::resolve`.
            let Some(resolved) = resolve(&region.rect, geometry) else {
                continue;
            };
            cropped.push(CapturedRegion {
                id: region.id,
                rect: resolved.rect,
                coverage: resolved.coverage,
                pixels: crop_bgra_to_rgba(bytes, bytes_per_row, resolved.rect),
            });
        }

        Some(Delivered {
            generation,
            geometry,
            regions: cropped,
        })
    }
}

/// Capture from one window with `ScreenCaptureKit`.
pub struct ScreenCaptureKitBackend {
    shared: Arc<Shared>,
    /// Held so the stream is not deallocated while it is running; also what `release` stops.
    stream: Option<Retained<SCStream>>,
    /// Held for the same reason: `addStreamOutput:` does not retain the output.
    output: Option<Retained<StreamOutput>>,
    /// The queue the delegate runs on. Dropping it while the stream lives would be a use-after-free.
    queue: Option<dispatch2::DispatchRetained<DispatchQueue>>,
    /// How often the app wants a pass, used as the stream's minimum frame interval.
    interval: Duration,
}

impl std::fmt::Debug for ScreenCaptureKitBackend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // The Objective-C handles have no useful `Debug` and printing pointers into a log would
        // be noise; `running` is the one thing a reader wants.
        f.debug_struct("ScreenCaptureKitBackend")
            .field("running", &self.stream.is_some())
            .field("interval", &self.interval)
            .finish_non_exhaustive()
    }
}

impl ScreenCaptureKitBackend {
    /// A backend that will capture at most one frame per `interval`.
    ///
    /// The interval is the app's configured capture interval. Handing it to `SCStream` as
    /// `minimumFrameInterval` is most of the performance budget in one line: without it the stream
    /// runs at the display's refresh rate and the delegate crops sixty times a second for a
    /// consumer that reads five.
    #[must_use]
    pub fn new(interval: Duration) -> Self {
        Self {
            shared: Arc::new(Shared::new()),
            stream: None,
            output: None,
            queue: None,
            interval,
        }
    }

    /// Tear down any running session. Idempotent.
    fn stop(&mut self) {
        if let Some(stream) = self.stream.take() {
            let (sender, receiver) = channel();
            let handler = RcBlock::new(move |error: *mut NSError| {
                let _ = sender.send(error.is_null());
            });
            // SAFETY: `stream` is a live `SCStream` and the block matches the documented signature.
            unsafe { stream.stopCaptureWithCompletionHandler(Some(&handler)) };
            // Wait, but never for long: this runs on the way to process exit.
            let _ = receiver.recv_timeout(START_TIMEOUT);
        }
        self.output = None;
        self.queue = None;
        if let Ok(mut inner) = self.shared.inner.lock() {
            *inner = Inner::default();
        }
        if let Ok(mut slot) = self.shared.first_frame.lock() {
            *slot = None;
        }
    }
}

impl Drop for ScreenCaptureKitBackend {
    fn drop(&mut self) {
        self.stop();
    }
}

impl CaptureBackend for ScreenCaptureKitBackend {
    fn info(&self) -> BackendInfo {
        BackendInfo {
            name: "screencapturekit",
            available: true,
            // The permission returns black frames rather than an error once a session is already
            // running; `crate::health` turns a run of them into the diagnosis.
            black_frames_mean_permission_denied: true,
        }
    }

    fn acquire(&mut self, target: &WindowTarget) -> Result<WindowGeometry, CaptureError> {
        self.stop();

        let content = shareable_content()?;
        let window = find_window(&content, target)?;
        let filter = window_filter(&window);
        let configuration = stream_configuration(&window, self.interval);

        let shared = Arc::clone(&self.shared);
        let output = StreamOutput::new(Arc::clone(&shared));
        let queue = DispatchQueue::new("app.riki.vision.capture", None);

        let (sender, receiver) = channel();
        if let Ok(mut slot) = shared.first_frame.lock() {
            *slot = Some(sender);
        }

        let delegate = ProtocolObject::from_ref(&*output);
        // SAFETY: filter, configuration and delegate are all live, and the delegate outlives the
        // stream because both are stored on `self` below.
        let stream = unsafe {
            SCStream::initWithFilter_configuration_delegate(
                SCStream::alloc(),
                &filter,
                &configuration,
                Some(delegate),
            )
        };

        let sink = ProtocolObject::from_ref(&*output);
        // SAFETY: same objects; `addStreamOutput` does not take ownership, which is why `output`
        // and `queue` are held on `self`.
        unsafe {
            stream
                .addStreamOutput_type_sampleHandlerQueue_error(
                    sink,
                    SCStreamOutputType::Screen,
                    Some(&queue),
                )
                .map_err(|error| CaptureError::Failed {
                    detail: format!("could not attach the capture output: {}", describe(&error)),
                })?;
        }

        start_capture(&stream)?;

        self.stream = Some(stream);
        self.output = Some(output);
        self.queue = Some(queue);

        // The geometry comes from the first frame rather than from `SCWindow.frame`, because the
        // window's frame is in points and the pixel buffer is in pixels. On a Retina display those
        // differ by the backing scale factor, and every normalised region would resolve against a
        // window half the true size.
        match receiver.recv_timeout(FIRST_FRAME_TIMEOUT) {
            Ok(geometry) => Ok(geometry),
            Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => {
                let stopped = self
                    .shared
                    .inner
                    .lock()
                    .ok()
                    .and_then(|inner| inner.stopped.clone());
                self.stop();
                Err(match stopped {
                    // The window went away between being listed and being captured — Dota quitting
                    // during startup, or entering exclusive fullscreen.
                    Some(Stopped::StreamEnded) => CaptureError::WindowNotFound,
                    Some(Stopped::Internal(detail)) => CaptureError::Failed { detail },
                    None => CaptureError::Failed {
                        detail: "the capture stream started but delivered no frame".to_owned(),
                    },
                })
            }
        }
    }

    fn capture(&mut self, regions: &[CaptureRegion]) -> Result<Vec<CapturedRegion>, CaptureError> {
        if self.stream.is_none() {
            return Err(CaptureError::WindowNotFound);
        }

        let mut inner = self.shared.inner.lock().map_err(|_| CaptureError::Failed {
            detail: "the capture state was poisoned by a panic in the stream delegate".to_owned(),
        })?;

        if let Some(reason) = inner.stopped.clone() {
            drop(inner);
            self.stop();
            return Err(match reason {
                // `health` reads this as exclusive fullscreen once a window has been acquired,
                // and as "Dota is not running" before that. Both are right, and it is the one
                // distinction the user can act on.
                Stopped::StreamEnded => CaptureError::WindowNotFound,
                Stopped::Internal(detail) => CaptureError::Failed { detail },
            });
        }

        if inner.regions != regions {
            inner.regions = regions.to_vec();
            inner.generation = inner.generation.wrapping_add(1);
            // The crops in hand were cut to the old rectangles.
            inner.latest = None;
        }
        let generation = inner.generation;

        match &inner.latest {
            // Crops for the current region list, however old the frame: a window that has stopped
            // changing has stopped producing frames, and the last crops still describe it.
            Some(delivered) if delivered.generation == generation => Ok(delivered.regions.clone()),
            // Either nothing has arrived yet, or the region list changed and the next frame will
            // carry the new crops. Reporting an empty pass says "captured, nothing to see", which
            // keeps the session alive without inventing pixels.
            _ => Ok(Vec::new()),
        }
    }

    fn release(&mut self) {
        self.stop();
    }
}

/// Fetch the list of capturable windows, blocking.
fn shareable_content() -> Result<Retained<SCShareableContent>, CaptureError> {
    let (sender, receiver) = channel();
    let handler = RcBlock::new(
        move |content: *mut SCShareableContent, error: *mut NSError| {
            // SAFETY: inside the completion handler both pointers are either null or valid, and
            // `retain_autoreleased`-style borrowing is what objc2 expects here.
            let message = if content.is_null() {
                let detail = if error.is_null() {
                    "ScreenCaptureKit returned no shareable content and no error".to_owned()
                } else {
                    let error = unsafe { &*error };
                    if error.code() == SC_STREAM_ERROR_USER_DECLINED {
                        String::new()
                    } else {
                        describe(error)
                    }
                };
                Err(detail)
            } else {
                Ok(Transfer(unsafe { Retained::retain(content) }))
            };
            let _ = sender.send(message);
        },
    );

    // Desktop windows are excluded and off-screen windows are skipped: neither can be the game,
    // and asking for less is the habit this crate keeps.
    unsafe {
        SCShareableContent::getShareableContentExcludingDesktopWindows_onScreenWindowsOnly_completionHandler(
            true, true, &handler,
        );
    }

    match receiver.recv_timeout(CONTENT_TIMEOUT) {
        Ok(Ok(Transfer(Some(content)))) => Ok(content),
        Ok(Ok(Transfer(None))) => Err(CaptureError::Failed {
            detail: "ScreenCaptureKit returned a null shareable-content handle".to_owned(),
        }),
        // An empty detail is the sentinel for the declined permission, which is the one error here
        // that is not a failure to report but a state to act on.
        Ok(Err(detail)) if detail.is_empty() => Err(CaptureError::PermissionDenied),
        Ok(Err(detail)) => Err(CaptureError::Failed { detail }),
        Err(RecvTimeoutError::Timeout) => Err(CaptureError::Failed {
            detail: "ScreenCaptureKit did not answer a request for shareable content".to_owned(),
        }),
        Err(RecvTimeoutError::Disconnected) => Err(CaptureError::Failed {
            detail: "the shareable-content request was dropped without answering".to_owned(),
        }),
    }
}

/// Pick the Dota window out of the shareable content.
fn find_window(
    content: &SCShareableContent,
    target: &WindowTarget,
) -> Result<Retained<SCWindow>, CaptureError> {
    // SAFETY: `content` is live; `windows()` returns a retained array.
    let windows = unsafe { content.windows() };

    let mut candidates = Vec::new();
    let mut handles = Vec::new();
    for window in &windows {
        // SAFETY: each element is a live `SCWindow`.
        let (id, title, application, bundle_id, frame, on_screen) = unsafe {
            let application = window.owningApplication();
            (
                window.windowID(),
                window.title().map(|title| title.to_string()),
                application
                    .as_ref()
                    .map(|app| app.applicationName().to_string()),
                application
                    .as_ref()
                    .map(|app| app.bundleIdentifier().to_string()),
                window.frame(),
                window.isOnScreen(),
            )
        };

        candidates.push(WindowCandidate {
            id,
            application: application.unwrap_or_default(),
            bundle_id,
            title: title.unwrap_or_default(),
            // Points here, not pixels — used only to compare windows against each other, never to
            // resolve a region. The true pixel geometry comes from the first frame.
            width: whole_pixels(frame.size.width),
            height: whole_pixels(frame.size.height),
            on_screen,
        });
        handles.push(window);
    }

    let chosen = select(&candidates, target).ok_or(CaptureError::WindowNotFound)?;
    let index = candidates
        .iter()
        .position(|candidate| std::ptr::eq(candidate, chosen))
        .ok_or(CaptureError::WindowNotFound)?;
    handles
        .get(index)
        .cloned()
        .ok_or(CaptureError::WindowNotFound)
}

/// The window-scoped content filter.
///
/// `initWithDesktopIndependentWindow:` is the only filter constructor this file may use. The
/// display-scoped ones can see other applications' windows.
fn window_filter(window: &SCWindow) -> Retained<SCContentFilter> {
    // SAFETY: `window` is live and the initialiser takes it by reference.
    unsafe { SCContentFilter::initWithDesktopIndependentWindow(SCContentFilter::alloc(), window) }
}

/// Build the stream configuration for a window.
fn stream_configuration(window: &SCWindow, interval: Duration) -> Retained<SCStreamConfiguration> {
    // SAFETY: `window` is live.
    let frame = unsafe { window.frame() };
    let scale = backing_scale();

    // At least one pixel each way: `SCStreamConfiguration` rejects a zero dimension, and a window
    // that reports one has already been filtered out by `window_match`.
    let width = whole_pixels(frame.size.width * scale).max(1) as usize;
    let height = whole_pixels(frame.size.height * scale).max(1) as usize;

    // SAFETY: a plain `[[SCStreamConfiguration alloc] init]`, then setters that take scalars.
    let configuration = unsafe { SCStreamConfiguration::new() };
    unsafe {
        configuration.setWidth(width);
        configuration.setHeight(height);
        configuration.setPixelFormat(PIXEL_FORMAT_32_BGRA);
        // The cursor is not part of the HUD and would put a moving object into otherwise static
        // regions, defeating the change gate.
        configuration.setShowsCursor(false);
        // Audio is a capability this process must not have (ADR-0003).
        configuration.setCapturesAudio(false);
        // One frame in flight. The consumer reads at 1–5 Hz and a deeper queue would only buy
        // latency and memory against the ≤50 MB budget.
        configuration.setQueueDepth(1);
        configuration.setMinimumFrameInterval(frame_interval(interval));
    }
    configuration
}

/// `minimumFrameInterval` as a `CMTime`, in the microsecond timescale.
fn frame_interval(interval: Duration) -> objc2_core_media::CMTime {
    const TIMESCALE: i32 = 1_000_000;
    // At least one microsecond: a zero interval would ask the stream for every frame the
    // compositor produces, which is the budget failure this call exists to prevent.
    let micros = i64::try_from(interval.as_micros())
        .unwrap_or(i64::MAX)
        .max(1);
    objc2_core_media::CMTime {
        value: micros,
        timescale: TIMESCALE,
        flags: objc2_core_media::CMTimeFlags::Valid,
        epoch: 0,
    }
}

/// The backing scale factor of the display the window is on, or 1.0 if it cannot be determined.
///
/// `SCWindow.frame` is in points and `SCStreamConfiguration` is in pixels. Capturing at point size
/// on a Retina display would halve the resolution the template matcher sees, which is the
/// difference between reading a gold count and not.
#[allow(clippy::cast_precision_loss)]
fn backing_scale() -> f64 {
    // `SCWindow` does not name the display it is on, so this uses the main display as the
    // reference. A multi-monitor setup with mixed scale factors will get this wrong for a window
    // on the non-main display — and only the *capture resolution* is wrong, because the first
    // frame still reports true pixel geometry and regions resolve against that. Listed in
    // ADR-0033 as hardware-verify work.
    let main = objc2_core_graphics::CGMainDisplayID();
    let Some(mode) = CGDisplayCopyDisplayMode(main) else {
        return 1.0;
    };
    let points = CGDisplayMode::width(Some(&mode));
    let pixels = CGDisplayMode::pixel_width(Some(&mode));
    if points == 0 || pixels == 0 {
        return 1.0;
    }
    // Both are display widths, so far inside f64's exact-integer range; the lint is about
    // `usize` in the abstract.
    pixels as f64 / points as f64
}

/// Round a Core Graphics dimension to whole pixels, saturating rather than wrapping.
///
/// Core Graphics deals in `f64` points and this crate in `u32` pixels. The conversion is allowed
/// to lose precision — `geometry::resolve` does the same, for the same reason — but it must not
/// wrap a negative or absurd value into a plausible-looking size.
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn whole_pixels(value: f64) -> u32 {
    if !value.is_finite() || value <= 0.0 {
        return 0;
    }
    let rounded = value.round();
    if rounded >= f64::from(u32::MAX) {
        u32::MAX
    } else {
        rounded as u32
    }
}

/// Start the stream, blocking until macOS says whether it did.
fn start_capture(stream: &SCStream) -> Result<(), CaptureError> {
    let (sender, receiver) = channel();
    let handler = RcBlock::new(move |error: *mut NSError| {
        let message = if error.is_null() {
            Ok(())
        } else {
            // SAFETY: non-null inside the completion handler.
            let error = unsafe { &*error };
            Err((error.code(), describe(error)))
        };
        let _ = sender.send(message);
    });

    // SAFETY: `stream` is live and the block matches the documented signature.
    unsafe { stream.startCaptureWithCompletionHandler(Some(&handler)) };

    match receiver.recv_timeout(START_TIMEOUT) {
        Ok(Ok(())) => Ok(()),
        Ok(Err((code, _))) if code == SC_STREAM_ERROR_USER_DECLINED => {
            Err(CaptureError::PermissionDenied)
        }
        Ok(Err((_, detail))) => Err(CaptureError::Failed {
            detail: format!("the capture stream would not start: {detail}"),
        }),
        Err(_) => Err(CaptureError::Failed {
            detail: "the capture stream did not answer a request to start".to_owned(),
        }),
    }
}

/// A short, pixel-free description of an `NSError`.
fn describe(error: &NSError) -> String {
    format!("{} ({})", error.localizedDescription(), error.code())
}
