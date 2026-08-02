/**
 * The shell's telemetry surface, and the one port that has no data behind it yet.
 *
 * ## Why this is an interface and not a logger
 *
 * `console.*` is confined to `packages/telemetry` by lint (REPO_SKELETON.md §6.2), so that
 * redaction runs before anything reaches a sink and cannot be bypassed by accident. That package
 * is a skeleton — it exports `{}` — so **the shell currently has no way to emit a log line at
 * all**, and `nullTelemetry()` is the honest consequence rather than a placeholder chosen for
 * convenience.
 *
 * The rule is right and this file does not work around it. What it does is make the swap free:
 * every counter and every event the shell produces is named here, so landing `packages/telemetry`
 * means writing one implementation of one interface and passing it to `createRikiShell`. Nothing
 * else moves.
 *
 * The interface composes the four sinks the subsystems declare separately rather than redeclaring
 * them, which is what keeps `createRikiShell` free of casts: one object satisfies the state
 * subsystem, the interaction machine, the coaching agent and the silent session at once.
 *
 * **Nothing here carries a transcript, a token, a path or a Steam ID.** dota2 §7 requires the last
 * of those to be hashed before any egress and ADR-0022 makes the API key unloggable by
 * construction; the cheapest way to keep both true is for the interface to have nowhere to put
 * them. `wouldSpeak` takes a character count for exactly this reason.
 */

import type { CoachTelemetry } from '@riki/coach';
import type { ReferenceDataPort } from '@riki/context';
import type { CoachMode } from '@riki/config';
import type { AgentTelemetry } from '../agent/index.js';
import type { TelemetrySink } from '../session/contracts.js';
import type { StateTelemetry } from '../state/index.js';
import type { SilentSessionTelemetry } from './silent-session.js';

export interface ShellTelemetry
  extends StateTelemetry, TelemetrySink, AgentTelemetry, SilentSessionTelemetry, CoachTelemetry {
  /** The sidecar's stderr, a line at a time. A panic trace arrives here and nowhere else. */
  sidecarStderr(line: string): void;
  /** The sidecar answered the handshake. `backend` is what it can capture with, if anything. */
  sidecarReady(backend: string, available: boolean): void;
  /**
   * The sidecar reported a named failure (dota2 §9).
   *
   * `remedy` is user-facing text when there is one — the Screen Recording permission and
   * exclusive fullscreen both have one, and the first-run flow is where it should end up. This
   * carries no pixels and no chat text; the protocol forbids both.
   */
  sidecarProblem(kind: string, fatal: boolean, remedy: string | null): void;
  /** The sidecar speaks a protocol this build does not. Not a crash — a mismatched build. */
  sidecarProtocolMismatch(theirs: number, ours: number): void;
  /** The accelerator could not be registered — usually another application owns it (§6.3). */
  hotkeyUnavailable(accelerator: string, hasKeyUp: boolean): void;
  /** Bound, but key-up is synthetic: tap-to-latch works and hold-to-push does not (§6.4). */
  pushToTalkUnavailable(): void;
  /**
   * The Realtime session could not be opened for this match.
   *
   * Not fatal and deliberately not a chip fault: detection, the gates and the brief all still run,
   * so what the player has is a Riki that is thinking and not talking. The message is an `Error`'s
   * own text and never carries config — `packages/config` keeps the key out of one by construction.
   */
  sessionOpenFailed(message: string): void;
  /**
   * Which coach a match is running under. Emitted on construction and on every live switch.
   *
   * Widened from `AgentTelemetry`'s optional method to a required one here, because the shell is the
   * thing that knows: a record that cannot say which coach spoke makes any comparison between them
   * unreadable after the fact.
   */
  coachMode(mode: CoachMode): void;
  /**
   * The LLM coach was asked for — from the tray, or from `settings.json` at startup — with no key
   * behind it, or with no model factory wired.
   *
   * Reported **once**, when the driver would have been built, and never per turn. dota2 §9's rule:
   * degrade loudly to the developer and quietly to the player. A coach that silently does nothing is
   * the failure REPO_SKELETON.md §7.1 describes as discovering it ten minutes into a game.
   */
  coachUnavailable(reason: string): void;
}

/**
 * Every method a no-op.
 *
 * Not `undefined` and not optional methods: a subsystem that has to ask whether telemetry exists
 * before every call is a subsystem that will one day forget to, and the branch costs more than
 * the empty function it is avoiding.
 */
export function nullTelemetry(): ShellTelemetry {
  return {
    sourceStarted: () => undefined,
    sourceRestarted: () => undefined,
    sourceGaveUp: () => undefined,
    worldReset: () => undefined,
    matchStarted: () => undefined,
    matchEnded: () => undefined,
    degraded: () => undefined,
    transition: () => undefined,
    visibilityLatency: () => undefined,
    rendererFault: () => undefined,
    coachingTurn: () => undefined,
    suppressed: () => undefined,
    emptyBrief: () => undefined,
    wouldSpeak: () => undefined,
    sidecarStderr: () => undefined,
    sidecarReady: () => undefined,
    sidecarProblem: () => undefined,
    sidecarProtocolMismatch: () => undefined,
    hotkeyUnavailable: () => undefined,
    pushToTalkUnavailable: () => undefined,
    sessionOpenFailed: () => undefined,
    coachMode: () => undefined,
    coachUnavailable: () => undefined,
    consulted: () => undefined,
    spoke: () => undefined,
    declined: () => undefined,
    skipped: () => undefined,
    modelFailed: () => undefined,
  };
}

/**
 * No external reference data — matchup notes and build benchmarks are unavailable.
 *
 * `PreambleAssembler` is specified as total: an enrichment failure is recorded in `degraded`,
 * never thrown, because *"a preamble that fails is a match with no coach, and a coach with no
 * matchup notes is still a coach"* (context-and-memory §4.1). So answering `unavailable` is the
 * designed path rather than a broken one, and the two sections that wanted a port are omitted and
 * counted.
 *
 * dota2 §2.4 treats external data as best-effort throughout, and REPO_SKELETON.md §10 has no step
 * that provides it: there is no `packages/reference`, and ADR-0019 makes the benchmark a
 * reference-class judgement rather than a fetch. So this is not waiting on a known piece of work —
 * it is waiting on a decision that has not been made.
 */
export const NULL_REFERENCE_DATA: ReferenceDataPort = {
  item: () => Promise.resolve({ ok: false, reason: 'unavailable' }),
  matchup: () => Promise.resolve({ ok: false, reason: 'unavailable' }),
  benchmark: () => Promise.resolve({ ok: false, reason: 'unavailable' }),
};
