/**
 * The committed corpus, replayed through a real session.
 *
 * The unit tests build their events inline, which keeps them readable but means they only ever
 * assert against shapes this package already believes in. These files are the other direction: a
 * corpus a future recording can be added to, which fails loudly if the wire vocabulary drifts.
 *
 * `REQUIRED_FIXTURES` names what has to exist. The first test asserts the set is complete, so a
 * missing recording is a failure here rather than a surprise three tasks later.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createRealtimeSession } from '../src/session.js';
import { createFakeRealtimeTransport, FakeClock, REQUIRED_FIXTURES } from '../src/testing/index.js';
import { parseServerEvent } from '../src/wire.js';
import { resetTurnIds } from '../src/turn.js';
import type { FixtureSession } from '../src/testing/index.js';
import type { RealtimeSessionConfig } from '../src/session-config.js';
import type { MonoMs, SessionId, VoiceEvent, VoiceTelemetry } from '../src/types.js';

const CONFIG: RealtimeSessionConfig = {
  model: 'gpt-realtime-2.1-mini',
  voice: 'marin',
  instructions: '',
  turnDetection: {
    kind: 'server_vad',
    createResponse: false,
    interruptResponse: true,
    silenceDurationMs: 200,
  },
  noiseReduction: 'near_field',
  transcription: { model: 'gpt-4o-mini-transcribe', language: 'en' },
  truncation: { mode: 'auto', retentionRatio: 0.8 },
};

function loadFixture(name: string): FixtureSession {
  const path = fileURLToPath(new URL(`../../../fixtures/realtime/${name}`, import.meta.url));
  const events = readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => parseServerEvent(JSON.parse(line), 0 as MonoMs));
  return { name, events };
}

/** Narrows a `VoiceEvent` stream to final transcripts, which most of these assertions want. */
function finalTranscripts(events: readonly VoiceEvent[]): { role: string; text: string }[] {
  return events
    .filter(
      (event): event is Extract<VoiceEvent, { kind: 'transcript' }> => event.kind === 'transcript',
    )
    .filter((event) => event.final)
    .map((event) => ({ role: event.role, text: event.text }));
}

/**
 * Spies kept beside the sink rather than reached for through it.
 *
 * `VoiceTelemetry` declares its members as methods, so `expect(telemetry.fault)` — and even a
 * destructure of it — is an unbound method access. Holding the `vi.fn()`s separately sidesteps
 * that without weakening the rule anywhere it matters.
 */
function telemetrySpies() {
  const spies = {
    turnLatency: vi.fn(),
    truncation: vi.fn(),
    windowDrop: vi.fn(),
    fault: vi.fn(),
    cost: vi.fn(),
    selfInterruption: vi.fn(),
    strayToolCall: vi.fn(),
  };
  const sink: VoiceTelemetry = {
    turnLatency: spies.turnLatency,
    truncation: spies.truncation,
    windowDrop: spies.windowDrop,
    fault: spies.fault,
    cost: spies.cost,
    selfInterruption: spies.selfInterruption,
    strayToolCall: spies.strayToolCall,
  };
  return { spies, sink };
}

async function replay(name: string) {
  resetTurnIds();
  const transport = createFakeRealtimeTransport();
  const clock = new FakeClock(1000);
  const events: VoiceEvent[] = [];
  const { spies, sink } = telemetrySpies();
  let captureOpen = false;

  const session = await createRealtimeSession(
    {
      transport,
      credentials: {
        acquire: () =>
          Promise.resolve({
            value: 'ek',
            expiresAt: 60_000 as MonoMs,
            sessionId: 'sess' as SessionId,
          }),
      },
      capture: {
        open: () => {
          captureOpen = true;
        },
        close: () => {
          captureOpen = false;
        },
        get isOpen() {
          return captureOpen;
        },
      },
      playback: { audibleMs: () => 1200 },
      clock: { now: clock.now, schedule: (_ms, fire) => (fire(), () => undefined) },
      telemetry: sink,
    },
    { preambleText: 'You are Riki.' },
    CONFIG,
  );

  session.onEvent((event) => events.push(event));
  await transport.play(loadFixture(name));

  return { session, events, transport, telemetry: spies };
}

describe('the corpus is complete', () => {
  it.each(REQUIRED_FIXTURES)('%s exists and parses', (name) => {
    const fixture = loadFixture(name);
    expect(fixture.events.length).toBeGreaterThan(0);
  });

  it('contains no beta event names outside the fixture that exists to catch them', () => {
    for (const name of REQUIRED_FIXTURES) {
      const betaEvents = loadFixture(name).events.filter(
        (event) => event.type === 'error' && event.code === 'beta-schema',
      );
      expect(betaEvents, `${name} carries beta event names`).toEqual([]);
    }
  });
});

describe('ptt-turn.jsonl', () => {
  it('produces both transcripts and a completed turn', async () => {
    const { events } = await replay('ptt-turn.jsonl');

    expect(finalTranscripts(events).map((entry) => `${entry.role}: ${entry.text}`)).toEqual([
      'player: should I buy a black king bar',
      'agent: You have the gold for it.',
    ]);
    expect(events.some((event) => event.kind === 'turn' && event.event === 'responseEnded')).toBe(
      true,
    );
  });

  it('accounts for the turn, cache included', async () => {
    const { session } = await replay('ptt-turn.jsonl');
    const cost = session.cost.snapshot();
    expect(cost.turns).toBe(1);
    expect(cost.cachedFraction).toBeCloseTo(960 / 1400, 5);
  });
});

describe('barge-in.jsonl', () => {
  it('reports self-interruption, because the gate was shut when speech started', async () => {
    // The player's key was not down in this recording, so `speech_started` can only be Riki
    // hearing itself — the loop in research §11.5.
    const { telemetry: tel } = await replay('barge-in.jsonl');
    expect(tel.selfInterruption).toHaveBeenCalled();
  });

  it('lands the truncated transcript, not the sentence the model planned', async () => {
    const { events } = await replay('barge-in.jsonl');
    expect(finalTranscripts(events).at(-1)?.text).toBe('You should really consider backing');
  });
});

describe('stray-function-call.jsonl', () => {
  it('counts the call, answers nothing, and lets the turn finish', async () => {
    // The session is configured with `tools: []`, so this event should never arrive. When it does
    // — realtime §11.6 records the model narrating calls it did not make — the only correct
    // response is a counter. Answering would put a `function_call_output` item into a conversation
    // that contains no call (coaching-architecture.md §2.4).
    const { events, transport, telemetry: tel } = await replay('stray-function-call.jsonl');

    expect(tel.strayToolCall).toHaveBeenCalledWith('read_screen');
    expect(transport.sent().filter((event) => event.type === 'conversation.item.create')).toEqual(
      [],
    );
    // And the turn still ends, which is the property that makes ignoring safe: with nothing
    // awaited, there is nothing to stall.
    expect(events.some((event) => event.kind === 'turn' && event.event === 'responseEnded')).toBe(
      true,
    );
  });
});

describe('mid-response-disconnect.jsonl', () => {
  it('raises a retryable session-lost fault rather than hanging', async () => {
    // The turn never ends. Without the fault this is a session that is simply never heard from
    // again, which is the hardest bug class in this component to reproduce.
    const { events } = await replay('mid-response-disconnect.jsonl');
    expect(events.filter((event) => event.kind === 'fault')).toMatchObject([
      { fault: { kind: 'session-lost', retryable: true } },
    ]);
    expect(events.some((event) => event.kind === 'turn' && event.event === 'responseEnded')).toBe(
      false,
    );
  });
});

describe('context-exhaustion.jsonl', () => {
  it('records the usage that got us there, and surfaces the truncation as a fault', async () => {
    const { session, events } = await replay('context-exhaustion.jsonl');
    expect(session.window.usage()?.reportedTokens).toBe(27_320);
    expect(events.filter((event) => event.kind === 'fault')).toHaveLength(1);
  });

  it('shows the cache busted — the reason this is a bug and not a condition', async () => {
    const { session } = await replay('context-exhaustion.jsonl');
    expect(session.cost.snapshot().cachedFraction).toBe(0);
  });
});

describe('long-session-25min.jsonl', () => {
  it('runs 75 turns without losing count', async () => {
    const { session } = await replay('long-session-25min.jsonl');
    expect(session.cost.snapshot().turns).toBe(75);
  });

  it('keeps the cached fraction high, which is the only cost number that matters', async () => {
    const { session } = await replay('long-session-25min.jsonl');
    expect(session.cost.snapshot().cachedFraction).toBeGreaterThan(0.7);
  });

  it('stays under the per-match budget at mini rates', async () => {
    // §5.8's worked example: a well-cached 40-minute match should land nowhere near $1.00.
    const { session } = await replay('long-session-25min.jsonl');
    expect(session.cost.snapshot().usd).toBeLessThan(1);
  });
});

describe('beta-schema-session.jsonl', () => {
  it('is detected rather than silently ignored', async () => {
    const { events } = await replay('beta-schema-session.jsonl');
    const faults = events.filter((event) => event.kind === 'fault');
    expect(faults.length).toBeGreaterThan(0);
    expect(faults[0]?.fault.persistent).toBe(true);
  });

  it('emits no transcript — the beta events must not be handled', async () => {
    const { events } = await replay('beta-schema-session.jsonl');
    expect(events.filter((event) => event.kind === 'transcript')).toEqual([]);
  });
});
