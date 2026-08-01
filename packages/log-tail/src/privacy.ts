/**
 * Privacy tagging, applied where the data is created.
 *
 * dota2 §7 is unambiguous that chat lines carry **other people's words**, and the reason this is a
 * source-side concern rather than a sink-side one is that a sink can forget. Two independent
 * gates consume the tag — `packages/telemetry` redacts on `sensitive`, and `packages/context`
 * refuses to render such a field into the snapshot unless the config flag is on — and both of
 * them are downstream of a decision made here, once.
 *
 * There is deliberately no way to construct a `ChatLine` with any other classification: the type
 * in `contracts.ts` fixes `privacy` to the literal `'sensitive'`. This module exists to make the
 * same rule reachable for anything a later matcher adds.
 */

import type { LogEvent, PrivacyClass } from './contracts.js';

/**
 * A kill and a ping are public: they describe the game, and every player in the match already saw
 * them. A chat line is not, whoever typed it.
 */
export function privacyOf(event: LogEvent): PrivacyClass {
  return event.kind === 'chat' ? 'sensitive' : 'public';
}

/**
 * Whether an event may leave the machine under a given configuration.
 *
 * The default is the strict one, and it is the default because this is the failure that cannot be
 * walked back once it has happened: a chat line sent to a model is a chat line somebody else's
 * words are now in the training-adjacent path of, and no later toggle undoes it.
 */
export function mayEgress(event: LogEvent, chatEgressEnabled = false): boolean {
  return privacyOf(event) === 'public' || chatEgressEnabled;
}
