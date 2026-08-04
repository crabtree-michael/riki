/**
 * One coach turn, on demand, against a game state that is not the one being played (ADR-0038).
 *
 * ## The question this answers
 *
 * Every other way of seeing what the coach does with a moment requires that moment to happen. A
 * live match reaches laning phase once and then leaves it; a replay reaches it on the timeline's
 * schedule and the latches, the cooldowns and the intensity fold all start from nothing each run.
 * So *"here is a state — what would you say about it, and what were you looking at when you decided
 * that"* has had no answer short of playing a game, which is the slow part of iterating on coaching
 * behaviour and is what `debug-inspector.md` §9's seventh open item is about.
 *
 * ## What a rehearsal is, precisely
 *
 * ```
 *   fixtures/gsi/<id>.jsonl ──► scratch WorldModelStore ──► scratch coach ──► consult(now)
 *                                        │                                        │
 *                                        └──► scratch ContextAssembler ──► openTurn ──► DebugHub
 * ```
 *
 * Four objects, all built for this call and all thrown away at the end of it. **Nothing here
 * touches the live match**, and that is the property the whole component is built around rather
 * than a side effect: the scratch world is a different `WorldModelStore`, so the fused facts the
 * app is coaching on never see a mock payload; the scratch coach is a different engine or a
 * different `LlmCoach`, so the latch set and the cooldown clocks somebody is watching in the Gate
 * state panel do not move; and the scratch context is a different ledger, so the conversation Riki
 * is actually having is not appended to.
 *
 * **It cannot make Riki speak.** No `CoachingSessionPort` is reachable from this file. A rehearsal
 * produces text and records it; there is no path from here to `speakUnprompted`, which is the same
 * refusal `shared/debug.ts` has always made about the bridge and is the reason this is an
 * acceptable fifth intent.
 *
 * ## Two things it is honest about rather than hiding
 *
 * **A rehearsed turn is marked.** It lands in the same buffer as a real one and renders identically,
 * so `DebugTurn.mockState` carries the state's id and the outcome is `rehearsed` or `declined` —
 * never `spoke`, because nothing spoke. A window whose only job is to be believed must not be able
 * to offer a fabricated moment and a real one as the same claim.
 *
 * **The mock state is a recording replayed to its end**, not a hand-authored moment. See
 * `mock-states.ts`. What the coach reads is what the whole file fuses to, aged as though the last
 * POST had just arrived — see `feed` for why that last part is load-bearing.
 */

import type { EventTape } from '@riki/events';
import type { MatchId, RikiContext } from '@riki/context';
import type { TurnId } from '@riki/context';
import { createFakeGsiSource, createManualClock } from '@riki/gsi/testing';
import type { MonoMs, Observation, WorldModelStore } from '@riki/world-model';

import type { DebugMockState } from '../../shared/debug.js';
import type { CoachDriver } from '../agent/index.js';
import type { DebugHub } from './contracts.js';
import type { MockState, MockStateLibrary } from './mock-states.js';
import { projectMockStates } from './mock-states.js';
import { observeContext } from './observing-context.js';

/**
 * A throwaway coaching root over a world the rehearsal owns.
 *
 * Built by the shell rather than here, because *what a coaching root is made of* is the composition
 * root's knowledge and duplicating it would be the second copy that drifts: the tape, the assembler,
 * the preamble source, the durable memory and the choice between the two coaches are all decisions
 * `shell/index.ts` already makes for the live match, and a rehearsal that made them differently
 * would be measuring a coach the app does not run.
 *
 * The one thing this file does insist on is `dispose`. A `CoachDriver` that outlived its rehearsal
 * would keep a subscription to a world nobody writes to, and under `llm` it would keep a pooled
 * transport open.
 */
export interface RehearsalStack {
  readonly context: RikiContext;
  readonly driver: CoachDriver;
  readonly tape: EventTape;
  dispose(): void;
}

export interface DebugRehearsalDeps {
  readonly library: MockStateLibrary;
  readonly hub: DebugHub;
  /** Main's monotonic clock. The mock's observations are aged against it; see `feed`. */
  readonly now: () => number;
  /** An empty world model with the app's own fusion policies. The shell's, so they cannot differ. */
  readonly world: () => WorldModelStore;
  readonly stack: (world: WorldModelStore, matchId: MatchId) => RehearsalStack;
}

export type RehearsalOutcome =
  | { readonly ok: true; readonly turnId: string; readonly spoke: boolean }
  | { readonly ok: false; readonly reason: string };

/** What the surface calls. Total: every failure is an outcome and a problem, never a throw. */
export interface DebugRehearsalPort {
  states(): readonly DebugMockState[];
  run(stateId: string): Promise<RehearsalOutcome>;
}

let rehearsals = 0;

/**
 * `rehearsal_1`, and deliberately not `coach_1`.
 *
 * `agent/index.ts` allocates the latter from its own counter, and two counters sharing a prefix
 * would eventually produce two entries in the turn buffer claiming to be the same turn — which the
 * buffer joins transcripts on and cannot detect.
 */
function nextRehearsalId(): TurnId {
  rehearsals += 1;
  return `rehearsal_${String(rehearsals)}` as TurnId;
}

/** Test-only: the counter is module state, and a test that asserts an id needs it reset. */
export function resetRehearsalIds(): void {
  rehearsals = 0;
}

export function createDebugRehearsal(deps: DebugRehearsalDeps): DebugRehearsalPort {
  /**
   * One at a time.
   *
   * Under `llm` a rehearsal is a model call taking seconds, and the button is one click. Two
   * overlapping runs would interleave two turns into the panel and — because `LlmCoach` refuses a
   * second consultation while one is `in_flight` — the second would report a skip that says nothing
   * about the state it was asked about. Refusing with a reason is the readable failure.
   */
  let running = false;

  return {
    states: () => projectMockStates(deps.library.list()),

    async run(stateId: string): Promise<RehearsalOutcome> {
      const state = deps.library.get(stateId);
      if (state === null) {
        return fail(`no mock game state named ${stateId}`);
      }
      if (state.lines.length === 0) {
        return fail(`mock game state ${stateId} replays nothing`);
      }
      if (running) {
        return fail('a rehearsal is already running');
      }

      running = true;
      try {
        return await rehearse(state);
      } catch (error: unknown) {
        // A rehearsal is a debug affordance reached from a renderer click. Anything it throws —
        // a fixture that fuses to a world a detector chokes on, a model client that rejects — is a
        // problem to read, not an unhandled rejection in main.
        return fail(error instanceof Error ? error.message : String(error));
      } finally {
        running = false;
      }
    },
  };

  function fail(reason: string): RehearsalOutcome {
    deps.hub.recordProblem('inspector', `rehearsal: ${reason}`, deps.now());
    return { ok: false, reason };
  }

  async function rehearse(state: MockState): Promise<RehearsalOutcome> {
    const world = deps.world();
    feed(world, state, deps.now());

    const at = deps.now() as MonoMs;
    const clock = world.snapshot(at).clock;
    const stack = deps.stack(world, `mock:${state.id}` as MatchId);

    try {
      const consultation = await stack.driver.consult(at);
      const guidance = consultation.spoke ? consultation.proposal.guidance : null;

      if (!consultation.spoke) {
        // Into the Triggers panel as well as onto the turn, because under `llm` this sentence *is*
        // the coach's output for the moment — the panel is the only place a reason ever appears at
        // its full length. Prefixed, so a rehearsal's reason is never read as the live coach's.
        deps.hub.recordDecline(`rehearsal ${state.id}: ${consultation.reason}`, at, clock);
      }

      // The same projection the live turn path uses, so a rehearsed turn and a real one are
      // rendered from the same fields and cannot drift apart. Only the three that say *this was a
      // rehearsal* are added on top.
      const observed = observeContext({
        delegate: stack.context,
        clock: () => clock,
        onOpened: (turn) => {
          deps.hub.recordTurnOpened({
            ...turn,
            cause: 'rehearsal',
            mockState: state.id,
            guidance,
          });
        },
        // `closeTurn` is told `silent`, which is the truth about the *ledger*: no session turn was
        // opened and nothing was said. The panel is told which kind of silence it was, which is the
        // only thing a reader of a rehearsal wants to know at a glance.
        onClosed: (turnId) => {
          deps.hub.recordTurnClosed(turnId, consultation.spoke ? 'rehearsed' : 'declined');
        },
      });

      const turnId = nextRehearsalId();
      observed.openTurn(
        {
          turnId,
          // With a proposal in hand the brief is assembled for the moment the coach named, which is
          // the whole point — `BRIEF_PLAN` keys off the event id. Without one there is no event, so
          // the turn takes the player-question shape: the widest row the budget allows, which is
          // the most a rehearsal can show about a state nothing fired on.
          ...(consultation.spoke
            ? {
                cause: {
                  by: 'trigger' as const,
                  event: consultation.proposal.id,
                  salience: consultation.proposal.salience,
                },
                topic: consultation.proposal.topic,
              }
            : { cause: { by: 'player' as const, gesture: 'push_to_talk' as const } }),
        },
        at,
      );
      observed.closeTurn(turnId, 'silent', deps.now() as MonoMs);

      return { ok: true, turnId: String(turnId), spoke: consultation.spoke };
    } finally {
      stack.dispose();
    }
  }
}

/**
 * Replay the recording into the scratch world, ending *now*.
 *
 * The subtle half of this whole component, and getting it wrong produces a rehearsal that looks
 * broken rather than one that looks wrong. A fixture's `atMs` starts at zero; main's clock has been
 * running since the app started. Applying the payloads at their recorded times would put every fact
 * in the world tens of minutes in the past, `packages/world-model` would age all of them to
 * `expired`, and the snapshot handed to the coach would render as an empty match — which is exactly
 * what a developer would then report as "the rehearsal shows nothing".
 *
 * So the recording is *slid* rather than *stretched*: the last line lands on `now` and every earlier
 * one keeps its recorded distance behind it. The relative ages inside the state are the ones the
 * recording captured, and the whole thing is as fresh as a live match's last POST.
 */
function feed(world: WorldModelStore, state: MockState, now: number): void {
  const lines = state.lines;
  const first = lines[0];
  const last = lines[lines.length - 1];
  if (first === undefined || last === undefined) return;

  const span = Math.max(0, last.atMs - first.atMs);
  const clock = createManualClock(now - span);
  const source = createFakeGsiSource({ lines, clock, speed: 0, sourceId: 'mock-gsi' });

  // `FakeGsiSource` is the same parser, liveness and clock estimator the live listener uses — the
  // fake is the HTTP layer's absence and nothing else (`@riki/gsi/testing`). So a mock state is
  // fused by the production path, which is the only version of this worth having: a rehearsal
  // against a world assembled some other way would be a rehearsal against a different app.
  const stop = source.subscribe((observation: Observation) => {
    world.apply(observation, observation.receivedAt);
  });

  // `step()` emits one line and stamps it with whatever the clock says at that instant, so the
  // cursor is moved between steps rather than the source being driven on a timer.
  for (const line of lines) {
    clock.set(now - span + (line.atMs - first.atMs));
    source.step();
  }

  stop();
}
