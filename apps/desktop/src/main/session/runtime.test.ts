import { describe, expect, it } from 'vitest';

import {
  createFakeClock,
  recordAudio,
  recordOverlay,
  recordTelemetry,
  recordTray,
  recordVoice,
  type FakeClock,
  type RecordedAudio,
  type RecordedOverlay,
  type RecordedTelemetry,
  type RecordedTray,
  type RecordedVoice,
} from '../testing/fakes.js';
import { machine } from './machine.js';
import { createSessionRuntime } from './runtime.js';
import { DEFAULT_ENVIRONMENT, ELAPSED_HINT_MS, HIDE_HOLD_MS } from './timing.js';
import type { SessionRuntime } from './contracts.js';

interface Harness {
  readonly runtime: SessionRuntime;
  readonly clock: FakeClock;
  readonly overlay: RecordedOverlay;
  readonly tray: RecordedTray;
  readonly voice: RecordedVoice;
  readonly audio: RecordedAudio;
  readonly telemetry: RecordedTelemetry;
}

function harness(): Harness {
  const clock = createFakeClock(1_000);
  const overlay = recordOverlay();
  const tray = recordTray();
  const voice = recordVoice();
  const audio = recordAudio();
  const telemetry = recordTelemetry();

  const runtime = createSessionRuntime(
    { machine, clock, overlay, tray, voice, audio, telemetry },
    DEFAULT_ENVIRONMENT,
  );

  return { runtime, clock, overlay, tray, voice, audio, telemetry };
}

/**
 * Drive the runtime into Speaking.
 *
 * Four inputs where one used to do: the machine reached Speaking from Idle on an `unprompted`
 * input until ADR-0042 removed it, and the only way there now is the way a player gets there — a
 * press, audio, a release, and a response.
 */
function speak(runtime: SessionRuntime): void {
  runtime.dispatch({ kind: 'trigger', event: { kind: 'down' } });
  runtime.dispatch({ kind: 'capture', event: 'firstAudio' });
  runtime.dispatch({ kind: 'trigger', event: { kind: 'up' } });
  runtime.dispatch({ kind: 'turn', event: 'responseStarted' });
}

describe('createSessionRuntime', () => {
  it('projects one model at construction, so a reload has something to re-send', () => {
    const { overlay, tray } = harness();
    expect(overlay.models).toHaveLength(1);
    expect(overlay.models[0]?.state).toBe('hidden');
    expect(tray.glyphs).toEqual(['idle']);
  });

  it('shows the window before it does anything else on the key press', () => {
    const { runtime, overlay, audio } = harness();
    const order: string[] = [];

    const originalSetVisible = overlay.setVisible.bind(overlay);
    const originalEarcon = audio.earcon.bind(audio);
    Object.assign(overlay, {
      setVisible: (visible: boolean, holdMs?: number) => {
        order.push(`window:${String(visible)}`);
        originalSetVisible(visible, holdMs);
      },
    });
    Object.assign(audio, {
      earcon: (sound: 'capture-start' | 'capture-end' | 'error') => {
        order.push(`earcon:${sound}`);
        originalEarcon(sound);
      },
    });

    runtime.dispatch({ kind: 'trigger', event: { kind: 'down' } });

    expect(order[0]).toBe('window:true');
  });

  it('applies every effect before dispatch returns', () => {
    const { runtime, overlay, audio, clock } = harness();
    runtime.dispatch({ kind: 'trigger', event: { kind: 'down' } });

    // Synchronous: no timers advanced, no microtasks awaited.
    expect(overlay.visibility).toContainEqual({ visible: true });
    expect(overlay.levels).toContainEqual({ running: true, source: 'input' });
    expect(audio.earcons).toEqual(['capture-start']);
    expect(clock.scheduled).toEqual(['listen-timeout']);
  });

  it('carries the hide hold through to the window', () => {
    const { runtime, overlay } = harness();
    runtime.dispatch({ kind: 'trigger', event: { kind: 'down' } });
    runtime.dispatch({ kind: 'trigger', event: { kind: 'cancel' } });

    expect(overlay.visibility.at(-1)).toEqual({ visible: false, holdMs: HIDE_HOLD_MS });
  });

  it('fires a scheduled timer back into itself', () => {
    const { runtime, clock, overlay } = harness();
    runtime.dispatch({ kind: 'trigger', event: { kind: 'down' } });
    runtime.dispatch({ kind: 'capture', event: 'firstAudio' });
    runtime.dispatch({ kind: 'trigger', event: { kind: 'up' } });

    const before = overlay.models.length;
    clock.advance(ELAPSED_HINT_MS);

    expect(overlay.models.length).toBeGreaterThan(before);
    expect(overlay.models.at(-1)?.text?.elapsedMs).toBeDefined();
  });

  it('lets the listen timeout become an error without a real clock', () => {
    const { runtime, clock } = harness();
    runtime.dispatch({ kind: 'trigger', event: { kind: 'down' } });
    runtime.dispatch({ kind: 'capture', event: 'firstAudio' });

    clock.advance(DEFAULT_ENVIRONMENT.listenTimeoutMs);

    expect(runtime.snapshot().phase.kind).toBe('error');
  });

  it('cancels a timer that its phase no longer needs', () => {
    const { runtime, clock } = harness();
    runtime.dispatch({ kind: 'trigger', event: { kind: 'down' } });
    expect(clock.scheduled).toEqual(['listen-timeout']);

    runtime.dispatch({ kind: 'trigger', event: { kind: 'cancel' } });
    expect(clock.scheduled).toEqual([]);
  });

  it('sends voice commands out through the voice sink and nowhere else', () => {
    const { runtime, voice } = harness();
    speak(runtime);
    runtime.dispatch({ kind: 'trigger', event: { kind: 'down' } });

    expect(voice.commands).toEqual([{ kind: 'interrupt', at: 1_000 }]);
  });

  it('ducks on the way into Speaking and off on the way out', () => {
    const { runtime, audio } = harness();
    speak(runtime);
    expect(audio.ducking).toEqual([true]);

    runtime.dispatch({ kind: 'turn', event: 'responseEnded' });
    expect(audio.ducking).toEqual([true, false]);
  });

  it('keeps the tray and the chip as two projections of one state', () => {
    const { runtime, tray, overlay } = harness();
    runtime.dispatch({ kind: 'trigger', event: { kind: 'down' } });

    expect(overlay.models.at(-1)?.state).toBe('armed');
    expect(tray.glyphs.at(-1)).toBe('active');
  });

  it('records transitions for telemetry, and only real ones', () => {
    const { runtime, telemetry } = harness();
    runtime.dispatch({ kind: 'trigger', event: { kind: 'down' } });
    runtime.dispatch({ kind: 'capture', event: 'opened' });

    expect(telemetry.transitions).toEqual([{ from: 'idle', to: 'armed', at: 1_000 }]);
  });

  it('notifies subscribers, and stops when they unsubscribe', () => {
    const { runtime } = harness();
    const seen: string[] = [];
    const off = runtime.subscribe((s) => seen.push(s.phase.kind));

    runtime.dispatch({ kind: 'trigger', event: { kind: 'down' } });
    off();
    runtime.dispatch({ kind: 'trigger', event: { kind: 'cancel' } });

    expect(seen).toEqual(['armed']);
  });

  it('queues a re-entrant dispatch instead of interleaving two effect lists', () => {
    const { runtime, overlay } = harness();
    let reentered = false;

    runtime.subscribe((s) => {
      if (s.phase.kind === 'armed' && !reentered) {
        reentered = true;
        runtime.dispatch({ kind: 'trigger', event: { kind: 'cancel' } });
      }
    });

    runtime.dispatch({ kind: 'trigger', event: { kind: 'down' } });

    // Show fully applied before the cancel's hide, rather than the two lists interleaving.
    const visibility = overlay.visibility.map((v) => v.visible);
    expect(visibility).toEqual([true, false]);
    expect(runtime.snapshot().phase.kind).toBe('idle');
  });

  it('goes quiet after dispose', () => {
    const { runtime, clock, overlay } = harness();
    runtime.dispatch({ kind: 'trigger', event: { kind: 'down' } });
    const models = overlay.models.length;

    runtime.dispose();
    runtime.dispatch({ kind: 'trigger', event: { kind: 'cancel' } });
    clock.advance(60_000);

    expect(overlay.models).toHaveLength(models);
    expect(clock.scheduled).toEqual([]);
  });
});
