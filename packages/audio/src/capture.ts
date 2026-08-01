/**
 * The capture graph — the one stateful audio object in this package.
 *
 *   MediaStreamSource ─► Analyser ────────────────────► levels, silence  (always running)
 *          │
 *          ▼
 *     Delay(preRollMs) ─► Gain(gate) ─► Destination ─► the transport's outbound track
 *
 * Three things about that shape are decisions rather than taste, and all three are ADR-0016:
 *
 * - The analyser is **upstream of the gate** and runs whenever the device is open, so
 *   `speech.silence` / `speech.resumed` exist for the overlay's silence nudge and 8 s listen
 *   timeout without asking the server anything.
 * - The gate **ramps**. A step change in gain is a click, and a click at the start of every
 *   utterance is both audible and something the server's VAD will occasionally read as speech.
 * - The delay node **is** the pre-roll. There is no way to inject a buffer into an RTP stream
 *   after the fact, so running the outbound leg permanently late is what makes "audio from before
 *   the key press" (ui-design.md §3) possible at all. It costs `preRollMs` of latency on every
 *   utterance, by design, and it is allowed to be zero.
 *
 * See docs/design/voice-input-architecture.md §3.2–§3.5.
 *
 * The graph is built through an injected `AudioGraphBackend` rather than against `AudioContext`
 * directly. That is partly the `lib: ["ES2023"]` wall described in types.ts, and partly that the
 * three properties above are the whole of what is worth testing here — the ramp, the gate's
 * position relative to the track, and the delay — and all three are assertable against a fake
 * backend that records what it was asked to do. A test against a real `AudioContext` would need
 * a browser and would assert less.
 */

import { envelope, isSilent, peak, rms } from './level.js';
import type { Clock, LevelSample, MicStream, MonoMs, OutboundTrack, Unsubscribe } from './types.js';

export interface CaptureGraphOptions {
  /** Default 200. Pure added latency against a ~1–1.5 s turnaround — architecture §3.3. */
  readonly preRollMs: number;
  /** Default 8. Below about 5 ms the ramp is audible as a click. */
  readonly gateRampMs: number;
  /** Default 33 (~30 Hz), which is the rate the chip's bars are pumped at (overlay §5.5). */
  readonly levelIntervalMs: number;
  /** Default -50 dBFS. Drives `onSpeech`, not the server's VAD. */
  readonly silenceFloorDb: number;
}

export interface CaptureGraph {
  /** Handed to the transport at connect time. Never crosses a process boundary (§2.3). */
  readonly outbound: OutboundTrack;

  /**
   * Opens the gate over `gateRampMs`, emitting audio captured `preRollMs` ago.
   *
   * Synchronous and cheap: this sits on the trigger path, where the overlay's ≤100 ms budget
   * forbids an `await` between the key press and the window being shown (overlay §9.1). Nothing
   * here may allocate a device, negotiate anything, or return a promise.
   */
  open(): void;
  close(): void;
  readonly isOpen: boolean;

  onLevel(listener: (sample: LevelSample) => void): Unsubscribe;
  /** From the pre-gate analyser, so it reports whether the gate is open or shut. */
  onSpeech(listener: (event: 'silence' | 'resumed') => void): Unsubscribe;

  /**
   * Swap the microphone without touching the gate, the delay, the track identity or the peer
   * connection — so unplugging a headset mid-match does not renegotiate SDP and does not
   * interrupt a turn in flight (§3.5).
   */
  replaceStream(stream: MicStream): Promise<void>;

  dispose(): Promise<void>;
}

// -----------------------------------------------------------------------------------------------
// Implementation
// -----------------------------------------------------------------------------------------------

export const DEFAULT_CAPTURE_OPTIONS: CaptureGraphOptions = {
  preRollMs: 200,
  gateRampMs: 8,
  levelIntervalMs: 33,
  silenceFloorDb: -50,
};

/**
 * The Web Audio nodes this graph needs, and nothing else.
 *
 * `setGate` takes a ramp because a step change in gain is a click, and a click at the start of
 * every utterance is both audible and something the server's VAD will occasionally read as
 * speech (§3.2).
 */
export interface AudioGraphBackend {
  /** The outbound track, created once and never replaced — swapping it would renegotiate SDP. */
  readonly outbound: OutboundTrack;
  /** Ramps the gate's gain to `value` over `rampMs`. 0 is shut, 1 is open. */
  setGate(value: number, rampMs: number): void;
  /** Pre-gate analyser frames, at roughly `levelIntervalMs`. Always running while open. */
  onAnalyserFrame(listener: (frame: Float32Array, at: MonoMs) => void): Unsubscribe;
  /** Swap the source node. Must not touch the gate, the delay or the track. */
  replaceSource(stream: MicStream): Promise<void>;
  setPreRoll(delayMs: number): void;
  dispose(): Promise<void>;
}

export interface CaptureGraphDeps {
  readonly backend: AudioGraphBackend;
  readonly clock: Clock;
  readonly options?: CaptureGraphOptions;
}

/**
 * How long the level must stay under the floor before `speech.silence` fires.
 *
 * Debounce, not policy: the machine's own silence-nudge timer is the user-configurable one
 * (ui-design §9.1). This only stops the gap between two words from firing it.
 */
const SILENCE_HOLD_MS = 250;

export function createCaptureGraph(deps: CaptureGraphDeps): CaptureGraph {
  const options = deps.options ?? DEFAULT_CAPTURE_OPTIONS;
  const levelListeners = new Set<(sample: LevelSample) => void>();
  const speechListeners = new Set<(event: 'silence' | 'resumed') => void>();

  let open = false;
  let level = 0;
  let silent = false;
  let quietSince: MonoMs | null = null;

  deps.backend.setPreRoll(options.preRollMs);
  deps.backend.setGate(0, 0);

  const unsubscribe = deps.backend.onAnalyserFrame((frame, at) => {
    const amplitude = rms(frame);
    level = envelope(level, amplitude, {
      attackMs: 10,
      releaseMs: 180,
      frameMs: options.levelIntervalMs,
    });

    const sample: LevelSample = { rms: level, peak: peak(frame), at };
    for (const listener of levelListeners) listener(sample);

    // Deliberately measured on the *raw* frame rather than the smoothed level: the release
    // ballistics exist to make the bars readable, and inheriting them here would delay
    // `speech.silence` by most of a release constant.
    if (!isSilent({ rms: amplitude, peak: sample.peak, at }, options.silenceFloorDb)) {
      quietSince = null;
      if (silent) {
        silent = false;
        for (const listener of speechListeners) listener('resumed');
      }
      return;
    }

    quietSince ??= at;
    if (!silent && at - quietSince >= SILENCE_HOLD_MS) {
      silent = true;
      for (const listener of speechListeners) listener('silence');
    }
  });

  return {
    outbound: deps.backend.outbound,

    get isOpen() {
      return open;
    },

    open() {
      if (open) return;
      open = true;
      // A new turn starts as speaking, not as silence, or the chip dims on the first frame.
      silent = false;
      quietSince = null;
      deps.backend.setGate(1, options.gateRampMs);
    },

    close() {
      if (!open) return;
      open = false;
      deps.backend.setGate(0, options.gateRampMs);
    },

    onLevel(listener) {
      levelListeners.add(listener);
      return () => levelListeners.delete(listener);
    },

    onSpeech(listener) {
      speechListeners.add(listener);
      return () => speechListeners.delete(listener);
    },

    /**
     * Swaps the microphone without touching the gate, the delay, the track identity or the peer
     * connection — so unplugging a headset mid-match does not renegotiate SDP and does not
     * interrupt a turn in flight (§3.5). The gate state is deliberately not reset: a swap during
     * an open turn keeps the turn.
     */
    replaceStream(stream) {
      return deps.backend.replaceSource(stream);
    },

    async dispose() {
      unsubscribe();
      levelListeners.clear();
      speechListeners.clear();
      open = false;
      await deps.backend.dispose();
    },
  };
}
