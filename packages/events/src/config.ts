/**
 * Every number that decides whether Riki speaks, in one file.
 *
 * `coaching-architecture.md` §6.2 refuses to give coefficients, and §15 item 1 says why: *"they are
 * unmeasurable without a replayed corpus and a human judging the output, and a number written down
 * would be treated as decided."* That refusal is about **authority**, not about the existence of
 * numbers — code cannot run without them.
 *
 * So they are all here, each marked *(tunable, unmeasured)*, and **nothing else in this package
 * contains a numeric literal that affects behaviour**. The tuning ticket (§16 step 3) is then a diff
 * to one file against a golden corpus, rather than a hunt through eight detectors.
 *
 * The one thing the defaults do encode is a *shape*, and the shape is arguable before the numbers
 * are: `low_hp_no_escape` outranks everything because it is the only kind where being late is the
 * same as being wrong, and `ult_ready` is last because it is the easiest thing here to say too
 * often. The ordering is the claim; the gaps between the weights are guesses.
 *
 * This package never reads `process.env` and never resolves a config file — `packages/config` does
 * that once at startup and the composition root injects the result (REPO_SKELETON §6.2, §7).
 *
 * See docs/design/coaching-trigger-architecture.md §4.5.
 */

import type { CoachEventKind } from './types.js';

export interface TriggerConfig {
  // ---------------------------------------------------------------------------------------------
  // Salience (§4)
  // ---------------------------------------------------------------------------------------------

  /** The only *policy* number in the score. Tuning changes this and nothing else (§4.1). */
  readonly kindWeight: Readonly<Record<CoachEventKind, number>>;
  /**
   * Nearer is more urgent, hyperbolically: at this horizon urgency is 0.5 (§4.2).
   *
   * Linear decay over a fixed window has to pick a window length, and any choice makes everything
   * beyond it identical. The hyperbola never reaches zero on its own, which leaves *expired* as the
   * only thing that does.
   */
  readonly urgencyHorizonSeconds: number;
  /**
   * How long speaking takes, subtracted from every deadline before urgency is computed.
   *
   * voice-input §7 puts the conversational latency floor at 1–1.5 s. A stack reminder with 1 s left
   * on it is not a slightly worse stack reminder, it is a wrong one — so this subtraction is what
   * turns "would arrive too late" into a zero urgency and a `stale_window` refusal.
   */
  readonly speakLatencySeconds: number;
  /**
   * Urgency for a detection with no deadline.
   *
   * It exists so that `enemy_missing` — no deadline, and one of the two most valuable things this
   * package can say — is not structurally out-ranked by every rune spawn.
   */
  readonly noDeadlineUrgency: number;

  // ---------------------------------------------------------------------------------------------
  // The gates (§5)
  // ---------------------------------------------------------------------------------------------

  /** Salience below this is `below_threshold`. The single most consequential number here. */
  readonly speakThreshold: number;
  /** Salience below this is not even taped (§6). Deliberately far below `speakThreshold`. */
  readonly tapeSalience: number;
  /** Global rate limit, milliseconds. dota2 §6.4's "don't speak more than once per N seconds". */
  readonly globalCooldownMs: number;
  /** Per-kind rate limit, milliseconds. "Don't say 'rune in 30s' every rune." */
  readonly kindCooldownMs: Readonly<Record<CoachEventKind, number>>;
  /**
   * A latch expires after this much game time, so a condition that has been true for twenty minutes
   * because nothing about the game changed is eventually worth mentioning again (§5.3).
   */
  readonly latchExpirySeconds: number;
  /** The novelty gate's window, in seconds of **game clock** — `CoachingMemoryReader`'s scale. */
  readonly noveltyWindowSeconds: number;
  /** Refuse above this intensity (§7). */
  readonly intensityThreshold: number;
  /**
   * Game modes the standard timings and benchmarks are wrong for.
   *
   * An *unknown* mode is allowed, deliberately: failing closed on a mode string Valve renamed would
   * silently disable the product, which is a worse failure than coaching one Turbo game.
   */
  readonly blockedModes: readonly string[];

  // ---------------------------------------------------------------------------------------------
  // Intensity (§7)
  // ---------------------------------------------------------------------------------------------

  /** The fold window, in seconds of **game** clock — so a pause does not manufacture calm. */
  readonly intensityWindowSeconds: number;
  /** Fraction of max HP lost within the window that alone counts as a full-intensity moment. */
  readonly intensityHpSwing: number;
  /** Enemies within `nearbyRadius` that alone count as a full-intensity moment. */
  readonly intensityNearbyEnemies: number;
  /** Ability casts within the window that alone count as a full-intensity moment. */
  readonly intensityCasts: number;
  /** Dota world units. The minimap is ~16,000 units across, so this is "in the same fight". */
  readonly nearbyRadius: number;

  // ---------------------------------------------------------------------------------------------
  // The detectors (§3)
  // ---------------------------------------------------------------------------------------------

  /** `enemy_missing`: seconds unseen before a hero is worth mentioning. */
  readonly missingAfterSeconds: number;
  /** …and where its magnitude saturates. A hero missing this long is as alarming as it gets. */
  readonly missingSaturationSeconds: number;
  /** `low_hp_no_escape`: the HP fraction below which it looks at escapes at all. */
  readonly lowHpFraction: number;
  /** …and how long that advice stays actionable. */
  readonly lowHpActWithinSeconds: number;
  /**
   * What counts as an escape, by item id.
   *
   * `AbilityState` carries no "is this an escape" flag and the world model has no reason to grow
   * one; hero-specific ability knowledge is reference data, and reference data has exactly one
   * consumer in this product and it is the preamble. This list is deliberately approximate — §3.2
   * says the fix for the noise is the salience weight, not a cleverer detector.
   */
  readonly escapeItems: readonly string[];
  /** `enemy_core_dead_window`: respawn seconds remaining that make a window worth naming. */
  readonly deadWindowSeconds: number;
  /** …and where its magnitude saturates. A longer window is more valuable, not more urgent (§3.2). */
  readonly deadWindowSaturationSeconds: number;
  /** `buyback_unaffordable`: only mention a shortfall the player could plausibly close. */
  readonly buybackShortfallGold: number;
  /** `rune_soon`: predictive lead time. It fires *before* the moment, which is the point. */
  readonly runeLeadSeconds: number;
  /** `stack_now`: the same, and shorter — a stack is a fifteen-second decision. */
  readonly stackLeadSeconds: number;
}

/**
 * Starting points. Every number below is *(tunable, unmeasured)*.
 *
 * `coaching-architecture.md` §12 rows 1 and 2 are the two that decide whether any of this is right,
 * and neither can be settled by a test — both need a replay harness and a person, which is why the
 * tuning ticket is last rather than first.
 */
export const DEFAULT_TRIGGER_CONFIG: TriggerConfig = {
  kindWeight: {
    // The only one where being late is the same as being wrong.
    low_hp_no_escape: 1.0,
    // dota2 §6.2's own example of the highest-value thing Riki can say.
    enemy_missing: 0.85,
    enemy_core_dead_window: 0.6,
    can_afford_key_item: 0.55,
    buyback_unaffordable: 0.5,
    // Frequent. Frequency is what the cooldown is for, not the weight.
    rune_soon: 0.48,
    stack_now: 0.42,
    // Lowest, because it is the easiest thing in this list to say too often.
    ult_ready: 0.38,
  },
  urgencyHorizonSeconds: 15,
  speakLatencySeconds: 1.5,
  noDeadlineUrgency: 0.85,

  speakThreshold: 0.3,
  tapeSalience: 0.05,
  globalCooldownMs: 45_000,
  kindCooldownMs: {
    low_hp_no_escape: 20_000,
    enemy_missing: 45_000,
    enemy_core_dead_window: 90_000,
    can_afford_key_item: 120_000,
    buyback_unaffordable: 180_000,
    rune_soon: 150_000,
    stack_now: 120_000,
    ult_ready: 120_000,
  },
  latchExpirySeconds: 300,
  noveltyWindowSeconds: 600,
  intensityThreshold: 0.5,
  // Lowercase, and matched against a lowercased `meta.mode`. Riki confidently coaching Ability
  // Draft on standard ability timings is a failure that looks exactly like working software.
  blockedModes: ['turbo', 'ability_draft', 'abilitydraft', 'custom', 'event', 'demo'],

  intensityWindowSeconds: 8,
  intensityHpSwing: 0.35,
  intensityNearbyEnemies: 3,
  intensityCasts: 4,
  nearbyRadius: 2_000,

  missingAfterSeconds: 25,
  missingSaturationSeconds: 45,
  lowHpFraction: 0.35,
  lowHpActWithinSeconds: 5,
  escapeItems: [
    'item_blink',
    'item_force_staff',
    'item_hurricane_pike',
    'item_glimmer_cape',
    'item_cyclone',
    'item_wind_waker',
    'item_ghost',
    'item_tpscroll',
  ],
  deadWindowSeconds: 25,
  deadWindowSaturationSeconds: 60,
  buybackShortfallGold: 1_500,
  runeLeadSeconds: 30,
  stackLeadSeconds: 12,
};

/** A partial override, for the composition root and for tests that vary one number. */
export function withTriggerConfig(overrides: Partial<TriggerConfig>): TriggerConfig {
  return { ...DEFAULT_TRIGGER_CONFIG, ...overrides };
}
