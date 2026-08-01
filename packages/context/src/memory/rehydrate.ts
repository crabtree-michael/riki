/**
 * Reconnect — §7.5.
 *
 * A dropped or expired session is a normal event in a long match, not an edge case: Riki's window
 * fills in ~38 minutes (§7.1) and the API caps a session at 60. Without a ledger, a reconnected Riki
 * repeats every piece of advice it has already given, at the point in the match where the player has
 * had the most chances to get tired of it. With one, recovery is this file.
 *
 * Two rules, and the second is a product rule rather than a technical one:
 *
 * - **Audio is never replayed.** The brief is text; the recorded transcripts are the record.
 * - **The player is told.** A coach that silently forgets the last twenty minutes and then
 *   confidently repeats itself is worse than one that says "lost you for a second — where were we".
 *   The brief exists so that sentence is not necessary, but dota2 §9's honesty rule still applies:
 *   degrade loudly to the developer, quietly to the user, and never silently into wrongness. Saying
 *   it is the composition root's job; making it unnecessary is this file's.
 *
 * The load-bearing property is that **every advice topic already raised appears in the brief** —
 * that is the "does not repeat itself" guarantee, and it is what `rehydrate.test.ts` asserts.
 */

import type { WorldModelReader, WorldSnapshot } from '../common/ports.js';
import type { Budget, RenderedText, Section, SectionId } from '../render/types.js';
import type { ConversationLedger, Rehydrator, SummaryRenderer } from './contracts.js';
import type { LedgerEntry, LedgerRef } from './types.js';
import { createSectionComposer } from '../render/compose.js';
import { estimateTokens } from '../render/tokens.js';
import { topicKey } from './coaching.js';
import { topicLabel } from './summary.js';

const composer = createSectionComposer();

export interface RehydratorOptions {
  readonly summary: SummaryRenderer;
  /** How many recent utterances the gist carries *(tunable)*. */
  readonly recentTurns?: number;
}

/**
 * `SummaryRenderer` reads a `WorldModelReader`; a brief is handed a `WorldSnapshot`.
 *
 * Adapting the one we have rather than taking a second dependency keeps the brief a pure function
 * of the ledger and the snapshot it was given — so a test can hand it a fixture and get the same
 * text every time. `history()` is empty because a brief summarises what Riki *said*, and the world
 * model's own history is the summary's other half only when it is available.
 */
function readerFor(world: WorldSnapshot): WorldModelReader {
  return {
    snapshot: () => world,
    onVersion: () => () => undefined,
    history: () => [],
  };
}

const DEFAULT_RECENT_TURNS = 3;

function section(id: string, priority: number, text: string, droppable = true): Section {
  return { id: id as SectionId, priority, droppable, body: { text, tokens: estimateTokens(text) } };
}

export function createRehydrator(options: RehydratorOptions): Rehydrator {
  const recentTurns = options.recentTurns ?? DEFAULT_RECENT_TURNS;

  return {
    brief(ledger: ConversationLedger, world: WorldSnapshot, budget: Budget): RenderedText {
      const entries = ledger.since(0 as LedgerRef);

      const rolled = options.summary.render(entries, readerFor(world), {
        maxTokens: Math.floor(budget.maxTokens / 2),
        spentTokens: 0,
      });

      // Every topic, deduplicated but never truncated by count — this is the section that stops
      // twenty minutes of coaching being repeated, so it is `droppable: false`. If the budget
      // cannot hold it, the brief is over budget and says so, rather than quietly dropping the one
      // thing it exists to carry.
      const topics = new Map<string, string>();
      for (const entry of entries) {
        if (entry.kind !== 'agent_said') continue;
        for (const topic of entry.topics) topics.set(topicKey(topic), topicLabel(topic));
      }

      const gist = entries
        .filter(
          (entry): entry is Extract<LedgerEntry, { kind: 'agent_said' | 'player_said' }> =>
            entry.kind === 'agent_said' || entry.kind === 'player_said',
        )
        .slice(-recentTurns)
        .map((entry) => `${entry.kind === 'agent_said' ? 'you' : 'player'}: ${entry.transcript}`)
        .join(' · ');

      const composed = composer.compose(
        [
          section('rehydrate_header', 100, '[session resumed — match already in progress]', false),
          ...(rolled.text === '' ? [] : [section('rehydrate_summary', 90, rolled.text, false)]),
          ...(topics.size === 0
            ? []
            : [
                section(
                  'rehydrate_advised',
                  80,
                  `already advised: ${[...topics.values()].join(', ')} — do not repeat`,
                  false,
                ),
              ]),
          ...(gist === '' ? [] : [section('rehydrate_gist', 20, `last exchanges: ${gist}`)]),
        ],
        budget,
      );

      return { text: composed.text, tokens: composed.tokens };
    },
  };
}
