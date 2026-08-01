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
 * See docs/design/voice-input-architecture.md §3.2–§3.5. Declarations only; the DOM-typed
 * constructor lands with the voice window (see types.ts).
 */

import type { LevelSample, MicStream, OutboundTrack, Unsubscribe } from './types.js';

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
