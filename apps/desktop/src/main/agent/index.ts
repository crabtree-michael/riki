/**
 * The composition root for coaching: `@riki/events` → `@riki/context` → `@riki/realtime`.
 *
 * `coaching-architecture.md` §9.3 proposed this directory and nothing ever created it. It is §16
 * step 7, and it is the first point at which the two halves of coaching are in the same process.
 *
 * Three paths meet here and only one of them is new:
 *
 * ```
 *   engine.onCoachEvent ──► openTurn({ by:'trigger', topic }) ──► speakUnprompted   ← proactive
 *   push-to-talk        ──► openTurn({ by:'player' })         ──► endTurn           ← voice intent
 *   VoiceEvent          ──► ledger, and the engine's four switches                  ← routing
 * ```
 *
 * **`agent_said.topics` comes from the `CoachEvent` that opened the turn, never from the
 * transcript.** That is the one rule in this file that cannot be relaxed: nothing on this path
 * classifies natural language, which is what keeps the novelty gate deterministic and ADR-0013's
 * free-text prohibition structural rather than remembered (context-and-memory §6.3). It is why the
 * agent holds the topic from `openTurn` until the final transcript arrives.
 *
 * **An empty brief is a turn that does not happen** (coaching-architecture.md §6.5). The assembler
 * cannot refuse to open one — the gates already admitted it — so it renders, reports
 * `brief.empty`, and this file closes the turn `'silent'` rather than opening a session turn with
 * nothing behind it and a model left to improvise.
 *
 * See docs/design/coaching-trigger-architecture.md §9.
 */

import type { AdviceTopic, TurnId, TurnOutcome } from '@riki/context';
import type { CoachEvent, SuppressionReason } from '@riki/events';
import type { CaptureMode, TurnEndReason, VoiceEvent } from '@riki/realtime';
import type { MonoMs } from '@riki/world-model';
import type { CoachingAgent, CoachingAgentDeps, SessionTurn } from './contracts.js';

/** Minutes to milliseconds, for the `mute` local command. */
const MS_PER_MINUTE = 60_000;
/** `mute` with no duration. dota2 §6.4's off switch is `quiet-mode`; this one is a breather. */
const DEFAULT_MUTE_MINUTES = 10;

let coachTurns = 0;

/**
 * `coach_1`, not `turn_1`.
 *
 * `@riki/realtime` allocates its own ids for gesture turns, and two independent counters sharing a
 * prefix would eventually produce two ledger entries claiming to be the same turn — which the
 * ledger cannot detect, because a turn id is only ever a join key.
 */
function nextCoachTurnId(): TurnId {
  coachTurns += 1;
  return `coach_${String(coachTurns)}` as TurnId;
}

/** Test-only: the counter is module state, and a test that asserts an id needs it reset. */
export function resetCoachTurnIds(): void {
  coachTurns = 0;
}

export function createCoachingAgent(deps: CoachingAgentDeps): CoachingAgent {
  const { context, engine, session, clock, telemetry } = deps;

  /**
   * The turn currently open, and what it is about.
   *
   * One slot rather than a map: the whole trigger policy exists to guarantee there is at most one
   * (`agent_speaking`, §5.5), and a map would quietly accept the state the gate is there to make
   * unreachable.
   */
  let open: { readonly turnId: TurnId; readonly topics: readonly AdviceTopic[] } | null = null;
  let disposed = false;
  const disposers: (() => void)[] = [];

  /** Deduplicates the ledger's silent record; see `recordSuppression`. */
  let lastSuppression: string | null = null;

  /**
   * The snapshot and the brief, as one system message.
   *
   * Blank-line separated rather than concatenated: the two are different kinds of thing — a general
   * view and the reason this turn exists — and the format is an interface to the model, so the
   * separation is the same one the golden corpora render.
   */
  function inject(snapshotText: string, briefText: string): string {
    if (briefText === '') return snapshotText;
    if (snapshotText === '') return briefText;
    return `${snapshotText}\n\n${briefText}`;
  }

  function close(turnId: TurnId, outcome: TurnOutcome, now: MonoMs): void {
    context.closeTurn(turnId, outcome, now);
    if (open?.turnId === turnId) open = null;
    engine.setAgentSpeaking(false);
  }

  /**
   * A refused trigger, in the ledger as well as in the counters.
   *
   * `coaching-trigger-architecture.md` §5.4 asks for both, and the counters carry the fine-grained
   * accounting. The ledger gets the **coarse** record, deduplicated on (reason, key): the gates run
   * on every world-model version bump, so an entry per refusal would be tens of thousands of
   * entries in a match against ADR-0012's "a few hundred", and the ledger is projected on every
   * novelty-gate read. What survives the dedupe is the transition — the moment Riki started being
   * quiet for a new reason — which is the thing anybody reading the record is looking for.
   */
  function recordSuppression(reason: SuppressionReason, event: CoachEvent | null): void {
    telemetry?.suppressed(reason, event?.id ?? null);
    const key = `${reason}:${event?.key ?? ''}`;
    if (key === lastSuppression) return;
    lastSuppression = key;

    context.ledger.append({
      kind: 'turn_closed',
      turnId: nextCoachTurnId(),
      outcome: 'silent',
      at: clock.now(),
    });
  }

  async function speakAbout(event: CoachEvent): Promise<void> {
    if (disposed) return;

    lastSuppression = null;
    const turnId = nextCoachTurnId();
    const now = clock.now();

    const turn = context.openTurn(
      {
        turnId,
        cause: { by: 'trigger', event: event.id, salience: event.salience },
        topic: event.topic,
      },
      now,
    );

    if (turn.brief.empty) {
      telemetry?.emptyBrief(event.id);
      telemetry?.coachingTurn(event.id, event.salience, false);
      // The cooldown the engine armed on emit is *not* released. Retracting it would re-fire this
      // detection on the next version bump, render another empty brief, and loop
      // (coaching-trigger-architecture.md §5.6).
      close(turnId, 'silent', clock.now());
      return;
    }

    open = { turnId, topics: [event.topic] };
    engine.setAgentSpeaking(true);
    telemetry?.coachingTurn(event.id, event.salience, true);

    await session.speakUnprompted(
      { turnId, snapshotText: inject(turn.snapshot.text, turn.brief.text) },
      { eventId: event.id, salience: event.salience },
    );
  }

  /**
   * The routing table, and the half of step 7 that is about voice rather than about triggers.
   *
   * Every arm is either a control — one of the engine's four switches — or a ledger append. None of
   * them classifies text: `LocalCommand` is a four-member closed union parsed locally from a
   * transcript by `@riki/realtime` (voice-input §6.3), and it is the only thing in this product
   * that turns speech into an action.
   */
  function route(voice: VoiceEvent): void {
    switch (voice.kind) {
      case 'command':
        switch (voice.command) {
          case 'quiet-mode':
            // "Only when I ask" — the off switch for the primary path, and the most important
            // control in the product now that Riki speaks unprompted (coaching §7.1).
            engine.setQuietMode(true);
            return;
          case 'mute':
            engine.setMuted((clock.now() + DEFAULT_MUTE_MINUTES * MS_PER_MINUTE) as MonoMs);
            return;
          case 'stop':
            void session.abort();
            if (open !== null) close(open.turnId, 'cancelled', clock.now());
            return;
          case 'cancel':
            if (open !== null) close(open.turnId, 'cancelled', clock.now());
            return;
        }
        return;

      case 'speech':
        // Never speak while the player is talking (dota2 §6.4).
        engine.setPlayerSpeaking(voice.event === 'resumed');
        return;

      case 'turn':
        if (voice.event === 'responseStarted') engine.setAgentSpeaking(true);
        if (voice.event === 'responseEnded') close(voice.turnId, 'spoke', clock.now());
        return;

      case 'transcript': {
        if (!voice.final) return;
        const at = clock.now();
        if (voice.role === 'player') {
          context.ledger.append({
            kind: 'player_said',
            turnId: voice.turnId,
            transcript: voice.text,
            at,
          });
          return;
        }
        context.ledger.append({
          kind: 'agent_said',
          turnId: voice.turnId,
          transcript: voice.text,
          // From the trigger, before a word was spoken. A player-initiated turn has no topic at
          // all, which is correct: the player asked, and answering the same question twice is what
          // a coach should do (context-and-memory §6.3).
          topics: open?.turnId === voice.turnId ? open.topics : [],
          at,
        });
        return;
      }

      case 'fault':
        // A lost session does not clear a latch or a cooldown: those are about the *match*, and
        // rehydration replays the advice topics rather than the moments (§10).
        if (open !== null) close(open.turnId, 'cancelled', clock.now());
        return;

      case 'level':
      case 'capture':
      case 'cost':
        return;
    }
  }

  return {
    start(): () => void {
      const stopEngine = engine.start();
      const stopCoach = engine.onCoachEvent((event) => {
        void speakAbout(event);
      });
      const stopSilent = engine.onSuppressed(recordSuppression);
      const stopVoice = session.onEvent(route);

      disposers.push(stopEngine, stopCoach, stopSilent, stopVoice);
      return (): void => {
        stopEngine();
        stopCoach();
        stopSilent();
        stopVoice();
      };
    },

    /**
     * A push-to-talk press.
     *
     * The gesture pre-empts rather than queues: a player turn does not go through the gates at all,
     * so nothing here consults the engine — it only tells it that a turn is open, which is what
     * stops a coaching trigger from landing on top of the answer.
     */
    beginPlayerTurn(mode: CaptureMode): TurnId {
      const turnId = session.beginTurn(mode, clock.now());
      engine.setAgentSpeaking(true);
      open = { turnId, topics: [] };
      return turnId;
    },

    /**
     * The release, and this is where "voice intents route into `openTurn`".
     *
     * A player-initiated turn takes exactly the same path as a coaching turn: a snapshot, a brief,
     * one injected system message. Its `BRIEF_PLAN` row is `player_question`, which is the widest
     * one the budget allows — and that width is coaching-architecture.md §3.2's first mitigation
     * for the pull surface the deletion removed, not a default.
     */
    async endPlayerTurn(turnId: TurnId, reason: TurnEndReason): Promise<void> {
      const now = clock.now();
      if (reason === 'cancel') {
        close(turnId, 'cancelled', now);
        await session.endTurn(turnId, reason, { turnId, snapshotText: '' });
        return;
      }

      const turn = context.openTurn(
        { turnId, cause: { by: 'player', gesture: 'push_to_talk' } },
        now,
      );
      const injected: SessionTurn = {
        turnId,
        snapshotText: inject(turn.snapshot.text, turn.brief.empty ? '' : turn.brief.text),
      };
      // Unlike a coaching turn, an empty brief here is not a reason to stay quiet: the player
      // asked, and the snapshot alone is still an answer.
      await session.endTurn(turnId, reason, injected);
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const stop of disposers) stop();
      disposers.length = 0;
      engine.dispose();
      open = null;
    },
  };
}

export * from './contracts.js';
export { toContextReader, toContextSnapshot, observedFrom } from './world-view.js';
export type { WorldViewOptions } from './world-view.js';
export { toEventTapeReader } from './tape.js';
