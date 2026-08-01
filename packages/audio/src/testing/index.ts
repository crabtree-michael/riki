/**
 * Shared fakes for @riki/audio, exported as `@riki/audio/testing`.
 *
 * These are not test scaffolding: `pnpm dev:replay` drives the whole app through the same
 * fakes, which is what keeps them honest (REPO_SKELETON.md §5.2). No test may require a
 * running Dota 2 client, a real microphone, a GPU, or a live OpenAI session.
 *
 * Contracts only. `FakeAudioDevice` is the one fake in the set that *generates* its input rather
 * than replaying a recording: tones and PCM are produced deterministically in the test rather than
 * committed, because a committed binary that exists to check arithmetic is a fixture nobody can
 * read in a diff (docs/design/voice-input-architecture.md §11).
 */

import type { CaptureGraph } from '../capture.js';
import type { LevelSample, MicStream, Unsubscribe } from '../types.js';

export interface ToneSpec {
  readonly hz: number;
  readonly durationMs: number;
  readonly sampleRate: number;
  readonly amplitude: number;
}

export interface FakeAudioDevice {
  /** What a `CaptureGraph` is built over. Nothing here touches a real device. */
  readonly stream: MicStream;

  /** Deterministic. The input to the round-trip resampling test (REPO_SKELETON.md §5.4). */
  pushTone(spec: ToneSpec): void;
  pushSilence(durationMs: number): void;
  pushFrames(frames: readonly Float32Array[]): void;

  /**
   * Everything that reached the outbound track. The privacy assertion in architecture §11 —
   * gate closed means no signal leaves — is a statement about this array.
   */
  outbound(): readonly Float32Array[];
  levels(): readonly LevelSample[];

  /** Device departure and arrival, for the swap path (architecture §3.5). */
  detach(): void;
  attach(): MicStream;

  onDispose(listener: () => void): Unsubscribe;
}

export declare function createFakeAudioDevice(sampleRate?: number): FakeAudioDevice;

/** A `CaptureGraph` over a `FakeAudioDevice`, with an injected clock. No `AudioContext` anywhere. */
export declare function createFakeCaptureGraph(device: FakeAudioDevice): CaptureGraph;
