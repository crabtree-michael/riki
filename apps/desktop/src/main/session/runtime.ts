/**
 * `SessionRuntime` — the machine's state, its timers, and the four sinks its effects leave through.
 *
 * The reducer decides; this performs. Keeping the two apart is what lets the whole state table be
 * a pure Tier 1 test and lets the runtime itself be driven with a fake clock and a fake window,
 * with no Electron (docs/design/overlay-architecture.md §5.1).
 *
 * `dispatch` is synchronous and must stay that way: no `await` may appear between a trigger
 * arriving and the window being shown, or the ≤100 ms budget is spent on scheduling (§9.1).
 */

import type { Millis, Unsubscribe } from '../../shared/overlay.js';
import type { SessionRuntime, SessionRuntimeDeps } from './contracts.js';
import type { Effect, MachineEnvironment, MachineInput, MachineState } from './types.js';

export function createSessionRuntime(
  deps: SessionRuntimeDeps,
  env: MachineEnvironment,
): SessionRuntime {
  const { machine, clock, overlay, tray, voice, audio, keys, telemetry } = deps;

  let state = machine.initial(env, clock.now());
  let disposed = false;

  const subscribers = new Set<(s: Readonly<MachineState>) => void>();

  /**
   * A timer firing, or a subscriber dispatching, can re-enter `dispatch` while effects are still
   * being applied. Queueing rather than recursing keeps effects in the order the reducer emitted
   * them — which matters, because the first one is the show call.
   */
  const queue: MachineInput[] = [];
  let draining = false;

  function dispatch(input: MachineInput): void {
    if (disposed) return;
    queue.push(input);
    if (draining) return;

    draining = true;
    try {
      while (queue.length > 0) {
        const next = queue.shift();
        if (next === undefined) break;
        step(next);
      }
    } finally {
      draining = false;
      queue.length = 0;
    }
  }

  function step(input: MachineInput): void {
    const now = clock.now();
    const before = state;
    const transition = machine.reduce(before, input, now);
    state = transition.state;

    for (const effect of transition.effects) perform(effect, now);

    if (before.phase.kind !== state.phase.kind) {
      telemetry.transition(before.phase.kind, state.phase.kind, now);
    }
    for (const subscriber of subscribers) subscriber(state);
  }

  function perform(effect: Effect, now: Millis): void {
    switch (effect.kind) {
      case 'window':
        overlay.setVisible(effect.visible, effect.holdMs);
        return;

      case 'project':
        overlay.project(machine.projectChip(state, now));
        tray.set(machine.projectTray(state));
        return;

      case 'schedule':
        clock.schedule(effect.id, effect.delayMs, () => {
          dispatch({ kind: 'timer', id: effect.id });
        });
        return;

      case 'cancel':
        clock.cancel(effect.id);
        return;

      case 'levels':
        overlay.setLevels(effect.running, effect.source);
        return;

      case 'earcon':
        // Emitted unconditionally; the sink honours the setting. The machine does not branch on a
        // preference it should not have to hold (§8).
        audio.earcon(effect.sound);
        return;

      case 'duck':
        audio.duck(effect.on);
        return;

      case 'keys':
        if (effect.grab.length > 0) keys.grab(effect.grab);
        else keys.release();
        return;

      case 'voice':
        voice.send(effect.command);
        return;
    }
  }

  // One model before anything happens, so the presenter has something to re-send when the renderer
  // announces itself — including after a crash, when the interaction must survive the reload.
  overlay.project(machine.projectChip(state, clock.now()));
  tray.set(machine.projectTray(state));

  return {
    dispatch,

    snapshot(): Readonly<MachineState> {
      return state;
    },

    subscribe(fn: (s: Readonly<MachineState>) => void): Unsubscribe {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      clock.cancelAll();
      subscribers.clear();
      keys.release();
    },
  };
}
