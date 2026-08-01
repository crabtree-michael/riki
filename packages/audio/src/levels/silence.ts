/**
 * Silence detection, for the chip's nudge — not for turn-taking.
 *
 * Worth being precise about, because two different things are called VAD in this codebase and
 * conflating them would be a real bug. ADR-0004 makes push-to-talk the default, which means
 * `turn_detection: null` on the session (openai-realtime-research.md §4) and **the model never
 * decides when the user stopped talking** — the hotkey does. What this class drives is purely
 * cosmetic: the `silence-nudge` timer in overlay-architecture.md §4.6, after which the bars
 * flatten and the chip dims to 60 %.
 *
 * So a false positive here costs a dimmed chip, not a dropped turn. That is what licenses an
 * energy threshold this simple.
 */

import type { Level, Millis, Unsubscribe } from '../types.js';

export type SpeechEvent = 'silence' | 'resumed';

export interface SilenceDetectorOptions {
  /**
   * Envelope level below which we call it silence. 0.06 sits above room tone at the default
   * −60 dBFS floor and well below any deliberate speech. *(tunable — measure on real mics)*
   */
  readonly threshold?: Level;
  /**
   * How long the level must stay under the threshold. ui-design.md §9.1 requires the nudge delay
   * itself to be user-configurable — those are hostile defaults for people who speak slowly —
   * but that timer lives in the machine; this is the debounce that keeps a gap between two words
   * from firing it.
   */
  readonly holdMs?: Millis;
}

const DEFAULT_THRESHOLD = 0.06;
const DEFAULT_HOLD_MS = 250;

export class SilenceDetector {
  readonly #threshold: Level;
  readonly #holdMs: Millis;
  readonly #listeners = new Set<(event: SpeechEvent) => void>();

  #silent = false;
  #quietSince: Millis | null = null;

  constructor(options: SilenceDetectorOptions = {}) {
    this.#threshold = options.threshold ?? DEFAULT_THRESHOLD;
    this.#holdMs = options.holdMs ?? DEFAULT_HOLD_MS;
  }

  get silent(): boolean {
    return this.#silent;
  }

  onEvent(fn: (event: SpeechEvent) => void): Unsubscribe {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  push(level: Level, at: Millis): void {
    if (level >= this.#threshold) {
      this.#quietSince = null;
      if (this.#silent) {
        this.#silent = false;
        this.#emit('resumed');
      }
      return;
    }

    this.#quietSince ??= at;
    if (!this.#silent && at - this.#quietSince >= this.#holdMs) {
      this.#silent = true;
      this.#emit('silence');
    }
  }

  /** Called when capture opens: a new turn starts as speaking, not as silence. */
  reset(): void {
    this.#silent = false;
    this.#quietSince = null;
  }

  #emit(event: SpeechEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}
