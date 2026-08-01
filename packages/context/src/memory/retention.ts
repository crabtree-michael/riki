/**
 * The retention ladder — §7.2. What should leave the window, as a pure function.
 *
 * Pure, because policy that is a pure function of a ledger and a budget can be Tier 1 tested
 * against a fixture with no session, no game and no network, while mechanism cannot. That split is
 * §1.2's second non-goal: this file decides *what should not be in the window and what should
 * replace it*; `packages/realtime` decides *how to make that true*.
 *
 * The drop order, least-valuable first:
 *
 * 1. **Command results older than the current turn.** A stale answer about a fight that ended ten
 *    minutes ago has no residual value, while the conversation around it does. This is also the
 *    fastest-growing thing in the window (§7.1): our own injection, not the conversation.
 * 2. **The tool calls whose results were dropped, in the same plan.** See below — this is the rule
 *    an implementation is most likely to get wrong.
 * 3. **Superseded snapshots**, every one but the most recent. A ten-minute-old snapshot describes a
 *    game that no longer exists; it is self-labelling, because the format leads with `T 14:32`, but
 *    it is still ~300 tokens saying nothing.
 * 4. **Old conversation turns, replaced by a rolled summary** (§7.4).
 * 5. **Never dropped:** the most recent snapshot, and the last `keepLastTurns` turns of
 *    conversation. The preamble and manifest are not in the ledger at all — they are the cached
 *    prefix, and removing them costs everything and saves nothing.
 *
 * > **Dropping a result and keeping its call leaves the model looking at a question it asked and
 * > never got an answer to** — the exact vacuum the command architecture's one-result invariant
 * > exists to prevent, reintroduced from the other end. Here that cannot happen structurally: a
 * > `command` ledger entry *is* the pair, holding both the call's name and its result, so one ref
 * > drops both items or neither. `packages/realtime` maps the ref back to its two conversation
 * > items. An implementation that split the entry in two would have to re-earn this rule, and
 * > `retention.test.ts` asserts it in the form that would catch that.
 */

import type { TurnId } from '../common/types.js';
import type { RenderedText, TokenCounter } from '../render/types.js';
import type { RetentionPolicy } from './contracts.js';
import type { LedgerEntry, LedgerRef, WindowBudget, WindowPlan } from './types.js';
import { entryTokens } from './occupancy.js';

/** realtime §5 and K3, as the shape §7.2 asks for. Every number here is *(tunable)*. */
export const DEFAULT_WINDOW_BUDGET: WindowBudget = {
  capTokens: 28_672,
  lowWaterMark: 0.75,
  targetAfter: 0.55,
  keepLastTurns: 6,
};

export interface RetentionOptions {
  readonly counter: TokenCounter;
  /**
   * Renders the replacement for a run of dropped conversation turns (§7.4). Absent means the
   * fourth rung is skipped and old turns are dropped outright rather than summarised — which is
   * what a caller with no world model to render from should do, not a reason to generate one.
   */
  readonly summarise?: (entries: readonly LedgerEntry[]) => RenderedText;
}

interface Candidate {
  readonly ref: LedgerRef;
  readonly entry: LedgerEntry;
  readonly tokens: number;
}

export function createRetentionPolicy(options: RetentionOptions): RetentionPolicy {
  const { counter } = options;

  return {
    // `now` is part of the declared signature and deliberately not taken: everything on the ladder
    // is ordered by ledger position, not by wall time, so a policy that read a clock would be a
    // pure function with a hidden input and a fixture that could stop reproducing.
    plan(ledger, budget: WindowBudget): WindowPlan {
      const visible: Candidate[] = ledger
        .inWindow()
        .map((ref) => ({ ref, entry: ledger.entry(ref) }))
        .filter((c): c is { ref: LedgerRef; entry: LedgerEntry } => c.entry !== undefined)
        .map(({ ref, entry }) => ({ ref, entry, tokens: entryTokens(entry, counter) }));

      const occupancy = visible.reduce((sum, c) => sum + c.tokens, 0);
      const target = Math.floor(budget.capTokens * budget.targetAfter);

      const protectedRefs = protect(visible, budget.keepLastTurns);
      const drop: LedgerRef[] = [];
      const replace: { refs: readonly LedgerRef[]; with: RenderedText }[] = [];
      let estimated = occupancy;

      const take = (candidate: Candidate): void => {
        drop.push(candidate.ref);
        estimated -= candidate.tokens;
      };

      // Rung 1 and 2: command entries outside the current turn. One entry is the call *and* the
      // result, so this rung cannot half-drop a pair.
      //
      // `keepLastTurns` does **not** protect these. §7.2's never-dropped set is the last N turns of
      // *conversation*, and the whole point of the ladder's order is that Riki's own injected
      // artifacts go before anything anybody said — they are ~500 of the ~750 tokens a minute
      // (§7.1), and they are the half we can economise.
      const currentTurn = latestTurn(visible);
      for (const candidate of visible) {
        if (estimated <= target) break;
        if (candidate.entry.kind !== 'command') continue;
        if (candidate.entry.turnId === currentTurn) continue;
        take(candidate);
      }

      // Rung 3: superseded snapshots. The most recent one is never dropped — it is the only line
      // in the window that says what the game currently looks like.
      const newestSnapshot = [...visible].reverse().find((c) => c.entry.kind === 'snapshot')?.ref;
      for (const candidate of visible) {
        if (estimated <= target) break;
        if (candidate.entry.kind !== 'snapshot' || candidate.ref === newestSnapshot) continue;
        if (drop.includes(candidate.ref)) continue;
        take(candidate);
      }

      // Rung 4: old conversation, replaced by a rendered summary rather than deleted. A summary
      // that costs more than what it replaces is not a summary, so the replacement only stands if
      // it is actually cheaper.
      if (estimated > target && options.summarise !== undefined) {
        const stale = visible.filter(
          (c) =>
            (c.entry.kind === 'agent_said' || c.entry.kind === 'player_said') &&
            !protectedRefs.has(c.ref) &&
            !drop.includes(c.ref),
        );
        if (stale.length > 0) {
          const rolled = options.summarise(stale.map((c) => c.entry));
          const freed = stale.reduce((sum, c) => sum + c.tokens, 0);
          if (rolled.tokens < freed) {
            replace.push({ refs: stale.map((c) => c.ref), with: rolled });
            estimated -= freed - rolled.tokens;
          }
        }
      }

      return {
        drop,
        replace,
        estimatedTokensAfter: estimated,
        // Above the cap a cache bust during a teamfight still beats the API truncating oldest-first,
        // which would take the cached prefix — Riki would forget who it is before it forgot its own
        // small talk (§7.3). The compactor may relabel a below-cap plan `quiet_moment`.
        reason: occupancy >= budget.capTokens ? 'forced' : 'low_water',
      };
    },
  };
}

/**
 * What was *said* in the last `keepLastTurns` turns. Never dropped, never summarised away.
 *
 * Conversation only, and that is the whole design of the ladder: everything above rung 4 is
 * something Riki injected, and rung 4 is the first rung that touches what a person said. A coach
 * that forgets the last six exchanges to save tokens it spent on its own snapshots has economised
 * the wrong half (§7.1).
 */
function protect(visible: readonly Candidate[], keepLastTurns: number): ReadonlySet<LedgerRef> {
  const turns: TurnId[] = [];
  for (const candidate of visible) {
    const turnId = turnOf(candidate.entry);
    if (turnId !== null && !turns.includes(turnId)) turns.push(turnId);
  }
  const kept = new Set(turns.slice(-Math.max(0, keepLastTurns)));
  return new Set(
    visible
      .filter((c) => c.entry.kind === 'agent_said' || c.entry.kind === 'player_said')
      .filter((c) => {
        const turnId = turnOf(c.entry);
        return turnId !== null && kept.has(turnId);
      })
      .map((c) => c.ref),
  );
}

function latestTurn(visible: readonly Candidate[]): TurnId | null {
  for (let index = visible.length - 1; index >= 0; index -= 1) {
    const turnId = turnOf(visible[index]?.entry);
    if (turnId !== null) return turnId;
  }
  return null;
}

function turnOf(entry: LedgerEntry | undefined): TurnId | null {
  if (entry === undefined || entry.kind === 'summary') return null;
  return entry.turnId;
}
