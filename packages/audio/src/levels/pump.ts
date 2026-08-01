/**
 * The level pump: envelope values out to the chip, rate-limited, and only when it can be seen.
 *
 * overlay-architecture.md §4.5 makes the point this file exists to honour — `levels: { running:
 * false }` is how "idle costs literally nothing" (ui-design.md §10) is enforced *upstream*. A
 * hidden overlay must cost no IPC at all, not merely no pixels, so the pump is the thing that
 * stops rather than the renderer being asked to ignore frames it was sent anyway.
 *
 * ui-design.md §10 also fixes the rate: "animate at 30 fps, not the game's refresh rate". Audio
 * chunks arrive far faster than that (128-sample worklet quanta at 48 kHz is ~375 Hz), so
 * without throttling this would be twelve times the necessary IPC while a game is trying to hold
 * a frame budget.
 */

import type { Level, Millis, MonoFrame, Unsubscribe } from '../types.js';
import { EnvelopeFollower, type EnvelopeOptions } from './envelope.js';

export type LevelSource = 'input' | 'output';

/**
 * Structurally the overlay's `LevelFrame`. Declared here rather than imported for the boundary
 * reason in `types.ts`; when `@riki/protocol` grows the schema (REPO_SKELETON.md §4) both become
 * inferred types from it and this definition goes away.
 */
export interface LevelSample {
  readonly source: LevelSource;
  readonly value: Level;
  readonly at: Millis;
}

/** 30 fps, per ui-design.md §10. */
export const LEVEL_FRAME_INTERVAL_MS = 1000 / 30;

export interface LevelPumpOptions extends EnvelopeOptions {
  readonly intervalMs?: Millis;
}

export class LevelPump {
  readonly #follower: EnvelopeFollower;
  readonly #intervalMs: Millis;
  readonly #listeners = new Set<(sample: LevelSample) => void>();

  #running = false;
  #source: LevelSource = 'input';
  #lastEmitAt: Millis | null = null;
  #lastPushAt: Millis | null = null;

  constructor(options: LevelPumpOptions = {}) {
    this.#follower = new EnvelopeFollower(options);
    this.#intervalMs = options.intervalMs ?? LEVEL_FRAME_INTERVAL_MS;
  }

  get running(): boolean {
    return this.#running;
  }

  get source(): LevelSource {
    return this.#source;
  }

  /** Mirrors the machine's `levels` effect exactly, so the adapter is a one-liner. */
  setRunning(running: boolean, source: LevelSource = this.#source): void {
    this.#source = source;
    if (running === this.#running) return;
    this.#running = running;
    if (!running) {
      // Reset rather than freeze: the bars must not resume from a stale height next time.
      this.#follower.reset();
      this.#lastEmitAt = null;
      this.#lastPushAt = null;
    }
  }

  onSample(fn: (sample: LevelSample) => void): Unsubscribe {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  /**
   * Feed a captured chunk. Returns the envelope value whether or not a frame was emitted, so
   * callers that want the level for their own purposes — silence detection — need not subscribe.
   */
  push(frame: MonoFrame, at: Millis): Level {
    if (!this.#running) return 0;
    const dtMs = this.#lastPushAt === null ? this.#intervalMs : at - this.#lastPushAt;
    this.#lastPushAt = at;
    return this.#emitIfDue(this.#follower.push(frame, dtMs), at);
  }

  /** The output leg: the API reports a level rather than handing us the samples. */
  pushLevel(value: Level, at: Millis): Level {
    if (!this.#running) return 0;
    const dtMs = this.#lastPushAt === null ? this.#intervalMs : at - this.#lastPushAt;
    this.#lastPushAt = at;
    return this.#emitIfDue(this.#follower.pushLevel(value, dtMs), at);
  }

  #emitIfDue(value: Level, at: Millis): Level {
    if (this.#lastEmitAt !== null && at - this.#lastEmitAt < this.#intervalMs) return value;
    this.#lastEmitAt = at;
    const sample: LevelSample = { source: this.#source, value, at };
    for (const listener of this.#listeners) listener(sample);
    return value;
  }
}
