import { describe, expect, it } from 'vitest';

import { isOverlayIntent, parseDebugIntent, parseOverlayIntent } from './intents.js';

describe('parseOverlayIntent — what the renderer is allowed to say', () => {
  it('accepts the four intents and nothing more', () => {
    expect(parseOverlayIntent({ kind: 'ready' })).toEqual({ kind: 'ready' });
    expect(parseOverlayIntent({ kind: 'cancel' })).toEqual({ kind: 'cancel' });
    expect(parseOverlayIntent({ kind: 'paint', revision: 12 })).toEqual({
      kind: 'paint',
      revision: 12,
    });
    expect(parseOverlayIntent({ kind: 'fault', message: 'boom' })).toEqual({
      kind: 'fault',
      message: 'boom',
    });
  });

  it('rejects anything that is not one of them', () => {
    for (const payload of [
      null,
      undefined,
      42,
      'ready',
      [],
      {},
      { kind: 'teardown' },
      { kind: 'dispatch', input: { kind: 'mute', muted: true } },
      // The consent gate is gone (ADR-0023), so a renderer that still says `confirm` is a stale
      // renderer, and the allow-list must not let it through.
      { kind: 'confirm', answer: true },
      { kind: 'confirm', answer: 'yes' },
      { kind: 'paint' },
      { kind: 'paint', revision: Number.NaN },
      { kind: 'paint', revision: '3' },
      { kind: 'fault', message: 42 },
    ]) {
      expect(parseOverlayIntent(payload)).toBeNull();
      expect(isOverlayIntent(payload)).toBe(false);
    }
  });

  it('rebuilds the intent rather than forwarding what it was given', () => {
    const smuggled = { kind: 'cancel', extra: 'payload', __proto__: { nasty: true } };
    expect(parseOverlayIntent(smuggled)).toEqual({ kind: 'cancel' });
    expect(Object.keys(parseOverlayIntent(smuggled) ?? {})).toEqual(['kind']);
  });

  it('caps a fault message rather than letting the renderer flood a log', () => {
    const parsed = parseOverlayIntent({ kind: 'fault', message: 'x'.repeat(10_000) });
    expect(parsed).not.toBeNull();
    if (parsed?.kind === 'fault') expect(parsed.message.length).toBe(500);
  });
});

describe('parseDebugIntent — what the inspector is allowed to say', () => {
  it('accepts the two intents and nothing more', () => {
    expect(parseDebugIntent({ kind: 'ready' })).toEqual({ kind: 'ready' });
    expect(parseDebugIntent({ kind: 'fault', message: 'boom' })).toEqual({
      kind: 'fault',
      message: 'boom',
    });
  });

  it('cannot reach anything that changes what the app does', () => {
    for (const payload of [
      null,
      undefined,
      42,
      'ready',
      [],
      {},
      // A read-only window, by construction. None of these is a thing the inspector may say — an
      // inspector that can poke the thing it inspects produces readings nobody can act on, and it
      // would be the widest privilege escalation in the app.
      { kind: 'cancel' },
      { kind: 'setQuietMode', on: false },
      { kind: 'evaluate' },
      { kind: 'dispatch', input: { kind: 'mute', muted: true } },
      { kind: 'paint', revision: 1 },
      { kind: 'fault', message: 42 },
    ]) {
      expect(parseDebugIntent(payload)).toBeNull();
    }
  });

  it('rebuilds the intent and caps the fault message, like the overlay bridge', () => {
    const smuggled = { kind: 'ready', extra: 'payload' };
    expect(Object.keys(parseDebugIntent(smuggled) ?? {})).toEqual(['kind']);

    const parsed = parseDebugIntent({ kind: 'fault', message: 'x'.repeat(10_000) });
    if (parsed?.kind === 'fault') expect(parsed.message.length).toBe(500);
  });
});
