/**
 * The three earcons, synthesised rather than shipped as audio files.
 *
 * ui-design.md §7.1 specifies them precisely enough to generate: two ~80 ms two-tone blips and
 * one 140 ms low tone, soft sine with a short attack, at −18 dBFS. Generating them buys three
 * things a `resources/*.wav` does not — they are unit-testable (the frequencies are assertable),
 * they cost no binary in git, and they render at whatever rate the output device is running so
 * nothing resamples them.
 *
 * The capture-end earcon carries more weight than its 80 ms suggests: §7.1 calls it "the only
 * confirmation that the mic actually closed, which is the thing users are anxious about", and
 * overlay-architecture.md §4.5 makes leaving Listening always emit it, as a table-testable
 * property of the reducer. If it is ever silent, that anxiety has nothing to answer it.
 */

import { fromDbfs } from '../levels/envelope.js';
import type { Decibels, Hertz, Millis, MonoFrame } from '../types.js';

/** Matches the machine's `EarconId` (apps/desktop/src/main/session/types.ts) by value. */
export type EarconId = 'capture-start' | 'capture-end' | 'error';

/** ui-design.md §7.1. Independently adjustable and mutable — this is only the default. */
export const DEFAULT_EARCON_LEVEL_DB: Decibels = -18;

interface ToneSegment {
  readonly frequency: Hertz;
  readonly durationMs: Millis;
}

const EARCONS: Record<EarconId, readonly ToneSegment[]> = {
  'capture-start': [
    { frequency: 660, durationMs: 40 },
    { frequency: 880, durationMs: 40 },
  ],
  'capture-end': [
    { frequency: 880, durationMs: 40 },
    { frequency: 660, durationMs: 40 },
  ],
  error: [{ frequency: 330, durationMs: 140 }],
};

/**
 * "Short attack" per §7.1, plus a release the doc does not name but the ear demands: a sine cut
 * dead at a non-zero sample is a click, and a click is exactly the attention-grabbing artefact a
 * product called "invisible until needed" cannot afford.
 */
const ATTACK_MS = 4;
const RELEASE_MS = 12;

function envelopeAt(positionMs: Millis, durationMs: Millis): number {
  if (positionMs < ATTACK_MS) return positionMs / ATTACK_MS;
  const remaining = durationMs - positionMs;
  if (remaining < RELEASE_MS) return Math.max(0, remaining / RELEASE_MS);
  return 1;
}

export interface EarconOptions {
  readonly levelDb?: Decibels;
}

export function renderEarcon(
  id: EarconId,
  sampleRate: Hertz,
  options: EarconOptions = {},
): MonoFrame {
  const segments = EARCONS[id];
  const amplitude = fromDbfs(options.levelDb ?? DEFAULT_EARCON_LEVEL_DB);
  const totalMs = segments.reduce((sum, segment) => sum + segment.durationMs, 0);
  const out = new Float32Array(Math.round((totalMs / 1000) * sampleRate));

  let written = 0;
  for (const segment of segments) {
    const count = Math.round((segment.durationMs / 1000) * sampleRate);
    // Phase is per-segment. The two-tone blips step in frequency, and a discontinuity at the
    // boundary is inaudible under the per-segment release; carrying phase across would buy
    // nothing and complicate the test.
    for (let i = 0; i < count && written < out.length; i += 1, written += 1) {
      const positionMs = (i / sampleRate) * 1000;
      const phase = 2 * Math.PI * segment.frequency * (i / sampleRate);
      out[written] = Math.sin(phase) * amplitude * envelopeAt(positionMs, segment.durationMs);
    }
  }
  return out;
}

export function earconDurationMs(id: EarconId): Millis {
  return EARCONS[id].reduce((sum, segment) => sum + segment.durationMs, 0);
}

/**
 * Where a rendered earcon goes. Kept a port because ui-design.md §9.3 requires earcons to be on
 * a **separate audio stream** so streamers can exclude them from the mix — which is an output
 * routing decision the adapter makes, not something this package can express.
 */
export interface EarconOutputPort {
  play(frame: MonoFrame, sampleRate: Hertz): void;
}

export interface EarconPlayerOptions extends EarconOptions {
  readonly sampleRate: Hertz;
  readonly output: EarconOutputPort;
  readonly enabled?: boolean;
}

/** Renders each earcon once and caches it; they are ≤140 ms and there are three. */
export class EarconPlayer {
  readonly #cache = new Map<EarconId, MonoFrame>();
  readonly #sampleRate: Hertz;
  readonly #output: EarconOutputPort;
  readonly #options: EarconOptions;
  #enabled: boolean;

  constructor(options: EarconPlayerOptions) {
    this.#sampleRate = options.sampleRate;
    this.#output = options.output;
    this.#enabled = options.enabled ?? true;
    this.#options = options.levelDb === undefined ? {} : { levelDb: options.levelDb };
  }

  setEnabled(enabled: boolean): void {
    this.#enabled = enabled;
  }

  play(id: EarconId): void {
    if (!this.#enabled) return;
    let frame = this.#cache.get(id);
    if (!frame) {
      frame = renderEarcon(id, this.#sampleRate, this.#options);
      this.#cache.set(id, frame);
    }
    this.#output.play(frame, this.#sampleRate);
  }
}
