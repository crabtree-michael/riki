/**
 * **A `CoachingSessionPort` that never speaks — now the no-key path rather than the only path.**
 *
 * `main/voice/session.ts` is the real one and `main/index.ts` chooses between them on whether
 * `packages/config` found an API key. This is not dead code and is not a stand-in any more: ADR-0006
 * makes "absent key, voice disabled, app boots and says so" a supported mode, and it is the mode
 * every test, every fixture run and CI are in.
 *
 * The history below is kept because the reasoning is still why the seam is shaped this way.
 *
 * `RealtimeSession` and its transport do not run in main. ADR-0002 puts the peer connection in a
 * renderer and `voice-input-architecture.md` §2.2 is explicit about why — `getUserMedia`, Web
 * Audio and Chromium's AEC exist only in a renderer, and the peer connection has to be where the
 * tracks are. The voice window that hosts them is that document's §7.3, `apps/desktop/src/main/
 * voice/`, and its own build order puts it at step 7 **after** the shell this file is part of.
 * `src/renderer/` has an `overlay/` directory and nothing else.
 *
 * Two other things would have to land first anyway:
 *
 * - `packages/config`, for `RIKI_OPENAI_API_KEY`. `ClientSecretBroker` takes an `ApiKey` by
 *   injection and a lint rule stops anything but `packages/config` reading the environment, so
 *   there is no key to inject and no permitted way to obtain one (see `config.ts`).
 * - `packages/protocol`, for the messages that cross the preload bridge.
 *
 * *(Both of those have since landed — this file's remaining job is the keyless path.)*
 *
 * So this exists to make the shell's remaining seven eighths real. Everything upstream of speech —
 * GSI, fusion, detection, salience, the thirteen gates, the brief — runs against a live game and
 * is observable through the ledger and the counters, which is exactly what
 * `coaching-trigger-architecture.md` §16 step 3 needs for tuning. What is missing is the audio.
 *
 * ## The one behaviour it must get right
 *
 * **Closing the turn.** `agent_speaking` is gate 4, and the composition root arms it before
 * calling `speakUnprompted` and disarms it on `turn.responseEnded`. A port that accepted the turn
 * and emitted nothing would leave the gate armed forever, and every later trigger would be
 * suppressed — a silent session would look identical to a broken trigger policy, which is the one
 * confusion that would make this stand-in worse than useless.
 *
 * So it emits `responseStarted` and `responseEnded` around a nominal speaking duration. The
 * duration is not cosmetic: it is what keeps the overlay chip's Speaking state, the cooldown
 * timers and the intensity gate exercised on the same rough timescale as a real utterance.
 */

import type { TurnId } from '@riki/context';
import type { CaptureMode, TurnEndReason, VoiceEvent } from '@riki/realtime';
import type { MonoMs } from '@riki/world-model';
import type { Timers } from '@riki/context';
import type { CoachingSessionPort, SessionTurn, SpeakReason } from '../agent/index.js';

/** About as long as one piece of advice. `coaching-architecture.md` §3.2 wants two short sentences. */
export const NOMINAL_SPEECH_MS = 4_000;

export interface SilentSessionTelemetry {
  /**
   * What Riki *would* have said, as its inputs. The rendered text is deliberately not passed: the
   * golden corpora are where output is inspected, and a transcript in a log is a privacy surface.
   */
  wouldSpeak(turnId: TurnId, reason: SpeakReason, chars: number): void;
}

export interface SilentSessionDeps {
  readonly clock: { now(): MonoMs };
  readonly timers: Timers;
  readonly speechMs?: number;
  readonly telemetry?: SilentSessionTelemetry;
}

export interface SilentSession extends CoachingSessionPort {
  openMatch(preambleText: string): Promise<void>;
  closeMatch(reason: string): Promise<void>;
  /** Every turn this port was handed, in order. The Tier 4 assertion for the whole coaching path. */
  readonly turns: readonly { readonly turn: SessionTurn; readonly reason: SpeakReason | null }[];
  dispose(): void;
}

export function createSilentSession(deps: SilentSessionDeps): SilentSession {
  const speechMs = deps.speechMs ?? NOMINAL_SPEECH_MS;
  const listeners = new Set<(event: VoiceEvent) => void>();
  const turns: { turn: SessionTurn; reason: SpeakReason | null }[] = [];
  const pending = new Map<TurnId, () => void>();
  let ids = 0;
  let disposed = false;

  function emit(event: VoiceEvent): void {
    for (const listener of [...listeners]) listener(event);
  }

  /**
   * The two edges a turn must produce, separated in time.
   *
   * Emitted rather than resolved-through: `CoachingSessionPort.speakUnprompted` returns a promise
   * that means *handed over*, not *finished speaking*, and the agent closes the turn from the
   * event stream. Collapsing the two would make the stand-in disagree with the real session about
   * what an awaited `speakUnprompted` means.
   */
  function speak(turnId: TurnId): void {
    emit({ kind: 'turn', event: 'responseStarted', turnId });
    const cancel = deps.timers.after(speechMs, () => {
      pending.delete(turnId);
      emit({ kind: 'turn', event: 'responseEnded', turnId });
    });
    pending.set(turnId, cancel);
  }

  function endPending(turnId: TurnId): void {
    const cancel = pending.get(turnId);
    if (cancel === undefined) return;
    cancel();
    pending.delete(turnId);
    emit({ kind: 'turn', event: 'responseEnded', turnId });
  }

  return {
    turns,

    /**
     * There is no session to open, and that is the point.
     *
     * Present so `MatchScopedSession` has one shape and the shell needs no branch: everything
     * upstream of speech is identical whether or not there is an API key, and a shell that had to
     * ask which session it was holding would eventually ask in one place and forget in another.
     */
    openMatch(preambleText: string): Promise<void> {
      void preambleText;
      return Promise.resolve();
    },

    closeMatch(reason: string): Promise<void> {
      void reason;
      return Promise.resolve();
    },

    speakUnprompted(turn: SessionTurn, reason: SpeakReason): Promise<void> {
      if (disposed) return Promise.resolve();
      turns.push({ turn, reason });
      deps.telemetry?.wouldSpeak(turn.turnId, reason, turn.snapshotText.length);
      speak(turn.turnId);
      return Promise.resolve();
    },

    beginTurn(mode: CaptureMode, now: MonoMs): TurnId {
      // Neither is consulted: a turn id is a join key, and the real session allocates one from its
      // own counter for the same reason (`agent/index.ts`'s `nextCoachTurnId`).
      void mode;
      void now;
      ids += 1;
      return `silent_${String(ids)}` as TurnId;
    },

    endTurn(turnId: TurnId, reason: TurnEndReason, turn: SessionTurn): Promise<void> {
      if (disposed) return Promise.resolve();
      if (reason === 'cancel') {
        endPending(turnId);
        return Promise.resolve();
      }
      turns.push({ turn, reason: null });
      speak(turnId);
      return Promise.resolve();
    },

    abort(): Promise<void> {
      for (const turnId of [...pending.keys()]) endPending(turnId);
      return Promise.resolve();
    },

    onEvent(listener: (event: VoiceEvent) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const cancel of pending.values()) cancel();
      pending.clear();
      listeners.clear();
    },
  };
}
