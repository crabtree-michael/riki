/**
 * The guarding tests REPO_SKELETON.md §5.4 names for the key:
 *
 * > Assert the key is absent from the preload bridge surface and from anything
 * > `packages/telemetry` emits… Assert `packages/realtime` receives it injected and never reads
 * > `process.env` itself.
 *
 * The lint boundary in §6.2 makes `process.env` unreadable here, which covers the deliberate
 * case. What it does not cover is the accidental one — a key reaching a log through
 * `JSON.stringify` or a template literal — which is what `ApiKey`'s redaction exists for.
 */

import { describe, expect, it } from 'vitest';
import {
  ApiKey,
  EphemeralSecretMinter,
  MIN_MINT_INTERVAL_MS,
  parseClientSecret,
} from './credentials.js';
import { FakeClock, FakeFetch } from '../testing/index.js';

const KEY = 'sk-test-not-a-real-key-000000000000';

describe('ApiKey redaction', () => {
  it('does not leak through string interpolation', () => {
    const key = new ApiKey(KEY);
    expect(`Authorization: ${String(key)}`).toBe('Authorization: [redacted]');
    expect(String(key)).not.toContain(KEY);
  });

  it('does not leak through JSON.stringify — the realistic telemetry accident', () => {
    const key = new ApiKey(KEY);
    expect(JSON.stringify({ apiKey: key, other: 1 })).toBe('{"apiKey":"[redacted]","other":1}');
  });

  it('does not leak through Node’s inspect, which toString does not cover', () => {
    const key = new ApiKey(KEY);
    const inspect = Reflect.get(key, Symbol.for('nodejs.util.inspect.custom')) as () => string;
    expect(inspect.call(key)).toBe('[redacted]');
    expect(inspect.call(key)).not.toContain(KEY);
  });

  it('yields the real value only through reveal()', () => {
    expect(new ApiKey(KEY).reveal()).toBe(KEY);
  });

  it('rejects an empty key at construction, naming the variable', () => {
    // §7.1: what must not happen is discovering this on the first connection attempt, ten
    // minutes into a game.
    expect(() => new ApiKey('')).toThrow(/RIKI_OPENAI_API_KEY/);
    expect(() => new ApiKey('   ')).toThrow(/RIKI_OPENAI_API_KEY/);
  });
});

describe('EphemeralSecretMinter', () => {
  function minter(fetch = new FakeFetch(), clock = new FakeClock(1000)) {
    const apiKey = new ApiKey(KEY);
    return {
      apiKey,
      fetch,
      clock,
      minter: new EphemeralSecretMinter({
        apiKey,
        fetch: fetch.fetch,
        safetyIdentifier: 'hashed-user-id',
        now: clock.now,
      }),
    };
  }

  it('mints a short-lived client secret', async () => {
    const { minter: subject } = minter();
    const credentials = await subject.mint({ model: 'gpt-realtime-2.1-mini', voice: 'marin' });
    expect(credentials.clientSecret).toBe('ek_test_secret');
  });

  it('sends the real key only in the Authorization header, never in the body', async () => {
    const { minter: subject, fetch, apiKey } = minter();
    const credentials = await subject.mint({ model: 'gpt-realtime-2.1-mini', voice: 'marin' });

    expect(fetch.requests[0]?.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(fetch.leakedOutside(apiKey, ['Authorization'])).toBe(false);
    // The whole point of minting (ADR-0010, research §9): what leaves this call for the voice
    // window is `ek_…`, never `sk-…`. The renderer must never be able to see the real key.
    expect(credentials.clientSecret).not.toContain(KEY);
    expect(credentials.clientSecret.startsWith('ek_')).toBe(true);
  });

  it('sets the safety identifier from our side, per §6', async () => {
    const { minter: subject, fetch } = minter();
    await subject.mint({ model: 'gpt-realtime-2.1-mini', voice: 'marin' });
    expect(fetch.requests[0]?.headers['OpenAI-Safety-Identifier']).toBe('hashed-user-id');
  });

  it('uses the GA session shape, not the beta one', async () => {
    const { minter: subject, fetch } = minter();
    await subject.mint({ model: 'gpt-realtime-2.1-mini', voice: 'marin' });

    const body = JSON.parse(fetch.requests[0]?.body ?? '{}') as {
      session: Record<string, unknown>;
    };
    expect(body.session.type).toBe('realtime');
    expect(body.session).not.toHaveProperty('voice');
    expect(body.session.audio).toEqual({ output: { voice: 'marin' } });
  });

  it('rate-limits itself — §12, or the mint path becomes the abuse vector', async () => {
    const { minter: subject } = minter();
    await subject.mint({ model: 'gpt-realtime-2.1-mini', voice: 'marin' });
    await expect(subject.mint({ model: 'gpt-realtime-2.1-mini', voice: 'marin' })).rejects.toThrow(
      /once per second/,
    );
  });

  it('allows a mint again after the interval', async () => {
    const clock = new FakeClock(1000);
    const { minter: subject } = minter(new FakeFetch(), clock);
    await subject.mint({ model: 'gpt-realtime-2.1-mini', voice: 'marin' });
    clock.advance(MIN_MINT_INTERVAL_MS);
    await expect(
      subject.mint({ model: 'gpt-realtime-2.1-mini', voice: 'marin' }),
    ).resolves.toBeDefined();
  });

  it('does not echo the response body into the error, which may carry request material', async () => {
    const fetch = new FakeFetch({ ok: false, status: 401, body: `{"error":"key ${KEY}"}` });
    const { minter: subject } = minter(fetch);
    await expect(subject.mint({ model: 'gpt-realtime-2.1-mini', voice: 'marin' })).rejects.toThrow(
      /HTTP 401/,
    );
    await expect(
      minter(new FakeFetch({ ok: false, status: 401, body: `{"k":"${KEY}"}` })).minter.mint({
        model: 'gpt-realtime-2.1-mini',
        voice: 'marin',
      }),
    ).rejects.not.toThrow(new RegExp(KEY));
  });
});

describe('parseClientSecret', () => {
  it('accepts the flat shape', () => {
    expect(parseClientSecret('{"value":"ek_1","expires_at":1700}', 0)).toEqual({
      clientSecret: 'ek_1',
      expiresAt: 1_700_000,
    });
  });

  it('accepts the nested shape', () => {
    expect(parseClientSecret('{"client_secret":{"value":"ek_2"}}', 5000).clientSecret).toBe('ek_2');
  });

  it('falls back to a short expiry rather than assuming a long one', () => {
    expect(parseClientSecret('{"value":"ek_3"}', 5000).expiresAt).toBe(65_000);
  });

  it('rejects a response with no secret', () => {
    expect(() => parseClientSecret('{}', 0)).toThrow(/no secret/);
    expect(() => parseClientSecret('not json', 0)).toThrow(/not JSON/);
  });
});
