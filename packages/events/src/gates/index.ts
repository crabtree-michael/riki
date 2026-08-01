/**
 * The thirteen reasons to say nothing, in the order they are asked.
 *
 * Every one is a pure function of a candidate and a `GateContext`, which is what makes the whole
 * trigger policy a Tier 1 test with no game, no session and no clock. **The order is the design**,
 * and it is three rules (coaching-trigger-architecture.md §5.2):
 *
 * 1. **Absolute before conditional.** `quiet_mode` and `muted` are the player's explicit
 *    instruction. They are asked before anything about the game so that "only when I ask" cannot be
 *    defeated by a bug in a game-state gate, and so that its counter is unambiguous.
 * 2. **Cheap before expensive.** `not_in_match` is two field reads; `already_advised` projects the
 *    ledger. The ladder runs on every version bump.
 * 3. **Attribution before convenience.** A trigger refused during a teamfight *and* under cooldown
 *    is counted as `high_intensity`, because that is the reason whoever is tuning the thresholds
 *    needs to see. §5.4 is why that matters more than it looks.
 *
 * The three foldings this ordering exists to prevent, each a real temptation: salience absorbing
 * the cooldown (§4.1), the latch absorbing the cooldown (§5.3), and the gates absorbing detection.
 */

import type { Gate, GateContext } from '../contracts.js';
import type { CoachEvent } from '../types.js';
import { META_MODE, META_PHASE, factAt } from '../detect/util.js';

/**
 * No live match, or a mode the standard timings and benchmarks are wrong for.
 *
 * Two things under one counter, deliberately. No live match is the obvious half; the half that
 * earns the gate is **mode** — Riki confidently coaching Ability Draft on standard ability timings,
 * or Turbo on standard gold and rune timings, is a failure that looks exactly like working
 * software.
 *
 * An *unknown* mode is allowed. Failing closed on a mode string Valve renamed would silently
 * disable the product, which is a worse failure than coaching one Turbo game.
 */
const notInMatch: Gate = {
  reason: 'not_in_match',
  refuses(_candidate: CoachEvent, ctx: GateContext): boolean {
    if (factAt<string>(ctx.world, META_PHASE)?.value !== 'in_progress') return true;
    const mode = factAt<string>(ctx.world, META_MODE)?.value;
    return mode !== undefined && ctx.cfg.blockedModes.includes(mode.toLowerCase());
  },
};

/**
 * "Only when I ask" — dota2 §6.4's hard mode, and under a proactive product the most important
 * control there is. It is parsed locally from a transcript so it works with the model down
 * (coaching-architecture.md §7.1), and this is where that parse takes effect.
 */
const quietMode: Gate = {
  reason: 'quiet_mode',
  refuses: (_candidate, ctx) => ctx.quietMode,
};

const muted: Gate = {
  reason: 'muted',
  refuses: (_candidate, ctx) => ctx.mutedUntil !== null && ctx.now < ctx.mutedUntil,
};

/**
 * A turn is already open, so this trigger is **dropped, not queued** (§5.5).
 *
 * Queueing means speaking about a moment that has passed, and dota2 §6.4's real complaint about
 * unprompted speech is not that there is too much of it but that it arrives late. A
 * player-initiated turn is unaffected: it does not come through this package at all.
 */
const agentSpeaking: Gate = {
  reason: 'agent_speaking',
  refuses: (_candidate, ctx) => ctx.agentSpeaking,
};

const playerSpeaking: Gate = {
  reason: 'player_speaking',
  refuses: (_candidate, ctx) => ctx.playerSpeaking,
};

/** Mid-teamfight advice is noise at best and actively harmful at worst (dota2 §6.4). */
const highIntensity: Gate = {
  reason: 'high_intensity',
  refuses: (_candidate, ctx) => ctx.intensity >= ctx.cfg.intensityThreshold,
};

/**
 * The condition has been continuously true since Riki last mentioned it.
 *
 * This is the gate no cooldown can express, because a cooldown cannot tell a recurrence from a
 * persistence. Without it: "your ult is up" is said, the cooldown expires, the ult is still up, and
 * Riki says it again — forever, at the cooldown's period, for as long as the player does not cast
 * it. No cooldown length fixes that; too short and it repeats, too long and a genuinely new
 * ult-ready moment twenty minutes later is suppressed. §5.3.
 */
const latched: Gate = {
  reason: 'latched',
  refuses: (candidate, ctx) => ctx.latched.has(candidate.key),
};

const kindCooldown: Gate = {
  reason: 'kind_cooldown',
  refuses(candidate, ctx) {
    const last = ctx.lastSpokeByKind.get(candidate.kind);
    return last !== undefined && ctx.now - last < ctx.cfg.kindCooldownMs[candidate.kind];
  },
};

const globalCooldown: Gate = {
  reason: 'global_cooldown',
  refuses: (_candidate, ctx) =>
    ctx.lastSpokeAt !== null && ctx.now - ctx.lastSpokeAt < ctx.cfg.globalCooldownMs,
};

/**
 * dota2 §6.4's novelty gate, first half: **they acted on it**, so saying it again is noise.
 *
 * Whether advice was followed is observed in the world model, never inferred from the conversation
 * (context-and-memory §6.3) — "yeah okay" is worth nothing, the item appearing in the inventory is
 * worth everything.
 *
 * `within` is seconds of **game clock**, which is `CoachingMemoryReader`'s scale and not this
 * package's monotonic one. Conflating the two is the easiest mistake available here and it is
 * invisible until a match pauses.
 */
const alreadyAdvised: Gate = {
  reason: 'already_advised',
  refuses(candidate, ctx) {
    return (
      ctx.memory?.recent(candidate.topic, ctx.cfg.noveltyWindowSeconds)?.response === 'followed'
    );
  },
};

/** …and the second half: they ignored it twice, so they do not want this kind of coaching. */
const ignoredTwice: Gate = {
  reason: 'ignored_twice',
  refuses(candidate, ctx) {
    const record = ctx.memory?.recent(candidate.topic, ctx.cfg.noveltyWindowSeconds);
    return (
      record !== undefined &&
      record.count >= 2 &&
      (record.response === 'ignored' || record.response === 'dismissed')
    );
  },
};

/**
 * The advice would arrive after its window closed.
 *
 * Not a separate calculation: `urgencyOf` already subtracts the speaking latency and returns zero
 * past the deadline, which drives salience to zero. This gate exists so that outcome gets its own
 * counter instead of being indistinguishable from "not important enough" — which are two very
 * different things to learn while tuning (§5.4).
 */
const staleWindow: Gate = {
  reason: 'stale_window',
  refuses: (candidate) => candidate.salience <= 0,
};

const belowThreshold: Gate = {
  reason: 'below_threshold',
  refuses: (candidate, ctx) => candidate.salience < ctx.cfg.speakThreshold,
};

/** The ladder. Order is policy; see the header. */
export const GATES: readonly Gate[] = [
  notInMatch,
  quietMode,
  muted,
  agentSpeaking,
  playerSpeaking,
  highIntensity,
  latched,
  kindCooldown,
  globalCooldown,
  alreadyAdvised,
  ignoredTwice,
  staleWindow,
  belowThreshold,
];

export {
  agentSpeaking,
  alreadyAdvised,
  belowThreshold,
  globalCooldown,
  highIntensity,
  ignoredTwice,
  kindCooldown,
  latched,
  muted,
  notInMatch,
  playerSpeaking,
  quietMode,
  staleWindow,
};
