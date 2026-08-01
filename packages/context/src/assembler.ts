/**
 * The one thing this package exports at runtime.
 *
 * Three renderings of context and four spans of memory meet here, and the reason they meet in one
 * object is that they share two budgets: the 16,384-token cached prefix (Tier 1, §4.2) and the
 * ~28,672-token conversation window (the snapshot, the coaching brief and the conversation, §7.1).
 * Nobody can enforce a ceiling on a resource they can only see a third of.
 *
 * One turn, end to end (§9.2, coaching-architecture.md §9.2):
 *
 * ```
 *   events decides to speak ──► openTurn(brief)
 *          snapshot + coaching brief rendered ──► ledger.append() ×2 ──► handed to the session
 *          agent speaks ──► ledger.append({kind:'agent_said', topics})
 *                                  closeTurn() ──► Compactor.consider() ──► WindowPlan | null
 * ```
 *
 * **An empty brief is a turn that should not happen** (coaching-architecture.md §6.5). This object
 * cannot refuse to open one — `packages/events` already admitted it — so it renders, reports
 * `TurnContext.brief.empty`, and leaves the composition root to close the turn `'silent'` rather
 * than opening a session turn with nothing behind it and a model left to improvise.
 *
 * The compaction check is at turn **close**, never at turn open. At open it would add latency to
 * the path the 5 ms and 100 ms budgets protect; at close there is nobody waiting.
 *
 * What this file deliberately does not do: decide whether to speak (`packages/events`), truncate
 * anything (`packages/realtime` executes the plan it is handed), fuse or age a fact
 * (`packages/world-model`), or summarise with a model (§7.4). Each is a non-goal in §1.2 with an
 * argument attached.
 *
 * See docs/design/context-and-memory-architecture.md §9.4.
 */

import type { GameClock, MatchId, MonoMs, PrivacyPolicy, TurnId } from './common/types.js';
import type { ContextTelemetry, WorldModelReader } from './common/ports.js';
import type { Budget, RenderedText, TokenCounter } from './render/types.js';
import type { Preamble, PreambleInput, PrefixBudget } from './preamble/types.js';
import type { RenderedSnapshot, TurnBrief } from './snapshot/types.js';
import type { CoachingBrief } from './coaching/types.js';
import type { BriefRenderer } from './coaching/contracts.js';
import type { LedgerRef, TurnOutcome, WindowBudget, WindowPlan } from './memory/types.js';
import type {
  CoachingMemory,
  ConversationLedgerWriter,
  CoachingMemoryReader,
  PlayerMemoryStore,
} from './memory/contracts.js';
import type { EventTapeReader } from './memory/ports.js';
import type { MatchLedger } from './memory/ledger.js';
import type { MutableWorkingMemory } from './memory/working.js';
import type { PreambleAssembler } from './preamble/contracts.js';
import type { SnapshotRenderer } from './snapshot/contracts.js';
import { createTokenCounter } from './render/tokens.js';
import { DEFAULT_PRIVACY } from './render/privacy.js';
import { createConversationLedger } from './memory/ledger.js';
import { createCoachingMemory } from './memory/coaching.js';
import { createWorkingMemory } from './memory/working.js';
import { createRetentionPolicy, DEFAULT_WINDOW_BUDGET } from './memory/retention.js';
import { createSummaryRenderer } from './memory/summary.js';
import { createCompactor } from './memory/compactor.js';
import { createRehydrator } from './memory/rehydrate.js';
import { createSnapshotRenderer } from './snapshot/renderer.js';
import { createBriefRenderer, sectionIdsOf } from './coaching/render.js';
import { createPrefixBudget } from './preamble/budget.js';

/** What the session is opened with. Frozen for the match (§4.4). */
export interface SessionContext {
  readonly preamble: Preamble;
  /** The sum nobody was computing: persona + preamble against the 16,384 cap (§4.2). */
  readonly prefix: PrefixBudget;
}

export interface TurnContext {
  readonly turnId: TurnId;
  readonly snapshot: RenderedSnapshot;
  /** The focused half: what *this* moment's advice needs (coaching-architecture.md §4–§5). */
  readonly brief: CoachingBrief;
  /**
   * What is left after the snapshot and the brief (§7.1).
   *
   * It used to be what was left for command *results*, which accumulated. A brief supersedes
   * itself the way a snapshot does, which is why coaching-architecture.md §8.2's drop order has
   * four rungs where this one had five.
   */
  readonly remaining: Budget;
}

export interface ContextAssembler {
  /** Tier 1. Called once per match, before the session opens. */
  openSession(input: PreambleInput, deadline: MonoMs): Promise<SessionContext>;

  /**
   * The hot path: the snapshot *and* the brief, synchronous and budgeted under 5 ms together
   * (§5.4, coaching-architecture.md §5.5). Nothing here can reach a network, which is what keeps
   * a turn from needing a watchdog.
   */
  openTurn(turn: TurnBrief, now: MonoMs): TurnContext;

  /**
   * Where compaction is considered (§9.2). At turn *open* it would add latency to the path the
   * 5 ms and 100 ms budgets protect; at close there is nobody waiting.
   */
  closeTurn(turnId: TurnId, outcome: TurnOutcome, now: MonoMs): void;

  /** For `packages/events`. Read-only, and the only edge between the two packages (§9.3). */
  readonly coaching: CoachingMemoryReader;

  /** For the session adapter in the composition root: transcripts in. */
  readonly ledger: ConversationLedgerWriter;

  /** After a lost session (§7.5). The preamble is re-assembled separately, byte-identically. */
  rehydrate(now: MonoMs): Promise<RenderedText>;
}

// -----------------------------------------------------------------------------------------------
// The implementation
// -----------------------------------------------------------------------------------------------

export interface ContextAssemblerDeps {
  readonly matchId: MatchId;
  readonly world: WorldModelReader;
  readonly preamble: PreambleAssembler;
  /** `packages/events` implements this; the composition root wires it (§8.2). */
  readonly tape?: EventTapeReader;
  readonly durable?: PlayerMemoryStore;
  readonly telemetry?: ContextTelemetry;
  readonly counter?: TokenCounter;
  readonly renderer?: SnapshotRenderer;
  readonly brief?: BriefRenderer;
  readonly windowBudget?: WindowBudget;
  /** From `packages/config`, injected. This package never reads `process.env`. */
  readonly privacy?: PrivacyPolicy;
  /** §4.2's persona allocation, counted whether or not the text has found its home yet. */
  readonly personaTokens?: number;
  /** Snapshot ceiling per turn *(tunable: 400, dota2 §6.2's upper bound)*. */
  readonly snapshotTokens?: number;
  /** The coaching brief's ceiling, after the snapshot *(tunable: 200, coaching §8.2)*. */
  readonly briefTokens?: number;
  /** Elision is off; §5.3 is the argument. Present so the switch has one place to live. */
  readonly elision?: boolean;
  /** Where a plan goes when the compactor produces one. `packages/realtime` executes it (§8.4). */
  readonly onWindowPlan?: (plan: WindowPlan) => void;
}

const DEFAULT_SNAPSHOT_TOKENS = 400;

/**
 * coaching-architecture.md §8.2's *(tunable)* ceiling.
 *
 * A third of what command results were given, and that is the bet §12 row 1 asks to be measured:
 * a focused brief assembled for one moment should carry as much useful signal as a call the model
 * had to think to make.
 */
const DEFAULT_BRIEF_TOKENS = 200;
const DEFAULT_TAPE_EVENTS = 5;

/** What the assembler exposes beyond the declared contract, for the composition root's own wiring. */
export interface RikiContext extends ContextAssembler {
  readonly ledgerRecord: MatchLedger;
  readonly coachingMemory: CoachingMemory;
  readonly working: MutableWorkingMemory;
  /** Called once `packages/realtime` confirms a plan it was handed (§8.4, §7.6). */
  applyWindowPlan(plan: WindowPlan, dropped: readonly LedgerRef[]): void;
  /** Reconciliation (§7.6): a non-zero `api_truncation` count is a bug, not a condition. */
  noteDropped(refs: readonly LedgerRef[], reason: 'api_truncation' | 'session_lost'): void;
}

export function createContextAssembler(deps: ContextAssemblerDeps): RikiContext {
  const counter = deps.counter ?? createTokenCounter();
  const privacy = deps.privacy ?? DEFAULT_PRIVACY;
  const snapshotTokens = deps.snapshotTokens ?? DEFAULT_SNAPSHOT_TOKENS;
  const briefTokens = deps.briefTokens ?? DEFAULT_BRIEF_TOKENS;
  const windowBudget = deps.windowBudget ?? DEFAULT_WINDOW_BUDGET;

  const ledger = createConversationLedger(deps.matchId);
  const coaching = createCoachingMemory(ledger);
  const working = createWorkingMemory(ledger, coaching, counter, {
    elision: deps.elision ?? false,
  });
  const renderer = deps.renderer ?? createSnapshotRenderer();
  // The brief renderer is constructed after the coaching memory it reads: `history` is the one
  // section that reads something other than the world model (coaching-architecture.md §5.4).
  const brief = deps.brief ?? createBriefRenderer({ coaching });
  const summary = createSummaryRenderer();
  const retention = createRetentionPolicy({
    counter,
    summarise: (entries) =>
      summary.render(entries, deps.world, { maxTokens: snapshotTokens, spentTokens: 0 }),
  });
  const compactor = createCompactor({
    ledger,
    working,
    retention,
    budget: windowBudget,
    ...(deps.onWindowPlan === undefined ? {} : { onPlan: deps.onWindowPlan }),
  });
  const rehydrator = createRehydrator({ summary });

  /** The clock of the turn currently open, so a ledger entry can carry game time (§6.3). */
  const clockOfTurn = new Map<TurnId, GameClock | null>();

  return {
    async openSession(input: PreambleInput, deadline: MonoMs) {
      const preamble = await deps.preamble.assemble(input, deadline);

      // §4.2's sum, in the one place that can see both claimants. `check()` fails a test, not a
      // match: every number here is knowable before a session exists. The third claimant, the tool
      // manifest, was 2,000 tokens and no longer exists (coaching-architecture.md §8.1).
      const parts = new Map<string, number>([
        ['persona', deps.personaTokens ?? 0],
        ...preamble.sections.map((s): [string, number] => [`preamble.${s.id}`, s.tokens]),
      ]);
      const prefix = createPrefixBudget(parts);
      deps.telemetry?.noteRender('preamble', 0, preamble.tokens);

      return { preamble, prefix };
    },

    openTurn(turn: TurnBrief, now: MonoMs) {
      const started = now;
      const world = deps.world.snapshot(now);

      ledger.append({
        kind: 'turn_opened',
        turnId: turn.turnId,
        cause: turn.cause,
        at: now,
        clock: world.clock,
      });
      clockOfTurn.set(turn.turnId, world.clock);

      const snapshot = renderer.render(world, {
        turnId: turn.turnId,
        now,
        cause: turn.cause,
        budget: { maxTokens: snapshotTokens, spentTokens: 0 },
        privacy,
        tape: deps.tape?.recent(DEFAULT_TAPE_EVENTS, null) ?? [],
        elisionBase: working.elisionBase(),
      });

      const ref = ledger.append({
        kind: 'snapshot',
        turnId: turn.turnId,
        rendered: { text: snapshot.text, tokens: snapshot.tokens },
        sections: snapshot.sections.map((s) => s.id),
        at: now,
      });
      working.recordSnapshot(snapshot, ref, world.clock);

      deps.telemetry?.noteRender('snapshot', now - started, snapshot.tokens);
      if (snapshot.omitted.length > 0) {
        deps.telemetry?.noteTruncation('snapshot', snapshot.omitted.map(String));
      }

      const rendered = brief.render(world, {
        turnId: turn.turnId,
        cause: turn.cause,
        ...(turn.topic === undefined ? {} : { topic: turn.topic }),
        now,
        budget: { maxTokens: briefTokens, spentTokens: 0 },
        privacy,
      });

      // An empty brief is not appended: there is nothing for retention to supersede and nothing
      // for the model to read, and a zero-token ledger entry would make "Riki had nothing to say"
      // and "Riki said nothing about it" look the same in the record (§6.5).
      if (!rendered.empty) {
        ledger.append({
          kind: 'brief',
          turnId: turn.turnId,
          rendered: { text: rendered.text, tokens: rendered.tokens },
          sections: sectionIdsOf(rendered),
          at: now,
        });
      }

      deps.telemetry?.noteRender('brief', now - started, rendered.tokens);
      if (rendered.omitted.length > 0) {
        deps.telemetry?.noteTruncation('brief', rendered.omitted.map(String));
      }

      return {
        turnId: turn.turnId,
        snapshot,
        brief: rendered,
        remaining: {
          maxTokens: briefTokens,
          spentTokens: rendered.tokens,
        },
      };
    },

    closeTurn(turnId: TurnId, outcome: TurnOutcome, now: MonoMs) {
      ledger.append({ kind: 'turn_closed', turnId, outcome, at: now });
      working.noteTurnClosed(turnId, outcome);
      clockOfTurn.delete(turnId);

      // The only place a compaction is considered. Cheap, and usually null.
      const plan = compactor.consider(deps.world.snapshot(now), now);
      if (plan !== null) {
        deps.telemetry?.noteCompaction(
          plan.reason,
          working.window().estimatedTokens - plan.estimatedTokensAfter,
          plan.estimatedTokensAfter,
        );
      }
    },

    coaching: coaching satisfies CoachingMemoryReader,

    ledger: {
      append: (entry) => ledger.append(entry),
      markDropped: (refs, reason) => {
        ledger.markDropped(refs, reason);
      },
    } satisfies ConversationLedgerWriter,

    rehydrate(now: MonoMs): Promise<RenderedText> {
      return Promise.resolve(
        rehydrator.brief(ledger, deps.world.snapshot(now), {
          maxTokens: snapshotTokens * 2,
          spentTokens: 0,
        }),
      );
    },

    ledgerRecord: ledger,
    coachingMemory: coaching,
    working,

    applyWindowPlan(plan: WindowPlan, dropped: readonly LedgerRef[]): void {
      compactor.applied(plan, dropped);
    },

    noteDropped(refs, reason): void {
      ledger.markDropped(refs, reason);
      const usage = working.window().estimatedTokens;
      // §7.6: an API-initiated truncation means our low-water mark or our counter is wrong. It is a
      // bug, not a condition, and it should read like one in telemetry.
      if (reason === 'api_truncation')
        deps.telemetry?.noteWindowDrift(usage, windowBudget.capTokens);
    },
  };
}
