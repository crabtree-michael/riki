import { describe, expect, it } from 'vitest';
import { AudioCaptureStream } from './stream.js';
import { REALTIME_SAMPLE_RATE } from '../types.js';
import {
  dominantFrequency,
  FakeAudioDevice,
  generateSilence,
  generateTone,
  RecordingChunkSink,
} from '../testing/index.js';
import type { CaptureEvent } from './stream.js';
import type { SpeechEvent } from '../levels/silence.js';

function harness(deviceRate = 48_000) {
  const source = new FakeAudioDevice({ sampleRate: deviceRate });
  const sink = new RecordingChunkSink();
  const stream = new AudioCaptureStream({ source, sink });
  const capture: CaptureEvent[] = [];
  const speech: SpeechEvent[] = [];
  stream.onCapture((event) => capture.push(event));
  stream.onSpeech((event) => speech.push(event));
  return { source, sink, stream, capture, speech };
}

describe('lifecycle', () => {
  it('emits opened, then firstAudio only once the device actually delivers', async () => {
    const { source, stream, capture } = harness();
    await stream.open();
    expect(capture).toEqual(['opened']);

    source.pump(generateTone({ frequency: 440, sampleRate: 48_000, durationMs: 50 }));
    expect(capture).toEqual(['opened', 'firstAudio']);

    source.pump(generateTone({ frequency: 440, sampleRate: 48_000, durationMs: 50 }));
    expect(capture.filter((event) => event === 'firstAudio')).toHaveLength(1);
  });

  it('emits closed and stops the device', async () => {
    const { source, stream, capture } = harness();
    await stream.open();
    await stream.close();
    expect(capture.at(-1)).toBe('closed');
    expect(source.started).toBe(false);
  });

  it('drops frames that arrive after close', async () => {
    const { source, sink, stream } = harness();
    await stream.open();
    await stream.close();
    sink.clear();
    source.pump(generateTone({ frequency: 440, sampleRate: 48_000, durationMs: 50 }));
    expect(sink.chunks).toEqual([]);
  });

  it('reports a fault instead of throwing when the device will not start', async () => {
    const source = new FakeAudioDevice({
      failOnStart: { kind: 'mic-denied', message: 'Permission denied' },
    });
    const stream = new AudioCaptureStream({ source, sink: new RecordingChunkSink() });
    const faults: string[] = [];
    stream.onFault((fault) => faults.push(fault.kind));

    await stream.open();

    expect(faults).toEqual(['no-input-device']);
    expect(stream.isOpen).toBe(false);
    expect(stream.levels.running).toBe(false);
  });
});

describe('the signal reaching the session', () => {
  it('arrives at the Realtime rate, whatever the device runs at', async () => {
    for (const deviceRate of [44_100, 48_000]) {
      const { source, sink, stream } = harness(deviceRate);
      await stream.open();
      source.pump(generateTone({ frequency: 440, sampleRate: deviceRate, durationMs: 300 }));

      const captured = sink.concat();
      const guard = Math.round(REALTIME_SAMPLE_RATE * 0.03);
      const analysed = captured.subarray(guard, guard + 4096);

      expect(dominantFrequency(analysed, REALTIME_SAMPLE_RATE)).toBeCloseTo(440, 0);
      // ~300 ms at 24 kHz, within a filter's worth of latency.
      expect(captured.length).toBeGreaterThan(0.3 * REALTIME_SAMPLE_RATE - 100);
    }
  });

  it('drains the resampler tail on close, so the last syllable is not clipped', async () => {
    const { source, sink, stream } = harness();
    await stream.open();
    source.pump(generateTone({ frequency: 440, sampleRate: 48_000, durationMs: 100 }));
    const beforeClose = sink.concat().length;
    await stream.close();
    expect(sink.concat().length).toBeGreaterThan(beforeClose);
  });
});

describe('levels and silence', () => {
  it('runs the level pump only while capture is open', async () => {
    const { stream, source } = harness();
    expect(stream.levels.running).toBe(false);
    await stream.open();
    expect(stream.levels.running).toBe(true);
    source.pump(generateTone({ frequency: 440, sampleRate: 48_000, durationMs: 20 }));
    await stream.close();
    expect(stream.levels.running).toBe(false);
  });

  it('reports silence and resumption for the chip nudge', async () => {
    const { source, stream, speech } = harness();
    await stream.open();

    source.pump(generateTone({ frequency: 440, sampleRate: 48_000, durationMs: 200 }));
    source.pump(generateSilence(48_000, 1200));
    expect(speech).toEqual(['silence']);

    source.pump(generateTone({ frequency: 440, sampleRate: 48_000, durationMs: 200 }));
    expect(speech).toEqual(['silence', 'resumed']);
  });

  it('takes levels before resampling, so the bars do not wait on filter delay', async () => {
    const { source, stream } = harness();
    const samples: number[] = [];
    stream.onLevel((sample) => samples.push(sample.value));
    await stream.open();

    // One 10 ms chunk — fewer samples than the resampler needs to emit anything at all.
    source.pump(generateTone({ frequency: 440, sampleRate: 48_000, durationMs: 10 }));
    expect(samples.length).toBeGreaterThan(0);
    expect(samples[0] ?? 0).toBeGreaterThan(0);
  });
});
