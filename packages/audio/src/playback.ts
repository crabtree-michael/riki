/**
 * How much of Riki's answer the player actually heard.
 *
 * `conversation.item.truncate` needs an `audio_end_ms`, and getting it wrong corrupts every later
 * turn in the session (openai-realtime-research.md §4): too high and the model believes it said
 * things that were cut off, too low and it repeats itself. Under WebRTC the audio arrives as RTP
 * rather than as events, so there are no deltas to count — the only honest measurement is of the
 * output itself.
 *
 * So: an analyser on the remote track, accumulating milliseconds above a silence floor, reset at
 * each response. That includes jitter-buffer delay and excludes trailing silence, which is exactly
 * the quantity meant. It also produces the output envelope the chip's bars use during Speaking, so
 * the barge-in machinery and the display signal are one measurement rather than two.
 *
 * This is the only place in Riki that analyses an output signal, and it analyses Riki's own voice.
 * There is no capture path for game audio anywhere in this package, which is how
 * dota2-state-capture-design.md §7's "voice chat is never captured" stays true by construction.
 *
 * See docs/design/voice-input-architecture.md §4.3.
 *
 * ## The bug this design forecloses
 *
 * An earlier implementation keyed the measurement off `response.output_audio.delta` and started
 * accounting when the first delta arrived. That passes every WebSocket test and then never fires
 * in production, because **`response.output_audio.delta` does not arrive on WebRTC at all** — the
 * audio is on the media track (research §2). The tracker never starts, `audibleMs()` stays zero,
 * and barge-in silently stops truncating on the default transport.
 *
 * Measuring the signal removes that failure mode rather than fixing it: there is no wire event
 * anywhere in this file. `beginResponse` is called by the session from `response.created` /
 * `response.output_item.added`, which arrive on every transport, and the analyser feeds frames
 * regardless. `playback.test.ts` asserts a full response measures correctly with no audio-delta
 * events in play at all.
 */

import { dbfs, envelope, rms } from './level.js';
import type {
  Clock,
  ItemId,
  LevelSample,
  MonoMs,
  RemoteTrack,
  ResponseId,
  Unsubscribe,
} from './types.js';

export interface PlaybackReport {
  readonly responseId: ResponseId;
  readonly itemId: ItemId;
  readonly audibleMs: number;
  readonly interrupted: boolean;
}

export interface PlaybackTrackerOptions {
  /** Default -50 dBFS. Silence between phrases must not be counted as heard. */
  readonly silenceFloorDb: number;
  readonly frameMs: number;
}

export const DEFAULT_PLAYBACK_OPTIONS: PlaybackTrackerOptions = {
  silenceFloorDb: -50,
  frameMs: 1000 / 30,
};

export interface PlaybackTracker {
  attach(track: RemoteTrack): void;
  beginResponse(responseId: ResponseId, itemId: ItemId): void;
  /** Valid mid-response: this is the number the truncate is sent with. */
  audibleMs(): number;
  endResponse(interrupted: boolean): PlaybackReport;
  onLevel(listener: (sample: LevelSample) => void): Unsubscribe;
  dispose(): void;
}

/**
 * The pure half: one analysed frame in, accumulated audible milliseconds out.
 *
 * Split from the tracker so the barge-in arithmetic is assertable without a `RemoteTrack`, an
 * `AnalyserNode`, or any notion of time passing.
 */
export interface AnalysedFrame {
  readonly audibleMs: number;
  readonly level: number;
}

export function accumulate(
  previous: AnalysedFrame,
  frame: Float32Array,
  opts: PlaybackTrackerOptions,
): AnalysedFrame {
  const amplitude = rms(frame);
  const audible = dbfs(amplitude) >= opts.silenceFloorDb;
  return {
    // Only frames above the floor count. Trailing silence is generated audio the player did not
    // hear as speech, and counting it inflates `audio_end_ms` past what was actually said.
    audibleMs: previous.audibleMs + (audible ? opts.frameMs : 0),
    level: envelope(previous.level, amplitude, {
      attackMs: 10,
      releaseMs: 120,
      frameMs: opts.frameMs,
    }),
  };
}

/** What the voice window supplies: frames pulled off an analyser on the remote track. */
export interface RemoteAnalyser {
  onFrame(listener: (frame: Float32Array, at: MonoMs) => void): Unsubscribe;
  dispose(): void;
}

export interface PlaybackTrackerDeps {
  readonly clock: Clock;
  /** Built by the voice window over an `AnalyserNode`; a fake in every test. */
  readonly analyserFor: (track: RemoteTrack) => RemoteAnalyser;
  readonly options?: PlaybackTrackerOptions;
}

class SignalPlaybackTracker implements PlaybackTracker {
  readonly #deps: PlaybackTrackerDeps;
  readonly #options: PlaybackTrackerOptions;
  readonly #listeners = new Set<(sample: LevelSample) => void>();

  #analyser: RemoteAnalyser | null = null;
  #unsubscribe: Unsubscribe | null = null;
  #state: AnalysedFrame = { audibleMs: 0, level: 0 };
  #responseId: ResponseId | null = null;
  #itemId: ItemId | null = null;

  constructor(deps: PlaybackTrackerDeps) {
    this.#deps = deps;
    this.#options = deps.options ?? DEFAULT_PLAYBACK_OPTIONS;
  }

  attach(track: RemoteTrack): void {
    this.#detach();
    const analyser = this.#deps.analyserFor(track);
    this.#analyser = analyser;
    this.#unsubscribe = analyser.onFrame((frame, at) => {
      this.#onFrame(frame, at);
    });
  }

  beginResponse(responseId: ResponseId, itemId: ItemId): void {
    this.#responseId = responseId;
    this.#itemId = itemId;
    this.#state = { audibleMs: 0, level: 0 };
  }

  audibleMs(): number {
    return this.#state.audibleMs;
  }

  endResponse(interrupted: boolean): PlaybackReport {
    const report: PlaybackReport = {
      // A report for a response that never began is still a report, carrying zero. Throwing here
      // would turn a benign ordering race into a lost turn.
      responseId: this.#responseId ?? ('' as ResponseId),
      itemId: this.#itemId ?? ('' as ItemId),
      audibleMs: this.#state.audibleMs,
      interrupted,
    };
    this.#responseId = null;
    this.#itemId = null;
    this.#state = { audibleMs: 0, level: 0 };
    return report;
  }

  onLevel(listener: (sample: LevelSample) => void): Unsubscribe {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  dispose(): void {
    this.#detach();
    this.#listeners.clear();
  }

  #onFrame(frame: Float32Array, at: MonoMs): void {
    // Frames outside a response still drive the level — the chip may be showing an output tail —
    // but must not accumulate audible time against a response that has already ended.
    this.#state =
      this.#responseId === null
        ? { audibleMs: this.#state.audibleMs, level: rms(frame) }
        : accumulate(this.#state, frame, this.#options);
    this.#emit(frame, at);
  }

  #emit(frame: Float32Array, at: MonoMs): void {
    if (this.#listeners.size === 0) return;
    const sample: LevelSample = { rms: this.#state.level, peak: peakOf(frame), at };
    for (const listener of this.#listeners) listener(sample);
  }

  #detach(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#analyser?.dispose();
    this.#analyser = null;
  }
}

function peakOf(frame: Float32Array): number {
  let highest = 0;
  for (const sample of frame) {
    const magnitude = Math.abs(sample);
    if (magnitude > highest) highest = magnitude;
  }
  return highest;
}

export function createPlaybackTracker(deps: PlaybackTrackerDeps): PlaybackTracker {
  return new SignalPlaybackTracker(deps);
}
