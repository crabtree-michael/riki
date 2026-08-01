/**
 * The guarding tests REPO_SKELETON.md §5.4 names for the key:
 *
 * > Assert the key is absent from the preload bridge surface and from anything
 * > `packages/telemetry` emits… Assert `packages/realtime` receives it injected and never reads
 * > `process.env` itself.
 *
 * The lint boundary in §6.2 covers the deliberate leak. `ApiKey` (ADR-0022) covers the accidental
 * one, which is the realistic one.
 */

import { describe, expect, it } from 'vitest';
import {
  ApiKey,
  CLIENT_SECRETS_URL,
  createClientSecretBroker,
  MIN_MINT_INTERVAL_MS,
  parseClientSecret,
  type FetchLike,
  type RequestInitLike,
} from './credentials.js';
import type { MonoMs, VoiceFault } from './types.js';
import type { RealtimeSessionConfig } from './session-config.js';

const KEY = 'sk-test-not-a-real-key-000000000000';

const CONFIG: RealtimeSessionConfig = {
  model: 'gpt-realtime-2.1-mini',
  voice: 'marin',
  instructions: '',
  tools: [],
  turnDetection: {
    kind: 'server_vad',
    createResponse: false,
    interruptResponse: true,
    silenceDurationMs: 200,
  },
  noiseReduction: 'near_field',
  transcription: null,
  truncation: { mode: 'auto', retentionRatio: 0.8 },
};

const OK_BODY = JSON.stringify({
  value: 'ek_test_secret',
  expires_at: 1_800_000,
  session_id: 's1',
});

function harness(response = { ok: true, status: 200, body: OK_BODY }) {
  const requests: { url: string; init: RequestInitLike }[] = [];
  const fetch: FetchLike = (url, init) => {
    requests.push({ url, init });
    return Promise.resolve({
      ok: response.ok,
      status: response.status,
      text: () => Promise.resolve(response.body),
    });
  };

  let now = 1000;
  const apiKey = new ApiKey(KEY);
  return {
    apiKey,
    requests,
    advance: (ms: number) => (now += ms),
    broker: createClientSecretBroker({
      apiKey,
      safetyIdentifier: 'hashed-install-id',
      fetch,
      now: () => now as MonoMs,
    }),
  };
}

describe('ApiKey redaction — ADR-0022', () => {
  it('does not leak through string interpolation', () => {
    expect(`Authorization: ${String(new ApiKey(KEY))}`).toBe('Authorization: [redacted]');
  });

  it('does not leak through JSON.stringify — the realistic telemetry accident', () => {
    expect(JSON.stringify({ apiKey: new ApiKey(KEY), other: 1 })).toBe(
      '{"apiKey":"[redacted]","other":1}',
    );
  });

  it('does not leak through util.inspect, which is what console.log in main calls', () => {
    const key = new ApiKey(KEY);
    const inspect = Reflect.get(key, Symbol.for('nodejs.util.inspect.custom')) as () => string;
    expect(inspect.call(key)).toBe('[redacted]');
  });

  it('yields the real value only through reveal()', () => {
    expect(new ApiKey(KEY).reveal()).toBe(KEY);
  });

  it('rejects an empty key at construction, naming the variable', () => {
    // §7.1: what must not happen is discovering this on the first connection attempt, ten minutes
    // into a game.
    expect(() => new ApiKey('  ')).toThrow(/RIKI_OPENAI_API_KEY/);
  });
});

describe('minting', () => {
  it('returns a short-lived secret, never the key', async () => {
    const { broker } = harness();
    const secret = await broker.mint(CONFIG);
    expect(secret.value).toBe('ek_test_secret');
    expect(secret.value).not.toContain(KEY);
  });

  it('sends the key only in the Authorization header, never in the body', async () => {
    const { broker, requests } = harness();
    await broker.mint(CONFIG);

    const request = requests[0];
    expect(request?.url).toBe(CLIENT_SECRETS_URL);
    expect(request?.init.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(request?.init.body).not.toContain(KEY);
  });

  it('sets the safety identifier from our side, per realtime §6', async () => {
    const { broker, requests } = harness();
    await broker.mint(CONFIG);
    expect(requests[0]?.init.headers['OpenAI-Safety-Identifier']).toBe('hashed-install-id');
  });

  it('uses the GA session shape, not the beta one', async () => {
    const { broker, requests } = harness();
    await broker.mint(CONFIG);
    const body = JSON.parse(requests[0]?.init.body ?? '{}') as { session: Record<string, unknown> };
    expect(body.session.type).toBe('realtime');
    expect(body.session).not.toHaveProperty('voice');
    expect(body.session.audio).toEqual({ output: { voice: 'marin' } });
  });

  it('rate-limits itself, or the mint endpoint becomes the abuse vector (realtime §12)', async () => {
    const { broker } = harness();
    await broker.mint(CONFIG);
    await expect(broker.mint(CONFIG)).rejects.toMatchObject({ retryable: true });
  });

  it('allows another mint once the interval has passed', async () => {
    const { broker, advance } = harness();
    await broker.mint(CONFIG);
    advance(MIN_MINT_INTERVAL_MS);
    await expect(broker.mint(CONFIG)).resolves.toBeDefined();
  });
});

describe('failures are VoiceFaults, not bare Errors — the chip needs the kind', () => {
  it('401 is auth, is not retryable, and names the environment variable', async () => {
    const { broker } = harness({ ok: false, status: 401, body: '{}' });
    const fault = (await broker.mint(CONFIG).catch((error: unknown) => error)) as VoiceFault;
    expect(fault.kind).toBe('auth');
    expect(fault.retryable).toBe(false);
    expect(fault.message).toMatch(/RIKI_OPENAI_API_KEY/);
  });

  it('429 is offline and retryable', async () => {
    const { broker } = harness({ ok: false, status: 429, body: '{}' });
    await expect(broker.mint(CONFIG)).rejects.toMatchObject({ kind: 'offline', retryable: true });
  });

  it('never echoes the response body, which can carry request material', async () => {
    const { broker } = harness({ ok: false, status: 401, body: `{"echo":"${KEY}"}` });
    const fault = (await broker.mint(CONFIG).catch((error: unknown) => error)) as VoiceFault;
    expect(fault.message).not.toContain(KEY);
  });
});

describe('parseClientSecret', () => {
  it('accepts the flat shape', () => {
    expect(
      parseClientSecret('{"value":"ek_1","expires_at":1700,"session_id":"s1"}', 0 as MonoMs),
    ).toEqual({ value: 'ek_1', expiresAt: 1_700_000, sessionId: 's1' });
  });

  it('accepts the nested shape the API has also used', () => {
    expect(parseClientSecret('{"client_secret":{"value":"ek_2"}}', 0 as MonoMs).value).toBe('ek_2');
  });

  it('falls back to a short expiry rather than assuming a long one', () => {
    expect(parseClientSecret('{"value":"ek_3"}', 5_000 as MonoMs).expiresAt).toBe(65_000);
  });

  it('rejects a response with no secret', () => {
    expect(() => parseClientSecret('{}', 0 as MonoMs)).toThrow();
    expect(() => parseClientSecret('not json', 0 as MonoMs)).toThrow();
  });
});
