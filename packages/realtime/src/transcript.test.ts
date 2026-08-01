import { describe, expect, it } from 'vitest';
import { createTranscriptStream } from './transcript.js';
import type { TranscriptChunk } from './transcript.js';
import type { ItemId, MonoMs, TurnId } from './types.js';

const TURN = 'turn_1' as TurnId;
const ITEM = 'item_1' as ItemId;
const AT = 1000 as MonoMs;

function collect() {
  const stream = createTranscriptStream();
  const chunks: TranscriptChunk[] = [];
  stream.onChunk((chunk) => chunks.push(chunk));
  return { stream, chunks };
}

describe('agent transcripts', () => {
  it('accumulates deltas into partials for captions', () => {
    const { stream, chunks } = collect();
    stream.appendAgent(TURN, ITEM, 'you have ', AT);
    stream.appendAgent(TURN, ITEM, 'the gold', AT);

    expect(chunks.map((chunk) => chunk.text)).toEqual(['you have ', 'you have the gold']);
    expect(chunks.every((chunk) => !chunk.final)).toBe(true);
  });

  it('takes the completion as authoritative over the accumulation', () => {
    // Deltas can be dropped by a lossy transport; the done event carries the whole string.
    const { stream, chunks } = collect();
    stream.appendAgent(TURN, ITEM, 'you have the g', AT);
    stream.completeAgent(TURN, ITEM, 'you have the gold for a black king bar', AT);

    expect(chunks.at(-1)).toMatchObject({
      text: 'you have the gold for a black king bar',
      final: true,
    });
  });

  it('falls back to the accumulation when the completion is empty', () => {
    const { stream, chunks } = collect();
    stream.appendAgent(TURN, ITEM, 'partial only', AT);
    stream.completeAgent(TURN, ITEM, '', AT);
    expect(chunks.at(-1)?.text).toBe('partial only');
  });

  it('ignores deltas that arrive after the completion', () => {
    const { stream, chunks } = collect();
    stream.completeAgent(TURN, ITEM, 'done', AT);
    stream.appendAgent(TURN, ITEM, ' and more', AT);
    expect(chunks).toHaveLength(1);
  });
});

describe('player transcripts', () => {
  /**
   * There are no player deltas: the ASR pass runs over the whole utterance, so the first thing we
   * ever hear about it is the result (§6.1).
   */
  it('arrive only as a completion, and are final', () => {
    const { stream, chunks } = collect();
    stream.completePlayer(TURN, 'u1' as ItemId, 'should I buy a bkb', AT);
    expect(chunks).toEqual([
      { role: 'player', turnId: TURN, text: 'should I buy a bkb', final: true, at: AT },
    ]);
  });
});

describe('barge-in', () => {
  it('finalises what was transcribed up to the cut, and returns it', () => {
    const { stream, chunks } = collect();
    stream.appendAgent(TURN, ITEM, 'you should really consider', AT);

    expect(stream.cut(ITEM, 2000 as MonoMs)).toBe('you should really consider');
    expect(chunks.at(-1)).toMatchObject({ final: true, text: 'you should really consider' });
  });

  it('is a no-op for an item that already completed', () => {
    const { stream } = collect();
    stream.completeAgent(TURN, ITEM, 'finished', AT);
    expect(stream.cut(ITEM, 2000 as MonoMs)).toBeNull();
  });

  it('is a no-op for an item that never opened', () => {
    // An interrupt with nothing in flight is ordinary, not an error.
    const { stream } = collect();
    expect(stream.cut('nope' as ItemId, AT)).toBeNull();
  });
});

describe('lifecycle', () => {
  it('reset drops accumulated state without notifying', () => {
    const { stream, chunks } = collect();
    stream.appendAgent(TURN, ITEM, 'text', AT);
    const before = chunks.length;

    stream.reset();
    expect(chunks).toHaveLength(before);

    // The same item id can now open again from scratch.
    stream.appendAgent(TURN, ITEM, 'fresh', AT);
    expect(chunks.at(-1)?.text).toBe('fresh');
  });

  it('stops notifying an unsubscribed listener', () => {
    const stream = createTranscriptStream();
    const chunks: TranscriptChunk[] = [];
    stream.onChunk((chunk) => chunks.push(chunk))();
    stream.completePlayer(TURN, ITEM, 'ignored', AT);
    expect(chunks).toEqual([]);
  });
});
