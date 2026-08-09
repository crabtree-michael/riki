/**
 * Tier 1 for the main half of the voice path: a full coaching turn and a full push-to-talk turn,
 * with no Electron, no renderer, no microphone and no network.
 *
 * That is possible because the only Electron in this component is `electron-window.ts`, and
 * `VoiceWindow` is a pipe. What is asserted here is everything that is main's to get right —
 * ordering, the credential, the turn ids, and the four ways a failure has to *not* propagate.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import type { RikiConfig } from '@riki/config';
import { resolveConfig } from '@riki/config';
import type { TurnId } from '@riki/context';
import { ManualTimers } from '@riki/context/testing';
import type { VoiceDirective, VoiceUpdate } from '@riki/protocol';
import { voiceUpdates } from '@riki/protocol';
import { ApiKey, createRealtimeSession } from '@riki/realtime';
import type { RealtimeSession, VoiceEvent } from '@riki/realtime';
import { createFakeRealtimeTransport } from '@riki/realtime/testing';
import type { FakeRealtimeTransport } from '@riki/realtime/testing';
import type { MonoMs } from '@riki/world-model';

import { createVoiceSession, resetVoiceTurnIds } from './session.js';
import type { RenewalOptions, VoiceSession, VoiceSessionTelemetry } from './session.js';
import type { VoiceWindow, VoiceWindowFactory } from './contracts.js';

// Low entropy on purpose: gitleaks' `generic-api-key` rule is entropy-based and a realistic-looking
// fake here fails the pre-commit gate (see the `config-secrets` skill).
const KEY = 'sk-test-aaaa-bbbb-cccc-dddd';
const SECRET = 'ek_test_secret_value';

interface FakeWindow extends VoiceWindow {
  readonly sent: VoiceDirective[];
  readonly created: number;
  push(update: VoiceUpdate): void;
  readonly isClosed: boolean;
}

function fakeWindows(
  onDirective?: (directive: VoiceDirective) => void,
): VoiceWindowFactory & { readonly window: FakeWindow } {
  const sent: VoiceDirective[] = [];
  const updateListeners = new Set<(update: VoiceUpdate) => void>();
  let created = 0;
  let isClosed = false;

  const window: FakeWindow = {
    sent,
    get created(): number {
      return created;
    },
    get isClosed(): boolean {
      return isClosed;
    },
    send: (directive) => {
      sent.push(directive);
      onDirective?.(directive);
    },
    onUpdate(listener): () => void {
      updateListeners.add(listener);
      return () => updateListeners.delete(listener);
    },
    onProblem: () => () => undefined,
    close(): void {
      isClosed = true;
    },
    push(update): void {
      for (const listener of [...updateListeners]) listener(update);
    },
  };

  return {
    window,
    create(): VoiceWindow {
      created += 1;
      return window;
    },
  };
}

function config(apiKey: ApiKey | null): RikiConfig {
  return resolveConfig({ layer: {}, dataDir: '/tmp/riki', gsiToken: 'token', apiKey });
}

/** `fetch`, as `ClientSecretBroker` sees it. No network, ever (REPO_SKELETON §5.2). */
function mintingFetch(body: unknown, ok = true, status = 200) {
  const calls: { url: string; headers: Readonly<Record<string, string>> }[] = [];
  const fn = (url: string, init: { readonly headers: Readonly<Record<string, string>> }) => {
    calls.push({ url, headers: init.headers });
    return Promise.resolve({ ok, status, text: () => Promise.resolve(JSON.stringify(body)) });
  };
  return { fn, calls };
}

const MINTED = { value: SECRET, expires_at: 0, session: { id: 'sess_1' } };

let clockNow = 1_000;

/**
 * Every telemetry call, in order, as the strings the inspector's Trace panel actually shows.
 *
 * A record rather than spies because the assertions that matter are about *what a reader would
 * see* — a renewal in the trace and nothing in Problems — and a spy call count does not say that.
 */
function recordingTelemetry() {
  const lines: string[] = [];
  const sink: VoiceSessionTelemetry = {
    speaking: () => undefined,
    fault: (kind, message) => lines.push(`fault ${kind}: ${message}`),
    state: (next) => lines.push(`state ${next}`),
    bridgeProblem: (detail) => lines.push(`bridge ${detail}`),
    renewal: (phase, reason, detail) => lines.push(`renewal ${phase} (${reason}): ${detail}`),
  };
  return { lines, sink };
}

function build(
  apiKey: ApiKey | null,
  fetchImpl = mintingFetch(MINTED),
  over: {
    timers?: ManualTimers;
    renewal?: RenewalOptions;
    telemetry?: VoiceSessionTelemetry;
    onDirective?: (directive: VoiceDirective) => void;
  } = {},
) {
  const windows = fakeWindows(over.onDirective);
  const events: VoiceEvent[] = [];
  const session: VoiceSession = createVoiceSession({
    config: config(apiKey),
    windows,
    clock: { now: (): MonoMs => clockNow as MonoMs },
    safetyIdentifier: 'install-hash',
    fetch: fetchImpl.fn,
    ...(over.timers === undefined ? {} : { timers: over.timers }),
    ...(over.renewal === undefined ? {} : { renewal: over.renewal }),
    ...(over.telemetry === undefined ? {} : { telemetry: over.telemetry }),
  });
  session.onEvent((event) => events.push(event));
  return { session, windows, events, fetchImpl };
}

/**
 * Let every pending chain settle.
 *
 * **Macrotasks, not microtasks.** A renewal is main's mint (a promise), then the directive, then —
 * in the tests that run a real session — the renderer's own open, which is several awaits deep. A
 * fixed count of `await Promise.resolve()` gets partway and passes assertions about a step that has
 * not happened yet, which is the same trap `transport.test.ts` documents for the SDP round trip.
 */
async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Ready, then drain — the shape every test below needs before a directive actually goes out. */
function ready(windows: ReturnType<typeof fakeWindows>): void {
  windows.window.push(voiceUpdates.ready());
}

beforeEach(() => {
  resetVoiceTurnIds();
  clockNow = 1_000;
});

describe('with no API key', () => {
  it('is unavailable rather than faulted — the app boots with voice off and says so', async () => {
    // ADR-0006. This is the mode CI, every fixture run and every keyless machine is in, and a
    // persistent `auth` fault here would put a permanent error on an overlay working as designed.
    const { session, events, windows } = build(null);
    await session.openMatch('preamble');

    expect(session.state).toBe('unavailable');
    expect(events).toEqual([]);
    expect(windows.window.created).toBe(0);
  });

  it('still accepts every port method, so nothing upstream has to check first', async () => {
    const { session } = build(null);
    const turnId = session.beginTurn('push', 0 as MonoMs);
    expect(turnId).toBe('voice_1');
    await expect(
      session.endTurn(turnId, 'release', { turnId, snapshotText: 'x' }),
    ).resolves.toBeUndefined();
    await expect(session.abort()).resolves.toBeUndefined();
  });
});

describe('opening a match', () => {
  it('mints a client secret and sends it, and never the key', async () => {
    const { session, windows, fetchImpl } = build(new ApiKey(KEY));
    await session.openMatch('You are Riki.');
    ready(windows);

    // The mint carries the key in an Authorization header — in *this* process, over TLS, to
    // OpenAI. That is the only place it appears (ADR-0015).
    expect(fetchImpl.calls[0]?.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(fetchImpl.calls[0]?.headers['OpenAI-Safety-Identifier']).toBe('install-hash');

    const open = windows.window.sent.find((d) => d.type === 'voice.session.open');
    expect(open).toBeDefined();
    // The property, restated at the one place that could break it: whatever crosses the bridge,
    // it is not the key. `voice-contract.test.ts` asserts the schema has no field for it; this
    // asserts the value we actually send.
    expect(JSON.stringify(windows.window.sent)).not.toContain(KEY);
    expect(JSON.stringify(open)).toContain(SECRET);
  });

  it('sends the secret as a duration, because the renderer has a different epoch', async () => {
    const { session, windows } = build(new ApiKey(KEY));
    await session.openMatch('preamble');
    ready(windows);

    const open = windows.window.sent.find((d) => d.type === 'voice.session.open');
    expect(open).toMatchObject({ secret: { expiresInMs: expect.any(Number) as number } });
    // Never negative: `Math.max(0, …)` matters because a secret can be handed over after it has
    // notionally expired, and a negative duration parses as an invalid message and is dropped.
    expect(
      open?.type === 'voice.session.open' ? open.secret.expiresInMs : -1,
    ).toBeGreaterThanOrEqual(0);
  });

  it('carries the config the player set, and the settings that are not theirs to set', async () => {
    const { session, windows } = build(new ApiKey(KEY));
    await session.openMatch('You are Riki.');
    ready(windows);

    const open = windows.window.sent.find((d) => d.type === 'voice.session.open');
    expect(open).toMatchObject({
      session: {
        model: 'gpt-realtime-2.1-mini',
        voice: 'marin',
        instructions: 'You are Riki.',
        // ADR-0017: VAD on, response creation ours. `createResponse` cannot be true — the schema
        // has no way to express it — and this is the assertion that it is not accidentally absent.
        turnDetection: { kind: 'server_vad', createResponse: false, interruptResponse: true },
      },
      // Never false on the product path (ADR-0001): without it the model hears itself.
      capture: { echoCancellation: true, preRollMs: 200 },
      transport: 'webrtc',
    });
  });

  it('turns a refused mint into a fault on the chip, not a rejected promise', async () => {
    // 401 is `auth` and is never retried in a loop — it names the environment variable instead.
    const { session, events } = build(new ApiKey(KEY), mintingFetch({}, false, 401));
    await expect(session.openMatch('preamble')).resolves.toBeUndefined();

    expect(session.state).toBe('unavailable');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'fault', fault: { kind: 'auth', retryable: false } });
  });
});

describe('the ready handshake', () => {
  it('queues every directive until the renderer says it is listening', async () => {
    // A directive sent before `voice.ready` is a message with no listener, and the failure is a
    // session that never opens and never errors — which is the whole reason the handshake exists.
    const { session, windows } = build(new ApiKey(KEY));
    await session.openMatch('preamble');
    session.beginTurn('push', 0 as MonoMs);

    expect(windows.window.sent).toEqual([]);

    ready(windows);
    expect(windows.window.sent.map((d) => d.type)).toEqual([
      'voice.session.open',
      'voice.turn.begin',
    ]);
  });
});

describe('turns', () => {
  it('allocates the turn id in main and returns it synchronously', async () => {
    // `CoachingAgent.beginPlayerTurn` returns this id and the overlay's ≤100 ms budget forbids an
    // await, so an id that had to come back from the renderer could not exist.
    const { session, windows } = build(new ApiKey(KEY));
    await session.openMatch('preamble');
    ready(windows);

    const turnId = session.beginTurn('latch', 0 as MonoMs);
    expect(turnId).toBe('voice_1');
    expect(windows.window.sent.at(-1)).toMatchObject({
      type: 'voice.turn.begin',
      turnId: 'voice_1',
      mode: 'latch',
    });
  });

  it('sends the same id back on end, which is what the renderer matches on', async () => {
    const { session, windows } = build(new ApiKey(KEY));
    await session.openMatch('preamble');
    ready(windows);

    const turnId = session.beginTurn('push', 0 as MonoMs);
    await session.endTurn(turnId, 'release', { turnId, snapshotText: 'snapshot\n\nbrief' });

    expect(windows.window.sent.at(-1)).toMatchObject({
      type: 'voice.turn.end',
      turnId,
      reason: 'release',
      snapshotText: 'snapshot\n\nbrief',
    });
  });

  it('sends a scenario turn with no capture behind it (ADR-0039)', async () => {
    const { session, windows } = build(new ApiKey(KEY));
    await session.openMatch('instructions');
    ready(windows);

    await session.speakNow({
      turnId: 'scenario_3' as TurnId,
      snapshotText: 'snapshot\n\nward the river',
    });

    expect(windows.window.sent.at(-1)).toMatchObject({
      type: 'voice.turn.speak',
      turnId: 'scenario_3',
      // The wire still carries `eventId` and `salience` — `packages/protocol` is a coordination
      // event, not this package's to change — and they are filled with what is true now that
      // ADR-0042 has deleted the detections they used to name.
      eventId: 'scenario.speak',
      salience: 1,
    });
  });

  it('resolves speakNow immediately, because the chip leaves Speaking from the events', async () => {
    // The confusion `silent-session.ts` was written to avoid: `speakNow` means *handed over*, not
    // *finished speaking*. Resolving only when the response ended would leave the overlay claiming
    // Riki is talking for the duration and make a slow model look like a hung session.
    const { session, windows } = build(new ApiKey(KEY));
    await session.openMatch('instructions');
    ready(windows);

    let resolved = false;
    await session.speakNow({ turnId: 'scenario_1' as TurnId, snapshotText: 'x' }).then(() => {
      resolved = true;
    });
    expect(resolved).toBe(true);
    // And nothing has come back from the renderer at all.
    expect(windows.window.sent.some((d) => d.type === 'voice.turn.speak')).toBe(true);
  });

  it('sends abort as a command rather than closing anything', async () => {
    const { session, windows } = build(new ApiKey(KEY));
    await session.openMatch('preamble');
    ready(windows);

    await session.abort();
    expect(windows.window.sent.at(-1)).toMatchObject({ type: 'voice.command', command: 'abort' });
  });
});

describe('events coming back', () => {
  it('stamps level frames with main’s clock, because the renderer sends none', async () => {
    // The two processes do not share a `performance.timeOrigin`. A renderer timestamp would look
    // entirely plausible and be off by however long that renderer took to start.
    const { session, windows, events } = build(new ApiKey(KEY));
    await session.openMatch('preamble');
    ready(windows);

    clockNow = 4_242;
    windows.window.push(voiceUpdates.event({ kind: 'level', source: 'input', value: 0.5 }));

    expect(events.at(-1)).toEqual({ kind: 'level', source: 'input', value: 0.5, at: 4_242 });
  });

  it('passes every other event through untouched — the adapter above is the translator', async () => {
    const { session, windows, events } = build(new ApiKey(KEY));
    await session.openMatch('preamble');
    ready(windows);

    windows.window.push(
      voiceUpdates.event({ kind: 'turn', turnId: 'voice_1', event: 'responseEnded' }),
    );
    expect(events.at(-1)).toEqual({ kind: 'turn', turnId: 'voice_1', event: 'responseEnded' });
  });

  it('tracks the renderer’s session state', async () => {
    const { session, windows } = build(new ApiKey(KEY));
    await session.openMatch('preamble');
    ready(windows);
    expect(session.state).toBe('connecting');

    windows.window.push(voiceUpdates.sessionState('ready'));
    expect(session.state).toBe('ready');
  });
});

describe('lifetime', () => {
  it('keeps the window across matches, so the next one does not pay a cold renderer start', async () => {
    const { session, windows } = build(new ApiKey(KEY));
    await session.openMatch('first');
    ready(windows);
    await session.closeMatch('match ended');
    // Past `MIN_MINT_INTERVAL_MS` — see the next test for why that matters.
    clockNow += 5_000;
    await session.openMatch('second');

    expect(windows.window.created).toBe(1);
    expect(windows.window.sent.filter((d) => d.type === 'voice.session.close')).toHaveLength(1);
    expect(windows.window.sent.filter((d) => d.type === 'voice.session.open')).toHaveLength(2);
  });

  it('reports the mint rate limit as a retryable fault rather than opening a broken session', async () => {
    // `ClientSecretBroker` refuses more than one mint per second (realtime research §12: the mint
    // path is the abuse vector). Two matches inside a second is not a real scenario, but a
    // reconnect loop is — and the honest outcome is a `degraded` chip, not a session opened with
    // a secret that was never minted.
    const { session, windows, events } = build(new ApiKey(KEY));
    await session.openMatch('first');
    ready(windows);
    await session.openMatch('second');

    expect(session.state).toBe('degraded');
    expect(events.at(-1)).toMatchObject({ kind: 'fault', fault: { retryable: true } });
    expect(windows.window.sent.filter((d) => d.type === 'voice.session.open')).toHaveLength(1);
  });

  it('closes the window on dispose and stops sending', async () => {
    const { session, windows } = build(new ApiKey(KEY));
    await session.openMatch('preamble');
    ready(windows);
    await session.dispose();

    expect(windows.window.isClosed).toBe(true);
    const before = windows.window.sent.length;
    session.beginTurn('push', 0 as MonoMs);
    expect(windows.window.sent).toHaveLength(before);
  });
});

/**
 * Renewal — ADR-0045, and the failure it repairs.
 *
 * Observed live on 2026-08-09 at 15:43:36: `session_expired`, the data channel closed, ICE
 * disconnected, and nothing reconnected. Riki was mute for the rest of a match it was still
 * nominally in.
 *
 * The first three tests here run the **real** `createRealtimeSession` over `FakeRealtimeTransport`
 * inside the fake voice window, so an expiry starts where a real one starts — on the wire — and
 * travels the whole chain: `faultFor`'s classification, the `VoiceEvent`, the bridge, and main's
 * decision to renew rather than to tell the player. A hand-written fault object here would assert
 * main's half and quietly let the two packages' idea of "retryable" drift apart, which is precisely
 * the seam the incident fell through.
 */
describe('renewing an expired session', () => {
  /**
   * A voice window that actually opens a session, the way the renderer's `host.ts` does.
   *
   * Each `voice.session.open` builds a fresh transport and session, exactly as the renderer's
   * handler does — it closes the live one and opens a new one — and reports `ready` afterwards,
   * which is main's only evidence that a renewal landed.
   */
  function voiceWindowRunningRealSessions() {
    const transports: FakeRealtimeTransport[] = [];
    const sessions: RealtimeSession[] = [];
    let push: ((update: VoiceUpdate) => void) | null = null;
    /** Serialised, because opening is several awaits deep and directives must not interleave. */
    let queue: Promise<void> = Promise.resolve();

    const openOne = async (
      directive: Extract<VoiceDirective, { type: 'voice.session.open' }>,
    ): Promise<void> => {
      await sessions.at(-1)?.close('reopening');
      const transport = createFakeRealtimeTransport();
      const session = await createRealtimeSession(
        {
          transport,
          // The renderer's is exactly this: the secret it was handed, resolved. It cannot mint —
          // that needs the `ApiKey`, which is why renewal is main's (ADR-0045).
          credentials: {
            acquire: () =>
              Promise.resolve({
                value: directive.secret.value,
                expiresAt: (clockNow + directive.secret.expiresInMs) as never,
                sessionId: directive.secret.sessionId as never,
              }),
          },
          capture: { open: () => undefined, close: () => undefined, isOpen: false },
          playback: { audibleMs: () => 0 },
          clock: { now: () => clockNow as never },
          telemetry: {
            turnLatency: () => undefined,
            truncation: () => undefined,
            windowDrop: () => undefined,
            fault: () => undefined,
            cost: () => undefined,
            selfInterruption: () => undefined,
            toolCallRejected: () => undefined,
          },
        },
        { preambleText: directive.session.instructions },
        directive.session,
      );
      session.onEvent((event) => push?.(voiceUpdates.event(event)));
      transports.push(transport);
      sessions.push(session);
      push?.(voiceUpdates.sessionState('ready'));
    };

    return {
      transports,
      onDirective: (directive: VoiceDirective): void => {
        if (directive.type !== 'voice.session.open') return;
        queue = queue.then(() => openOne(directive));
      },
      bind(to: (update: VoiceUpdate) => void): void {
        push = to;
      },
      /** Let main's mint, the directive and this renderer's own open all finish. */
      settle: async (): Promise<void> => {
        for (let i = 0; i < 4; i += 1) {
          await flush(1);
          await queue;
        }
      },
    };
  }

  async function live(renewalOptions?: RenewalOptions) {
    const renderer = voiceWindowRunningRealSessions();
    const timers = new ManualTimers();
    const { lines, sink } = recordingTelemetry();
    const built = build(new ApiKey(KEY), mintingFetch(MINTED), {
      timers,
      telemetry: sink,
      onDirective: renderer.onDirective,
      ...(renewalOptions === undefined ? {} : { renewal: renewalOptions }),
    });
    renderer.bind((update) => {
      built.windows.window.push(update);
    });

    await built.session.openMatch('You are Riki. The match is a Pudge safelane.');
    ready(built.windows);
    await renderer.settle();
    return { ...built, renderer, timers, lines };
  }

  const opens = (harness: { windows: ReturnType<typeof fakeWindows> }) =>
    harness.windows.window.sent.filter((d) => d.type === 'voice.session.open');

  it('opens a new session when the old one hits the 60-minute cap, and says nothing to the player', async () => {
    const harness = await live();
    expect(opens(harness)).toHaveLength(1);
    const faultsBefore = harness.events.filter((event) => event.kind === 'fault').length;

    // Past `MIN_MINT_INTERVAL_MS`: the second mint is nearly an hour after the first in reality.
    clockNow += 5_000;
    harness.renderer.transports[0]?.expireSession('error-first');
    await harness.renderer.settle();

    // A second session exists, and the renderer is running it.
    expect(opens(harness)).toHaveLength(2);
    expect(harness.renderer.transports).toHaveLength(2);
    expect(harness.session.state).toBe('ready');
    // And the chip saw nothing. This is the whole point: an expiry is the ordinary end of a
    // session's life, not something the player is asked to care about.
    expect(harness.events.filter((event) => event.kind === 'fault')).toHaveLength(faultsBefore);
  });

  it('shows the renewal in the inspector, in the trace and not as a problem', async () => {
    const harness = await live();
    clockNow += 5_000;
    harness.renderer.transports[0]?.expireSession('error-first');
    await harness.renderer.settle();

    expect(harness.lines).toContain(
      'renewal started (lost): Your session hit the maximum duration of 60 minutes.',
    );
    expect(harness.lines.some((line) => line.startsWith('renewal opened (lost):'))).toBe(true);
    // `fault` is the line that becomes a `DebugProblem`. A renewal that succeeded is not one.
    expect(harness.lines.filter((line) => line.startsWith('fault '))).toEqual([]);
  });

  it('renews once for one expiry, though the API signals it twice', async () => {
    // `session_expired` *and* a dead transport arrive for a single loss. Two renewals would mean a
    // second reopen — and a second cold session — for a session that was only lost once.
    const harness = await live();
    clockNow += 5_000;
    harness.renderer.transports[0]?.expireSession('close-first');
    await harness.renderer.settle();

    expect(opens(harness)).toHaveLength(2);
    expect(harness.lines.filter((line) => line.startsWith('renewal started'))).toHaveLength(1);
  });

  it('joins a renewal already running, rather than starting a second', async () => {
    // The test above goes through the real session, which already collapses `session_expired` and
    // the dead transport into one fault — so it exercises *that* guard and cannot see this one.
    // Two renewable faults are pushed straight across the bridge here, because two mechanisms
    // agreeing is only worth having if each is known to work on its own: a second renewal would
    // mint inside `MIN_MINT_INTERVAL_MS`, be refused, and back off from a session that is fine.
    const timers = new ManualTimers();
    const { lines, sink } = recordingTelemetry();
    const harness = build(new ApiKey(KEY), mintingFetch(MINTED), { timers, telemetry: sink });
    await harness.session.openMatch('preamble');
    ready(harness.windows);
    harness.windows.window.push(voiceUpdates.sessionState('ready'));

    clockNow += 5_000;
    const lost = {
      kind: 'session-lost' as const,
      message: 'gone',
      persistent: false,
      retryable: true,
    };
    harness.windows.window.push(voiceUpdates.event({ kind: 'fault', fault: lost }));
    harness.windows.window.push(voiceUpdates.event({ kind: 'fault', fault: lost }));
    await flush();

    expect(lines.filter((line) => line.startsWith('renewal started'))).toHaveLength(1);
    expect(harness.windows.window.sent.filter((d) => d.type === 'voice.session.open')).toHaveLength(
      2,
    );
  });

  it('re-sends the instructions byte-identically, which is what keeps the prefix cached', async () => {
    const harness = await live();
    clockNow += 5_000;
    harness.renderer.transports[0]?.expireSession('error-first');
    await harness.renderer.settle();

    const [first, second] = opens(harness);
    expect(second?.type === 'voice.session.open' ? second.session.instructions : null).toBe(
      first?.type === 'voice.session.open' ? first.session.instructions : undefined,
    );
    // The secret is emphatically *not* carried across: a renewal that reused it would present an
    // expired credential to the SDP exchange and fail in a way that looks like a network problem.
    expect(harness.fetchImpl.calls).toHaveLength(2);
  });

  it('renews before the cap rather than waiting to be told', async () => {
    // The reactive path is the backstop. The path that is meant to run replaces the session while
    // the old one still works, so the player never has a window in which Riki cannot answer.
    const harness = await live({ renewAfterMs: 50_000 });
    clockNow += 5_000;

    harness.timers.advance(49_000);
    expect(opens(harness)).toHaveLength(1);

    harness.timers.advance(1_500);
    await harness.renderer.settle();

    expect(opens(harness)).toHaveLength(2);
    expect(harness.lines.some((line) => line.startsWith('renewal started (age):'))).toBe(true);
    expect(harness.events.filter((event) => event.kind === 'fault')).toEqual([]);
  });

  it('does not renew a match that has ended', async () => {
    // A deadline armed against a finished match would reopen a session nobody is in, minutes
    // later, with the closed match's instructions in it.
    const harness = await live({ renewAfterMs: 50_000 });
    await harness.session.closeMatch('match ended');

    harness.timers.advance(60_000);
    await harness.renderer.settle();

    expect(opens(harness)).toHaveLength(1);
    expect(harness.timers.pending).toBe(0);
  });
});

describe('renewal that cannot succeed', () => {
  /** No renderer behind the window: directives go out and nothing ever reports `ready`. */
  async function wedged(renewalOptions: RenewalOptions) {
    const timers = new ManualTimers();
    const { lines, sink } = recordingTelemetry();
    const harness = build(new ApiKey(KEY), mintingFetch(MINTED), {
      timers,
      telemetry: sink,
      renewal: renewalOptions,
    });
    await harness.session.openMatch('preamble');
    ready(harness.windows);
    harness.windows.window.push(voiceUpdates.sessionState('ready'));
    return { ...harness, timers, lines };
  }

  it('retries a reopen the voice window never acknowledged', async () => {
    // A directive sent into a wedged renderer produces no error of any kind — the failure shape
    // this area keeps rediscovering. Without the ready deadline, a renewal that went nowhere would
    // be indistinguishable from the expiry it was meant to repair.
    const harness = await wedged({ renewAfterMs: 50_000, readyTimeoutMs: 20_000 });
    clockNow += 5_000;

    harness.timers.advance(50_000);
    await flush();
    expect(harness.windows.window.sent.filter((d) => d.type === 'voice.session.open')).toHaveLength(
      2,
    );

    clockNow += 5_000;
    harness.timers.advance(20_000);
    await flush();
    expect(harness.lines.some((line) => line.startsWith('renewal retrying'))).toBe(true);
  });

  it('tells the player once, after it has run out of attempts — and not before', async () => {
    const harness = await wedged({
      renewAfterMs: 50_000,
      readyTimeoutMs: 10_000,
      backoffMs: [2_000],
    });

    // Attempt 1 goes out and is never acknowledged; the single backoff buys attempt 2; that one is
    // not acknowledged either, and there is no third.
    for (const step of [50_000, 10_000, 2_000, 10_000]) {
      clockNow += 5_000;
      harness.timers.advance(step);
      await flush();
    }

    expect(harness.lines.some((line) => line.startsWith('renewal gaveUp'))).toBe(true);
    const faults = harness.events.filter((event) => event.kind === 'fault');
    expect(faults).toHaveLength(1);
    expect(faults[0]).toMatchObject({ fault: { kind: 'session-lost', retryable: true } });
    expect(harness.session.state).toBe('degraded');
  });
});

describe('level frames', () => {
  it('are off until something can show them (overlay §5.5)', async () => {
    const { session, windows } = build(new ApiKey(KEY));
    await session.openMatch('preamble');
    ready(windows);

    session.setLevelsEnabled(true);
    expect(windows.window.sent.at(-1)).toMatchObject({
      type: 'voice.level.enable',
      enabled: true,
    });
  });
});
