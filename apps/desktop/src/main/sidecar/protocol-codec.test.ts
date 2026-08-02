/**
 * The adapter between the wire and the world model, against real protocol lines.
 *
 * These are the same bytes `crates/riki-vision` emits — `fixtures/protocol/` is the corpus both
 * languages agree on, and `packages/protocol` is what encodes them here. No process is spawned:
 * everything this file asserts is a decision the codec makes about a string.
 */

import { describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, encodeMessage, type SidecarEvent } from '@riki/protocol';
import { createWorldModelStore, type MonoMs } from '@riki/world-model';
import {
  DEFAULT_CAPTURE_CONFIG,
  MAP_WORLD_EXTENT_UNITS,
  createProtocolCodec,
  type CvDetectionsPayload,
} from './protocol-codec.js';

const APP = { name: 'riki-desktop', build: 'test' };

function codec(overrides: Parameters<typeof createProtocolCodec>[0] | object = {}) {
  return createProtocolCodec({ app: APP, capture: DEFAULT_CAPTURE_CONFIG, ...overrides });
}

const READY: SidecarEvent = {
  v: PROTOCOL_VERSION,
  type: 'ready',
  sidecar: {
    name: 'riki-vision',
    version: '0.0.0',
    platform: 'macos',
    backend: 'screencapturekit',
    backendAvailable: false,
  },
};

/**
 * One capture pass, as the sidecar would write it: a hero sighting and the digest of the crop it
 * came from.
 *
 * Both in one message on purpose. The two travel together on the wire and have to come apart here
 * — one is a fact about the match and the other is a fact about the capture pipeline — and a helper
 * that only ever produced one of them would not exercise that.
 */
function detections(
  overrides: Partial<{
    emittedAtMonoMs: number;
    capturedAtMonoMs: number;
    x: number;
    y: number;
    confidence: number;
  }> = {},
) {
  const emittedAtMonoMs = overrides.emittedAtMonoMs ?? 5_040;
  const capturedAtMonoMs = overrides.capturedAtMonoMs ?? 5_000;
  return {
    v: PROTOCOL_VERSION,
    type: 'cv.detections',
    emittedAtMonoMs,
    facts: [
      {
        regionId: 'minimap',
        detector: 'minimap-icon/v1',
        confidence: overrides.confidence ?? 0.75,
        capturedAtMonoMs,
        payload: {
          kind: 'minimap.hero',
          hero: 'npc_dota_hero_nevermore',
          side: 'enemies',
          at: { x: overrides.x ?? 0.75, y: overrides.y ?? 0.25 },
        },
      },
      {
        regionId: 'minimap',
        detector: 'region-digest/v1',
        confidence: 1,
        capturedAtMonoMs,
        payload: {
          kind: 'region.digest',
          hash: '19b9a20c1ab22482',
          width: 298,
          height: 264,
          meanLuma: 0.12,
          changed: true,
        },
      },
    ],
  } satisfies SidecarEvent;
}

describe('the handshake', () => {
  it('sends hello first, then the configuration, then start', () => {
    // Order is the whole safety argument: a pipe preserves it, so the sidecar's handshake gate is
    // established by the time it reads the second line, and no waiting is needed.
    const lines = codec()
      .hello()
      .map((line) => JSON.parse(line) as { type: string });
    expect(lines.map((line) => line.type)).toStrictEqual([
      'hello',
      'capture.configure',
      'capture.start',
    ]);
  });

  it('asks for named window regions and never for a screen', () => {
    // dota2 §7. The protocol has no display variant to ask for, and this asserts the app does not
    // find some other way to widen the request.
    const [, configure] = codec().hello();
    const parsed = JSON.parse(configure ?? '{}') as {
      config: { target: Record<string, unknown>; regions: { id: string }[] };
    };
    expect(Object.keys(parsed.config.target).sort()).toStrictEqual([
      'processName',
      'titleContains',
    ]);
    expect(parsed.config.regions.map((region) => region.id)).toStrictEqual(['minimap', 'top-bar']);
  });

  it('reports what answered, including a backend that cannot capture', () => {
    const onReady = vi.fn();
    const decoded = codec({ onReady }).decode(encodeMessage(READY), 100 as MonoMs, 0);

    // Understood, but not a fact — so it must not count as an observation for health purposes.
    expect(decoded.kind).toBe('handled');
    expect(onReady).toHaveBeenCalledWith(
      expect.objectContaining({ backend: 'screencapturekit', backendAvailable: false }),
    );
  });
});

describe('decoding detections', () => {
  it('translates the sidecar clock into ours by subtracting the age', () => {
    // The two clocks share no epoch; only their difference means anything. 40 ms inside the
    // sidecar means the fact was observed 40 ms before we read the line.
    const decoded = codec().decode(
      encodeMessage(detections({ emittedAtMonoMs: 5_040, capturedAtMonoMs: 5_000 })),
      1_000 as MonoMs,
      3,
    );

    if (decoded.kind !== 'observation') throw new Error(`expected an observation: ${decoded.kind}`);
    const payload = decoded.observation.payload as CvDetectionsPayload;
    expect(decoded.observation.receivedAt).toBe(1_000);
    expect(payload.detections[0]?.observedAt).toBe(960);
  });

  it('carries confidence and provenance through unchanged', () => {
    const decoded = codec().decode(encodeMessage(detections()), 1_000 as MonoMs, 0);
    if (decoded.kind !== 'observation') throw new Error('expected an observation');

    const detection = (decoded.observation.payload as CvDetectionsPayload).detections[0];
    expect(detection?.confidence).toBe(0.75);
    expect(detection?.detector).toBe('minimap-icon/v1');
  });

  it('turns a minimap sighting into the flat record fusion reads', () => {
    // The shape, not just the values: `readCvDetections` switches on a top-level `kind`, so a
    // nested `payload` — which is what this codec used to emit — is unreadable to it.
    const decoded = codec().decode(encodeMessage(detections()), 1_000 as MonoMs, 0);
    if (decoded.kind !== 'observation') throw new Error('expected an observation');

    expect((decoded.observation.payload as CvDetectionsPayload).detections[0]).toMatchObject({
      kind: 'hero_position',
      side: 'enemies',
      hero: 'npc_dota_hero_nevermore',
    });
  });

  it('converts a minimap point into Dota world units, with y flipped', () => {
    // Crop coordinates grow downward from a top-left origin; the world's grow upward from the
    // centre. Getting only the scale right mirrors the map north-to-south, which reads as advice
    // about the wrong lane rather than as a bug.
    const decoded = codec().decode(
      encodeMessage(detections({ x: 0.75, y: 0.25 })),
      1_000 as MonoMs,
      0,
    );
    if (decoded.kind !== 'observation') throw new Error('expected an observation');

    const detection = (decoded.observation.payload as CvDetectionsPayload).detections[0];
    if (detection?.kind !== 'hero_position') throw new Error('expected a hero position');
    expect(detection.x).toBeCloseTo(MAP_WORLD_EXTENT_UNITS * 0.25);
    expect(detection.y).toBeCloseTo(MAP_WORLD_EXTENT_UNITS * 0.25);

    const centre = codec().decode(
      encodeMessage(detections({ x: 0.5, y: 0.5 })),
      1_000 as MonoMs,
      0,
    );
    if (centre.kind !== 'observation') throw new Error('expected an observation');
    expect((centre.observation.payload as CvDetectionsPayload).detections[0]).toMatchObject({
      x: 0,
      y: 0,
    });
  });

  it('keeps the region digest out of the detections fusion reads', () => {
    // A region hash is a fact about the capture pipeline, not about the match. In `detections` it
    // is an `unparsed` rejection on every single pass; here it is the evidence that capture is
    // alive while nothing on screen has moved.
    const decoded = codec().decode(encodeMessage(detections()), 1_000 as MonoMs, 0);
    if (decoded.kind !== 'observation') throw new Error('expected an observation');
    const payload = decoded.observation.payload as CvDetectionsPayload;

    expect(payload.detections).toHaveLength(1);
    expect(payload.digests).toHaveLength(1);
    expect(payload.digests[0]).toMatchObject({
      regionId: 'minimap',
      hash: '19b9a20c1ab22482',
      changed: true,
    });
  });

  /**
   * The assertion the two vocabularies never had.
   *
   * Everything above checks the codec against what this file believes fusion wants. This runs the
   * real reducer, which is the only thing that can say whether it was right — and the answer,
   * before this change, was that a decoded batch produced zero facts and one `unparsed` rejection
   * per detection (ADR-0035).
   */
  it('produces an observation the world model actually accepts', () => {
    const decoded = codec().decode(encodeMessage(detections()), 1_000 as MonoMs, 0);
    if (decoded.kind !== 'observation') throw new Error('expected an observation');

    const store = createWorldModelStore({});
    const result = store.apply(decoded.observation, 1_000 as MonoMs);

    expect(result.rejected).toStrictEqual([]);
    expect(result.accepted).toBeGreaterThan(0);
    expect(
      store
        .snapshot(1_000 as MonoMs)
        .enemies()
        .map((view) => view.hero),
    ).toStrictEqual(['npc_dota_hero_nevermore']);
  });

  it('drops a sighting the confidence gate refuses, and says why', () => {
    // "Low-confidence output" is one of the three things `FakeVisionSidecar` exists to produce
    // (REPO_SKELETON §5.2). Below the gate a fact is dropped rather than softened — the renderer is
    // the layer least able to decide whether a 0.3 blob is a hero.
    const decoded = codec().decode(
      encodeMessage(detections({ confidence: 0.3 })),
      1_000 as MonoMs,
      0,
    );
    if (decoded.kind !== 'observation') throw new Error('expected an observation');

    const result = createWorldModelStore({}).apply(decoded.observation, 1_000 as MonoMs);
    expect(result.accepted).toBe(0);
    expect(result.rejected.map((r) => r.why)).toContain('below_threshold');
  });

  it('stamps the observation with the sequence the supervisor gave it', () => {
    const decoded = codec().decode(encodeMessage(detections()), 1_000 as MonoMs, 7);
    if (decoded.kind !== 'observation') throw new Error('expected an observation');
    expect(decoded.observation.seq).toBe(7);
    expect(decoded.observation.kind).toBe('cv.detections');
  });

  it('refuses to date a fact into the future', () => {
    // An emit that predates its own capture is a clock bug, and letting the negative age through
    // would make the world model treat the fact as newer than the moment it arrived.
    const decoded = codec().decode(
      encodeMessage(detections({ emittedAtMonoMs: 1_000, capturedAtMonoMs: 9_000 })),
      500 as MonoMs,
      0,
    );
    if (decoded.kind !== 'observation') throw new Error('expected an observation');
    expect((decoded.observation.payload as CvDetectionsPayload).detections[0]?.observedAt).toBe(
      500,
    );
  });
});

describe('decoding a problem', () => {
  it('hands the named failure and its remedy to the app', () => {
    const onProblem = vi.fn();
    const problem: SidecarEvent = {
      v: PROTOCOL_VERSION,
      type: 'problem',
      problem: {
        kind: 'exclusive_fullscreen',
        fatal: false,
        message: 'the window stopped being visible to the capture API',
        remedy: 'Set Dota 2 to Borderless Window in Settings > Video.',
      },
    };

    const decoded = codec({ onProblem }).decode(encodeMessage(problem), 1 as MonoMs, 0);

    expect(decoded.kind).toBe('handled');
    // dota2 §9: exclusive fullscreen is a prompt-once, not a CV failure to swallow.
    expect(onProblem).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'exclusive_fullscreen' }),
    );
  });
});

describe('lines that are not ours', () => {
  it('separates a version mismatch from a line it cannot parse', () => {
    const onVersionMismatch = vi.fn();
    const onUndecodable = vi.fn();
    const subject = codec({ onVersionMismatch, onUndecodable });

    expect(subject.decode('{"v":99,"type":"ready"}', 1 as MonoMs, 0).kind).toBe('undecodable');
    expect(onVersionMismatch).toHaveBeenCalledWith(99);
    expect(onUndecodable).not.toHaveBeenCalled();
  });

  it('treats a panic trace as undecodable rather than throwing', () => {
    // Electron main holds the API key and the whole coaching path. A stray line of sidecar output
    // is not permitted to be the thing that ends it.
    const onUndecodable = vi.fn();
    const subject = codec({ onUndecodable });

    expect(() => subject.decode('thread panicked at lib.rs:1', 1 as MonoMs, 0)).not.toThrow();
    expect(subject.decode('thread panicked at lib.rs:1', 1 as MonoMs, 0).kind).toBe('undecodable');
    expect(onUndecodable).toHaveBeenCalled();
  });

  it('rejects a detections message whose confidence is out of range', () => {
    // The schema is the guard, and this is the assertion that the app actually runs it rather
    // than trusting a process it spawned.
    const overconfident = JSON.stringify({
      ...detections(),
      facts: [{ ...detections().facts[0], confidence: 12 }],
    });
    expect(codec().decode(overconfident, 1 as MonoMs, 0).kind).toBe('undecodable');
  });
});
