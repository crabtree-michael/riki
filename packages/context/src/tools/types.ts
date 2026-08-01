/**
 * The vocabulary of a command, from the wire to the result.
 *
 * A *command* is a tool call the agent issues to Riki. It reads what has already been observed; it
 * never reaches into the game (ADR-0003, and §0 C1 of the architecture doc). Everything in this
 * file is the contract for docs/design/agent-command-execution-architecture.md §3.
 *
 * Declarations only — no behaviour lands here. Implementations follow §16 of that document, from
 * REPO_SKELETON.md §10 step 5.
 *
 * ⚠ Transitional declarations. `ConsentRequest` / `ConsentDecision` cross main → renderer, so per
 * REPO_SKELETON.md §4 they belong in @riki/protocol as zod schemas. That package is step 2 and
 * still empty; moving `ConsentRequest` when it lands is a coordination event (the `protocol` skill).
 *
 * The scalars this file used to declare — `MonoMs`, `GameClock`, `TurnId`, `CallId`, `HeroId`,
 * `ItemId`, `Staleness`, `Observed<T>`, `PrivacyPolicy`, `Unsubscribe` — now live in
 * `../common/types.ts` and are re-exported below, because Tiers 1 and 2 speak about all of them
 * too (context-and-memory-architecture.md §3, §11). One transitional declaration per type means
 * one edit when @riki/protocol lands, rather than one per tier.
 */

export type {
  CallId,
  GameClock,
  HeroId,
  ItemId,
  MonoMs,
  Observed,
  PrivacyPolicy,
  Staleness,
  TurnId,
  Unsubscribe,
} from '../common/types.js';

import type {
  CallId,
  GameClock,
  MonoMs,
  PrivacyPolicy,
  TurnId,
  Unsubscribe,
} from '../common/types.js';

// -----------------------------------------------------------------------------------------------
// Identity (§3.1)
// -----------------------------------------------------------------------------------------------

/** Canonicalised name + arguments. Two calls with the same fingerprint are the same question. */
export type CallFingerprint = string & { readonly __brand: 'CallFingerprint' };

/** Named for telemetry and for the circuit breaker (§7.3). */
export type PortId = 'world' | 'capture' | 'reference' | 'consent';

// -----------------------------------------------------------------------------------------------
// Commands and effect classes (§3.2)
// -----------------------------------------------------------------------------------------------

/** The eight commands of dota2-state-capture-design.md §6.3. A closed union on purpose. */
export type ToolName =
  | 'get_enemy_detail'
  | 'get_minimap_summary'
  | 'get_item_info'
  | 'get_matchup_advice'
  | 'get_timings'
  | 'get_recent_events'
  | 'read_screen'
  | 'get_build_benchmark';

/**
 * The class decides concurrency, deadline, consent, caching and degradation behaviour — so adding
 * a command does not mean deciding those five things again (§3.2).
 *
 * - `model`        reads the current snapshot, in process
 * - `reference`    reads patch-keyed external data
 * - `observe`      asks for a fresh CV pass, then reads the snapshot
 * - `consequential` sends pixels off the machine. Exactly one member while ADR-0003 holds
 */
export type ToolEffect = 'model' | 'reference' | 'observe' | 'consequential';

/** Per-command limits. Defaults come from the effect class; a definition may tighten them. */
export interface ToolLimits {
  readonly deadlineMs: number;
  readonly maxResultTokens: number;
  /** Rate floor. `read_screen` is 0.2 Hz per dota2 §5; enforced at admission, not in the handler. */
  readonly minIntervalMs: number;
  readonly maxPerTurn: number;
  readonly maxPerMatch: number | null;
  readonly consent: 'none' | 'per_call';
  readonly cache: 'none' | 'turn' | 'patch';
}

// -----------------------------------------------------------------------------------------------
// A call, from wire to result (§3.3)
// -----------------------------------------------------------------------------------------------

/** What the composition-root adapter hands in. `name` and `argumentsJson` are untrusted strings. */
export interface RawToolCall {
  readonly callId: CallId;
  readonly turnId: TurnId;
  readonly name: string;
  /** Accumulated from argument deltas. May be malformed, empty or truncated (§4.1). */
  readonly argumentsJson: string;
  readonly receivedAt: MonoMs;
}

/** What survives parsing, validation and subject resolution. */
export interface ParsedCall<A = unknown> {
  readonly callId: CallId;
  readonly turnId: TurnId;
  readonly name: ToolName;
  readonly args: A;
  readonly fingerprint: CallFingerprint;
  readonly receivedAt: MonoMs;
}

/**
 * What the adapter submits back to the session. Exactly one per `callId`, always (§7.4).
 *
 * `status` is not for the model — the model sees `output` and nothing else. It exists so that a
 * rising `timeout` rate is visible, which is the cheapest detector for a port that has quietly
 * stopped answering.
 */
export interface ToolResultMessage {
  readonly callId: CallId;
  readonly name: string;
  /** Already rendered, already budgeted, already redacted. */
  readonly output: string;
  readonly tokens: number;
  readonly status: 'ok' | ToolErrorCode;
  readonly elapsedMs: number;
}

// -----------------------------------------------------------------------------------------------
// Outcomes and failures — the total-function rule (§3.4)
// -----------------------------------------------------------------------------------------------

/**
 * Nothing in this component throws and nothing rejects. An exception escaping the pipeline would
 * leave a `callId` unanswered, which is the one failure that stalls a voice conversation.
 */
export type ToolOutcome<R> =
  { readonly ok: true; readonly value: R } | { readonly ok: false; readonly failure: ToolFailure };

export interface ToolFailure {
  readonly code: ToolErrorCode;
  /** What the model is told. Written in Riki's voice, because the model will say it out loud. */
  readonly speakable: string;
  readonly retryable: boolean;
  /** Telemetry only. Never reaches the model, so it may name internals (§13 asserts this). */
  readonly detail?: string;
}

/** Ten codes, exhaustively. The taxonomy and its speakable strings are §7.1. */
export type ToolErrorCode =
  | 'unknown_tool'
  | 'malformed_arguments'
  | 'invalid_arguments'
  | 'unknown_subject'
  | 'unavailable'
  | 'timeout'
  | 'rate_limited'
  | 'consent_denied'
  | 'cancelled'
  | 'internal';

// -----------------------------------------------------------------------------------------------
// Turn scope (§3.5)
// -----------------------------------------------------------------------------------------------

export type CancelReason = 'barge_in' | 'turn_deadline' | 'session_closed' | 'match_ended';

export interface CancelSignal {
  readonly cancelled: boolean;
  readonly reason: CancelReason | null;
  onCancel(fn: (reason: CancelReason) => void): Unsubscribe;
}

/**
 * Everything with a lifetime shorter than the match has this lifetime instead.
 *
 * The scope exists because of barge-in: a result still in flight when the player interrupts belongs
 * to a conversation item that has been truncated, so submitting it would answer a question the
 * conversation no longer contains (§6.5).
 */
export interface TurnScope {
  readonly turnId: TurnId;
  readonly openedAt: MonoMs;
  readonly deadlineAt: MonoMs;
  readonly signal: CancelSignal;
  readonly memo: ResultMemo;
  spentTokens(): number;
  noteTokens(n: number): void;
}

/** Turn-scoped, never longer: a memo that outlived its turn would answer "now" with "before". */
export interface ResultMemo {
  get(fp: CallFingerprint): ToolResultMessage | undefined;
  set(fp: CallFingerprint, result: ToolResultMessage): void;
  /** A call already running for this fingerprint — join it rather than starting a second (§6.4). */
  inflight(fp: CallFingerprint): Promise<ToolResultMessage> | undefined;
}

// -----------------------------------------------------------------------------------------------
// Rendering (§4.6)
// -----------------------------------------------------------------------------------------------

export interface RenderContext {
  readonly now: MonoMs;
  readonly clock: GameClock | null;
  readonly maxTokens: number;
  readonly privacy: PrivacyPolicy;
}

export interface RenderedResult {
  readonly text: string;
  readonly tokens: number;
  readonly truncated: boolean;
  /** What the budget or the confidence gate dropped. Telemetry, and asserted by golden tests. */
  readonly omitted: readonly string[];
}

// -----------------------------------------------------------------------------------------------
// Consent (§5.4) — ⚠ these two cross main → renderer and belong in @riki/protocol
// -----------------------------------------------------------------------------------------------

export interface ConsentRequest {
  readonly callId: CallId;
  readonly kind: 'read_screen';
  /** Short, specific, and in the player's terms: "Look at the scoreboard?" */
  readonly prompt: string;
  readonly region: RegionId;
  readonly expiresAt: MonoMs;
}

/** `expired` is distinct from `denied`: a prompt nobody noticed is not a refusal (§5.4). */
export type ConsentDecision = 'granted' | 'denied' | 'expired';

/** Held for the duration of a capture, because dota2 §7 asks for an indicator, not a prompt. */
export interface ConsequentialActivity {
  readonly callId: CallId;
  readonly kind: 'read_screen';
  readonly region: RegionId;
}

export interface ActivityHandle {
  end(): void;
}

// -----------------------------------------------------------------------------------------------
// Domain ids — ⚠ placeholder for @riki/protocol (§11)
// -----------------------------------------------------------------------------------------------

/** A named capture region. Tier 3's alone: no other tier names one. */
export type RegionId = string & { readonly __brand: 'RegionId' };
