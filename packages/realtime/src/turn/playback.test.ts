/**
 * The guarding test REPO_SKELETON.md §5.4 names:
 *
 * > On simulated interruption, assert a truncate event was sent with a plausible `audio_end_ms`.
 *
 * "Plausible" is the whole assertion. An `audio_end_ms` past the end of the generated audio is
 * rejected by the API; one that is too small tells the model it said less than the user heard.
 * Either way the conversation proceeds on a false premise, which is what research §4 means by
 * "every subsequent turn is built on that false premise".
 */

import { describe, expect, it } from 'vitest';
import { PlaybackTracker } from './playback.js';

describe('PlaybackTracker', () => {
  it('has nothing to truncate when nothing is playing', () => {
    expect(new PlaybackTracker().truncateFor(1000)).toBeNull();
  });

  it('uses wall clock when that is all it has', () => {
    const tracker = new PlaybackTracker();
    tracker.begin('item_1', 1000);
    expect(tracker.truncateFor(1750)).toEqual({
      type: 'conversation.item.truncate',
      item_id: 'item_1',
      content_index: 0,
      audio_end_ms: 750,
    });
  });

  it('prefers the transport’s reported playback position — the only source that reflects output', () => {
    let position = 0;
    const tracker = new PlaybackTracker({ positionMs: () => position });
    tracker.begin('item_1', 1000);

    // Wall clock says 5 s, but the track has only played 400 ms — the user heard 400 ms.
    position = 400;
    expect(tracker.truncateFor(6000)?.audio_end_ms).toBe(400);
  });

  it('never claims more audio was heard than was generated', () => {
    const tracker = new PlaybackTracker();
    tracker.begin('item_1', 0);
    tracker.noteGeneratedMs(1200);
    // Ten seconds of wall clock against 1.2 s of audio: the clamp is what keeps this plausible.
    expect(tracker.truncateFor(10_000)?.audio_end_ms).toBe(1200);
  });

  it('tracks queued audio on the websocket path, where bytes are the ground truth', () => {
    const tracker = new PlaybackTracker();
    tracker.begin('item_1', 0);
    // PCM16 at 24 kHz is 48 bytes per ms. 4,800 bytes is 100 ms.
    tracker.noteAudioBytes(4800);
    // Audio arrives faster than it plays, so the queue is an upper bound and the clock wins.
    expect(tracker.truncateFor(40)?.audio_end_ms).toBe(40);
    expect(tracker.truncateFor(500)?.audio_end_ms).toBe(100);
  });

  it('forgets the item once the turn ends, so a late interrupt truncates nothing', () => {
    const tracker = new PlaybackTracker();
    tracker.begin('item_1', 0);
    tracker.end();
    expect(tracker.truncateFor(500)).toBeNull();
    expect(tracker.speaking).toBe(false);
  });

  it('bills what was generated, not what was heard', () => {
    // §10 bills assistant audio at 1 token / 50 ms. Barging in early saves latency, not money —
    // keeping that visible is the point of the cost meter.
    const tracker = new PlaybackTracker();
    tracker.begin('item_1', 0);
    tracker.noteGeneratedMs(5000);
    expect(tracker.playedMs(100)).toBe(100);
    expect(tracker.generatedTokens()).toBe(100);
  });

  it('resets its accounting between items', () => {
    const tracker = new PlaybackTracker();
    tracker.begin('item_1', 0);
    tracker.noteAudioBytes(48_000);
    tracker.noteGeneratedMs(1000);

    tracker.begin('item_2', 5000);
    expect(tracker.truncateFor(5200)?.item_id).toBe('item_2');
    expect(tracker.truncateFor(5200)?.audio_end_ms).toBe(200);
  });
});
