/**
 * Tier 3 for the voice bridge, plus the codec's two promises.
 *
 * `contract.test.ts` next door is the *cross-language* half of the same idea and pins the sidecar
 * protocol against a Rust re-encode. These messages cross a process boundary but not a language
 * one, so what is pinned here is narrower and still worth pinning: that the schema has not drifted
 * from the shape the two sides send, and that a malformed or mismatched message is a **value**
 * rather than a throw inside an IPC handler nobody is watching.
 *
 * The exhaustiveness tests are the ones that earn their keep. A corpus that happens to cover eight
 * of nine message types looks exactly as green as one that covers all nine.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { PROTOCOL_VERSION } from './version.js';
import { VoiceDirective, VoiceEvent, VoiceUpdate } from './schemas/voice.js';
import { decodeVoiceDirective, decodeVoiceUpdate, voice, voiceUpdates } from './voice-codec.js';

const FIXTURES = fileURLToPath(new URL('../../../fixtures/protocol/voice', import.meta.url));

const files = readdirSync(FIXTURES)
  .filter((name) => name.endsWith('.json'))
  .sort();

function load(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as unknown;
}

/** The `type` of every message the schema can produce, from the schema rather than from a list. */
function typesOf(union: typeof VoiceDirective | typeof VoiceUpdate): string[] {
  return union.options.map((option) => option.shape.type.value).sort();
}

describe('the voice fixture corpus', () => {
  it('is not empty — an empty corpus passes every assertion below', () => {
    expect(files.length).toBeGreaterThanOrEqual(20);
  });

  it.each(files)('%s round-trips through the schema unchanged', (name) => {
    const original = load(name);
    // The prefix says which direction the message travels, matching the sidecar corpus's
    // `command-` / `event-` convention one directory up.
    expect(name).toMatch(/^(directive|update)-/);
    const schema = name.startsWith('directive-') ? VoiceDirective : VoiceUpdate;

    const parsed = schema.parse(original);
    // zod strips unknown keys, so this catches a fixture carrying a field the schema no longer
    // has — which is exactly the drift a fixture is supposed to reveal rather than absorb.
    expect(JSON.parse(JSON.stringify(parsed))).toStrictEqual(original);
  });

  it.each(files)('%s carries the current protocol version', (name) => {
    expect((load(name) as { v: number }).v).toBe(PROTOCOL_VERSION);
  });

  it('covers every directive the schema can produce', () => {
    const covered = new Set(
      files
        .filter((name) => name.startsWith('directive-'))
        .map((name) => (load(name) as { type: string }).type),
    );
    expect([...covered].sort()).toEqual(typesOf(VoiceDirective));
  });

  it('covers every update the schema can produce', () => {
    const covered = new Set(
      files
        .filter((name) => name.startsWith('update-'))
        .map((name) => (load(name) as { type: string }).type),
    );
    expect([...covered].sort()).toEqual(typesOf(VoiceUpdate));
  });

  it('covers every VoiceEvent kind, which is the union the overlay actually reacts to', () => {
    const covered = new Set(
      files
        .filter((name) => name.startsWith('update-event-'))
        .map((name) => (load(name) as { event: { kind: string } }).event.kind),
    );
    expect([...covered].sort()).toEqual(
      VoiceEvent.options.map((option) => option.shape.kind.value).sort(),
    );
  });
});

describe('what may never cross this bridge', () => {
  it('has no field on any message that could carry the API key', () => {
    // ADR-0015 and REPO_SKELETON.md §5.4. The renderer gets an ephemeral client secret; the key
    // stays in main. This asserts the *shape*, so it is a property of the protocol rather than a
    // rule someone has to keep — and it is why the assertion is here and not in a leak test.
    const shapes = JSON.stringify(
      [VoiceDirective, VoiceUpdate].map((u) => u.options.map((o) => Object.keys(o.shape))),
    );
    expect(shapes).not.toMatch(/apiKey|api_key|openai/i);
  });

  it('carries no monotonic timestamp, because the two processes share no epoch', () => {
    // `expiresInMs` is a duration and level frames are stamped by main on receipt. A field named
    // like an absolute uptime here would be off by however long the renderer took to start, and
    // would look entirely plausible in a log.
    const names = [VoiceDirective, VoiceUpdate].flatMap((union) =>
      union.options.flatMap((option) => Object.keys(option.shape)),
    );
    expect(names.filter((name) => /At$|MonoMs$/.test(name))).toEqual([]);
  });
});

describe('decoding', () => {
  it('accepts what the constructors produce, in both directions', () => {
    const directive = voice.turnBegin('coach_1', 'push');
    expect(decodeVoiceDirective(directive)).toEqual({ ok: true, message: directive });

    const update = voiceUpdates.event({ kind: 'capture', event: 'opened' });
    expect(decodeVoiceUpdate(update)).toEqual({ ok: true, message: update });
  });

  it('reports a version mismatch as a version mismatch, not as a missing field', () => {
    // The whole point of freezing `v` and `type`: a peer from another build has to stay parseable
    // *enough* to be recognised, or the report is a zod error about a field nobody has heard of.
    const fromTheFuture = { v: PROTOCOL_VERSION + 1, type: 'voice.turn.begin', unheardOf: true };
    expect(decodeVoiceDirective(fromTheFuture)).toEqual({
      ok: false,
      reason: 'version',
      theirs: PROTOCOL_VERSION + 1,
    });
  });

  it('names the message type when the content is unreadable', () => {
    // A `voice.turn.begin` with no `turnId`: right version, right type, wrong shape.
    const result = decodeVoiceDirective({ v: PROTOCOL_VERSION, type: 'voice.turn.begin' });
    expect(result).toMatchObject({ ok: false, reason: 'malformed' });
    expect(result.ok || result.reason !== 'malformed' ? '' : result.detail).toContain(
      'voice.turn.begin',
    );
  });

  it('never throws, whatever it is handed', () => {
    for (const input of [null, undefined, 42, 'a string', {}, { v: 'one' }, []]) {
      expect(() => decodeVoiceDirective(input)).not.toThrow();
      expect(decodeVoiceUpdate(input).ok).toBe(false);
    }
  });
});

describe('the constructors', () => {
  it('stamp the version on every message, which is the reason they exist', () => {
    const built = [
      voice.sessionClose('done'),
      voice.turnEnd('t1', 'release', 'text'),
      voice.turnSpeak('t2', 'text', 'e1', 0.5),
      voice.command('abort'),
      voice.levelEnable(false),
      voiceUpdates.ready(),
      voiceUpdates.sessionState('ready'),
    ];
    for (const message of built) expect(message.v).toBe(PROTOCOL_VERSION);
  });
});
