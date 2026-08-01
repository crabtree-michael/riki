/**
 * Replay the committed fixtures through a real session.
 *
 * The unit tests build their events inline, which keeps them readable but means they only ever
 * assert against shapes this package already believes in. These files are the other direction:
 * a corpus that a future recording can be added to, and that will fail loudly if the wire
 * vocabulary drifts (REPO_SKELETON.md §5.2 — every external input has a fixture and a fake).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RealtimeSession, type SessionEvent } from '../src/index.js';
import { FakeClock, FakeRealtimeTransport } from '../src/testing/index.js';
import type { SessionConfig } from '../src/index.js';

const CONFIG: SessionConfig = {
  model: 'gpt-realtime-2.1-mini',
  voice: 'marin',
  instructions: 'You are Riki.',
  tools: [],
  turnDetection: null,
  noiseReduction: 'near_field',
};

function loadFixture(name: string): readonly unknown[] {
  const path = fileURLToPath(new URL(`../../../fixtures/realtime/${name}`, import.meta.url));
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as unknown);
}

async function replay(name: string) {
  const transport = new FakeRealtimeTransport();
  const clock = new FakeClock(1000);
  const session = new RealtimeSession({ transport, config: CONFIG, now: clock.now });
  const events: SessionEvent[] = [];
  session.on((event) => events.push(event));
  await session.connect();
  transport.replay(loadFixture(name));
  return { transport, clock, session, events };
}

describe('ptt-turn.jsonl', () => {
  it('produces one complete turn with both transcripts', async () => {
    const { events, session } = await replay('ptt-turn.jsonl');

    const finals = events
      .filter(
        (event): event is Extract<SessionEvent, { kind: 'transcript' }> =>
          event.kind === 'transcript' && event.entry.final,
      )
      .map((event) => `${event.entry.role}: ${event.entry.text}`);

    expect(finals).toEqual([
      'user: should I buy a black king bar',
      'assistant: You have the gold for it.',
    ]);
    expect(events).toContainEqual({ kind: 'turn', event: 'responseStarted' });
    expect(events).toContainEqual({ kind: 'turn', event: 'responseEnded' });
    expect(session.sessionId).toBe('sess_fixture_ptt');
  });

  it('accounts for the turn’s cost, including the cache hit', async () => {
    const { session } = await replay('ptt-turn.jsonl');
    const cost = session.cost;
    expect(cost.turns).toBe(1);
    expect(cost.cachedInputTokens).toBe(960);
    expect(cost.cacheHitRatio).toBeCloseTo(960 / 1420, 5);
    expect(cost.usd).toBeGreaterThan(0);
  });
});

describe('ptt-turn-with-tool-call.jsonl', () => {
  it('surfaces the call, then the spoken answer that follows it', async () => {
    const { events } = await replay('ptt-turn-with-tool-call.jsonl');

    const calls = events.filter(
      (event): event is Extract<SessionEvent, { kind: 'tool'; event: 'started' }> =>
        event.kind === 'tool' && event.event === 'started',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.call).toEqual({
      callId: 'call_1',
      name: 'get_timings',
      argumentsJson: '{"which":"roshan"}',
    });

    // Two responses: the one that emitted the call, and the one that spoke the result.
    expect(events.filter((e) => e.kind === 'turn' && e.event === 'responseEnded')).toHaveLength(2);
  });
});

describe('barge-in.jsonl', () => {
  it('truncates mid-answer with what the user actually heard', async () => {
    const { transport, clock, session } = await replay('barge-in.jsonl');

    clock.advance(1200);
    session.interrupt(clock.now());

    const truncates = transport.sentOfType('conversation.item.truncate');
    expect(truncates).toHaveLength(1);
    expect(truncates[0]?.item_id).toBe('item_1');
    // 1.2 s into an 8.4 s answer — plausible, and well inside what was generated.
    expect(truncates[0]?.audio_end_ms).toBe(1200);
    expect(truncates[0]?.audio_end_ms).toBeLessThan(8400);
  });
});

describe('beta-schema-session.jsonl', () => {
  it('is detected rather than silently ignored', async () => {
    /**
     * This is the fixture that exists to prove a negative. Code written against the beta names
     * does not error — it just never fires, and Riki listens, thinks, and stays silent. Without
     * this detection the only symptom is a session that never speaks.
     */
    const { events } = await replay('beta-schema-session.jsonl');

    const faults = events.filter(
      (event): event is Extract<SessionEvent, { kind: 'fault' }> => event.kind === 'fault',
    );
    expect(faults.length).toBeGreaterThan(0);
    expect(faults[0]?.fault).toMatchObject({ kind: 'protocol', persistent: true });
    expect(faults[0]?.fault.message).toMatch(/beta schema/i);
  });

  it('emits no transcript at all — the beta events must not be handled', async () => {
    const { events } = await replay('beta-schema-session.jsonl');
    expect(events.filter((event) => event.kind === 'transcript')).toHaveLength(0);
  });
});
