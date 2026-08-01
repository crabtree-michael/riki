/**
 * The tape's two properties, and both look odd until you see what they are for:
 *
 * - it records **detections rather than utterances**, so a model can be told what it missed; and
 * - it selects by salience and then orders by time, because priority decides what survives the
 *   snapshot's budget while chronology decides how the line reads.
 */

import { describe, expect, it } from 'vitest';
import { asGameClock, asMonoMs } from '@riki/world-model';
import type { CoachEvent } from './types.js';
import { detectionKey, eventTopic } from './types.js';
import { createEventTape } from './tape.js';

function event(text: string, salience: number, atGameClock: number | null): CoachEvent {
  return {
    id: 'ult_ready' as CoachEvent['id'],
    kind: 'ult_ready',
    key: detectionKey('ult_ready', text),
    topic: eventTopic('ult_ready'),
    salience,
    detection: {
      kind: 'ult_ready',
      key: detectionKey('ult_ready', text),
      topic: eventTopic('ult_ready'),
      magnitude: 1,
      actWithinSeconds: null,
      confidence: 1,
      text,
      atGameClock: atGameClock === null ? null : asGameClock(atGameClock),
    },
    at: asMonoMs(0),
  };
}

describe('the event tape', () => {
  it('renders what happened, in the order it happened', () => {
    const tape = createEventTape();
    tape.record(event('first', 0.5, 100));
    tape.record(event('second', 0.5, 200));

    expect(tape.recent(5, null).map((e) => e.text)).toEqual(['first', 'second']);
  });

  it('keeps the most salient when asked for fewer than it holds', () => {
    const tape = createEventTape();
    tape.record(event('dull', 0.1, 100));
    tape.record(event('loud', 0.9, 200));
    tape.record(event('quiet', 0.2, 300));

    expect(tape.recent(2, null).map((e) => e.text)).toEqual(['loud', 'quiet']);
  });

  it('returns them newest last even when the loudest is oldest', () => {
    const tape = createEventTape();
    tape.record(event('loud', 0.9, 100));
    tape.record(event('quiet', 0.2, 300));

    expect(tape.recent(2, null).map((e) => e.text)).toEqual(['loud', 'quiet']);
  });

  it('filters by game clock when asked', () => {
    const tape = createEventTape();
    tape.record(event('old', 0.9, 100));
    tape.record(event('new', 0.5, 500));

    expect(tape.recent(5, asGameClock(400)).map((e) => e.text)).toEqual(['new']);
  });

  it('drops a pre-horn detection rather than stamping it at 0:00', () => {
    const tape = createEventTape();
    tape.record(event('draft', 0.9, null));
    expect(tape.recent(5, null)).toHaveLength(0);
  });

  it('carries the event id, which is what the snapshot renders it as', () => {
    const tape = createEventTape();
    tape.record(event('up', 0.5, 100));
    expect(tape.recent(1, null)[0]?.id).toBe('ult_ready');
  });

  it('bounds what it holds', () => {
    const tape = createEventTape({ capacity: 2 });
    tape.record(event('a', 0.5, 100));
    tape.record(event('b', 0.5, 200));
    tape.record(event('c', 0.5, 300));

    expect(tape.recent(10, null).map((e) => e.text)).toEqual(['b', 'c']);
  });

  it('answers nothing for a non-positive count', () => {
    const tape = createEventTape();
    tape.record(event('a', 0.5, 100));
    expect(tape.recent(0, null)).toHaveLength(0);
  });
});
