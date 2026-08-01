/**
 * Coaching memory — a lazy projection over the ledger, memoised against its version.
 *
 * The parallel to derived state (state-capture §6) is deliberate rather than decorative: it is what
 * gives "what happens to coaching memory at compaction" an answer instead of a bug. Compaction
 * changes `inWindow`, not the entries, and this projects from the entries — so the novelty gate is
 * correct across a compaction and across a reconnect, which is the entire reason ADR-0012 exists.
 *
 * Two decisions carry this file, and both are worth resisting the urge to improve:
 *
 * **Topics come from the trigger, never from the text.** When `packages/events` fires
 * `can_afford_key_item` and Riki speaks, the topic is that event — it was recorded on `turn_opened`
 * before a word was spoken. Nothing here classifies natural language, so there is no model in the
 * loop, no drift, and a deterministic gate. The imprecision is real and accepted: Riki may be
 * triggered by one thing and talk about another, and the record will be wrong. A player-initiated
 * turn has no topic at all, which is correct — the player asked, and answering the same question
 * twice is what a coach should do.
 *
 * **Whether advice was followed is observed in the world model, not inferred from the
 * conversation.** "Yeah okay" is worth nothing; the item appearing in the inventory is worth
 * everything.
 *
 * See docs/design/context-and-memory-architecture.md §6.3, §9.3.
 */

import type { GameClock, TurnId } from '../common/types.js';
import type { WorldSnapshot } from '../common/ports.js';
import type { CoachingMemory } from './contracts.js';
import type { MatchLedger } from './ledger.js';
import type { AdviceRecord, AdviceResponse, AdviceTopic } from './types.js';
import { path } from '../snapshot/sections/util.js';

/** A topic's identity, so `ReadonlyMap` can hold one. Closed union in, stable string out. */
export function topicKey(topic: AdviceTopic): string {
  switch (topic.of) {
    case 'event':
      return `event:${String(topic.event)}`;
    case 'item':
      return `item:${String(topic.item)}`;
    case 'hero':
      return `hero:${String(topic.hero)}`;
    case 'objective':
      return `objective:${topic.objective}`;
  }
}

export interface CoachingOptions {
  /**
   * How long an item has to appear in for the advice to count as followed *(tunable: 90 s of game
   * clock)*. Past it, gold spent elsewhere is `ignored` rather than a verdict still pending.
   */
  readonly followWithinSeconds?: number;
}

const DEFAULT_FOLLOW_WITHIN = 90;

interface Projection {
  readonly version: number;
  readonly records: ReadonlyMap<string, AdviceRecord>;
  readonly lastSpokeAt: GameClock | null;
  readonly firstClock: GameClock | null;
  readonly latestClock: GameClock | null;
}

interface ItemState {
  readonly id: string;
}

export function createCoachingMemory(
  ledger: MatchLedger,
  options: CoachingOptions = {},
): CoachingMemory {
  const followWithin = options.followWithinSeconds ?? DEFAULT_FOLLOW_WITHIN;
  let memo: Projection | null = null;

  function project(): Projection {
    if (memo !== null && memo.version === ledger.version()) return memo;

    // A turn's game clock lives on `turn_opened`; what was said lives on `agent_said`. Joining them
    // by turn id is what lets an `AdviceRecord` be in game time, which is the only time scale
    // `packages/events` reasons in.
    const clockOf = new Map<TurnId, GameClock | null>();
    const records = new Map<string, AdviceRecord>();
    let lastSpokeAt: GameClock | null = null;
    let firstClock: GameClock | null = null;
    let latestClock: GameClock | null = null;

    for (const entry of ledger.all()) {
      if (entry.kind === 'turn_opened') {
        clockOf.set(entry.turnId, entry.clock);
        if (entry.clock !== null) {
          firstClock ??= entry.clock;
          latestClock = entry.clock;
        }
        continue;
      }
      if (entry.kind !== 'agent_said') continue;

      // A turn whose `turn_opened` was never appended, or one opened before the horn, has no game
      // clock. Falling back to the latest one the ledger knows keeps an `AdviceRecord` in game
      // time — the only scale `packages/events` reasons in — instead of leaving a hole in it.
      const at = clockOf.get(entry.turnId) ?? latestClock;
      if (at !== null) lastSpokeAt = at;

      for (const topic of entry.topics) {
        const key = topicKey(topic);
        const previous = records.get(key);
        const clock = at ?? (0 as GameClock);
        records.set(
          key,
          previous === undefined
            ? { topic, firstAt: clock, lastAt: clock, count: 1, response: 'unknown' }
            : { ...previous, lastAt: clock, count: previous.count + 1 },
        );
      }
    }

    memo = { version: ledger.version(), records, lastSpokeAt, firstClock, latestClock };
    return memo;
  }

  return {
    /**
     * `within` is seconds of **game clock**, measured back from the latest clock the ledger knows
     * about — not from a wall clock, and not from a `now` the caller passes.
     *
     * `packages/events` reasons in game time (dota2 §6.4) and the ledger already holds the latest
     * one, so taking a second `now` would be a parameter two callers could disagree about.
     */
    recent(topic: AdviceTopic, within: number): AdviceRecord | undefined {
      const state = project();
      const record = state.records.get(topicKey(topic));
      if (record === undefined) return undefined;
      if (state.latestClock === null) return record;
      return state.latestClock - record.lastAt <= within ? record : undefined;
    },

    lastSpokeAt(): GameClock | null {
      return project().lastSpokeAt;
    },

    /**
     * Seconds since Riki last spoke, or since the ledger's first known clock if it never has.
     *
     * The second case is the one that matters to `packages/events`: "Riki has been quiet for nine
     * minutes" has to be true on a match where Riki has said nothing at all, which is exactly the
     * match where somebody should notice.
     */
    silentFor(now: GameClock): number {
      const state = project();
      const since = state.lastSpokeAt ?? state.firstClock;
      return since === null ? 0 : Math.max(0, now - since);
    },

    all(): readonly AdviceRecord[] {
      return [...project().records.values()];
    },

    /**
     * The one place this component reads the world model for something other than rendering.
     *
     * Only an item topic is observable today, and saying so is better than inventing a heuristic:
     * a `roshan` topic would need "did the team take Roshan, and was it because of this", which is
     * causal inference the world model cannot support and a coach should not guess at. `unknown`
     * is an honest verdict and durable memory (§6.4) is built to hold it.
     */
    observeOutcome(record: AdviceRecord, world: WorldSnapshot): AdviceResponse {
      const topic = record.topic;
      if (topic.of !== 'item') return 'unknown';

      const inventory = world.get<readonly ItemState[]>(path('self.items'));
      if (inventory === undefined) return 'unknown';

      const held = inventory.value.some((item) => item.id === String(topic.item));
      if (held) return 'followed';

      const clock = world.clock;
      if (clock === null) return 'unknown';
      return clock - record.lastAt > followWithin ? 'ignored' : 'unknown';
    },
  };
}
