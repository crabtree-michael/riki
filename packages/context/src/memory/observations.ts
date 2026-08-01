/**
 * The one path from a match to durable memory — §6.4.
 *
 * This function is where the privacy guarantee is actually *earned*. ADR-0013 makes free text
 * unrepresentable in `PlayerObservation`, which means a mistake here cannot leak a transcript even
 * if it tries; what this file has to get right is the narrower thing — that nothing about **other
 * people** is derived either. Teammates and opponents appear only as hero ids, and a hero id is not
 * a person.
 *
 * It reads the ledger and the world model and produces observations. It writes nothing: the store
 * decides what to keep and when to flush, and keeping the derivation separate is what lets the
 * egress test run the whole path — chat in, bytes out — without a store that could hide a step.
 */

import type { HeroId, Role } from '../common/types.js';
import type { WorldSnapshot } from '../common/ports.js';
import type { CoachingMemory } from './contracts.js';
import type { PlayerObservation } from './types.js';

export interface MatchOutcome {
  readonly hero: HeroId;
  readonly role: Role;
  readonly result: 'win' | 'loss' | 'unknown';
  /** Wall-clock milliseconds, from the composition root. Durable memory ages in days, not ticks. */
  readonly at: number;
}

/**
 * What this match taught us about this player.
 *
 * Exactly two kinds today: which hero was played and how it went, and how each piece of advice
 * landed. The second is the one OpenDota cannot supply and the reason durable memory exists at all
 * (§6.4) — and the response comes from `CoachingMemory.observeOutcome`, which reads the world model
 * rather than the conversation. "Yeah okay" is worth nothing; the item is worth everything.
 *
 * `pattern` observations are deliberately absent: a pattern is a claim across matches ("dies to the
 * same rotation three times in four"), and deriving one from a single match would be a claim this
 * function cannot support. That is a `PatternId` producer for someone with the whole history, and
 * §14 costs it as one new arm plus a projection.
 */
export function observationsFrom(
  coaching: CoachingMemory,
  world: WorldSnapshot,
  outcome: MatchOutcome,
): readonly PlayerObservation[] {
  const observations: PlayerObservation[] = [
    {
      kind: 'hero_played',
      hero: outcome.hero,
      role: outcome.role,
      result: outcome.result,
      at: outcome.at,
    },
  ];

  for (const record of coaching.all()) {
    const response = coaching.observeOutcome(record, world, world.now);
    // `unknown` is recorded, not skipped. "Riki gave this advice and we could not tell whether it
    // landed" is a different fact from "Riki never gave it", and the tendency projection needs the
    // denominator to mean anything.
    observations.push({
      kind: 'advice_response',
      topic: record.topic,
      response,
      at: outcome.at,
    });
  }

  return observations;
}
