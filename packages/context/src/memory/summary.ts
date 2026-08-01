/**
 * Summaries are **rendered, not generated** — §7.4.
 *
 * The obvious way to compact a conversation is to ask a model to summarise it. Riki should not,
 * because Riki is in an unusual position: *the thing being summarised is already structured.* The
 * world model holds the kills, the objectives, the item timings and the net-worth curve; the ledger
 * holds every piece of advice given. A summary of the first twenty minutes of a Dota match is a
 * template over data we already have.
 *
 * That buys four things a generated summary does not, and the fourth is the one that decides it:
 * it costs no tokens and no latency, it cannot hallucinate a kill that did not happen, it is
 * golden-testable as a diff like every other format here, and **it works when the session is
 * already unhealthy** — which is exactly when compaction tends to be needed.
 *
 * What it does not capture is the *texture* of the conversation: what the player was worried about,
 * how they asked. That is kept as topic labels rather than prose. Lossy, and accepted (§7.4).
 */

import type { MonoMs } from '../common/types.js';
import type { WorldModelReader } from '../common/ports.js';
import type { Budget, RenderedText, Section, SectionId } from '../render/types.js';
import type { SummaryRenderer } from './contracts.js';
import type { AdviceTopic, LedgerEntry } from './types.js';
import { createSectionComposer } from '../render/compose.js';
import { estimateTokens } from '../render/tokens.js';
import { clockText, path, short } from '../snapshot/sections/util.js';
import { topicKey } from './coaching.js';

const composer = createSectionComposer();

interface Kda {
  readonly kills: number;
  readonly deaths: number;
  readonly assists: number;
}

/** `bkb`, `roshan`, `rune_soon` — a topic said the short way, for a line the model skims. */
export function topicLabel(topic: AdviceTopic): string {
  switch (topic.of) {
    case 'event':
      return String(topic.event);
    case 'item':
      return String(topic.item);
    case 'hero':
      return String(topic.hero);
    case 'objective':
      return topic.objective;
  }
}

function section(id: string, priority: number, text: string, droppable = true): Section {
  return {
    id: id as SectionId,
    priority,
    droppable,
    body: { text, tokens: estimateTokens(text) },
  };
}

export function createSummaryRenderer(): SummaryRenderer {
  return {
    /**
     * Deterministic: the same ledger and the same world history render the same text.
     *
     * `now` comes from the last entry rather than from a clock, which is what makes that sentence
     * true. A summary that read the wall clock would render differently on every replay and could
     * not be a golden fixture.
     */
    render(entries: readonly LedgerEntry[], world: WorldModelReader, budget: Budget): RenderedText {
      const at = (entries.at(-1)?.at ?? 0) as MonoMs;
      const snapshot = world.snapshot(at);

      const kda = snapshot.get<Kda>(path('self.kda'))?.value;
      const netWorth = snapshot.get<number>(path('self.netWorth'))?.value;
      const lead = snapshot.get<number>(path('derived.netWorthLead'))?.value;

      const state = [
        kda === undefined
          ? null
          : `you ${String(kda.kills)}/${String(kda.deaths)}/${String(kda.assists)}`,
        netWorth === undefined ? null : `nw ${short(netWorth)}`,
        lead === undefined
          ? null
          : `net worth ${lead >= 0 ? 'us +' : 'them +'}${short(Math.abs(lead))}`,
      ]
        .filter((part): part is string => part !== null)
        .join(' · ');

      // Advice, by topic and count. This is the half the world model cannot reconstruct, and the
      // half the novelty gate needs to survive a compaction.
      const counts = new Map<string, { topic: AdviceTopic; count: number }>();
      let questions = 0;
      for (const entry of entries) {
        if (entry.kind === 'player_said') questions += 1;
        if (entry.kind !== 'agent_said') continue;
        for (const topic of entry.topics) {
          const key = topicKey(topic);
          const previous = counts.get(key);
          counts.set(key, { topic, count: (previous?.count ?? 0) + 1 });
        }
      }

      const advice = [...counts.values()]
        .map((c) =>
          c.count === 1 ? topicLabel(c.topic) : `${topicLabel(c.topic)}×${String(c.count)}`,
        )
        .join(', ');

      const composed = composer.compose(
        [
          section('summary_header', 100, `[summary to ${clockText(snapshot.clock)}]`, false),
          ...(state === '' ? [] : [section('summary_state', 90, state)]),
          ...(advice === '' ? [] : [section('summary_advice', 80, `advised: ${advice}`)]),
          ...(questions === 0
            ? []
            : [section('summary_questions', 40, `you asked ${String(questions)}`)]),
        ],
        budget,
      );

      return { text: composed.text, tokens: composed.tokens };
    },
  };
}
