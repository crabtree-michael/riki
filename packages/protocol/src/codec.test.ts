import { describe, expect, it } from 'vitest';
import { commands, decodeSidecarEvent, encodeMessage } from './codec.js';
import { PROTOCOL_VERSION } from './version.js';

const READY = JSON.stringify({
  v: PROTOCOL_VERSION,
  type: 'ready',
  sidecar: {
    name: 'riki-vision',
    version: '0.0.0',
    platform: 'linux',
    backend: 'replay',
    backendAvailable: true,
  },
});

describe('decoding a line of the sidecar’s stdout', () => {
  it('reads a message of our own version', () => {
    const decoded = decodeSidecarEvent(READY);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.event.type).toBe('ready');
  });

  it('reports a version mismatch as a mismatch and not as a parse failure', () => {
    // The payload of a future version is deliberately unreadable by this build. The envelope is
    // still the envelope, which is the property the whole scheme rests on (version.ts).
    const decoded = decodeSidecarEvent('{"v":99,"type":"ready","sidecarInfo":{"whatever":true}}');
    expect(decoded).toStrictEqual({ ok: false, reason: 'version', theirs: 99 });
  });

  it('treats a panic trace as a value rather than throwing', () => {
    // This is what the sidecar's stderr looks like if it ever reaches stdout, and Electron main is
    // not a place where a stray line may throw.
    const decoded = decodeSidecarEvent("thread 'main' panicked at src/main.rs:12");
    expect(decoded).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('names the message type it could not read', () => {
    const decoded = decodeSidecarEvent(
      JSON.stringify({ v: PROTOCOL_VERSION, type: 'cv.telepathy' }),
    );
    expect(decoded.ok).toBe(false);
    if (decoded.ok || decoded.reason !== 'malformed') throw new Error('expected malformed');
    expect(decoded.detail).toContain('cv.telepathy');
  });

  it('rejects a well-formed message whose fields are wrong', () => {
    // A confidence above 1 is the case that matters: it would otherwise reach the agent as an
    // over-certain CV fact, which dota2 §4 rule 3 calls the worst outcome in the product.
    const line = JSON.stringify({
      v: PROTOCOL_VERSION,
      type: 'cv.detections',
      emittedAtMonoMs: 1,
      facts: [
        {
          regionId: 'minimap',
          detector: 'region-digest/v1',
          confidence: 42,
          capturedAtMonoMs: 1,
          payload: {
            kind: 'region.digest',
            hash: '0000000000000000',
            width: 1,
            height: 1,
            meanLuma: 0,
            changed: true,
          },
        },
      ],
    });
    expect(decodeSidecarEvent(line).ok).toBe(false);
  });

  it('rejects a hash that is not sixteen hex digits', () => {
    // The Rust side formats it with `{:016x}`; a hash that lost its leading zeros would be a
    // silently shorter string, and the regex is what turns that into a caught bug.
    const bad = JSON.stringify({
      v: PROTOCOL_VERSION,
      type: 'cv.detections',
      emittedAtMonoMs: 1,
      facts: [
        {
          regionId: 'minimap',
          detector: 'region-digest/v1',
          confidence: 1,
          capturedAtMonoMs: 1,
          payload: {
            kind: 'region.digest',
            hash: 'ff',
            width: 1,
            height: 1,
            meanLuma: 0,
            changed: true,
          },
        },
      ],
    });
    expect(decodeSidecarEvent(bad).ok).toBe(false);
  });
});

describe('the commands the app sends', () => {
  it('stamps every one with the protocol version', () => {
    const all = [
      commands.hello({ name: 'riki', build: 'dev' }),
      commands.start(),
      commands.stop(),
      commands.shutdown(),
    ];
    for (const command of all) expect(command.v).toBe(PROTOCOL_VERSION);
  });

  it('encodes to a single line, because the wire is newline-delimited', () => {
    const line = encodeMessage(commands.hello({ name: 'riki', build: 'dev' }));
    expect(line).not.toContain('\n');
    expect(JSON.parse(line)).toMatchObject({ type: 'hello' });
  });
});
