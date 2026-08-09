/**
 * Every fault the shell already reports, mirrored into the inspector.
 *
 * `shell/telemetry.ts` names everything the app can say and then, today, says none of it:
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
 * The fault-shaped members become `DebugProblem`s. `playerTurn` does **not**: the snapshot decorator
 * already reports every turn in far more detail, and mirroring it here would be a second, coarser
 * account of the same event for the reader to reconcile. `emptySnapshot` *is* mirrored, because it
 * is the one signal a Turns panel full of plausible rows cannot give: the player asked a question
 * and the world model had nothing to answer it with.
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

    recordingOpened(matchId): void {
      delegate.recordingOpened(matchId);
    },

    recordingClosed(matchId, lines, keyframes): void {
      delegate.recordingClosed(matchId, lines, keyframes);
    },

    recordingFailed(matchId, reason): void {
      delegate.recordingFailed(matchId, reason);
      // The match keeps playing and the model keeps fusing, so nothing else in this window will
      // look wrong — but everything `world_at` could have answered about this match is now gone.
      problem('recording', `the recording for ${matchId} stopped: ${reason}`);
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

    playerTurn(turnId, snapshotTokens): void {
      delegate.playerTurn(turnId, snapshotTokens);
    },

    emptySnapshot(turnId): void {
      delegate.emptySnapshot(turnId);
      // Before the horn this is ordinary; thirty minutes into a match it means GSI has gone quiet
      // and the model is about to answer a question about a game it cannot see.
      problem('world', `the snapshot rendered empty for ${turnId}`);
    },

    snapshotOmitted(turnId, omitted): void {
      delegate.snapshotOmitted?.(turnId, omitted);
    },

    wouldSpeak(turnId, chars): void {
      delegate.wouldSpeak(turnId, chars);
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

    sessionOpenFailed(message: string): void {
      delegate.sessionOpenFailed(message);
      // A session that never opened is a Riki that watches the game and cannot answer, and the
      // symptom is a key press that produces a chip and no voice.
      problem('renderer', `the session could not be opened: ${message}`);
    },
  };
}
