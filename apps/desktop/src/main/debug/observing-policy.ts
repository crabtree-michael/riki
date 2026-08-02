/**
 * The gate ladder, made visible — and the answer to "which state has been hardest to inspect".
 *
 * `TriggerPolicy.decide` ranks the candidates, walks the thirteen gates against the winner, and
 * returns the first refusal. Everything else it computed on the way is discarded:
 *
 * - the **losing candidates**, which never reach a gate at all (§5.5: there is no fall-through),
 * - the **twelve gates that passed** before the one that refused,
 * - and every gate's verdict on anything other than the winner.
 *
 * From outside, "Riki said nothing" is one string. `TriggerCounters` aggregates it over a whole
 * match, `onSuppressed` reports it one event at a time, and neither can answer the question anyone
 * actually has at 14:20 — *`ult_ready` was true, why did nobody hear about it?* This decorator
 * answers it by evaluating the whole ladder against every ranked candidate and reporting the grid.
 *
 * ## It cannot change the decision
 *
 * The returned value is the delegate's, byte for byte — this file never constructs a
 * `TriggerDecision`. The gates it calls are the pure functions of `packages/events`' own `GATES`
 * array, in the same order, so what it reports is what the policy would have concluded rather than
 * a second implementation that has to be kept in step. If the two ever disagreed, the delegate
 * would still win, and the inspector would be visibly wrong — which is the right way round.
 *
 * ## Cost, stated rather than assumed
 *
 * Thirteen gate calls per candidate per world-model version bump, where the policy makes at most
 * thirteen in total. Eleven of the gates are field reads; `already_advised` and `ignored_twice`
 * project the conversation ledger, which is why they are last in the ladder and why this is worth
 * naming. The engine ticks at the world model's rate (2–8 Hz from GSI) with typically one or two
 * candidates alive, so this is tens of ledger projections a second in the worst case — acceptable
 * for a dev-only switch that defaults to off, and the reason it defaults to off.
 */

import type { CoachEvent, Gate, GateContext, TriggerDecision, TriggerPolicy } from '@riki/events';
import { GATES, rank } from '@riki/events';

import type { DebugGateInput, DebugTickInput } from './contracts.js';

export interface ObservingPolicyDeps {
  /** The real policy. Its answer is returned unchanged. */
  readonly delegate: TriggerPolicy;
  readonly report: (tick: DebugTickInput) => void;
  /**
   * The ladder to evaluate. Defaults to `GATES`, which is what `createTriggerPolicy()` uses.
   *
   * Injectable only so a test can prove the report follows the ladder it is given rather than a
   * copy of it — not so the app can run two different ladders, which would be the bug this file is
   * most able to cause.
   */
  readonly gates?: readonly Gate[];
  /** The world model's version at the moment of the tick. */
  readonly worldVersion: () => number;
}

export function createObservingPolicy(deps: ObservingPolicyDeps): TriggerPolicy {
  const gates = deps.gates ?? GATES;

  return {
    decide(candidates: readonly CoachEvent[], ctx: GateContext): TriggerDecision {
      // The delegate first, and its answer is the one that leaves this function. Observing after
      // deciding also means a throw in the reporting path — which should be impossible, but this is
      // the one place in the app where "should be impossible" would silence the coach — cannot
      // happen before the decision has been made.
      const decision = deps.delegate.decide(candidates, ctx);

      // `rank` is imported rather than reimplemented: the ordering is total by design so that the
      // golden corpus is insensitive to detector order, and a second sort here would be a second
      // definition of "winner" for the inspector to disagree with the policy about.
      const ranked = rank(candidates);

      deps.report({
        at: ctx.now,
        clock: ctx.clock,
        worldVersion: deps.worldVersion(),
        gates: gateStateOf(ctx),
        candidates: ranked.map((candidate, index) => ({
          kind: candidate.kind,
          key: candidate.key,
          salience: candidate.salience,
          magnitude: candidate.detection.magnitude,
          confidence: candidate.detection.confidence,
          actWithinSeconds: candidate.detection.actWithinSeconds,
          text: candidate.detection.text,
          // The engine's own tape rule (`engine.ts`): above the floor, and past gate 1. Recomputed
          // rather than observed because the tape is written before the policy is consulted, and
          // the floor is read off `ctx.cfg` rather than injected so that it is by construction the
          // config the engine used on this tick — which since ADR-0037 is a value the Controls
          // panel can move underneath it.
          taped:
            candidate.salience >= ctx.cfg.tapeSalience &&
            !refusedBy(gates, 'not_in_match', candidate, ctx),
          ladder: gates.map((gate) => ({
            reason: gate.reason,
            refuses: safeRefuses(gate, candidate, ctx),
          })),
          rank: index === 0 ? ('winner' as const) : ('ranked-below' as const),
        })),
        decision: decision.speak
          ? { speak: true, key: decision.event.key }
          : { speak: false, reason: decision.reason, key: decision.event?.key ?? null },
      });

      return decision;
    },
  };
}

/**
 * The engine's private state, read off the context it assembles once per tick.
 *
 * This is the whole reason the policy is the right seam rather than a new `EventEngine` method: the
 * latch set, the per-kind cooldown clocks and the intensity score are not reachable from outside
 * `createEventEngine`, and they are three of the four things somebody staring at an unexplained
 * silence needs. `GateContext` already carries all of them because the gates need them too.
 */
function gateStateOf(ctx: GateContext): DebugGateInput {
  const kindCooldowns: { kind: string; remainingMs: number }[] = [];
  for (const [kind, last] of ctx.lastSpokeByKind) {
    const remaining = ctx.cfg.kindCooldownMs[kind] - (ctx.now - last);
    // Spent cooldowns are omitted rather than shown as negative: a list of eight rows that are all
    // "-412000" buries the one that is actually running.
    if (remaining > 0) kindCooldowns.push({ kind, remainingMs: Math.round(remaining) });
  }

  return {
    quietMode: ctx.quietMode,
    agentSpeaking: ctx.agentSpeaking,
    playerSpeaking: ctx.playerSpeaking,
    mutedUntilMs: ctx.mutedUntil,
    intensity: ctx.intensity,
    intensityThreshold: ctx.cfg.intensityThreshold,
    speakThreshold: ctx.cfg.speakThreshold,
    lastSpokeAtMs: ctx.lastSpokeAt,
    globalCooldownMs: ctx.cfg.globalCooldownMs,
    latched: [...ctx.latched].sort(),
    kindCooldowns: kindCooldowns.sort((a, b) => b.remainingMs - a.remainingMs),
  };
}

/**
 * A gate is specified as a pure total function, so this catch is for a bug rather than a condition.
 *
 * It is here anyway for the same reason `engine.ts` wraps its detectors: the inspector runs gates
 * the policy may never have reached — a candidate ranked below the winner is asked all thirteen
 * questions, some of which the shipping path would have short-circuited past — so this is the one
 * place in the app that can provoke a gate with an input the policy would never have given it.
 * Reporting `true` for a gate that threw reads as "refused", which is the honest direction: it
 * cannot be relied on, so it should not look like a pass.
 */
function safeRefuses(gate: Gate, candidate: CoachEvent, ctx: GateContext): boolean {
  try {
    return gate.refuses(candidate, ctx);
  } catch {
    return true;
  }
}

function refusedBy(
  gates: readonly Gate[],
  reason: string,
  candidate: CoachEvent,
  ctx: GateContext,
): boolean {
  const gate = gates.find((each) => each.reason === reason);
  return gate !== undefined && safeRefuses(gate, candidate, ctx);
}
