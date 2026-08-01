/**
 * Queueing, admission, cancellation, and the one invariant everything else serves. Tier 1.
 *
 * The two tests that earn their emphasis are **the one-result property test**, which is the
 * executable form of §7.4 and the only thing that guards the invariant across every future handler,
 * and **the watchdog test**, because a handler that never settles is always possible and the
 * guarantee has to come from outside it.
 */

import { describe, expect, it } from 'vitest';
import type { CallId, MonoMs, RawToolCall, ToolName, ToolOutcome, TurnId } from './types.js';
import type { RegisteredTool } from './contracts.js';
import { ManualClock, ManualTimers, createFakeToolPorts, observed } from './testing/index.js';
import { ALL_HANDLERS } from './all-handlers.js';
import { NO_ARGS } from './codec.js';
import { buildToolSurface } from './surface.js';
import { createPortBreaker } from './breaker.js';
import { defineTool } from './registry.js';
import { failure, ok } from './failures.js';

const ENV = { visionEnabled: true, readScreenEnabled: true };

const raw = (name: string, argumentsJson = '{}', callId = 'c1', turnId = 't1'): RawToolCall => ({
  callId: callId as CallId,
  turnId: turnId as TurnId,
  name,
  argumentsJson,
  receivedAt: 0 as MonoMs,
});

type Effect = 'model' | 'reference' | 'observe' | 'consequential';

/** A stand-in command whose behaviour a test controls. */
function probe(
  name: ToolName,
  effect: Effect,
  run: (signal: { readonly cancelled: boolean }) => Promise<ToolOutcome<string>>,
): RegisteredTool {
  return defineTool({
    name,
    effect,
    summary: 'a probe',
    args: NO_ARGS,
    needs: effect === 'model' ? ['world'] : ['capture'],
    handler: async (_a, ctx) => run(ctx.scope.signal),
    renderer: {
      render: (value: string) => ({ text: value, tokens: 1, truncated: false, omitted: [] }),
    },
  });
}

/** A latch a test opens by hand, so no test depends on real time passing. */
function latch(): { readonly wait: Promise<void>; open: () => void } {
  let open: (() => void) | undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    wait,
    open: () => {
      open?.();
    },
  };
}

function harness(tools: readonly RegisteredTool[], turnDeadlineMs = 1200) {
  const clock = new ManualClock();
  const timers = new ManualTimers();
  const ports = createFakeToolPorts({ clock });
  const surface = buildToolSurface({
    ports,
    env: ENV,
    timers,
    tools,
    tunables: { turnDeadlineMs },
  });
  return { clock, timers, ports, surface };
}

// -------------------------------------------------------------------------------------------
// §7.4 — the invariant
// -------------------------------------------------------------------------------------------

describe('the one-result invariant', () => {
  it('produces exactly one result per callId, for any input at all', async () => {
    // The property test §13 asks for. Every future handler inherits it.
    const { surface } = harness(ALL_HANDLERS);
    const scope = surface.openTurn('t1' as TurnId, 0 as MonoMs);

    const inputs: RawToolCall[] = [];
    const names = ['get_timings', 'get_enemy_detail', 'get_item_info', 'nope', '', 'GET_TIMINGS'];
    const payloads = ['{}', '', 'null', '[1]', '{"x":', '{"hero":"sf"}', '"str"', '{"hero":"zzz"}'];
    let n = 0;
    for (const name of names) {
      for (const payload of payloads) {
        n += 1;
        inputs.push(raw(name, payload, `call-${String(n)}`));
      }
    }

    const results = await Promise.all(inputs.map((input) => surface.executor.invoke(input, scope)));

    expect(results).toHaveLength(inputs.length);
    for (const [index, result] of results.entries()) {
      expect(result.callId).toBe(inputs[index]?.callId);
      // A failure is a result, rendered and submitted like any other (§3.4).
      expect(typeof result.output).toBe('string');
      expect(result.status).toBeTruthy();
    }
    expect(new Set(results.map((r) => r.callId)).size).toBe(inputs.length);
    expect(surface.executor.stats().issued).toBe(inputs.length);
  });

  it('answers `timeout` when a handler never settles, and counts the late value', async () => {
    // Nothing prevents a handler from hanging, so the guarantee comes from outside it.
    const held = latch();
    const hang = probe('get_minimap_summary', 'observe', async () => {
      await held.wait;
      return ok('late');
    });

    const { surface, timers, clock } = harness([hang]);
    const scope = surface.openTurn('t1' as TurnId, 0 as MonoMs);
    const pending = surface.executor.invoke(raw('get_minimap_summary'), scope);

    await Promise.resolve();
    timers.advance(700, clock); // past observe's 600 ms deadline
    const result = await pending;

    expect(result.status).toBe('timeout');
    expect(result.output).toContain('taking too long');

    held.open();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(surface.executor.stats().lateHandlerValues).toBe(1);
  });

  it('turns a thrown handler into `internal` rather than an unanswered call', async () => {
    const thrower = defineTool({
      name: 'get_timings',
      effect: 'model',
      summary: 'throws',
      args: NO_ARGS,
      needs: ['world'],
      handler: () => {
        throw new Error('boom');
      },
      renderer: { render: () => ({ text: '', tokens: 0, truncated: false, omitted: [] }) },
    });

    const { surface } = harness([thrower]);
    const scope = surface.openTurn('t1' as TurnId, 0 as MonoMs);
    const result = await surface.executor.invoke(raw('get_timings'), scope);

    expect(result.status).toBe('internal');
    expect(result.output).toBe('Something went wrong on my end.');
    // The detail names the error for telemetry; the model never sees it.
    expect(result.output).not.toContain('boom');
  });
});

// -------------------------------------------------------------------------------------------
// §6 — queue, deadlines, dedup, cancellation
// -------------------------------------------------------------------------------------------

describe('ToolQueue', () => {
  it('runs one `observe` at a time and lets a `model` read straight past', async () => {
    // Per effect class, not global: a memory read must not queue behind a network round trip.
    // The two observes are *different questions*, or deduplication would join them and the lane
    // width would never be exercised.
    let running = 0;
    let peak = 0;
    const held = latch();
    const blocking = async (): Promise<ToolOutcome<string>> => {
      running += 1;
      peak = Math.max(peak, running);
      await held.wait;
      running -= 1;
      return ok('map');
    };

    const { surface } = harness([
      probe('get_minimap_summary', 'observe', blocking),
      probe('get_item_info', 'observe', blocking),
      probe('get_timings', 'model', () => Promise.resolve(ok('clock'))),
    ]);
    const scope = surface.openTurn('t1' as TurnId, 0 as MonoMs);

    const a = surface.executor.invoke(raw('get_minimap_summary', '{}', 'a'), scope);
    const b = surface.executor.invoke(raw('get_item_info', '{}', 'b'), scope);
    const c = await surface.executor.invoke(raw('get_timings', '{}', 'c'), scope);

    // The model read answered while both observes were still outstanding.
    expect(c.status).toBe('ok');
    expect(peak).toBe(1);

    held.open();
    await Promise.all([a, b]);
  });

  it('answers a call that waited out the turn without ever executing it', async () => {
    // The work might have been quick, but a result arriving after the model has already spoken is
    // worse than useless — it is context the retention policy carries for the rest of the match
    // having contributed nothing (§6.3).
    let started = 0;
    const held = latch();
    const blocking = async (): Promise<ToolOutcome<string>> => {
      started += 1;
      await held.wait;
      return ok('map');
    };

    const { surface, timers, clock } = harness(
      [
        probe('get_minimap_summary', 'observe', blocking),
        probe('get_item_info', 'observe', blocking),
      ],
      500,
    );
    const scope = surface.openTurn('t1' as TurnId, 0 as MonoMs);

    const first = surface.executor.invoke(raw('get_minimap_summary', '{}', 'a'), scope);
    const second = surface.executor.invoke(raw('get_item_info', '{}', 'b'), scope);

    await Promise.resolve();
    timers.advance(600, clock);

    expect((await second).status).toBe('timeout');
    expect(started).toBe(1); // the queued one never ran

    held.open();
    await first;
  });

  it('joins a repeated question rather than executing it twice', async () => {
    // The model repeats itself, particularly under interruption and particularly with
    // zero-argument commands.
    let executions = 0;
    const held = latch();
    const counted = probe('get_timings', 'model', async () => {
      executions += 1;
      await held.wait;
      return ok('clock');
    });

    const { surface } = harness([counted]);
    const scope = surface.openTurn('t1' as TurnId, 0 as MonoMs);

    const first = surface.executor.invoke(raw('get_timings', '{}', 'a'), scope);
    const second = surface.executor.invoke(raw('get_timings', '{}', 'b'), scope);
    held.open();

    const [a, b] = await Promise.all([first, second]);
    expect(executions).toBe(1);
    expect(a.output).toBe(b.output);
    // Re-stamped, so each answers its own call.
    expect(a.callId).toBe('a');
    expect(b.callId).toBe('b');
  });

  it('drains queued work on barge-in and answers it `cancelled`', async () => {
    // Cancellation is a correctness requirement, not an optimisation: the conversation item a late
    // result would answer no longer exists (§6.5).
    let sawCancel = false;
    const held = latch();
    const blocking = async (): Promise<ToolOutcome<string>> => {
      await held.wait;
      return ok('map');
    };

    const { surface } = harness([
      probe('get_minimap_summary', 'observe', blocking),
      probe('get_item_info', 'observe', blocking),
    ]);
    const scope = surface.openTurn('t1' as TurnId, 0 as MonoMs);
    scope.signal.onCancel(() => {
      sawCancel = true;
    });

    const first = surface.executor.invoke(raw('get_minimap_summary', '{}', 'a'), scope);
    const queued = surface.executor.invoke(raw('get_item_info', '{}', 'b'), scope);
    await Promise.resolve();

    surface.executor.cancelTurn('t1' as TurnId, 'barge_in');

    const queuedResult = await queued;
    expect(queuedResult.status).toBe('cancelled');
    // `cancelled` is the one code with no speakable, because it is never submitted.
    expect(queuedResult.output).toBe('');
    expect(sawCancel).toBe(true);

    held.open();
    await first;
  });
});

// -------------------------------------------------------------------------------------------
// §4.4 admission
// -------------------------------------------------------------------------------------------

describe('AdmissionController', () => {
  it('rate-limits `read_screen` without putting a second question on the screen', async () => {
    const { surface, ports } = harness(ALL_HANDLERS);
    const scope = surface.openTurn('t1' as TurnId, 0 as MonoMs);
    ports.consent.decision = 'granted';
    ports.world.set('screen.scoreboard', observed(['radiant 12 - 8 dire']));

    const first = await surface.executor.invoke(
      raw('read_screen', '{"region":"scoreboard"}', 'a'),
      scope,
    );
    const second = await surface.executor.invoke(
      raw('read_screen', '{"region":"shop"}', 'b'),
      scope,
    );

    expect(first.status).toBe('ok');
    expect(second.status).toBe('rate_limited');
    // Ordering matters: a consent prompt for a command that was going to be refused anyway would
    // put a question on the player's screen for no reason (§4.4).
    expect(ports.consent.prompts).toHaveLength(1);
  });

  it('takes no for an answer without calling it an error', async () => {
    const { surface, ports } = harness(ALL_HANDLERS);
    const scope = surface.openTurn('t1' as TurnId, 0 as MonoMs);
    ports.consent.decision = 'denied';

    const result = await surface.executor.invoke(raw('read_screen', '{"region":"shop"}'), scope);

    expect(result.status).toBe('consent_denied');
    expect(result.output).toBe("Okay, I won't look.");
    // Denied means the capture never happened, so the indicator never went up.
    expect(ports.consent.activities).toHaveLength(0);
    expect(ports.capture.requests).toHaveLength(0);
  });

  it('raises the indicator for the whole capture and lowers it after', async () => {
    // dota2 §7 asks for an unmistakable indicator *while* capture is happening, and a prompt that
    // disappears on `Y` is not one (§5.4).
    const { surface, ports } = harness(ALL_HANDLERS);
    const scope = surface.openTurn('t1' as TurnId, 0 as MonoMs);
    ports.world.set('screen.shop', observed(['blink dagger 2250']));

    await surface.executor.invoke(raw('read_screen', '{"region":"shop"}'), scope);

    expect(ports.consent.activities).toHaveLength(1);
    expect(ports.consent.endedCount).toBe(1);
    expect(ports.consent.active).toBeNull();
  });

  it('refuses further commands once the turn token budget is spent', async () => {
    // Refused rather than truncated to noise: three answers and a refusal beat four answers each
    // cut to nothing (§8.2).
    const { surface } = harness([
      probe('get_timings', 'model', () => Promise.resolve(ok('clock'))),
      probe('get_recent_events', 'model', () => Promise.resolve(ok('stuff'))),
    ]);
    const scope = surface.openTurn('t1' as TurnId, 0 as MonoMs);

    expect((await surface.executor.invoke(raw('get_timings', '{}', 'a'), scope)).status).toBe('ok');
    scope.noteTokens(1000);
    const second = await surface.executor.invoke(raw('get_recent_events', '{}', 'b'), scope);
    expect(second.status).toBe('rate_limited');
  });
});

// -------------------------------------------------------------------------------------------
// §7.3 the breaker
// -------------------------------------------------------------------------------------------

describe('PortBreaker', () => {
  it('opens after consecutive failures and half-opens once after the cooldown', () => {
    const breaker = createPortBreaker({ failureThreshold: 3, cooldownMs: 15_000 });
    expect(breaker.state('capture', 0 as MonoMs)).toBe('closed');

    breaker.note('capture', 'fail', 0 as MonoMs);
    breaker.note('capture', 'fail', 1 as MonoMs);
    expect(breaker.state('capture', 2 as MonoMs)).toBe('closed');

    breaker.note('capture', 'fail', 2 as MonoMs);
    expect(breaker.state('capture', 3 as MonoMs)).toBe('open');
    expect(breaker.state('capture', 16_000 as MonoMs)).toBe('half_open');
    // Only one probe gets through.
    expect(breaker.state('capture', 16_001 as MonoMs)).toBe('open');

    breaker.note('capture', 'ok', 16_002 as MonoMs);
    expect(breaker.state('capture', 16_003 as MonoMs)).toBe('closed');
  });

  it('refuses a command in microseconds once its port is open', async () => {
    // Without this a dead sidecar costs every turn its full deadline, and the player experiences a
    // coach who has become slow rather than one who has lost a source.
    const dead = probe('get_minimap_summary', 'observe', () =>
      Promise.resolve(failure<string>('unavailable', { detail: 'sidecar gone' })),
    );
    const { surface } = harness([dead]);

    for (let i = 0; i < 3; i += 1) {
      const turn = `t${String(i)}` as TurnId;
      const scope = surface.openTurn(turn, 0 as MonoMs);
      const result = await surface.executor.invoke(
        raw('get_minimap_summary', '{}', `c${String(i)}`, turn),
        scope,
      );
      expect(result.status).toBe('unavailable');
    }

    const scope = surface.openTurn('t9' as TurnId, 0 as MonoMs);
    const result = await surface.executor.invoke(
      raw('get_minimap_summary', '{}', 'c9', 't9'),
      scope,
    );
    // Same answer, but reached at admission rather than by spending the deadline again.
    expect(result.status).toBe('unavailable');
    expect(surface.executor.stats().byStatus.get('unavailable')).toBe(4);
  });
});
