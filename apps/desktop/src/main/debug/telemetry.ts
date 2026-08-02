/**
 * Every fault the shell already reports, mirrored into the inspector.
 *
 * `shell/telemetry.ts` names sixteen things the app can say and then, today, says none of them:
 * `packages/telemetry` is still a skeleton, so `nullTelemetry()` is what everything is wired to and
 * a sidecar panic, a renderer fault or a source that gave up reaches exactly nowhere. Until that
 * package lands **this window is the only place any of it is visible**, which is a large part of
 * why the inspector is worth building now rather than after.
 *
 * A decorator rather than a replacement: the underlying sink is called first and unconditionally,
 * so wiring the inspector never costs a telemetry event. When `packages/telemetry` lands, the real
 * sink goes underneath this and both surfaces get everything.
 *
 * ## What is mirrored, and what is not
 *
 * The fault-shaped members become `DebugProblem`s. `suppressed` and `coachingTurn` do **not**: they
 * fire on every version bump and the inspector already has both, in far more detail, from the
 * policy decorator — mirroring them here would be a second, coarser account of the same events for
 * the reader to reconcile. `emptyBrief` is mirrored as a counter because it is the one signal the
 * gate ladder genuinely cannot show: the trigger was admitted, and the *brief* is what came back
 * empty.
 */

import type { ShellTelemetry } from '../shell/telemetry.js';
import type { DebugHub } from './contracts.js';

export interface DebugTelemetryDeps {
  readonly hub: DebugHub;
  /** The sink that would have been used. Called first, always. */
  readonly delegate: ShellTelemetry;
  readonly now: () => number;
}

export function withDebugTelemetry(deps: DebugTelemetryDeps): ShellTelemetry {
  const { hub, delegate } = deps;

  function problem(origin: string, message: string): void {
    hub.recordProblem(origin, message, deps.now());
  }

  return {
    sourceStarted(id): void {
      delegate.sourceStarted(id);
    },

    sourceRestarted(id, attempt, delayMs): void {
      delegate.sourceRestarted(id, attempt, delayMs);
      problem('source', `${id} restarting, attempt ${String(attempt)} after ${String(delayMs)} ms`);
    },

    sourceGaveUp(id, reason): void {
      delegate.sourceGaveUp(id, reason);
      problem('source', `${id} is not coming back: ${reason}`);
    },

    worldReset(reason): void {
      delegate.worldReset(reason);
      // Not a fault, but the single most confusing thing that can happen while watching this
      // window: every fact vanishes at once and nothing else says why.
      problem('world', `world model reset: ${reason}`);
    },

    matchStarted(matchId): void {
      delegate.matchStarted(matchId);
    },

    matchEnded(matchId): void {
      delegate.matchEnded(matchId);
    },

    degraded(from, to, summary): void {
      delegate.degraded(from, to, summary);
      problem('degradation', `${from} → ${to}: ${summary}`);
    },

    transition(from, to, at): void {
      delegate.transition(from, to, at);
    },

    visibilityLatency(ms): void {
      delegate.visibilityLatency(ms);
    },

    rendererFault(message): void {
      delegate.rendererFault(message);
      problem('renderer', message);
    },

    coachingTurn(eventId, salience, spoke): void {
      delegate.coachingTurn(eventId, salience, spoke);
    },

    suppressed(reason, eventId): void {
      delegate.suppressed(reason, eventId);
    },

    emptyBrief(eventId): void {
      delegate.emptyBrief(eventId);
      hub.recordEmptyBrief();
      // A rising count means `BRIEF_PLAN` is wrong for that event id, which is a real defect and
      // reads as silence from every other vantage point.
      problem('coach', `brief rendered empty for ${eventId} — the turn was admitted and dropped`);
    },

    wouldSpeak(turnId, reason, chars): void {
      delegate.wouldSpeak(turnId, reason, chars);
    },

    // ---------------------------------------------------------------------------------------------
    // The LLM coach
    // ---------------------------------------------------------------------------------------------
    //
    // This block is the inspector's answer to "does it work against both coaches". Under `llm`
    // there are no detectors, no salience and no gate ladder, so the policy decorator sees nothing
    // and `packages/coach`'s own telemetry is the entire account of what that coach decided. It
    // already arrives here, because the shell hands the same sink to both — so covering the second
    // coach needed no change to `packages/coach`, to `agent/driver.ts`, or to the shape of a frame.
    //
    // `declined` and `skipped` become Triggers rows; `coachUnavailable` and `modelFailed` become
    // Problems. `consulted` and `spoke` are mirrored nowhere, for the same reason `suppressed` and
    // `coachingTurn` are not: they fire on every consultation and the frame already carries the
    // turn they produced.

    coachMode(mode): void {
      delegate.coachMode(mode);
    },

    coachUnavailable(reason): void {
      delegate.coachUnavailable(reason);
      // The failure REPO_SKELETON.md §7.1 describes as discovering it ten minutes into a game: the
      // LLM coach was asked for, could not be built, and the app degraded to `static` in silence.
      problem('coach', `the LLM coach could not be built: ${reason}`);
    },

    consulted(seq, signals): void {
      delegate.consulted(seq, signals);
    },

    spoke(kind, weight, chars): void {
      delegate.spoke(kind, weight, chars);
    },

    declined(reasoning): void {
      delegate.declined(reasoning);
      // The LLM coach's whole account of a moment it passed on, and the counterpart of a gate
      // ladder. It goes in the Triggers panel rather than in Problems: declining is the correct and
      // overwhelmingly common outcome for either coach, not a fault. Without this the panel is
      // empty in `llm` mode and looks exactly like a coach that never ran.
      hub.recordDecline(reasoning, deps.now(), null);
    },

    skipped(reason): void {
      delegate.skipped(reason);
      // Distinct from `declined`: the coach was not consulted at all, which is a different answer
      // to "why was it quiet" and the same distinction `counters.ticks` draws for the other coach.
      hub.recordDecline(`skipped: ${reason}`, deps.now(), null);
    },

    modelFailed(message): void {
      delegate.modelFailed(message);
      // A model call that failed is the LLM coach's equivalent of a sidecar panic: the coach goes
      // quiet, and quiet is indistinguishable from working. The message, never the key (ADR-0022).
      problem('coach', `the coach model failed: ${message}`);
    },

    sidecarStderr(line): void {
      delegate.sidecarStderr(line);
      problem('sidecar', line);
    },

    sidecarReady(backend, available): void {
      delegate.sidecarReady(backend, available);
      // Not a fault when `available`, and it is recorded anyway: a sidecar that handshook with no
      // capture backend is the state where every CV fact is legitimately missing, and it looks
      // exactly like a sidecar that never started.
      if (!available) problem('sidecar', `handshook with no capture backend (${backend})`);
    },

    sidecarProblem(kind, fatal, remedy): void {
      delegate.sidecarProblem(kind, fatal, remedy);
      problem(
        'sidecar',
        `${kind}${fatal ? ' (fatal)' : ''}${remedy === null ? '' : ` — ${remedy}`}`,
      );
    },

    sidecarProtocolMismatch(theirs, ours): void {
      delegate.sidecarProtocolMismatch(theirs, ours);
      // A mismatched build, not a crash — and the failure it produces downstream is "no CV facts",
      // which is indistinguishable from a game the sidecar simply cannot see.
      problem(
        'sidecar',
        `protocol mismatch: sidecar speaks v${String(theirs)}, app speaks v${String(ours)}`,
      );
    },

    hotkeyUnavailable(accelerator, hasKeyUp): void {
      delegate.hotkeyUnavailable(accelerator, hasKeyUp);
      problem('hotkey', `could not register ${accelerator} (key-up ${String(hasKeyUp)})`);
    },

    pushToTalkUnavailable(): void {
      delegate.pushToTalkUnavailable();
      problem('hotkey', 'key-up is synthetic: tap-to-latch works, hold-to-push does not');
    },
  };
}
