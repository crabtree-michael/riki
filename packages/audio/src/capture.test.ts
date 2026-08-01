/**
 * The capture graph, against `FakeAudioDevice`.
 *
 * The assertion that matters most is the privacy one from §11: **gate closed means no signal
 * leaves.** ADR-0016 trades the OS microphone indicator staying lit for the whole match against
 * the timing budgets, and the thing that makes that trade honest is that the gate is upstream of
 * the track rather than a flag on it — so "nothing is transmitted" is a statement about
 * `device.outbound()` rather than a promise in a document.
 */

import { describe, expect, it } from 'vitest';
import { createFakeAudioDevice, createFakeCaptureGraph } from './testing/index.js';
import { DEFAULT_CAPTURE_OPTIONS } from './capture.js';

const RATE = 48_000;

function harness(options = DEFAULT_CAPTURE_OPTIONS) {
  const device = createFakeAudioDevice(RATE);
  const graph = createFakeCaptureGraph(device, options);
  const speech: string[] = [];
  graph.onSpeech((event) => speech.push(event));
  return { device, graph, speech };
}

function speak(device: ReturnType<typeof createFakeAudioDevice>, durationMs: number): void {
  device.pushTone({ hz: 300, sampleRate: RATE, durationMs, amplitude: 0.4 });
}

describe('the gate — the privacy claim', () => {
  it('is shut before anything opens it', () => {
    const { device } = harness();
    expect(device.gateChanges()[0]).toEqual({ value: 0, rampMs: 0 });
  });

  it('lets nothing reach the outbound track while closed', () => {
    const { device, graph } = harness();
    expect(graph.isOpen).toBe(false);

    for (let i = 0; i < 20; i += 1) speak(device, 33);

    expect(device.outbound()).toEqual([]);
  });

  it('lets audio through once opened, and stops again on close', () => {
    const { device, graph } = harness();

    graph.open();
    speak(device, 33);
    expect(device.outbound()).toHaveLength(1);

    graph.close();
    speak(device, 33);
    expect(device.outbound()).toHaveLength(1);
  });

  it('ramps rather than switching — a click is audible and VAD sometimes reads it as speech', () => {
    const { device, graph } = harness();
    graph.open();
    expect(device.gateChanges().at(-1)).toEqual({
      value: 1,
      rampMs: DEFAULT_CAPTURE_OPTIONS.gateRampMs,
    });
    expect(DEFAULT_CAPTURE_OPTIONS.gateRampMs).toBeGreaterThan(0);
  });

  it('is idempotent, so a repeated key-down does not re-ramp', () => {
    const { device, graph } = harness();
    graph.open();
    const after = device.gateChanges().length;
    graph.open();
    expect(device.gateChanges()).toHaveLength(after);
  });
});

describe('the analyser runs whether or not the gate is open', () => {
  /**
   * §3.2: the analyser is upstream of the gate, which is what lets `speech.silence` and
   * `speech.resumed` exist for the machine's nudge and 8 s listen-timeout without asking the
   * server anything. It also means the level bars can move before the gate opens.
   */
  it('reports levels with the gate shut', () => {
    const { device } = harness();
    speak(device, 33);
    expect(device.levels().length).toBeGreaterThan(0);
    expect(device.levels().at(-1)?.rms ?? 0).toBeGreaterThan(0);
  });

  it('reports silence and resumption without the server', () => {
    const { device, graph, speech } = harness();
    graph.open();

    speak(device, 200);
    for (let i = 0; i < 20; i += 1) device.pushSilence(33);
    expect(speech).toEqual(['silence']);

    speak(device, 100);
    expect(speech).toEqual(['silence', 'resumed']);
  });

  it('does not fire on the gap between two words', () => {
    const { device, graph, speech } = harness();
    graph.open();
    speak(device, 200);
    // ~150 ms of gap, under the 250 ms hold.
    for (let i = 0; i < 4; i += 1) device.pushSilence(33);
    speak(device, 100);
    expect(speech).toEqual([]);
  });

  it('starts a turn as speaking, so the chip does not dim on the first frame', () => {
    const { device, graph, speech } = harness();
    graph.open();
    for (let i = 0; i < 20; i += 1) device.pushSilence(33);
    expect(speech).toEqual(['silence']);

    graph.close();
    graph.open();
    speak(device, 50);
    // Reopening resets to speaking; no spurious second 'silence' from the stale state.
    expect(speech.filter((event) => event === 'silence')).toHaveLength(1);
  });
});

describe('device swap', () => {
  /**
   * §3.5: unplugging a headset mid-match is ordinary. The swap must not touch the gate, the track
   * identity or the peer connection — otherwise it renegotiates SDP and interrupts a turn.
   */
  it('keeps the outbound track identity', async () => {
    const { device, graph } = harness();
    const before = graph.outbound.id;
    await graph.replaceStream({ id: 'another-mic' });
    expect(graph.outbound.id).toBe(before);
    expect(device.gateChanges()).toHaveLength(1);
  });

  it('keeps an open turn open across the swap', async () => {
    const { device, graph } = harness();
    graph.open();
    await graph.replaceStream({ id: 'another-mic' });

    expect(graph.isOpen).toBe(true);
    speak(device, 33);
    expect(device.outbound()).toHaveLength(1);
  });
});

describe('dispose', () => {
  it('stops emitting and closes the gate', async () => {
    const { device, graph } = harness();
    graph.open();
    await graph.dispose();

    const before = device.levels().length;
    speak(device, 33);
    expect(device.levels()).toHaveLength(before);
    expect(graph.isOpen).toBe(false);
  });
});
