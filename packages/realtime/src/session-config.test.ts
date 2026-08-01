/**
 * The guarding test REPO_SKELETON.md §5.4 names:
 *
 * > Assert the outgoing `session.update` matches the GA schema exactly and contains **no**
 * > top-level `voice` or string `input_audio_format`. Snapshot it.
 *
 * The trap is entirely on the outgoing side — no server response reveals it — so the assertion is
 * against what we send rather than against how the session behaves.
 */

import { describe, expect, it } from 'vitest';
import { assertGaShape, buildSessionUpdate, REALTIME_SAMPLE_RATE } from './session-config.js';
import type { RealtimeSessionConfig } from './session-config.js';

/** ADR-0017's configuration: VAD on, response creation ours, 200 ms silence. */
const BASE: RealtimeSessionConfig = {
  model: 'gpt-realtime-2.1-mini',
  voice: 'marin',
  instructions: 'You are Riki.',
  tools: [],
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

function session(config: RealtimeSessionConfig = BASE): Record<string, unknown> {
  return buildSessionUpdate(config).session;
}

describe('the beta → GA trap', () => {
  it('puts the voice under audio.output, never at the top level', () => {
    const payload = session();
    expect((payload.audio as { output: { voice: string } }).output.voice).toBe('marin');
    expect(payload).not.toHaveProperty('voice');
  });

  it('uses format objects, never the bare `pcm16` string', () => {
    const audio = session().audio as { input: { format: unknown }; output: { format: unknown } };
    const expected = { type: 'audio/pcm', rate: REALTIME_SAMPLE_RATE };
    expect(audio.input.format).toEqual(expected);
    expect(audio.output.format).toEqual(expected);
  });

  it('carries no beta field anywhere in the payload, at any depth', () => {
    const json = JSON.stringify(buildSessionUpdate(BASE));
    for (const key of ['input_audio_format', 'output_audio_format', 'modalities', 'temperature']) {
      expect(json).not.toContain(key);
    }
  });

  it('matches the GA shape exactly', () => {
    expect(buildSessionUpdate(BASE)).toMatchInlineSnapshot(`
      {
        "session": {
          "audio": {
            "input": {
              "format": {
                "rate": 24000,
                "type": "audio/pcm",
              },
              "noise_reduction": {
                "type": "near_field",
              },
              "transcription": {
                "language": "en",
                "model": "gpt-4o-mini-transcribe",
              },
              "turn_detection": {
                "create_response": false,
                "interrupt_response": true,
                "silence_duration_ms": 200,
                "type": "server_vad",
              },
            },
            "output": {
              "format": {
                "rate": 24000,
                "type": "audio/pcm",
              },
              "voice": "marin",
            },
          },
          "instructions": "You are Riki.",
          "model": "gpt-realtime-2.1-mini",
          "tool_choice": "auto",
          "tools": [],
          "truncation": {
            "retention_ratio": 0.8,
          },
          "type": "realtime",
        },
        "type": "session.update",
      }
    `);
  });
});

describe('turn detection — ADR-0017', () => {
  it('keeps VAD on, which is what keeps server-side truncation working', () => {
    const detection = (session().audio as { input: { turn_detection: unknown } }).input
      .turn_detection;
    expect(detection).toEqual({
      type: 'server_vad',
      create_response: false,
      interrupt_response: true,
      silence_duration_ms: 200,
    });
  });

  it('never lets the model create a response on its own', () => {
    // The gesture is the sole authority. `create_response: true` is the behaviour ADR-0004 exists
    // to prevent — Riki answering teammates the moment the gate is open.
    for (const kind of ['server_vad', 'semantic_vad'] as const) {
      const payload = session({ ...BASE, turnDetection: { ...BASE.turnDetection, kind } });
      const detection = (
        payload.audio as { input: { turn_detection: { create_response: boolean } } }
      ).input.turn_detection;
      expect(detection.create_response).toBe(false);
    }
  });

  it('sends null for `none`, which is what turning detection off means on the wire', () => {
    const payload = session({
      ...BASE,
      turnDetection: { ...BASE.turnDetection, kind: 'none' },
    });
    expect(
      (payload.audio as { input: { turn_detection: unknown } }).input.turn_detection,
    ).toBeNull();
  });
});

describe('truncation and tools', () => {
  it('carries the retention ratio in auto mode', () => {
    expect(session().truncation).toEqual({ retention_ratio: 0.8 });
  });

  it('supports the dev-only disabled mode, which errors instead of dropping context', () => {
    const payload = session({ ...BASE, truncation: { mode: 'disabled', retentionRatio: 0.8 } });
    expect(payload.truncation).toBe('disabled');
  });

  it('renders the manifest as GA function tools', () => {
    const payload = session({
      ...BASE,
      tools: [{ name: 'get_timings', description: 'Rune and Roshan windows', parameters: {} }],
    });
    expect(payload.tools).toEqual([
      {
        type: 'function',
        name: 'get_timings',
        description: 'Rune and Roshan windows',
        parameters: {},
      },
    ]);
  });

  it('omits transcription when it is off', () => {
    const payload = session({ ...BASE, transcription: null });
    expect((payload.audio as { input: { transcription: unknown } }).input.transcription).toBeNull();
  });
});

describe('assertGaShape — layer 3', () => {
  it('passes what we build', () => {
    expect(() => {
      assertGaShape(buildSessionUpdate(BASE));
    }).not.toThrow();
  });

  it('rejects a top-level voice, naming the consequence', () => {
    // openai-agents-js#495: this causes the GA audio settings to be discarded entirely and the
    // session to fall back to legacy defaults. Nothing errors; the session just runs wrong.
    const beta = buildSessionUpdate(BASE);
    const payload = { ...beta, session: { ...beta.session, voice: 'alloy' } };
    expect(() => {
      assertGaShape(payload);
    }).toThrow(/top-level `voice`/);
  });

  it('rejects a string audio format', () => {
    const beta = buildSessionUpdate(BASE);
    const audio = beta.session.audio as Record<string, unknown>;
    const payload = {
      ...beta,
      session: { ...beta.session, audio: { ...audio, input: { format: 'pcm16' } } },
    };
    expect(() => {
      assertGaShape(payload);
    }).toThrow(/string `audio.input.format`/);
  });

  it('rejects a beta field nested anywhere', () => {
    const beta = buildSessionUpdate(BASE);
    const payload = {
      ...beta,
      session: { ...beta.session, audio: { input: { format: {}, temperature: 0.8 }, output: {} } },
    };
    expect(() => {
      assertGaShape(payload);
    }).toThrow(/temperature/);
  });

  it('rejects a payload with no audio block at all — the beta shape by omission', () => {
    expect(() => {
      assertGaShape({ type: 'session.update', session: { model: 'x' } });
    }).toThrow(/no `audio` block/);
  });

  it('rejects a wrong envelope rather than trusting it', () => {
    expect(() => {
      assertGaShape(null);
    }).toThrow(TypeError);
    expect(() => {
      assertGaShape({ type: 'session.create', session: {} });
    }).toThrow(/envelope/);
  });
});
