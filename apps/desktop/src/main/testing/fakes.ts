/**
 * Fakes for every seam the overlay's main-process code takes by injection.
 *
 * They exist so the runtime, the presenter, the pump and the window controller can all be driven
 * in Vitest with no Electron, no display and no clock — REPO_SKELETON.md §5.2's rule applied to
 * this component. Tier 5 is the only place a real window is allowed to appear.
 */

import type {
  LevelFrame,
  LevelSource,
  Millis,
  OverlayCommand,
  OverlayIntent,
  TrayGlyph,
  ChipViewModel,
} from '../../shared/overlay.js';
import type {
  AudioEffectSink,
  Clock,
  ConfirmKeyGrabber,
  OverlayEffectSink,
  TelemetrySink,
  TrayEffectSink,
  VoiceCommandSink,
} from '../session/contracts.js';
import type { ConfirmKey, EarconId, TimerId, VoiceCommand } from '../session/types.js';
import type { Rectangle } from '../overlay/contracts.js';
import type { OverlayWindow, OverlayWindowFactory } from '../overlay/window-port.js';

// ---------------------------------------------------------------------------------------------

export interface FakeClock extends Clock {
  /** Moves time forward, firing everything that comes due on the way. */
  advance(byMs: Millis): void;
  set(toMs: Millis): void;
  readonly scheduled: readonly TimerId[];
}

export function createFakeClock(startMs: Millis = 0): FakeClock {
  let current = startMs;
  const timers = new Map<TimerId, { dueAt: Millis; fire: () => void }>();

  return {
    now: () => current,

    schedule(id, delayMs, fire) {
      timers.set(id, { dueAt: current + delayMs, fire });
    },

    cancel(id) {
      timers.delete(id);
    },

    cancelAll() {
      timers.clear();
    },

    advance(byMs) {
      this.set(current + byMs);
    },

    set(toMs) {
      // Fire in due order, and re-read the map each pass: a timer's callback may schedule another.
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.dueAt <= toMs)
          .sort((a, b) => a[1].dueAt - b[1].dueAt)[0];
        if (due === undefined) break;
        const [id, timer] = due;
        timers.delete(id);
        current = Math.max(current, timer.dueAt);
        timer.fire();
      }
      current = Math.max(current, toMs);
    },

    get scheduled() {
      return [...timers.keys()];
    },
  };
}

// ---------------------------------------------------------------------------------------------

export interface RecordedOverlay extends OverlayEffectSink {
  readonly visibility: readonly { visible: boolean; holdMs?: Millis }[];
  readonly models: readonly ChipViewModel[];
  readonly levels: readonly { running: boolean; source: LevelSource }[];
}

export function recordOverlay(): RecordedOverlay {
  const visibility: { visible: boolean; holdMs?: Millis }[] = [];
  const models: ChipViewModel[] = [];
  const levels: { running: boolean; source: LevelSource }[] = [];

  return {
    visibility,
    models,
    levels,
    setVisible(visible, holdMs) {
      visibility.push(holdMs === undefined ? { visible } : { visible, holdMs });
    },
    project(model) {
      models.push(model);
    },
    setLevels(running, source) {
      levels.push({ running, source });
    },
  };
}

export interface RecordedTray extends TrayEffectSink {
  readonly glyphs: readonly TrayGlyph[];
}

export function recordTray(): RecordedTray {
  const glyphs: TrayGlyph[] = [];
  return { glyphs, set: (glyph) => void glyphs.push(glyph) };
}

export interface RecordedVoice extends VoiceCommandSink {
  readonly commands: readonly VoiceCommand[];
}

export function recordVoice(): RecordedVoice {
  const commands: VoiceCommand[] = [];
  return { commands, send: (command) => void commands.push(command) };
}

export interface RecordedAudio extends AudioEffectSink {
  readonly earcons: readonly EarconId[];
  readonly ducking: readonly boolean[];
}

export function recordAudio(): RecordedAudio {
  const earcons: EarconId[] = [];
  const ducking: boolean[] = [];
  return {
    earcons,
    ducking,
    earcon: (sound) => void earcons.push(sound),
    duck: (on) => void ducking.push(on),
  };
}

export interface RecordedKeys extends ConfirmKeyGrabber {
  readonly grabs: readonly (readonly ConfirmKey[])[];
  readonly releases: number;
  readonly held: readonly ConfirmKey[];
}

export function recordKeys(): RecordedKeys {
  const grabs: (readonly ConfirmKey[])[] = [];
  let releases = 0;
  let held: readonly ConfirmKey[] = [];

  return {
    grabs,
    get releases() {
      return releases;
    },
    get held() {
      return held;
    },
    grab(keys) {
      grabs.push(keys);
      held = keys;
    },
    release() {
      releases += 1;
      held = [];
    },
  };
}

export interface RecordedTelemetry extends TelemetrySink {
  readonly transitions: readonly { from: string; to: string; at: Millis }[];
  readonly latencies: readonly Millis[];
  readonly faults: readonly string[];
}

export function recordTelemetry(): RecordedTelemetry {
  const transitions: { from: string; to: string; at: Millis }[] = [];
  const latencies: Millis[] = [];
  const faults: string[] = [];

  return {
    transitions,
    latencies,
    faults,
    transition: (from, to, at) => void transitions.push({ from, to, at }),
    visibilityLatency: (ms) => void latencies.push(ms),
    rendererFault: (message) => void faults.push(message),
  };
}

// ---------------------------------------------------------------------------------------------

export interface FakeOverlayWindow extends OverlayWindow {
  readonly commands: readonly OverlayCommand[];
  readonly frames: readonly LevelFrame[];
  readonly bounds: Rectangle | null;
  readonly contentProtection: boolean;
  readonly loads: number;
  readonly destroyed: boolean;
  /** Drives the renderer's half of the bridge. */
  emitIntent(intent: OverlayIntent): void;
}

export function createFakeWindow(): FakeOverlayWindow {
  const commands: OverlayCommand[] = [];
  const frames: LevelFrame[] = [];
  const intentListeners = new Set<(intent: OverlayIntent) => void>();

  let visible = false;
  let bounds: Rectangle | null = null;
  let contentProtection = false;
  let loads = 0;
  let destroyed = false;

  return {
    commands,
    frames,
    get bounds() {
      return bounds;
    },
    get contentProtection() {
      return contentProtection;
    },
    get loads() {
      return loads;
    },
    get destroyed() {
      return destroyed;
    },

    load() {
      loads += 1;
      return Promise.resolve();
    },

    showInactive() {
      visible = true;
    },

    hide() {
      visible = false;
    },

    isVisible() {
      return visible;
    },

    send(command) {
      commands.push(command);
    },

    sendLevel(frame) {
      frames.push(frame);
    },

    setBounds(next) {
      bounds = next;
    },

    setContentProtection(on) {
      contentProtection = on;
    },

    onIntent(fn) {
      intentListeners.add(fn);
      return () => intentListeners.delete(fn);
    },

    destroy() {
      destroyed = true;
      visible = false;
      intentListeners.clear();
    },

    emitIntent(intent) {
      for (const listener of [...intentListeners]) listener(intent);
    },
  };
}

export function fakeWindowFactory(window: FakeOverlayWindow): OverlayWindowFactory {
  return { create: () => window };
}
