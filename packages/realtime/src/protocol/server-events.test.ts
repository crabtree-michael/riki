import { describe, expect, it } from 'vitest';
import { parseServerEvent } from './server-events.js';
import { serverEvents } from '../testing/index.js';

describe('unknown events', () => {
  /**
   * The API gains events without a version bump. A session that dies because OpenAI shipped a new
   * notification is a worse failure than one that ignores it — and "hung session" is the failure
   * mode the whole package is written to avoid.
   */
  it('are ignored rather than treated as errors', () => {
    expect(parseServerEvent({ type: 'something.brand.new' })).toBeNull();
    expect(parseServerEvent({ type: 'response.output_item.added' })).toBeNull();
  });

  it('so is anything that is not an event at all', () => {
    expect(parseServerEvent(null)).toBeNull();
    expect(parseServerEvent('nonsense')).toBeNull();
    expect(parseServerEvent({ no: 'type' })).toBeNull();
  });
});

describe('the beta aliases', () => {
  /**
   * These are the *quiet* half of the schema trap. Code written against the beta names does not
   * error — it simply never fires, so Riki listens, thinks, and stays silent forever. Surfacing
   * them as a protocol fault is what turns that into something a developer can see.
   */
  it('are reported as a protocol error naming the cause', () => {
    const event = parseServerEvent(serverEvents.betaAudioDelta());
    expect(event).toMatchObject({ kind: 'error', code: 'beta-schema' });
    expect((event as { message: string }).message).toMatch(/beta schema/i);
  });

  it('cover the transcript names too, not just audio', () => {
    expect(parseServerEvent({ type: 'response.audio_transcript.delta', delta: 'x' })).toMatchObject(
      {
        code: 'beta-schema',
      },
    );
  });
});

describe('GA events', () => {
  it('reads the session id', () => {
    expect(parseServerEvent(serverEvents.sessionCreated('sess_abc'))).toEqual({
      kind: 'session.created',
      sessionId: 'sess_abc',
    });
  });

  it('converts an audio delta to a byte count', () => {
    // Base64 is 4 chars per 3 bytes; the samples themselves ride the media track on WebRTC.
    const event = parseServerEvent({
      type: 'response.output_audio.delta',
      item_id: 'item_1',
      delta: 'AAAAAAAA', // 8 chars → 6 bytes
    });
    expect(event).toEqual({ kind: 'audio.delta', itemId: 'item_1', bytes: 6 });
  });

  it('reads both transcript directions', () => {
    expect(parseServerEvent(serverEvents.assistantTranscriptDone('i1', 'buy a bkb'))).toEqual({
      kind: 'transcript.done',
      itemId: 'i1',
      role: 'assistant',
      text: 'buy a bkb',
    });
    expect(parseServerEvent(serverEvents.userTranscriptDone('u1', 'should i'))).toEqual({
      kind: 'transcript.done',
      itemId: 'u1',
      role: 'user',
      text: 'should i',
    });
  });

  it('reads function-call deltas and completions', () => {
    expect(parseServerEvent(serverEvents.toolDelta('call_1', 'get_timings', '{"a"'))).toEqual({
      kind: 'tool.delta',
      callId: 'call_1',
      name: 'get_timings',
      delta: '{"a"',
    });
    expect(parseServerEvent(serverEvents.toolDone('call_1', '{"a":1}'))).toEqual({
      kind: 'tool.done',
      callId: 'call_1',
      argumentsJson: '{"a":1}',
    });
  });

  it('reads usage off response.done, including cached tokens', () => {
    const event = parseServerEvent(
      serverEvents.responseDone('r1', { input: 2000, output: 300, cached: 1500 }),
    );
    expect(event).toMatchObject({
      kind: 'response.done',
      usage: { inputTokens: 2000, outputTokens: 300, cachedInputTokens: 1500 },
    });
  });

  it('survives a response.done with no usage block', () => {
    expect(parseServerEvent({ type: 'response.done', response: { id: 'r1' } })).toEqual({
      kind: 'response.done',
      responseId: 'r1',
      usage: null,
    });
  });

  it('reads remaining token budget off rate_limits.updated', () => {
    expect(
      parseServerEvent({
        type: 'rate_limits.updated',
        rate_limits: [
          { name: 'requests', remaining: 199 },
          { name: 'tokens', remaining: 38_000 },
        ],
      }),
    ).toEqual({ kind: 'rate-limits', remainingTokens: 38_000 });
  });

  it('reads errors', () => {
    expect(parseServerEvent(serverEvents.error('rate_limit_exceeded', 'Slow down'))).toEqual({
      kind: 'error',
      code: 'rate_limit_exceeded',
      message: 'Slow down',
    });
  });

  it('degrades to a usable event when fields are missing rather than throwing', () => {
    expect(parseServerEvent({ type: 'response.output_audio.done' })).toEqual({
      kind: 'audio.done',
      itemId: '',
      durationMs: null,
    });
  });
});
