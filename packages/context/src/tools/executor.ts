/**
 * The executor, and the invariant the whole component exists to hold.
 *
 * > **Every `callId` handed to `invoke()` produces exactly one `ToolResultMessage`, within its
 * > deadline, no matter what the handler does.**
 *
 * That is why `invoke` returns a promise that always resolves and never rejects. Nothing in the
 * design prevents a handler from hanging — a promise that never settles is always possible — so
 * the guarantee comes from outside the handler: the queue's per-call watchdog resolves a `timeout`
 * at the deadline whether or not the handler has returned, and this module wraps every remaining
 * path so that a thrown exception becomes `internal` rather than an unanswered call.
 *
 * Assumption C3 is that an unanswered function call stalls the turn. Even if C3 is wrong, the
 * model's documented behaviour under a missing result is *hallucinating one* (realtime §11.6),
 * which is worse than a timeout message. Both readings agree on this design.
 *
 * See docs/design/agent-command-execution-architecture.md §4, §7.4.
 */

import type {
  AdmissionController,
  ExecutorStats,
  PortBreaker,
  RegisteredTool,
  SubjectResolver,
  ToolCallParser,
  ToolContext,
  ToolExecutor,
  ToolQueue,
  ToolRegistry,
} from './contracts.js';
import type {
  CancelReason,
  CancelSignal,
  MonoMs,
  ParsedCall,
  PrivacyPolicy,
  RawToolCall,
  RenderContext,
  RenderedResult,
  ToolErrorCode,
  ToolFailure,
  ToolOutcome,
  ToolResultMessage,
  TurnId,
  TurnScope,
} from './types.js';
import type { ToolPorts } from './ports.js';
import type { Clock } from '../common/types.js';
import type { Turn } from './turn.js';
import type { RateLimiter } from './admission.js';
import { effectiveDeadline } from './queue.js';
import { estimateTokens } from '../render/tokens.js';
import { fail } from './failures.js';
import { resolveSubjects, subjectsFrom } from './resolve.js';

export interface ExecutorDeps {
  readonly registry: ToolRegistry;
  readonly parser: ToolCallParser;
  readonly resolver: SubjectResolver;
  readonly admission: AdmissionController;
  readonly queue: ToolQueue;
  readonly breaker: PortBreaker;
  readonly rate: RateLimiter;
  readonly ports: ToolPorts;
  readonly clock: Clock;
  readonly privacy: PrivacyPolicy;
  /** Looked up by turn id, so `cancelTurn` can reach a scope its caller still owns. */
  readonly turns: ReadonlyMap<TurnId, Turn>;
  /** Shared with the queue, which is where a late handler value is actually observed (§7.4). */
  readonly late: { count: number };
}

interface Counters {
  issued: number;
  submitted: number;
  readonly byStatus: Map<string, number>;
}

/** The codes that are evidence about a *port* rather than about the question that was asked. */
const PORT_FAILURES: ReadonlySet<ToolErrorCode> = new Set<ToolErrorCode>([
  'unavailable',
  'timeout',
]);

export function createExecutor(deps: ExecutorDeps): ToolExecutor {
  const counters: Counters = { issued: 0, submitted: 0, byStatus: new Map<string, number>() };

  const note = (status: string): void => {
    counters.byStatus.set(status, (counters.byStatus.get(status) ?? 0) + 1);
  };

  /**
   * A failure is a result. It is rendered, budgeted and submitted exactly like a success, because
   * the session cannot tell the difference and must not have to (§3.4).
   */
  const fromFailure = (
    raw: RawToolCall,
    failure: ToolFailure,
    startedAt: MonoMs,
  ): ToolResultMessage => ({
    callId: raw.callId,
    name: raw.name,
    output: failure.speakable,
    tokens: estimateTokens(failure.speakable),
    status: failure.code,
    elapsedMs: deps.clock.now() - startedAt,
  });

  const submit = (
    raw: RawToolCall,
    result: ToolResultMessage,
    scope: TurnScope,
  ): ToolResultMessage => {
    counters.submitted += 1;
    note(result.status);
    scope.noteTokens(result.tokens);
    deps.ports.telemetry.noteCall(raw.name, result.status, result.elapsedMs, result.tokens);
    return result;
  };

  /** The handler's view of the turn: the same scope, with the queue's per-call signal spliced in. */
  const contextFor = (
    call: ParsedCall,
    scope: TurnScope,
    signal: CancelSignal,
    deadlineAt: MonoMs,
  ): ToolContext => ({
    ports: deps.ports,
    callId: call.callId,
    scope: {
      turnId: scope.turnId,
      openedAt: scope.openedAt,
      deadlineAt: scope.deadlineAt,
      signal,
      memo: scope.memo,
      spentTokens: () => scope.spentTokens(),
      noteTokens: (n: number) => {
        scope.noteTokens(n);
      },
    },
    now: deps.clock.now(),
    deadlineAt,
  });

  /**
   * Run a handler so it cannot escape as an exception, and teach the breaker what happened.
   *
   * The breaker learns from this and only this: `unavailable` or `timeout` is evidence about the
   * port the command needed; anything else — including a bad argument — is evidence the port is
   * alive and says nothing about its health.
   */
  const runHandler = async (
    tool: RegisteredTool,
    args: unknown,
    ctx: ToolContext,
  ): Promise<ToolOutcome<unknown>> => {
    try {
      const outcome = await tool.execute(args, ctx);
      const bad = !outcome.ok && PORT_FAILURES.has(outcome.failure.code);
      for (const port of tool.needs) deps.breaker.note(port, bad ? 'fail' : 'ok', deps.clock.now());
      return outcome;
    } catch (error) {
      for (const port of tool.needs) deps.breaker.note(port, 'fail', deps.clock.now());
      return {
        ok: false,
        failure: fail('internal', {
          detail: `${tool.name}: ${error instanceof Error ? error.message : String(error)}`,
        }),
      };
    }
  };

  async function pipeline(
    raw: RawToolCall,
    call: ParsedCall,
    tool: RegisteredTool,
    scope: TurnScope,
    startedAt: MonoMs,
    /** This call's own eventual result, published to the memo if it becomes the owner. */
    joinable: Promise<ToolResultMessage>,
    claim: () => void,
  ): Promise<ToolResultMessage> {
    // ---- §4.4 admit ------------------------------------------------------------------------
    const admission = deps.admission.admit(call, scope, deps.clock.now());

    if (admission.verdict === 'refuse') {
      return submit(raw, fromFailure(raw, admission.failure, startedAt), scope);
    }

    if (admission.verdict === 'serve_memo') {
      const inflight = scope.memo.inflight(admission.fingerprint);
      const earlier =
        inflight === undefined ? scope.memo.get(admission.fingerprint) : await inflight;
      if (earlier !== undefined) {
        // Re-stamped so it answers *this* call, and charged zero tokens: the turn already paid for
        // this text once, and charging it twice would refuse a later command for nothing.
        counters.submitted += 1;
        note(earlier.status);
        deps.ports.telemetry.noteCall(raw.name, earlier.status, earlier.elapsedMs, 0);
        return { ...earlier, callId: raw.callId, name: raw.name };
      }
    }

    // Registered *here*: after admission has decided this call will do the work, and before the
    // first `await` on the way to doing it.
    //
    // Not earlier, which is the mistake this ordering exists to avoid — admission's first check is
    // the memo, so a call that published itself before being admitted would match its own entry and
    // await its own result. Everything from `invoke` to this line is synchronous, so a duplicate
    // arriving in a later microtask still finds the entry and joins (§6.4).
    scope.memo.begin(call.fingerprint, joinable);
    claim();

    if (admission.verdict === 'consent') {
      const decision = await deps.ports.consent.request(admission.request, scope.signal);
      if (decision !== 'granted') {
        // `expired` is counted distinctly from `denied` — a prompt nobody noticed produced no
        // refusal, and recording it as one would poison any future "they always say no" heuristic.
        // Both say the same thing out loud, because neither is the player's fault (§5.4).
        note(decision === 'expired' ? 'consent_expired' : 'consent_denied');
        return submit(
          raw,
          fromFailure(raw, fail('consent_denied', { detail: decision }), startedAt),
          scope,
        );
      }
    }

    // ---- §4.5 execute ----------------------------------------------------------------------
    const deadlineAt = effectiveDeadline(
      deps.clock.now(),
      tool.limits.deadlineMs,
      scope.deadlineAt,
    );

    const outcome = await deps.queue.enqueue<ToolOutcome<unknown>>({
      call,
      effect: tool.effect,
      scope,
      deadlineAt,
      run: async (signal) => {
        // The rate clock ticks when the work happens, not when it was admitted: a denied consent
        // never reaches here, but a barge-in after a capture does — the screen *was* read, and
        // pretending otherwise would let a barge-in loop sidestep the cap (§6.5).
        deps.rate.noteUse(tool.name, call.turnId, deps.clock.now());
        return runHandler(tool, call.args, contextFor(call, scope, signal, deadlineAt));
      },
    });

    if (!outcome.ran) return submit(raw, fromFailure(raw, outcome.failure, startedAt), scope);
    if (!outcome.value.ok) {
      return submit(raw, fromFailure(raw, outcome.value.failure, startedAt), scope);
    }

    // ---- §4.6 render -----------------------------------------------------------------------
    const renderCtx: RenderContext = {
      now: deps.clock.now(),
      clock: deps.ports.world.snapshot(deps.clock.now()).clock,
      maxTokens: tool.limits.maxResultTokens,
      privacy: deps.privacy,
    };

    let rendered: RenderedResult;
    try {
      rendered = tool.render(outcome.value.value, renderCtx);
    } catch (error) {
      return submit(
        raw,
        fromFailure(
          raw,
          fail('internal', {
            detail: `${tool.name} renderer: ${error instanceof Error ? error.message : 'threw'}`,
          }),
          startedAt,
        ),
        scope,
      );
    }

    return submit(
      raw,
      {
        callId: raw.callId,
        name: raw.name,
        output: rendered.text,
        tokens: rendered.tokens,
        status: 'ok',
        elapsedMs: deps.clock.now() - startedAt,
      },
      scope,
    );
  }

  return {
    async invoke(raw: RawToolCall, scope: TurnScope): Promise<ToolResultMessage> {
      counters.issued += 1;
      const startedAt = deps.clock.now();

      let publish: ((result: ToolResultMessage) => void) | undefined;
      const joinable = new Promise<ToolResultMessage>((resolve) => {
        publish = resolve;
      });

      let result: ToolResultMessage;
      // Set only if this call became the owner of its fingerprint. A refused or memo-served call
      // must not overwrite the memo: memoising a `rate_limited` would answer the rest of the turn
      // with a refusal that was only ever true once.
      let owned: ParsedCall['fingerprint'] | undefined;

      try {
        // ---- §4.2 parse --------------------------------------------------------------------
        const parsed = deps.parser.parse(raw);
        if (!parsed.ok) {
          result = submit(raw, fromFailure(raw, parsed.failure, startedAt), scope);
        } else {
          const tool = deps.registry.lookup(parsed.value.name);
          if (tool === undefined) {
            result = submit(
              raw,
              fromFailure(raw, fail('unknown_tool', { detail: raw.name }), startedAt),
              scope,
            );
          } else {
            // ---- §4.3 validate the subject -------------------------------------------------
            // The draft comes from the snapshot, not from a list. That is the whole stage.
            const roster = deps.ports.world.snapshot(deps.clock.now()).roster();
            const resolved = resolveSubjects(
              parsed.value,
              tool,
              deps.resolver,
              subjectsFrom(roster),
            );

            if (!resolved.ok) {
              result = submit(raw, fromFailure(raw, resolved.failure, startedAt), scope);
            } else {
              // The fingerprint is only knowable after resolution: `sf` and `shadow fiend` are the
              // same question and must share one (§6.4).
              const fingerprint = resolved.value.fingerprint;
              result = await pipeline(raw, resolved.value, tool, scope, startedAt, joinable, () => {
                owned = fingerprint;
              });
            }
          }
        }
      } catch (error) {
        // `internal` is the row that makes the total-function rule true rather than aspirational.
        // It should never appear, which is exactly what makes a non-zero rate a useful alert.
        result = submit(
          raw,
          fromFailure(
            raw,
            fail('internal', {
              detail: `${raw.name}: ${error instanceof Error ? error.message : String(error)}`,
            }),
            startedAt,
          ),
          scope,
        );
      }

      if (owned !== undefined) scope.memo.set(owned, result);
      publish?.(result);
      return result;
    },

    cancelTurn(turnId: TurnId, reason: CancelReason): void {
      deps.turns.get(turnId)?.cancel(reason);
      deps.queue.cancel(turnId, reason);
      if (reason === 'match_ended') deps.rate.reset();
      else deps.rate.endTurn(turnId);
    },

    stats(): ExecutorStats {
      return {
        issued: counters.issued,
        submitted: counters.submitted,
        byStatus: new Map(counters.byStatus),
        lateHandlerValues: deps.late.count,
      };
    },
  };
}
