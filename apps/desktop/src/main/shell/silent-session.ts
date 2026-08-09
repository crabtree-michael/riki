/**
 * **A `VoiceSessionPort` that never speaks — the no-key path rather than the only path.**
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
 * So this exists to make the rest of the shell real. Everything upstream of speech — GSI, fusion,
 * the world model, the snapshot — runs against a live game and is observable through the inspector.
 * What is missing is the audio.
 *
 * ## The one behaviour it must get right
 *
 * **Closing the turn.** The interaction machine enters Speaking on `turn.responseStarted` and
 * leaves it on `turn.responseEnded`. A port that accepted a turn and emitted nothing would leave
 * the chip Speaking forever, and a silent session would look identical to a session that hung —
 * which is the one confusion that would make this stand-in worse than useless.
 *
 * So it emits both edges around a nominal speaking duration. The duration is not cosmetic: it keeps
 * the chip's Speaking state exercised on the same rough timescale as a real utterance.
 */

import type { TurnId } from '@riki/context';
import type { CaptureMode, TurnEndReason, VoiceEvent } from '@riki/realtime';
import type { MonoMs } from '@riki/world-model';
import type { Timers } from '@riki/context';
import type { SessionTurn, VoiceSessionPort } from '../agent/index.js';

/** About as long as one spoken answer — two short sentences. */
export const NOMINAL_SPEECH_MS = 4_000;

export interface SilentSessionTelemetry {
  /**
   * What Riki *would* have said, as its input size. The rendered text is deliberately not passed:
   * the golden corpora are where output is inspected, and a transcript in a log is a privacy
   * surface.
   */
  wouldSpeak(turnId: TurnId, chars: number): void;
}

export interface SilentSessionDeps {
  readonly clock: { now(): MonoMs };
  readonly timers: Timers;
  readonly speechMs?: number;
  readonly telemetry?: SilentSessionTelemetry;
}

export interface SilentSession extends VoiceSessionPort {
  openMatch(instructions: string): Promise<void>;
  closeMatch(reason: string): Promise<void>;
  /** Every turn this port was handed, in order. The Tier 4 assertion for the whole turn path. */
  readonly turns: readonly SessionTurn[];
  /** The instructions each `openMatch` was given, so a test can assert the prefix without a session. */
  readonly opened: readonly string[];
  dispose(): void;
}

export function createSilentSession(deps: SilentSessionDeps): SilentSession {
  const speechMs = deps.speechMs ?? NOMINAL_SPEECH_MS;
  const listeners = new Set<(event: VoiceEvent) => void>();
  const turns: SessionTurn[] = [];
  const opened: string[] = [];
  const pending = new Map<TurnId, () => void>();
  let ids = 0;
  let disposed = false;

  function emit(event: VoiceEvent): void {
    for (const listener of [...listeners]) listener(event);
  }

  /**
   * The two edges a turn must produce, separated in time.
   *
   * Emitted rather than resolved-through: `VoiceSessionPort.endTurn` returns a promise that means
   * *handed over*, not *finished speaking*, and the chip leaves Speaking on the event stream.
   * Collapsing the two would make the stand-in disagree with the real session about what an awaited
   * `endTurn` means.
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
    opened,

    /**
     * There is no session to open, and that is the point.
     *
     * Present so `MatchScopedSession` has one shape and the shell needs no branch: everything
     * upstream of speech is identical whether or not there is an API key, and a shell that had to
     * ask which session it was holding would eventually ask in one place and forget in another.
     */
    openMatch(instructions: string): Promise<void> {
      opened.push(instructions);
      return Promise.resolve();
    },

    closeMatch(reason: string): Promise<void> {
      void reason;
      return Promise.resolve();
    },

    speakNow(turn: SessionTurn): Promise<void> {
      if (disposed) return Promise.resolve();
      turns.push(turn);
      deps.telemetry?.wouldSpeak(turn.turnId, turn.snapshotText.length);
      speak(turn.turnId);
      return Promise.resolve();
    },

    beginTurn(mode: CaptureMode, now: MonoMs): TurnId {
      // Neither is consulted: a turn id is a join key, and the real session allocates one from its
      // own counter for the same reason (`voice/session.ts`'s `nextTurnId`).
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
      turns.push(turn);
      deps.telemetry?.wouldSpeak(turnId, turn.snapshotText.length);
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
