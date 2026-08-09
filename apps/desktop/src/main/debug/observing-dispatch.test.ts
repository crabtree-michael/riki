/**
 * The tool-call decorator: what it reports, and what it must not change.
 *
 * The second half is the one worth having a test for. ADR-0032's rule is that the inspector can be
 * on without moving what it measures, and a decorator on the path a spoken answer runs through is
 * the easiest place in the codebase to break that — one swallowed rejection and a failed tool
 * becomes silence instead of the degraded answer `packages/realtime` builds from it.
 */

import { describe, expect, it, vi } from 'vitest';
import type { ToolDispatcher } from '@riki/realtime';

import { DEBUG_LIMITS } from '../../shared/debug.js';
import type { DebugToolCallInput, DebugToolResultInput } from './contracts.js';
import { observeToolCalls } from './observing-dispatch.js';

// -------------------------------------------------------------------------------------------

interface Recorded {
  readonly calls: DebugToolCallInput[];
  readonly results: { seq: number; result: DebugToolResultInput }[];
}

/**
 * A dispatcher that answers with whatever it is given, and a recorder in place of the hub.
 *
 * `clock` advances by 5 ms on every read, so a duration is a count of reads rather than a number
 * somebody has to keep in step with the assertions.
 */
function harness(answer: () => Promise<unknown>): {
  dispatcher: ToolDispatcher;
  recorded: Recorded;
} {
  const recorded: Recorded = { calls: [], results: [] };
  let now = 1_000;

  const delegate = {
    call: vi.fn(async () => answer()),
  } as unknown as ToolDispatcher;

  const dispatcher = observeToolCalls({
    delegate,
    now: () => {
      now += 5;
      return now;
    },
    onCall: (call) => {
      recorded.calls.push(call);
      return recorded.calls.length;
    },
    onResult: (seq, result) => void recorded.results.push({ seq, result }),
  });

  return { dispatcher, recorded };
}

// -------------------------------------------------------------------------------------------

describe('observing a tool call', () => {
  it('returns the dispatcher’s answer unchanged', async () => {
    const answer = { hero: { value: 'riki', age_seconds: 0.2, confidence: 1, source: 'gsi' } };
    const { dispatcher } = harness(() => Promise.resolve(answer));

    // The whole of ADR-0032 in one assertion: the same object, not an equal one. Anything that
    // reshaped a result on the way past would be the inspector changing what the model reads.
    await expect(dispatcher.call('my_state', {})).resolves.toBe(answer);
  });

  it('records the call with its arguments before the answer arrives', async () => {
    const { dispatcher, recorded } = harness(() => Promise.resolve({}));

    await dispatcher.call('enemy', { hero: 'puck' });

    expect(recorded.calls).toEqual([{ name: 'enemy', args: '{"hero":"puck"}', at: 1_005 }]);
    // Recorded first, answered second: a dispatcher that never returns has to leave a row behind,
    // because a hang that renders as nothing at all is how 2026-08-09's wedge stayed invisible.
    expect(recorded.results[0]?.result.at).toBeGreaterThan(recorded.calls[0]?.at ?? 0);
  });

  it('marks an answer of "nobody observed this" as unknown rather than as ok', async () => {
    const { dispatcher, recorded } = harness(() =>
      Promise.resolve({ unknown: 'never observed this match' }),
    );

    await dispatcher.call('world_at', { clock: '12:00' });

    // Not a fault — a tool answering honestly (ADR-0043) — but it is the reason an answer was
    // vague, and that question has nowhere else to be asked.
    expect(recorded.results[0]?.result.status).toBe('unknown');
  });

  it('does not read a report whose individual fields are unknown as an unknown answer', async () => {
    const { dispatcher, recorded } = harness(() =>
      Promise.resolve({ gold: { unknown: 'not observed' }, level: { value: 9 } }),
    );

    await dispatcher.call('my_state', {});

    // A top-level check, deliberately: "the tool had nothing" and "three of nine fields were
    // unknown" are different findings, and the second one is legible in the result JSON.
    expect(recorded.results[0]?.result.status).toBe('ok');
  });

  it('records a throw and re-throws it', async () => {
    const { dispatcher, recorded } = harness(() => Promise.reject(new Error('no scoreboard yet')));

    // Re-thrown, and this is not tidiness: `packages/realtime` turns a failed call into a degraded
    // answer rather than a dead turn. Swallowing it here would change what the player hears from
    // the one component that is supposed to change nothing.
    await expect(dispatcher.call('economy', {})).rejects.toThrow('no scoreboard yet');

    expect(recorded.results[0]?.result.status).toBe('failed');
    expect(recorded.results[0]?.result.result).toContain('no scoreboard yet');
  });

  it('bounds a result before it reaches the frame', async () => {
    const { dispatcher, recorded } = harness(() =>
      Promise.resolve({ note: 'x'.repeat(DEBUG_LIMITS.toolResultChars * 2) }),
    );

    await dispatcher.call('objectives', {});

    // The hub clips again on the way in. This one is here because the string is built here, and a
    // megabyte of JSON crossing the process boundary four times a second is a cost paid before
    // anything downstream gets a chance to refuse it.
    expect(recorded.results[0]?.result.result.length).toBeLessThanOrEqual(
      DEBUG_LIMITS.toolResultChars + 1,
    );
  });
});
