/**
 * Working memory — the smallest span, and the only one the renderer touches.
 *
 * It holds no history of its own. Every method below is a lookup into the ledger or a cached
 * projection of it, which is what makes "what happens to working memory at compaction" a question
 * with an answer rather than a bug: nothing here can survive a compaction that the ledger did not,
 * because nothing here is a copy.
 *
 * The elision base is the clearest case. It is a *lookup* — "the most recent snapshot, if we still
 * believe the model can see it" — rather than a cached string, so a compaction that drops the base
 * makes the next snapshot full automatically, with no invalidation step anyone has to remember to
 * call (§10, "elision base dropped").
 *
 * See docs/design/context-and-memory-architecture.md §6.1.
 */

import type { GameClock, MonoMs, TurnId } from '../common/types.js';
import type { TokenCounter } from '../render/types.js';
import type { ElisionBase, RenderedSnapshot } from '../snapshot/types.js';
import type { CoachingMemory, WorkingMemory } from './contracts.js';
import type { MatchLedger } from './ledger.js';
import type { AdviceRecord, AdviceTopic, LedgerRef, TurnOutcome, WindowState } from './types.js';
import { entryTokens } from './occupancy.js';

export interface WorkingMemoryOptions {
  /**
   * **Off, and §5.3 is the argument.** An elided snapshot is a delta against a base that compaction
   * is entitled to drop, and the failure — `(unchanged since 14:12)` about a value the model can no
   * longer see — is silent and lands in the tier that carries self-state. Turn it on when §12's
   * window-belief reconciliation has been measured, not before.
   */
  readonly elision?: boolean;
}

export interface MutableWorkingMemory extends WorkingMemory {
  /**
   * What the assembler calls: the rendered snapshot *and* the ref the ledger gave it.
   *
   * `noteRendered(ref)` is the declared contract (§6.1) and stays exactly that. This is the extra
   * half the assembler needs, kept off the interface three other things read.
   */
  recordSnapshot(rendered: RenderedSnapshot, ref: LedgerRef, clock: GameClock | null): void;
  /** Set by the compactor once `packages/realtime` has confirmed a plan (§7.3). */
  noteCompacted(at: MonoMs): void;
  /** The last snapshot rendered this match, in window or not. Read by the rehydration brief. */
  lastSnapshot(): RenderedSnapshot | null;
  outcomeOf(turnId: TurnId): TurnOutcome | undefined;
}

export function createWorkingMemory(
  ledger: MatchLedger,
  coaching: CoachingMemory,
  counter: TokenCounter,
  options: WorkingMemoryOptions = {},
): MutableWorkingMemory {
  const elisionEnabled = options.elision ?? false;
  const outcomes = new Map<TurnId, TurnOutcome>();

  let baseRef: LedgerRef | null = null;
  let baseRendered: RenderedSnapshot | null = null;
  let baseClock: GameClock | null = null;
  let lastCompactedAt: MonoMs | null = null;

  return {
    elisionBase(): ElisionBase | null {
      if (!elisionEnabled || baseRef === null || baseRendered === null) return null;
      // The base has to still be believed visible. `inWindow` is a belief and not a fact (§7.6) —
      // but it is the same belief the retention policy acts on, so the two cannot disagree.
      if (!ledger.inWindow().includes(baseRef)) return null;
      return { rendered: baseRendered, clock: baseClock };
    },

    /** Advice given at any point this match — the "you already know" suppression, unbounded. */
    raised(topic: AdviceTopic): AdviceRecord | undefined {
      return coaching.recent(topic, Number.POSITIVE_INFINITY);
    },

    window(): WindowState {
      const inWindow = ledger.inWindow();
      let estimatedTokens = 0;
      for (const ref of inWindow) {
        const entry = ledger.entry(ref);
        if (entry !== undefined) estimatedTokens += entryTokens(entry, counter);
      }
      return { estimatedTokens, inWindow, lastCompactedAt };
    },

    noteRendered(ref: LedgerRef): void {
      if (ledger.entry(ref)?.kind !== 'snapshot') return;
      baseRef = ref;
    },

    recordSnapshot(rendered: RenderedSnapshot, ref: LedgerRef, clock: GameClock | null): void {
      this.noteRendered(ref);
      baseRendered = rendered;
      baseClock = clock;
    },

    noteTurnClosed(turnId: TurnId, outcome: TurnOutcome): void {
      outcomes.set(turnId, outcome);
    },

    noteCompacted(at: MonoMs): void {
      lastCompactedAt = at;
    },

    lastSnapshot(): RenderedSnapshot | null {
      return baseRendered;
    },

    outcomeOf(turnId: TurnId): TurnOutcome | undefined {
      return outcomes.get(turnId);
    },
  };
}
