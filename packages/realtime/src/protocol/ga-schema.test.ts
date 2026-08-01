/**
 * The guarding test REPO_SKELETON.md §5.4 names:
 *
 * > Assert the outgoing `session.update` matches the GA schema exactly and contains **no**
 * > top-level `voice` or string `input_audio_format`. Snapshot it.
 *
 * openai-realtime-research.md §3 calls this "the single most common integration failure". The
 * trap is entirely on the *outgoing* side — no server response reveals it — which is why the
 * assertion is against what we send rather than against how the session behaves.
 */

import { describe, expect, it } from 'vitest';
import { buildSessionUpdate, truncateItem, functionCallOutput } from './ga-schema.js';
import { REALTIME_SAMPLE_RATE } from './constants.js';
import type { SessionConfig } from '../types.js';

const BASE: SessionConfig = {
  model: 'gpt-realtime-2.1-mini',
  voice: 'marin',
  instructions: 'You are Riki.',
  tools: [],
  turnDetection: null,
  noiseReduction: 'near_field',
};

describe('the beta → GA trap', () => {
  it('puts the voice under audio.output, never at the top level', () => {
    const { session } = buildSessionUpdate(BASE);
    expect(session.audio.output.voice).toBe('marin');
    expect(session).not.toHaveProperty('voice');
  });

  it('uses format objects, never the bare `pcm16` string', () => {
    const { session } = buildSessionUpdate(BASE);
    expect(session.audio.input.format).toEqual({ type: 'audio/pcm', rate: REALTIME_SAMPLE_RATE });
    expect(session.audio.output.format).toEqual({ type: 'audio/pcm', rate: REALTIME_SAMPLE_RATE });
    expect(session).not.toHaveProperty('input_audio_format');
    expect(session).not.toHaveProperty('output_audio_format');
  });

  it('carries no beta field anywhere in the payload', () => {
    // Serialised so a nested reintroduction is caught too, not just a top-level one.
    const json = JSON.stringify(buildSessionUpdate({ ...BASE, turnDetection: 'server_vad' }));
    for (const betaKey of ['"input_audio_format"', '"output_audio_format"', '"modalities"']) {
      expect(json).not.toContain(betaKey);
    }
  });

  it('omits temperature — GA removed it (§11.7)', () => {
    expect(JSON.stringify(buildSessionUpdate(BASE))).not.toContain('temperature');
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
              "turn_detection": null,
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
          "type": "realtime",
        },
        "type": "session.update",
      }
    `);
  });
});

describe('turn detection', () => {
  it('is null for push-to-talk, which is the default per ADR-0004', () => {
    expect(buildSessionUpdate(BASE).session.audio.input.turn_detection).toBeNull();
  });

  it('never lets VAD generate a response on its own', () => {
    // research §4's middle ground: speech_started/stopped for the chip, but nothing speaks
    // without an explicit response.create — Riki gates on game state first.
    for (const mode of ['server_vad', 'semantic_vad'] as const) {
      expect(
        buildSessionUpdate({ ...BASE, turnDetection: mode }).session.audio.input.turn_detection,
      ).toEqual({ type: mode, create_response: false, interrupt_response: false });
    }
  });
});

describe('truncation controls', () => {
  it('omits truncation entirely when nothing was configured', () => {
    expect(buildSessionUpdate(BASE).session).not.toHaveProperty('truncation');
  });

  it('carries the retention ratio when set', () => {
    expect(buildSessionUpdate({ ...BASE, retentionRatio: 0.8 }).session.truncation).toEqual({
      retention_ratio: 0.8,
    });
  });

  it('supports the dev-only disabled mode, which errors instead of dropping context', () => {
    expect(
      buildSessionUpdate({ ...BASE, truncationDisabled: true, retentionRatio: 0.8 }).session
        .truncation,
    ).toBe('disabled');
  });
});

describe('client events', () => {
  it('builds a truncate with a rounded, non-negative audio_end_ms', () => {
    expect(truncateItem('item_1', 1234.6)).toEqual({
      type: 'conversation.item.truncate',
      item_id: 'item_1',
      content_index: 0,
      audio_end_ms: 1235,
    });
    expect(truncateItem('item_1', -5).audio_end_ms).toBe(0);
  });

  it('builds a function_call_output item', () => {
    expect(functionCallOutput('call_1', '{"ok":true}').item).toEqual({
      type: 'function_call_output',
      call_id: 'call_1',
      output: '{"ok":true}',
    });
  });
});
