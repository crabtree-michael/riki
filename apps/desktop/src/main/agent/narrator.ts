/**
 * The world, rendered for the LLM coach — and rendered by the **same** renderer that writes it for
 * the voice model.
 *
 * That sharing is the load-bearing decision in this file and it is worth stating as a rule:
 *
 * > **There is one renderer of game facts in this product.** The coach reads what the Realtime model
 * > reads, through `packages/context`'s `AgeFormatter` and `PrivacyGate`, and it never sees a
 * > `WorldSnapshot`.
 *
 * Four things follow, and each is something that would otherwise have to be built and then kept in
 * step: no second age formatter, so the coach cannot render a thirty-second-old position as a bare
 * fact; no second privacy gate, so the brief's egress test covers this path rather than being
 * duplicated; no second format for a change to break; and — the one that is easy to miss — the two
 * models cannot contradict each other about what the game looks like, because they are looking at
 * the same string.
 *
 * ## Why the budget is larger, and why that is not a loophole
 *
 * The snapshot is capped at ~400 tokens because it lands in the Realtime **conversation window**,
 * where it is billed as input on every later turn and competes with the brief and the conversation
 * for a ceiling the three of them share (context-and-memory §7.1). The coach's copy is not in that
 * window: it is one request that ends when the judgement does. So the ceiling that applies to it is
 * a different one, and the number here is generous rather than tight.
 *
 * This is the asymmetry that makes the LLM coach worth having at all, and it is not obvious — the
 * coach can be shown considerably more of the game than the thing that speaks, for a cost paid once
 * rather than forever. `coaching-architecture.md` §8.2's per-minute arithmetic and its ~42-minute
 * first compaction are **unchanged by this file**, and they must stay that way: nothing here writes
 * to the ledger or to the window.
 *
 * See docs/design/llm-coach-architecture.md §6.1.
 */

import type { EventTapeReader, PrivacyPolicy, TurnId, WorldModelReader } from '@riki/context';
import { DEFAULT_PRIVACY, createSnapshotRenderer } from '@riki/context';
import type { WorldNarrator } from '@riki/coach';
import type { MonoMs } from '@riki/world-model';

/**
 * The coach's view ceiling *(tunable, unmeasured)*.
 *
 * Three times the voice model's, for the reason in the header. It is a ceiling rather than a target:
 * a mid-game world renders well under it, and the number exists so that a pathological one — every
 * enemy seen, every derived field satisfied — still terminates in a bounded string.
 */
export const NARRATION_TOKENS = 1_200;

/** How many taped events the coach is shown. More than the snapshot's five; it has room. */
export const NARRATION_TAPE_EVENTS = 12;

export interface SnapshotNarratorDeps {
  /** Already projected — `toContextReader(state.world)`. */
  readonly world: WorldModelReader;
  /** The same tape `packages/events` fills. Detections, not utterances (`EventTape`'s header). */
  readonly tape?: EventTapeReader;
  /** From config. Defaults to the same closed-by-default policy every other renderer takes. */
  readonly privacy?: PrivacyPolicy;
  readonly maxTokens?: number;
}

/**
 * A `WorldNarrator` over the snapshot renderer.
 *
 * `cause` is `{ by: 'system', reason: 'rehydrate' }` and the choice matters: the renderer promotes
 * exactly one section based on the turn's cause (context-and-memory §5.2), and a consultation has no
 * cause to promote — the coach is being shown the game, not a moment. A `system` cause promotes
 * nothing, which is the honest answer. Passing the last event's id instead would tilt every
 * narration toward whatever fired most recently, which is precisely the bias this coach exists to
 * be free of.
 *
 * `elisionBase: null` for a harder reason. An elided snapshot is a delta against a base that must
 * still be in the reader's context, and the coach has no context across consultations at all — every
 * judgement is a fresh call. A `(unchanged since 14:12)` marker would reference a turn this model
 * has never seen.
 */
export function createSnapshotNarrator(deps: SnapshotNarratorDeps): WorldNarrator {
  const renderer = createSnapshotRenderer();
  const privacy = deps.privacy ?? DEFAULT_PRIVACY;
  const maxTokens = deps.maxTokens ?? NARRATION_TOKENS;

  return {
    narrate(now: MonoMs): string {
      const world = deps.world.snapshot(now);
      const rendered = renderer.render(world, {
        // Not a real turn: nothing is opened, nothing is appended to the ledger, and no window
        // accounting happens. The id is a label so a golden fixture has something stable to key on,
        // and `nextCoachTurnId`'s counter is deliberately not touched — two ids from two counters
        // sharing a prefix is the bug that function's header warns about.
        turnId: 'coach_view' as TurnId,
        now,
        cause: { by: 'system', reason: 'rehydrate' },
        budget: { maxTokens, spentTokens: 0 },
        privacy,
        tape: deps.tape?.recent(NARRATION_TAPE_EVENTS, null) ?? [],
        elisionBase: null,
      });
      // Total, like every renderer here: a world with no facts in it yet renders nothing, and the
      // coach skips the consultation `no_world` rather than asking a model about an empty string.
      return rendered.text;
    },
  };
}
