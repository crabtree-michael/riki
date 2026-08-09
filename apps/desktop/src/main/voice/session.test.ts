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
import type { VoiceDirective, VoiceUpdate } from '@riki/protocol';
import { voiceUpdates } from '@riki/protocol';
import { ApiKey } from '@riki/realtime';
import type { VoiceEvent } from '@riki/realtime';
import type { MonoMs } from '@riki/world-model';

import { createVoiceSession, resetVoiceTurnIds } from './session.js';
import type { VoiceSession } from './session.js';
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

function fakeWindows(): VoiceWindowFactory & { readonly window: FakeWindow } {
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
    send: (directive) => sent.push(directive),
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

function build(apiKey: ApiKey | null, fetchImpl = mintingFetch(MINTED)) {
  const windows = fakeWindows();
  const events: VoiceEvent[] = [];
  const session: VoiceSession = createVoiceSession({
    config: config(apiKey),
    windows,
    clock: { now: (): MonoMs => clockNow as MonoMs },
    safetyIdentifier: 'install-hash',
    fetch: fetchImpl.fn,
  });
  session.onEvent((event) => events.push(event));
  return { session, windows, events, fetchImpl };
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
