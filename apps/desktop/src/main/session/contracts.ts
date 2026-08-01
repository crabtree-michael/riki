/**
 * The interaction machine and its runtime, as contracts.
 *
 * `MachineModule` is pure — every function on it is a total function of its arguments, `now` is
 * always passed in, and nothing on it may perform I/O. That is what makes the full state × input
 * table a Tier 1 test with no window and no Electron (docs/design/overlay-architecture.md §13).
 *
 * `SessionRuntime` is the only stateful object in the component. Its dependencies are injected so
 * the same tests can run it against a fake clock and a fake window.
 *
 * Declarations only — implementations land with REPO_SKELETON.md §10 step 6, in the order in
 * §15 of the architecture doc.
 */

import type { ChipViewModel, Millis, TrayGlyph, Unsubscribe } from '../../shared/overlay.js';
import type {
  ConfirmKey,
  EarconId,
  MachineEnvironment,
  MachineInput,
  MachineState,
  TimerId,
  Transition,
  VoiceCommand,
} from './types.js';

/** The pure core. No clock, no I/O, no randomness. */
export interface MachineModule {
  initial(env: MachineEnvironment, now: Millis): MachineState;
  reduce(state: Readonly<MachineState>, input: MachineInput, now: Millis): Transition;
  projectChip(state: Readonly<MachineState>, now: Millis): ChipViewModel;
  projectTray(state: Readonly<MachineState>): TrayGlyph;
}

/** Injected so timers are deterministic in tests (§4.6). */
export interface Clock {
  now(): Millis;
  schedule(id: TimerId, delayMs: Millis, fire: () => void): void;
  cancel(id: TimerId): void;
  cancelAll(): void;
}

/** Effects leave the runtime through these four sinks and nowhere else. */
export interface VoiceCommandSink {
  send(command: VoiceCommand): void;
}

export interface AudioEffectSink {
  earcon(sound: EarconId): void;
  duck(on: boolean): void;
}

export interface ConfirmKeyGrabber {
  /** Scoped to Confirming. A permanently grabbed `Y` would eat a game binding mid-match (§4.4). */
  grab(keys: readonly ConfirmKey[]): void;
  release(): void;
}

export interface TelemetrySink {
  transition(from: string, to: string, at: Millis): void;
  /** Key-down → first paint, both timestamps taken on main's clock (§6.1). */
  visibilityLatency(ms: Millis): void;
  rendererFault(message: string): void;
}

export interface SessionRuntimeDeps {
  readonly machine: MachineModule;
  readonly clock: Clock;
  readonly overlay: OverlayEffectSink;
  readonly tray: TrayEffectSink;
  readonly voice: VoiceCommandSink;
  readonly audio: AudioEffectSink;
  readonly keys: ConfirmKeyGrabber;
  readonly telemetry: TelemetrySink;
}

/**
 * The overlay's side of the runtime, kept here as the narrow slice the runtime needs — the full
 * presenter is in main/overlay/contracts.ts.
 */
export interface OverlayEffectSink {
  setVisible(visible: boolean, holdMs?: Millis): void;
  project(model: ChipViewModel): void;
  setLevels(running: boolean, source: 'input' | 'output'): void;
}

export interface TrayEffectSink {
  set(glyph: TrayGlyph): void;
}

export interface SessionRuntime {
  /**
   * Synchronous, and it must stay that way: no `await` may appear between a trigger arriving and
   * the window being shown, or the ≤100 ms budget is spent on scheduling (§9.1).
   */
  dispatch(input: MachineInput): void;
  snapshot(): Readonly<MachineState>;
  subscribe(fn: (state: Readonly<MachineState>) => void): Unsubscribe;
  dispose(): void;
}
