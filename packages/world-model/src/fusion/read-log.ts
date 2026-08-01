/**
 * A console-log event, read into candidate facts.
 *
 * The log is the only source that reports an *instant* rather than a state: "Pudge killed Lina"
 * happened at a moment, and everything downstream is inference from it. Two consequences:
 *
 * - A kill line yields `alive: false` and nothing else. The respawn timer is a function of level,
 *   which the log does not carry — CV's top bar does, and the `enemy_liveness` class lets it fill
 *   exactly that gap once the log has been quiet (fusion/precedence.ts).
 * - Chat does not become a fact at all. It goes to the chat ring, which the reducer owns, because
 *   a chat line is an event with a time and not a field with a current value.
 *
 * ⚠ Structural for the same reason as the other two readers: `packages/log-tail` owns `LogEvent`
 * and the model may not import a source.
 */

import type { Timestamps } from '../fact.js';
import { logFact } from '../fact.js';
import type { ChatLine, HeroId } from '../state.js';
import { heroField } from '../state.js';
import type { Candidate } from './candidate.js';
import { asRecord, readString } from './candidate.js';

export interface LogReadResult {
  readonly candidates: readonly Candidate[];
  /** Appended to the chat ring by the reducer; never a field, because it has no current value. */
  readonly chat: readonly ChatLine[];
}

/**
 * Which side a named hero is on is the model's knowledge, not the log's: the kill feed gives two
 * hero names and no teams. So the caller passes the roster it already has, and a kill involving a
 * hero the model has never heard of yields nothing rather than a guess.
 */
export function readLogEvent(
  payload: unknown,
  at: Timestamps,
  sideOf: (hero: HeroId) => 'allies' | 'enemies' | undefined,
): LogReadResult {
  const record = asRecord(payload);
  const kind = readString(record, 'kind');

  if (kind === 'chat') {
    const text = readString(record, 'text');
    if (text === undefined) return { candidates: [], chat: [] };
    const channel = readString(record, 'channel');
    return {
      candidates: [],
      chat: [
        {
          text,
          speaker: readString(record, 'speaker'),
          channel: channel === 'all' || channel === 'team' ? channel : 'system',
          privacy: 'sensitive',
        },
      ],
    };
  }

  if (kind === 'kill') {
    const victim = readString(record, 'victim') as HeroId | undefined;
    if (victim === undefined) return { candidates: [], chat: [] };
    const side = sideOf(victim);
    if (side === undefined) return { candidates: [], chat: [] };
    return {
      candidates: [
        {
          path: heroField(side, victim, 'alive'),
          fact: logFact(false, at, 'killfeed'),
        },
      ],
      chat: [],
    };
  }

  // Pings carry intent, not state. `packages/events` will want them off the delta tape; until it
  // does, dropping them here is better than inventing a field nothing reads.
  return { candidates: [], chat: [] };
}
