import { describe, expect, it } from 'vitest';
import { BETA_EVENT_ALIASES, parseServerEvent } from './wire.js';
import type { MonoMs } from './types.js';

const AT = 1000 as MonoMs;

describe('unknown events', () => {
  /**
   * The API gains events without a version bump. A session that dies because OpenAI shipped a new
   * notification is a worse failure than one that carries it and moves on — and "hung session" is
   * the failure mode this whole package is written to avoid.
   */
  it('are carried as `unhandled`, not dropped and not errors', () => {
    expect(parseServerEvent({ type: 'something.brand.new', a: 1 }, AT)).toEqual({
      type: 'unhandled',
      raw: { type: 'something.brand.new', a: 1 },
    });
  });

  it('so is anything that is not an event at all', () => {
    expect(parseServerEvent(null, AT).type).toBe('unhandled');
    expect(parseServerEvent('nonsense', AT).type).toBe('unhandled');
    expect(parseServerEvent({ no: 'type' }, AT).type).toBe('unhandled');
  });
});

describe('the beta aliases', () => {
  /**
   * The *quiet* half of the schema trap. Code written against the GA names never fires when the
   * session was configured with the beta schema, so Riki listens, thinks, and stays silent
   * forever with no error anywhere.
   */
  it('become an error naming the cause', () => {
    const event = parseServerEvent({ type: 'response.audio.delta', delta: 'AAAA' }, AT);
    expect(event).toMatchObject({ type: 'error', code: 'beta-schema' });
    expect((event as { message: string }).message).toMatch(/beta schema/i);
  });

  it('cover the transcript names too, not just audio', () => {
    for (const type of BETA_EVENT_ALIASES) {
      expect(parseServerEvent({ type }, AT)).toMatchObject({ code: 'beta-schema' });
    }
  });

  it('do not swallow the GA names they shadow', () => {
    expect(parseServerEvent({ type: 'response.output_audio_transcript.done' }, AT).type).toBe(
      'response.output_audio_transcript.done',
    );
  });
});

describe('GA events', () => {
  it('reads a committed item', () => {
    expect(parseServerEvent({ type: 'input_audio_buffer.committed', item_id: 'i1' }, AT)).toEqual({
      type: 'input_audio_buffer.committed',
      item_id: 'i1',
    });
  });

  it('reads speech start and stop, which the turn controller waits on', () => {
    expect(parseServerEvent({ type: 'input_audio_buffer.speech_stopped' }, AT).type).toBe(
      'input_audio_buffer.speech_stopped',
    );
  });

  it('reads the player transcript', () => {
    expect(
      parseServerEvent(
        {
          type: 'conversation.item.input_audio_transcription.completed',
          item_id: 'u1',
          transcript: 'should I buy a bkb',
        },
        AT,
      ),
    ).toEqual({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'u1',
      transcript: 'should I buy a bkb',
    });
  });

  it('reads a response id from either shape the API has used', () => {
    expect(parseServerEvent({ type: 'response.created', response_id: 'r1' }, AT)).toEqual({
      type: 'response.created',
      response_id: 'r1',
    });
    expect(parseServerEvent({ type: 'response.created', response: { id: 'r2' } }, AT)).toEqual({
      type: 'response.created',
      response_id: 'r2',
    });
  });

  it('reads output_item.added, which is what starts playback measurement on WebRTC', () => {
    // The only signal that an assistant item exists on the default transport — there are no audio
    // deltas there (research §2), which is the bug playback.ts documents.
    expect(parseServerEvent({ type: 'response.output_item.added', item_id: 'i9' }, AT)).toEqual({
      type: 'response.output_item.added',
      item_id: 'i9',
    });
  });

  it('reads a function call down to its name, and keeps nothing else', () => {
    // The branch survives the deletion of command execution on purpose (coaching-architecture.md
    // §2.4): a session told `tools: []` should never produce one, and we want a counter rather
    // than an unhandled event if it does. It keeps the name because that is what gets counted, and
    // drops `call_id` and `arguments` because nothing joins on the first and the second is a
    // model's arguments to a tool that does not exist.
    expect(
      parseServerEvent(
        {
          type: 'response.function_call_arguments.done',
          call_id: 'c1',
          name: 'get_timings',
          arguments: '{"which":"roshan"}',
        },
        AT,
      ),
    ).toEqual({ type: 'response.function_call_arguments.done', name: 'get_timings' });
  });

  it('does not throw on malformed arguments, because it never looks at them', () => {
    const event = parseServerEvent(
      { type: 'response.function_call_arguments.done', call_id: 'c1', name: 'x', arguments: '{{{' },
      AT,
    );
    expect(event).toEqual({ type: 'response.function_call_arguments.done', name: 'x' });
  });

  it('reads errors from either shape', () => {
    expect(
      parseServerEvent({ type: 'error', error: { code: 'rate_limit', message: 'slow' } }, AT),
    ).toEqual({ type: 'error', code: 'rate_limit', message: 'slow' });
    expect(parseServerEvent({ type: 'error' }, AT)).toMatchObject({ code: 'unknown' });
  });
});

describe('usage', () => {
  it('breaks out cached input, which is the only number in the bill that matters', () => {
    const event = parseServerEvent(
      {
        type: 'response.done',
        response: {
          id: 'r1',
          usage: {
            input_token_details: { audio_tokens: 1400, cached_tokens: 960, text_tokens: 300 },
            output_token_details: { audio_tokens: 210, text_tokens: 40 },
          },
        },
      },
      AT,
    );

    expect(event).toEqual({
      type: 'response.done',
      response_id: 'r1',
      usage: {
        inputAudioTokens: 1400,
        cachedInputTokens: 960,
        outputAudioTokens: 210,
        textTokens: 340,
        at: AT,
      },
    });
  });

  it('reports null rather than an estimate when usage is absent', () => {
    // cost.ts records only real usage: an estimated turn there is worse than a missing one.
    expect(parseServerEvent({ type: 'response.done', response: { id: 'r1' } }, AT)).toEqual({
      type: 'response.done',
      response_id: 'r1',
      usage: null,
    });
  });

  it('treats missing detail blocks as zero rather than NaN', () => {
    const event = parseServerEvent({ type: 'response.done', response: { id: 'r', usage: {} } }, AT);
    expect(event).toMatchObject({
      usage: { inputAudioTokens: 0, cachedInputTokens: 0, outputAudioTokens: 0, textTokens: 0 },
    });
  });
});
