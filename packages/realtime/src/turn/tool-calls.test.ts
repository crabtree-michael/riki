import { describe, expect, it } from 'vitest';
import { ToolCallAccumulator } from './tool-calls.js';

describe('ToolCallAccumulator', () => {
  it('joins deltas into the argument string', () => {
    const accumulator = new ToolCallAccumulator();
    accumulator.delta('call_1', 'get_enemy_detail', '{"hero"');
    accumulator.delta('call_1', null, ':"sf"}');
    expect(accumulator.done('call_1', '')).toEqual({
      callId: 'call_1',
      name: 'get_enemy_detail',
      argumentsJson: '{"hero":"sf"}',
    });
  });

  it('prefers the complete string on the done event', () => {
    // The deltas can be lossy; `arguments` on `done` is authoritative.
    const accumulator = new ToolCallAccumulator();
    accumulator.delta('call_1', 'get_timings', '{"par');
    expect(accumulator.done('call_1', '{"partial":false}')?.argumentsJson).toBe(
      '{"partial":false}',
    );
  });

  it('does not parse the JSON — that belongs to @riki/context', () => {
    /**
     * agent-command-execution-architecture.md §1.1 draws this line: this package never sees a
     * hero name, and that component never sees a wire event. Parsing here would turn a
     * malformed-argument failure — which has a defined home in the other component's failure
     * taxonomy — into a wire fault that kills the session.
     */
    const accumulator = new ToolCallAccumulator();
    accumulator.delta('call_1', 'get_timings', 'not json at all');
    expect(() => accumulator.done('call_1', 'not json at all')).not.toThrow();
    expect(accumulator.done('call_2', '{{{')).toBeNull();
  });

  it('keeps concurrent calls apart', () => {
    // Open question 10 in docs/README.md asks whether the API emits more than one call per
    // response. Until that is settled, interleaving must not corrupt either call.
    const accumulator = new ToolCallAccumulator();
    accumulator.delta('call_a', 'get_timings', '{"a"');
    accumulator.delta('call_b', 'get_enemy_detail', '{"b"');
    accumulator.delta('call_a', null, ':1}');
    accumulator.delta('call_b', null, ':2}');

    expect(accumulator.done('call_a', '')?.argumentsJson).toBe('{"a":1}');
    expect(accumulator.done('call_b', '')?.argumentsJson).toBe('{"b":2}');
  });

  it('captures the name from the first delta and keeps it', () => {
    const accumulator = new ToolCallAccumulator();
    accumulator.delta('call_1', 'get_timings', '{');
    accumulator.delta('call_1', null, '}');
    expect(accumulator.done('call_1', '')?.name).toBe('get_timings');
  });

  it('drops a call with no name rather than inventing one', () => {
    // An invented name surfaces as an unknown-command error two layers away from the problem.
    const accumulator = new ToolCallAccumulator();
    accumulator.delta('call_1', null, '{}');
    expect(accumulator.done('call_1', '{}')).toBeNull();
  });

  it('clears in-flight calls on barge-in, so a recycled id inherits nothing', () => {
    const accumulator = new ToolCallAccumulator();
    accumulator.delta('call_1', 'get_timings', '{"stale"');
    expect(accumulator.pending).toBe(1);

    accumulator.clear();
    expect(accumulator.pending).toBe(0);
    expect(accumulator.done('call_1', '{"fresh":1}')).toBeNull();
  });

  it('forgets a call once it is done, so nothing accumulates across a match', () => {
    const accumulator = new ToolCallAccumulator();
    accumulator.delta('call_1', 'get_timings', '{}');
    accumulator.done('call_1', '{}');
    expect(accumulator.pending).toBe(0);
  });
});
