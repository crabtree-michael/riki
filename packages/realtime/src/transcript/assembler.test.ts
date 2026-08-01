import { describe, expect, it } from 'vitest';
import { TranscriptAssembler } from './assembler.js';

describe('TranscriptAssembler', () => {
  it('emits partials for captions and finals for the ledger', () => {
    const assembler = new TranscriptAssembler();
    expect(assembler.delta('i1', 'assistant', 'buy ', 0).final).toBe(false);
    expect(assembler.delta('i1', 'assistant', 'a bkb', 10).text).toBe('buy a bkb');
    expect(assembler.complete('i1', 'assistant', 'buy a bkb', 20).final).toBe(true);
  });

  it('takes the completed transcript as authoritative over accumulated deltas', () => {
    // Deltas can be dropped by a lossy transport; the completion carries the whole string.
    const assembler = new TranscriptAssembler();
    assembler.delta('i1', 'assistant', 'buy a b', 0);
    expect(assembler.complete('i1', 'assistant', 'buy a black king bar', 10).text).toBe(
      'buy a black king bar',
    );
  });

  it('handles a user transcript that arrives only as a completion', () => {
    const assembler = new TranscriptAssembler();
    const entry = assembler.complete('u1', 'user', 'should I buy a bkb', 0);
    expect(entry).toMatchObject({ role: 'user', text: 'should I buy a bkb', final: true });
  });

  it('finalises what the user actually heard on barge-in', () => {
    const assembler = new TranscriptAssembler();
    assembler.delta('i1', 'assistant', 'you should really consider', 0);
    const cut = assembler.truncate('i1', 50);
    expect(cut).toMatchObject({ text: 'you should really consider', final: true });
  });

  it('does not re-truncate an already-final entry', () => {
    const assembler = new TranscriptAssembler();
    assembler.complete('i1', 'assistant', 'done', 0);
    expect(assembler.truncate('i1', 10)).toBeNull();
  });

  it('history is finals only, in conversation order', () => {
    const assembler = new TranscriptAssembler();
    assembler.complete('u1', 'user', 'question', 0);
    assembler.delta('i1', 'assistant', 'partial', 10);
    assembler.complete('i2', 'assistant', 'answer', 20);

    expect(assembler.history().map((entry) => entry.text)).toEqual(['question', 'answer']);
  });

  it('drops compacted turns so it does not hold a whole match in memory', () => {
    const assembler = new TranscriptAssembler();
    assembler.complete('i1', 'user', 'one', 0);
    assembler.complete('i2', 'assistant', 'two', 10);
    assembler.complete('i3', 'user', 'three', 20);

    assembler.forgetThrough('i2');
    expect(assembler.history().map((entry) => entry.text)).toEqual(['three']);
  });

  it('ignores a compaction cut for an item it never saw', () => {
    const assembler = new TranscriptAssembler();
    assembler.complete('i1', 'user', 'one', 0);
    assembler.forgetThrough('nope');
    expect(assembler.history()).toHaveLength(1);
  });
});
