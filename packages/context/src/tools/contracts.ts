/**
 * The pipeline, as contracts: registry, parse, validate, admit, queue, execute, render.
 *
 * Six stages, each of which can fail only *into a result* and never out of the pipeline. That is
 * what makes the failure taxonomy in §7.1 of the architecture doc exhaustive rather than
 * aspirational, and it is why every method here returns a value rather than throwing.
 *
 * See docs/design/agent-command-execution-architecture.md §4, §6 and §7. Declarations only;
 * implementations follow §16 in that order.
 */

import type {
  CallFingerprint,
  CancelReason,
  CancelSignal,
  ConsentRequest,
  HeroId,
  ItemId,
  MonoMs,
  Observed,
  ParsedCall,
  RawToolCall,
  RegionId,
  RenderContext,
  RenderedResult,
  ToolEffect,
  ToolFailure,
  ToolLimits,
  PortId,
  ToolName,
  ToolOutcome,
  ToolResultMessage,
  TurnId,
  TurnScope,
} from './types.js';
import type { ToolPorts } from './ports.js';

// -----------------------------------------------------------------------------------------------
// Definitions and the registry (§4.2, §8.1)
// -----------------------------------------------------------------------------------------------

/** A JSON Schema object as the model is shown it. Generated, never hand-written (§4.2). */
export type JsonSchemaObject = Readonly<Record<string, unknown>>;

/**
 * The schema and the validator must have one source. A hand-written JSON Schema that has drifted
 * from its validator is the exact failure `pnpm codegen` exists to prevent for the sidecar, and it
 * presents identically: the model is told a shape, sends it, and is told it is invalid.
 */
export interface ArgumentCodec<A> {
  /** Total. A malformed payload is a value, not an exception. */
  decode(raw: unknown): ToolOutcome<A>;
  readonly schema: JsonSchemaObject;
}

/** A handler is a function of its arguments and its ports. No `this`, no clock, no session. */
export type ToolHandler<A, R> = (args: A, ctx: ToolContext) => Promise<ToolOutcome<R>>;

export interface ToolContext {
  readonly ports: ToolPorts;
  readonly scope: TurnScope;
  readonly now: MonoMs;
  /** Already the minimum of the command's own limit and what is left of the turn (§6.3). */
  readonly deadlineAt: MonoMs;
}

export interface ToolDefinition<A, R> {
  readonly name: ToolName;
  readonly effect: ToolEffect;
  /** Prompt, not code. Its home is REPO_SKELETON.md §11.5, still open (§15.1). */
  readonly summary: string;
  readonly codec: ArgumentCodec<A>;
  readonly limits: ToolLimits;
  /** Which ports must be usable for this command to answer freshly (§4.4, §7.3). */
  readonly needs: readonly PortId[];
  readonly handler: ToolHandler<A, R>;
  readonly renderer: ResultRenderer<R>;
}

export interface ManifestEntry {
  readonly name: ToolName;
  readonly summary: string;
  readonly parameters: JsonSchemaObject;
  readonly estimatedTokens: number;
}

/**
 * Computed once at `match_started` and frozen (ADR-0011). Command definitions live in the cached
 * prefix against a 16,384-token cap shared with the instructions; changing the set mid-session
 * rewrites the prefix and busts the cache, so availability is a property of the *result* instead.
 */
export interface ToolManifest {
  readonly tools: readonly ManifestEntry[];
  readonly estimatedTokens: number;
  readonly frozenAt: MonoMs;
}

/** The config that legitimately changes the *set* — decided before the session opens, not during. */
export interface ManifestEnvironment {
  /** `RIKI_VISION=off` removes the vision-backed commands: no point advertising what cannot run. */
  readonly visionEnabled: boolean;
  readonly readScreenEnabled: boolean;
}

export interface ToolRegistry {
  register<A, R>(definition: ToolDefinition<A, R>): void;
  lookup(name: string): ToolDefinition<never, unknown> | undefined;
  names(): readonly ToolName[];
  manifest(env: ManifestEnvironment): ToolManifest;
}

// -----------------------------------------------------------------------------------------------
// Parse and validate (§4.2, §4.3)
// -----------------------------------------------------------------------------------------------

export interface ToolCallParser {
  /**
   * In order: is the name registered (`unknown_tool`); is `argumentsJson` valid JSON
   * (`malformed_arguments`); does it satisfy the codec (`invalid_arguments`). Total.
   */
  parse(raw: RawToolCall): ToolOutcome<ParsedCall>;
}

export type Resolved<T> =
  | { readonly ok: true; readonly value: T; readonly matched: 'exact' | 'alias' | 'fuzzy' }
  | {
      readonly ok: false;
      readonly reason: 'unknown' | 'ambiguous' | 'not_in_match';
      readonly candidates?: readonly string[];
    };

/** The heroes and items this match actually contains. Read from the snapshot, not from a list. */
export interface MatchSubjects {
  readonly allies: readonly HeroId[];
  readonly enemies: readonly HeroId[];
  readonly self: HeroId;
}

/**
 * Schema validation says the argument is a string. It does not say the string names a hero in *this
 * match*, and that distinction is where fabrication gets in: `get_enemy_detail("pudge")` in a game
 * with no Pudge has exactly one correct answer, and only the draft can give it.
 */
export interface SubjectResolver {
  hero(spoken: string, subjects: MatchSubjects): Resolved<HeroId>;
  item(spoken: string): Resolved<ItemId>;
  region(spoken: string): Resolved<RegionId>;
}

// -----------------------------------------------------------------------------------------------
// Admission (§4.4)
// -----------------------------------------------------------------------------------------------

/** The only stage that can answer without executing. Checks run cheapest-first (§4.4). */
export type Admission =
  | { readonly verdict: 'admit' }
  | { readonly verdict: 'serve_memo'; readonly fingerprint: CallFingerprint }
  | { readonly verdict: 'consent'; readonly request: ConsentRequest }
  | { readonly verdict: 'refuse'; readonly failure: ToolFailure };

export interface AdmissionController {
  admit(call: ParsedCall, scope: TurnScope, now: MonoMs): Admission;
}

/**
 * Converts a latency failure into an availability failure, which is the one this component can
 * explain. Without it a dead sidecar costs every turn its full `observe` deadline, and the player
 * experiences a coach who has become slow rather than one who has lost a source (§7.3).
 */
export interface PortBreaker {
  note(port: PortId, outcome: 'ok' | 'fail', now: MonoMs): void;
  state(port: PortId, now: MonoMs): 'closed' | 'open' | 'half_open';
}

// -----------------------------------------------------------------------------------------------
// Queue and executor (§6, §7.4)
// -----------------------------------------------------------------------------------------------

export type QueueOutcome<T> =
  | { readonly ran: true; readonly value: T }
  | { readonly ran: false; readonly failure: ToolFailure };

/**
 * Per effect class, not global: a `model` read waiting behind a `read_screen` would be a memory
 * access queued behind a network round trip. Limits are the §3.2 table.
 */
export interface ToolQueue {
  enqueue<T>(
    call: ParsedCall,
    effect: ToolEffect,
    run: (signal: CancelSignal) => Promise<T>,
  ): Promise<QueueOutcome<T>>;
  cancel(turnId: TurnId, reason: CancelReason): void;
  depth(): ReadonlyMap<ToolEffect, number>;
}

export interface ExecutorStats {
  readonly issued: number;
  readonly submitted: number;
  readonly byStatus: ReadonlyMap<string, number>;
  readonly lateHandlerValues: number;
}

/**
 * The one-result invariant (§7.4):
 *
 * > Every `callId` handed to `invoke()` produces exactly one `ToolResultMessage`, within its
 * > deadline, no matter what the handler does.
 *
 * The watchdog is a timer per call, not per queue — nothing prevents a handler from hanging, so the
 * guarantee has to come from outside it. `invoke` therefore always resolves and never rejects; a
 * cancelled turn's results are produced and then dropped by the bridge, not left unsettled (§6.5).
 */
export interface ToolExecutor {
  invoke(raw: RawToolCall, scope: TurnScope): Promise<ToolResultMessage>;
  cancelTurn(turnId: TurnId, reason: CancelReason): void;
  stats(): ExecutorStats;
}

// -----------------------------------------------------------------------------------------------
// Render (§4.6)
// -----------------------------------------------------------------------------------------------

/**
 * The snapshot's rules, reused rather than restated (dota2 §6.2): a stale fact renders with its age
 * and confidence or it does not render; below-threshold facts are dropped rather than hedged;
 * truncation is priority-ordered and recorded. Handlers hand over `Observed<T>` so a bare value is
 * not available to render even by mistake.
 */
export interface ResultRenderer<R> {
  render(value: R, ctx: RenderContext): RenderedResult;
}

/** Illustrative handler return shape, and the reason `Observed<T>` exists (§4.5). */
export interface EnemyDetail {
  readonly hero: HeroId;
  readonly level?: Observed<number>;
  readonly alive?: Observed<boolean>;
  readonly lastSeen?: Observed<{ readonly region: RegionId }>;
  readonly itemsSeen: readonly Observed<ItemId>[];
}

// -----------------------------------------------------------------------------------------------
// The assembled surface (§9.3)
// -----------------------------------------------------------------------------------------------

/**
 * What `packages/context` hands the composition root. The root wires it to a session through
 * `ToolCallBridge`, which is the only file in the repo that speaks both this vocabulary and the
 * Realtime one — same pattern and same reason as the overlay's `VoiceBridge`.
 */
export interface ToolSurface {
  readonly manifest: ToolManifest;
  readonly executor: ToolExecutor;
  openTurn(turnId: TurnId, now: MonoMs): TurnScope;
  closeTurn(turnId: TurnId, now: MonoMs): void;
}
