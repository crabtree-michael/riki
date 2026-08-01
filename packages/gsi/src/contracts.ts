/**
 * The GSI listener, and the four things around it that stop an unreliable push stream from
 * becoming unreliable state.
 *
 * See docs/design/state-capture-architecture.md §4.1.
 *
 * ⚠ Transitional. `MonoMs`, `GameClock`, `Observation`, `ObservationSource` and `SourceHealth` are
 * the same contract `packages/world-model` declares, mirrored here because a source may not import
 * the model (state-capture-architecture.md §2.3 — sources and the model meet at a type, not at
 * each other). All copies collapse into @riki/protocol at REPO_SKELETON.md §10 step 2.
 */

import type { GsiPayload } from './payload.js';

export type MonoMs = number & { readonly __brand: 'MonoMs' };
export type GameClock = number & { readonly __brand: 'GameClock' };
export type Seconds = number & { readonly __brand: 'Seconds' };
export type SourceId = string & { readonly __brand: 'SourceId' };
export type Unsubscribe = () => void;

export interface Observation<K extends string = 'gsi.payload'> {
  readonly kind: K;
  readonly sourceId: SourceId;
  readonly seq: number;
  readonly receivedAt: MonoMs;
  readonly payload: GsiPayload;
  readonly v: number;
}

export interface SourceHealth {
  readonly state: 'starting' | 'live' | 'degraded' | 'down';
  readonly lastObservationAt: MonoMs | null;
  readonly reason?: string;
}

export interface Clock {
  now(): MonoMs;
}

// -----------------------------------------------------------------------------------------------
// The listener
// -----------------------------------------------------------------------------------------------

export interface GsiServerOptions {
  /** From @riki/config. 53101 by default, matching the cfg tools/setup-gsi-cfg writes. */
  readonly port: number;
  /** Per-install secret. Never logged, never returned, never compared non-constant-time. */
  readonly token: string;
  readonly clock: Clock;
  /** 1 MiB (tunable). Reject oversized bodies rather than buffering them. */
  readonly maxBodyBytes: number;
}

/**
 * Binds **127.0.0.1 only**, and that is a security property rather than a default: the endpoint
 * accepts POSTs from anything that can reach it, and the token is the only other line of defence.
 */
export interface GsiServer {
  readonly id: SourceId;
  start(): Promise<void>;
  stop(): Promise<void>;
  subscribe(listener: (o: Observation) => void): Unsubscribe;
  health(now: MonoMs): SourceHealth;
  /** The actual bound port, for tests that pass 0. Null before `start()` resolves. */
  readonly address: { readonly port: number } | null;
}

export declare function createGsiServer(opts: GsiServerOptions): GsiServer;

// -----------------------------------------------------------------------------------------------
// Auth
// -----------------------------------------------------------------------------------------------

export type AuthVerdict = 'ok' | 'missing' | 'mismatch';

/** Constant-time. Returns a verdict, never throws, and never logs or echoes the token. */
export interface GsiAuthenticator {
  verify(presented: string | undefined): AuthVerdict;
}

export declare function createGsiAuthenticator(expected: string): GsiAuthenticator;

// -----------------------------------------------------------------------------------------------
// Liveness
// -----------------------------------------------------------------------------------------------

export interface GsiLivenessOptions {
  /** 30 s, matching `heartbeat` in the cfg — which is what makes this check possible at all. */
  readonly heartbeatSeconds: number;
  /** ≈1.17, giving a 35 s miss threshold: distinguishes "nothing changed" from "the client left". */
  readonly missMultiplier: number;
}

/** The detector behind dota2 §9's *GSI stops mid-game* row. */
export interface GsiLiveness {
  noteObservation(now: MonoMs): void;
  check(now: MonoMs): { readonly state: SourceHealth['state']; readonly sinceLastMs: number };
}

export declare function createGsiLiveness(opts: GsiLivenessOptions): GsiLiveness;

// -----------------------------------------------------------------------------------------------
// Match session
// -----------------------------------------------------------------------------------------------

export type MatchPhase =
  'idle' | 'draft' | 'strategy' | 'hero_selection' | 'pre_game' | 'in_progress' | 'post_game';

export type MatchLifecycleEvent =
  /** Triggers Tier 1 preamble assembly and external API enrichment. */
  | { readonly type: 'match_started'; readonly matchId: string; readonly heroes: readonly string[] }
  | { readonly type: 'phase_changed'; readonly from: MatchPhase; readonly to: MatchPhase }
  | { readonly type: 'paused' }
  | { readonly type: 'resumed' }
  /** Reconnect, or a new match on the same id. Triggers a resync, not a slow drift into wrongness. */
  | { readonly type: 'clock_discontinuity'; readonly delta: Seconds }
  | { readonly type: 'match_ended'; readonly matchId: string; readonly winner: string | null };

/** Returns transitions, not state: the caller reacts to edges. */
export interface MatchSessionTracker {
  observe(payload: GsiPayload, at: { observedAt: MonoMs }): readonly MatchLifecycleEvent[];
}

export declare function createMatchSessionTracker(): MatchSessionTracker;

// -----------------------------------------------------------------------------------------------
// The game clock
// -----------------------------------------------------------------------------------------------

/**
 * Interpolates between GSI updates so a fact observed between POSTs still gets a game clock. It
 * advances at 1 s/s while unpaused, freezes while paused, and is **corrected — never smoothed** on
 * the next real update.
 *
 * **Never infer elapsed time from update count.** The rate is 2–8 Hz, irregular, and varies with
 * client load; it is not a clock and treating it as one is the classic bug here.
 */
export interface GameClockEstimator {
  update(clock: GameClock, at: MonoMs, paused: boolean): void;
  /** Null before the first update — pre-horn and loading have no clock, which is not clock zero. */
  estimate(now: MonoMs): GameClock | null;
}

export declare function createGameClockEstimator(): GameClockEstimator;
