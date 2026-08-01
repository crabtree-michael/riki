/**
 * The console.log tailer, and the matcher registry that reads it.
 *
 * See docs/design/state-capture-architecture.md §4.2.
 *
 * ⚠ Transitional. The time and observation types mirror `packages/world-model`'s, because a source
 * may not import the model (§2.3). All copies collapse into @riki/protocol at REPO_SKELETON.md
 * §10 step 2.
 */

export type MonoMs = number & { readonly __brand: 'MonoMs' };
export type GameClock = number & { readonly __brand: 'GameClock' };
export type SourceId = string & { readonly __brand: 'SourceId' };
export type Unsubscribe = () => void;

export interface Clock {
  now(): MonoMs;
}

export interface SourceHealth {
  readonly state: 'starting' | 'live' | 'degraded' | 'down';
  readonly lastObservationAt: MonoMs | null;
  readonly reason?: string;
}

export interface Observation {
  readonly kind: 'log.event';
  readonly sourceId: SourceId;
  readonly seq: number;
  readonly receivedAt: MonoMs;
  readonly payload: LogEvent;
  readonly v: number;
}

// -----------------------------------------------------------------------------------------------
// Privacy — applied at the source, not at the sink
// -----------------------------------------------------------------------------------------------

/**
 * Chat lines carry other people's words (dota2 §7), so the tagging happens where the data is
 * created, before anything downstream can forget. Two independent gates consume it:
 * `packages/telemetry` redacts on `sensitive`, and `packages/context` refuses to render such a
 * field into the snapshot unless the config flag is on.
 *
 * Two gates, because this is the failure that cannot be walked back once it has left the machine.
 */
export type PrivacyClass = 'public' | 'sensitive';

// -----------------------------------------------------------------------------------------------
// Events
// -----------------------------------------------------------------------------------------------

export interface ChatLine {
  readonly kind: 'chat';
  readonly text: string;
  readonly speaker: string | undefined;
  readonly channel: 'all' | 'team' | 'system';
  readonly privacy: 'sensitive';
}

export interface KillFeedEntry {
  readonly kind: 'kill';
  readonly killer: string | undefined;
  readonly victim: string;
  readonly privacy: 'public';
}

export interface PingEvent {
  readonly kind: 'ping';
  readonly kind_detail: string;
  readonly privacy: 'public';
}

export type LogEvent = ChatLine | KillFeedEntry | PingEvent;

// -----------------------------------------------------------------------------------------------
// The tailer
// -----------------------------------------------------------------------------------------------

export interface ConsoleLogTailerOptions {
  readonly path: string;
  readonly matchers: readonly LineMatcher[];
  readonly clock: Clock;
  /** 250 ms (tunable). Polling, because `fs.watch` semantics differ across all three platforms. */
  readonly pollMs: number;
}

/**
 * The whole job is the boring part: **the file you opened is not the file being written to ten
 * minutes later.** Four cases, each a Tier 1 test against a temp file and a fixture in
 * `fixtures/console-log/`:
 *
 * 1. Rotation — the path now points at a new inode.
 * 2. Truncation — same inode, size went backwards.
 * 3. A partial trailing line, which must be buffered rather than parsed.
 * 4. Starting mid-match, which means seeking to the end rather than replaying the whole match.
 */
export interface ConsoleLogTailer {
  readonly id: SourceId;
  start(): Promise<void>;
  stop(): Promise<void>;
  subscribe(listener: (o: Observation) => void): Unsubscribe;
  health(now: MonoMs): SourceHealth;
}

export declare function createConsoleLogTailer(opts: ConsoleLogTailerOptions): ConsoleLogTailer;

/**
 * Pure, and cheap on the common path: most lines match nothing.
 *
 * The registry is the point. Console log format is outside our control and will change under us,
 * so the unit of breakage should be one small file with its own fixtures — adding kill-feed
 * parsing later is a new file in `matchers/` and one array entry.
 */
export interface LineMatcher {
  readonly id: string;
  match(
    line: string,
    at: { readonly observedAt: MonoMs; readonly atGameClock: GameClock | null },
  ): LogEvent | null;
}
