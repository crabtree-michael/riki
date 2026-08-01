/**
 * The three sounds, synthesised rather than sampled.
 *
 * ui-design.md §7.1 specifies them as frequencies and durations — 660→880 Hz rising for capture
 * start, 880→660 Hz falling for capture end, 330 Hz for error, ~80 ms, soft attack — so an
 * oscillator and a gain envelope reproduce the spec exactly, with nothing to ship in `resources/`
 * and nothing that can drift from the document.
 *
 * They are "part of the state model, not decoration": the capture-end tone is the only
 * confirmation the player gets that the microphone actually closed, which is the thing they are
 * anxious about. The overlay's machine decides when they play (its `earcon` effect); this plays
 * them.
 *
 * They render in the voice window's own context, so they are never gated by the mic gate and never
 * appear in the outbound track.
 *
 * See docs/design/voice-input-architecture.md §4.4.
 *
 * Only the specification table is implemented here. `EarconPlayer` needs an `AudioContext`, which
 * exists only in the voice window, so its implementation lands with that surface — the table is
 * what a Tier 1 test can compare against ui-design §7.1 without one.
 */

export type EarconId = 'capture-start' | 'capture-end' | 'error';

export interface EarconSpec {
  readonly id: EarconId;
  readonly fromHz: number;
  readonly toHz: number;
  readonly durationMs: number;
  readonly attackMs: number;
}

/**
 * The ui-design §7.1 table, as data, so the Tier 1 test compares against the specification.
 *
 * Two-tone blips are expressed as `fromHz` → `toHz` over the whole duration; the error tone holds
 * one pitch, so `fromHz === toHz`. `attackMs` is short but non-zero on all three: a sine that
 * starts at a non-zero sample is a click, and a click is exactly the attention-grabbing artefact
 * a product called "invisible until needed" cannot afford.
 */
export const EARCONS: Readonly<Record<EarconId, EarconSpec>> = {
  'capture-start': { id: 'capture-start', fromHz: 660, toHz: 880, durationMs: 80, attackMs: 4 },
  'capture-end': { id: 'capture-end', fromHz: 880, toHz: 660, durationMs: 80, attackMs: 4 },
  error: { id: 'error', fromHz: 330, toHz: 330, durationMs: 140, attackMs: 6 },
};

export interface EarconPlayer {
  /**
   * Fire and forget. This is called from the trigger path and must never be awaited there — an
   * `await` between the key press and the window being shown costs the overlay's 100 ms budget.
   */
  play(id: EarconId): void;
  /** Default -18 dBFS (ui-design §7.1). Independently adjustable and mutable. */
  setGainDb(db: number): void;
  setEnabled(on: boolean): void;
  dispose(): void;
}
