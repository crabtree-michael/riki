/**
 * The capture pipeline: device → levels → resample → sink.
 *
 * One object owns the whole inbound leg so there is exactly one place where the order is fixed,
 * and the order is load-bearing in a way that is easy to get backwards:
 *
 *   1. **Levels are taken at the device rate, before resampling.** The bars must respond within
 *      250 ms of key-down (ui-design.md §8) and resampling adds filter delay. Measuring the raw
 *      chunk also means the bars keep moving even if the resampler is mid-ratio-change.
 *   2. **Silence detection runs off the envelope, not the raw RMS**, so the nudge inherits the
 *      release ballistics and does not fire in the gap between two words.
 *   3. **Resampling is last**, and its output is the only thing the session ever sees.
 *
 * The events emitted map one-for-one onto `MachineInput.capture` and `MachineInput.speech`
 * (apps/desktop/src/main/session/types.ts). That is deliberate — it makes the eventual
 * `VoiceBridge` a table with no logic in it, which is the whole point of overlay-architecture.md
 * §5.6.
 */

import { LevelPump, type LevelSample, type LevelPumpOptions } from '../levels/pump.js';
import {
  SilenceDetector,
  type SilenceDetectorOptions,
  type SpeechEvent,
} from '../levels/silence.js';
import { createResampler, type Resampler } from '../resample/resampler.js';
import { REALTIME_SAMPLE_RATE, type Hertz, type Millis, type Unsubscribe } from '../types.js';
import type { AudioChunkSink, AudioFault, AudioSourcePort } from './ports.js';

export type CaptureEvent = 'opened' | 'firstAudio' | 'closed';

export interface CaptureStreamOptions {
  readonly source: AudioSourcePort;
  readonly sink: AudioChunkSink;
  /** Defaults to the Realtime API's 24 kHz, which is the only rate its PCM leg accepts. */
  readonly targetRate?: Hertz;
  readonly levels?: LevelPumpOptions;
  readonly silence?: SilenceDetectorOptions;
}

export class AudioCaptureStream {
  readonly #source: AudioSourcePort;
  readonly #sink: AudioChunkSink;
  readonly #targetRate: Hertz;
  readonly #pump: LevelPump;
  readonly #silence: SilenceDetector;

  readonly #captureListeners = new Set<(event: CaptureEvent) => void>();
  readonly #faultListeners = new Set<(fault: AudioFault) => void>();
  readonly #subscriptions: Unsubscribe[] = [];

  #resampler: Resampler;
  #open = false;
  #sawAudio = false;

  constructor(options: CaptureStreamOptions) {
    this.#source = options.source;
    this.#sink = options.sink;
    this.#targetRate = options.targetRate ?? REALTIME_SAMPLE_RATE;
    this.#pump = new LevelPump(options.levels ?? {});
    this.#silence = new SilenceDetector(options.silence ?? {});
    this.#resampler = createResampler(this.#source.sampleRate, this.#targetRate);
  }

  get isOpen(): boolean {
    return this.#open;
  }

  get levels(): LevelPump {
    return this.#pump;
  }

  onCapture(fn: (event: CaptureEvent) => void): Unsubscribe {
    this.#captureListeners.add(fn);
    return () => this.#captureListeners.delete(fn);
  }

  onSpeech(fn: (event: SpeechEvent) => void): Unsubscribe {
    return this.#silence.onEvent(fn);
  }

  onLevel(fn: (sample: LevelSample) => void): Unsubscribe {
    return this.#pump.onSample(fn);
  }

  onFault(fn: (fault: AudioFault) => void): Unsubscribe {
    this.#faultListeners.add(fn);
    return () => this.#faultListeners.delete(fn);
  }

  async open(): Promise<void> {
    if (this.#open) return;

    this.#subscriptions.push(
      this.#source.onFrame((chunk) => {
        this.#onFrame(chunk.frame, chunk.at);
      }),
    );
    this.#subscriptions.push(
      this.#source.onFault((fault) => {
        this.#emitFault(fault);
      }),
    );

    // The device may hand back a different rate than it advertised before starting.
    this.#resampler = createResampler(this.#source.sampleRate, this.#targetRate);
    this.#silence.reset();
    this.#sawAudio = false;
    this.#pump.setRunning(true, 'input');

    try {
      await this.#source.start();
    } catch (error) {
      this.#teardownSubscriptions();
      this.#pump.setRunning(false);
      this.#emitFault({
        kind: 'no-input-device',
        message: error instanceof Error ? error.message : 'Could not start the input device.',
      });
      return;
    }

    this.#open = true;
    this.#emitCapture('opened');
  }

  async close(): Promise<void> {
    if (!this.#open) return;
    this.#open = false;

    // Drain the filter tail so the last syllable is not clipped by the resampler's group delay.
    const tail = this.#resampler.flush();
    if (tail.length > 0) this.#sink.append(tail, 0);

    this.#pump.setRunning(false);
    this.#teardownSubscriptions();

    try {
      await this.#source.stop();
    } finally {
      this.#emitCapture('closed');
    }
  }

  dispose(): void {
    this.#teardownSubscriptions();
    this.#captureListeners.clear();
    this.#faultListeners.clear();
  }

  #onFrame(frame: Float32Array, at: Millis): void {
    if (!this.#open) return;

    if (!this.#sawAudio) {
      this.#sawAudio = true;
      this.#emitCapture('firstAudio');
    }

    const level = this.#pump.push(frame, at);
    this.#silence.push(level, at);

    const resampled = this.#resampler.process(frame);
    if (resampled.length > 0) this.#sink.append(resampled, at);
  }

  #teardownSubscriptions(): void {
    while (this.#subscriptions.length > 0) this.#subscriptions.pop()?.();
  }

  #emitCapture(event: CaptureEvent): void {
    for (const listener of this.#captureListeners) listener(event);
  }

  #emitFault(fault: AudioFault): void {
    for (const listener of this.#faultListeners) listener(fault);
  }
}
