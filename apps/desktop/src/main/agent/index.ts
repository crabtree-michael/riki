/**
 * The composition root for coaching: `@riki/events` → `@riki/context` → `@riki/realtime`.
 *
 * `coaching-architecture.md` §9.3 proposed this directory and nothing ever created it. It is §16
 * step 7, and it is the first point at which the two halves of coaching are in the same process.
 *
 * Three paths meet here and only one of them is new:
 *
 * ```
 *   driver.onProposal   ──► openTurn({ by:'trigger', topic }) ──► speakUnprompted   ← proactive
 *   push-to-talk        ──► openTurn({ by:'player' })         ──► endTurn           ← voice intent
 *   VoiceEvent          ──► ledger, and the driver's four switches                  ← routing
 * ```
 *
 * **`driver` is either coach and this file cannot tell which** (`contracts.ts`, `driver.ts`). That
 * is the whole of what requirement 1's runtime toggle costs: one port, two adapters, and two places
 * below where a proposal's `guidance` changes what happens — `inject`, and the empty-brief check.
 * Everything else on this page predates the LLM coach and did not move.
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
 * **…unless the proposal carries guidance.** That rule was written for a coach whose brief *is* the
 * advice: with nothing rendered there is nothing to say, and a model handed an empty brief invents
 * (realtime §11.6). An LLM proposal is the opposite case — the coach has already read the world and
 * drafted a line, so an empty brief means the plan's sections had nothing to add to it, not that the
 * turn has nothing behind it. Silencing it would throw away the judgement the mode exists for.
 *
 * See docs/design/coaching-trigger-architecture.md §9 and llm-coach-architecture.md §6.2.
 */

import type { AdviceTopic, TurnId, TurnOutcome } from '@riki/context';
import type { CaptureMode, TurnEndReason, VoiceEvent } from '@riki/realtime';
import type { MonoMs } from '@riki/world-model';
import type { CoachProposal, CoachingAgent, CoachingAgentDeps, SessionTurn } from './contracts.js';

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
  const { context, driver, session, clock, telemetry } = deps;

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
   * The snapshot, the brief and — under the LLM coach — the drafted line, as one system message.
   *
   * Blank-line separated rather than concatenated: they are different kinds of thing — a general
   * view, the reason this turn exists, and the point to make — and the format is an interface to the
   * model, so the separation is the same one the golden corpora render.
   *
   * **The guidance is framed as an instruction and the brief is not**, which is the one asymmetry
   * here. A brief is context the model reasons over; a drafted line is a decision another model
   * already made, and presenting it as more context would invite the voice model to re-litigate it
   * against a snapshot it can also see. `in your own voice` rather than `verbatim` is deliberate:
   * the persona lives in the session preamble and this line does not have it, so a verbatim read
   * would make a coaching turn sound different from an answer to a question — which is the closest
   * call in this design and is llm-coach-architecture.md §14 row 1.
   */
  function inject(snapshotText: string, briefText: string, guidance: string | null): string {
    const blocks = [snapshotText, briefText];
    if (guidance !== null && guidance !== '') {
      blocks.push(`coach — say this now, in your own voice, in one or two sentences:\n${guidance}`);
    }
    return blocks.filter((block) => block !== '').join('\n\n');
  }

  function close(turnId: TurnId, outcome: TurnOutcome, now: MonoMs): void {
    context.closeTurn(turnId, outcome, now);
    if (open?.turnId === turnId) open = null;
    driver.setAgentSpeaking(false);
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
  function recordSuppression(reason: string): void {
    telemetry?.suppressed(reason, null);
    // Deduplicated on the reason alone. Under the deterministic coach that reason is one of thirteen
    // and the key it used to carry made the dedupe per-condition; under the LLM coach it is a
    // sentence, which is already per-condition and then some — two consecutive declines phrased
    // differently are two transitions, which is the right answer for a coach whose reasons are prose.
    if (reason === lastSuppression) return;
    lastSuppression = reason;

    context.ledger.append({
      kind: 'turn_closed',
      turnId: nextCoachTurnId(),
      outcome: 'silent',
      at: clock.now(),
    });
  }

  async function speakAbout(proposal: CoachProposal): Promise<void> {
    if (disposed) return;

    lastSuppression = null;
    const turnId = nextCoachTurnId();
    const now = clock.now();

    const turn = context.openTurn(
      {
        turnId,
        cause: { by: 'trigger', event: proposal.id, salience: proposal.salience },
        topic: proposal.topic,
      },
      now,
    );

    if (turn.brief.empty) {
      telemetry?.emptyBrief(proposal.id);
      // With guidance in hand there is still something to say, so an empty brief is a *thinner*
      // turn rather than no turn. Without it the brief was the advice, and this is the silent path
      // coaching-architecture.md §6.5 specifies. The cooldown the engine armed on emit is not
      // released either way: retracting it would re-fire the same detection on the next version
      // bump, render another empty brief, and loop (coaching-trigger §5.6).
      if (proposal.guidance === null) {
        telemetry?.coachingTurn(proposal.id, proposal.salience, false);
        close(turnId, 'silent', clock.now());
        return;
      }
    }

    open = { turnId, topics: [proposal.topic] };
    driver.setAgentSpeaking(true);
    telemetry?.coachingTurn(proposal.id, proposal.salience, true);
    telemetry?.coachMode?.(driver.mode);

    await session.speakUnprompted(
      {
        turnId,
        snapshotText: inject(
          turn.snapshot.text,
          turn.brief.empty ? '' : turn.brief.text,
          proposal.guidance,
        ),
      },
      { eventId: proposal.id, salience: proposal.salience },
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
            driver.setQuietMode(true);
            return;
          case 'mute':
            driver.setMuted((clock.now() + DEFAULT_MUTE_MINUTES * MS_PER_MINUTE) as MonoMs);
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
        driver.setPlayerSpeaking(voice.event === 'resumed');
        return;

      case 'turn':
        if (voice.event === 'responseStarted') driver.setAgentSpeaking(true);
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
      const stopDriver = driver.start();
      const stopCoach = driver.onProposal((proposal) => {
        void speakAbout(proposal);
      });
      const stopSilent = driver.onDeclined(recordSuppression);
      const stopVoice = session.onEvent(route);

      disposers.push(stopDriver, stopCoach, stopSilent, stopVoice);
      return (): void => {
        stopDriver();
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
      driver.setAgentSpeaking(true);
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
        // No guidance: a player-initiated turn does not go through either coach, so there is no
        // drafted line and the widest `BRIEF_PLAN` row is the whole of the answer. Whether the LLM
        // coach should also answer questions is llm-coach-architecture.md §14 row 2, held open.
        snapshotText: inject(turn.snapshot.text, turn.brief.empty ? '' : turn.brief.text, null),
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
      driver.dispose();
      open = null;
    },
  };
}

export * from './contracts.js';
export { staticCoachDriver, llmCoachDriver, proposalOf } from './driver.js';
export type { StaticCoachDriver, LlmCoachDriver } from './driver.js';
export { createSnapshotNarrator } from './narrator.js';
export type { SnapshotNarratorDeps } from './narrator.js';
export { toContextReader, toContextSnapshot, observedFrom } from './world-view.js';
export type { WorldViewOptions } from './world-view.js';
export { toEventTapeReader } from './tape.js';
