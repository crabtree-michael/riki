/**
 * The inspector — a dev-only window showing everything the judge and the coach currently believe.
 *
 * ## What it is for
 *
 * Before this, the only way to see what Riki thought was `fixtures/golden/`: the snapshot and brief
 * renderers' output for six moments somebody wrote down in advance. That answers *does the format
 * still render correctly*, and it is the right tool for that. It answers none of the questions that
 * come up while the app is running — what does the world model actually hold right now, which
 * detections fired, which gate refused them, what text was composed for the turn that did happen,
 * and what went wrong underneath. Every one of those was a `console.log` somebody could not write,
 * because `console.*` is confined to `packages/telemetry` and that package is a skeleton.
 *
 * ## Shape
 *
 * ```
 *   TriggerPolicy ──decorated──►┐
 *   RikiContext   ──decorated──►│
 *   ShellTelemetry──decorated──►├──► DebugHub ──frame(now)──► DebugWindow ──IPC──► renderer/debug
 *   CoachingSessionPort ──sub──►│         ▲
 *   WorldModel / health / etc ──┘         └── pulled at frame time, not pushed
 * ```
 *
 * Three properties hold the whole thing together, and each is enforced somewhere rather than
 * remembered:
 *
 * - **It changes nothing on its own.** Both decorators return their delegate's value unchanged
 *   (`observing-policy.ts`, `observing-context.ts`) and the telemetry decorator calls its delegate
 *   first and always, so with the window open and untouched the app behaves exactly as it does with
 *   the flag off. The one thing that *can* change behaviour is a `control` intent, which only
 *   arrives when somebody clicks and can only reach a row in `controls.ts`' registry (ADR-0037).
 * - **It costs nothing when off.** `config.debug.enabled` is false by default; with it false the
 *   shell builds no hub, installs no decorator, adds no tray row and creates no window, so the
 *   extra gate evaluations in `observing-policy.ts` never run.
 * - **It is bounded.** Every buffer in `hub.ts` is capped and the two long text fields are clipped.
 *
 * ## Frames
 *
 * Pushed on a timer at `DEBUG_FRAME_INTERVAL_MS` while the window is open, and once immediately on
 * `ready`. Not on `onVersion`: the world model bumps at the GSI rate and faster during a fight, and
 * an inspector that redrew on every bump would be measuring its own cost as much as the app's.
 *
 * See docs/design/debug-inspector.md.
 */

import type { Timers } from '@riki/context';

import { DEBUG_FRAME_INTERVAL_MS } from '../../shared/debug.js';
import type { DebugHub, DebugSurface, DebugWindow, DebugWindowFactory } from './contracts.js';
import type { DebugControlPort } from './controls.js';
import { createDebugHub } from './hub.js';

export * from './contracts.js';
export { createDebugHub, toCounts } from './hub.js';
export { createObservingPolicy } from './observing-policy.js';
export type { ObservingPolicyDeps } from './observing-policy.js';
export { observeContext } from './observing-context.js';
export type { ObservingContextDeps } from './observing-context.js';
export { withDebugTelemetry } from './telemetry.js';
export type { DebugTelemetryDeps } from './telemetry.js';
export { projectCounters, projectWorld, renderValue } from './projections.js';
export type { WorldProjectionDeps } from './projections.js';
export { createDebugControls } from './controls.js';
export type {
  CoachModeControl,
  DebugControlOutcome,
  DebugControlPort,
  DebugControls,
  DebugControlsDeps,
  UnpromptedControl,
} from './controls.js';
export { createElectronDebugWindowFactory } from './electron-window.js';
export type { ElectronDebugWindowOptions } from './electron-window.js';

export interface DebugSurfaceDeps {
  readonly hub: DebugHub;
  /**
   * Absent means **collect but do not display**.
   *
   * That is the shape `shell.test.ts` runs in, and it is the honest one: everything the inspector
   * gathers is a Tier 1/Tier 4 concern with no window in it, and a window is Tier 5's business. It
   * is also what a headless replay wants — `pnpm dev:replay` can turn the flag on, drive a fixture
   * through the whole pipeline, and read frames straight off the hub.
   */
  readonly windows?: DebugWindowFactory;
  readonly timers: Timers;
  readonly now: () => number;
  readonly intervalMs?: number;
  /**
   * Absent means **display but do not control** — every `control` intent is refused and recorded.
   *
   * Optional for the same reason `windows` is: the collection half of this component is testable
   * with neither, and a headless replay wants frames without a way to move a threshold underneath
   * itself. It is also what keeps a shell built before this port existed compiling unchanged.
   */
  readonly controls?: DebugControlPort;
}

/**
 * A window that displays nothing, so `DebugSurface` has one shape rather than two.
 *
 * Not `undefined` and not optional methods, for the reason `nullTelemetry()` gives: a caller that
 * has to ask whether the window exists before every call is a caller that will one day forget to.
 */
export function nullDebugWindow(): DebugWindow {
  return {
    open: () => Promise.resolve(),
    close: () => undefined,
    isOpen: () => false,
    send: () => undefined,
    onIntent: () => () => undefined,
    onClosed: () => () => undefined,
    destroy: () => undefined,
  };
}

export function createDebugSurface(deps: DebugSurfaceDeps): DebugSurface {
  const { hub, timers } = deps;
  const intervalMs = deps.intervalMs ?? DEBUG_FRAME_INTERVAL_MS;

  const window = deps.windows?.create() ?? nullDebugWindow();
  let cancelPump: (() => void) | null = null;
  let disposed = false;

  function sendFrame(): void {
    if (disposed || !window.isOpen()) return;
    window.send({ kind: 'frame', frame: hub.frame(deps.now()) });
  }

  function pump(): void {
    sendFrame();
    // Re-armed from inside rather than on an interval, so a slow frame cannot queue behind itself.
    cancelPump = timers.after(intervalMs, pump);
  }

  function stopPump(): void {
    cancelPump?.();
    cancelPump = null;
  }

  /**
   * A control change, and then a frame straight back.
   *
   * Not waiting out the interval matters more here than anywhere else in this component: a control
   * whose value visibly lags the click by up to 250 ms reads as a control that did not work, and the
   * first thing anybody does with one that looks broken is click it again.
   *
   * A refusal — an unknown id, a locked gate, the wrong value type — becomes an `inspector` problem
   * rather than a silence. `controls` being absent is the same case: the panel is displayed from
   * whatever `DebugSources.controls` returns, so a window that could show controls but not move them
   * has to say so somewhere.
   */
  function applyControl(id: string, value: boolean | number | string): void {
    const outcome = deps.controls?.apply(id, value) ?? {
      ok: false,
      reason: 'this inspector has no control port',
    };
    if (!outcome.ok) {
      hub.recordProblem('inspector', `${id}: ${outcome.reason ?? 'refused'}`, deps.now());
    }
    sendFrame();
  }

  const stopIntent = window.onIntent((intent) => {
    // The window remounting after a crash: answer immediately rather than making it wait out the
    // interval on an empty document.
    if (intent.kind === 'ready') sendFrame();
    if (intent.kind === 'fault') hub.recordProblem('inspector', intent.message, deps.now());
    if (intent.kind === 'control') applyControl(intent.id, intent.value);
    if (intent.kind === 'reset-controls') {
      deps.controls?.reset();
      sendFrame();
    }
  });

  const stopClosed = window.onClosed(() => {
    stopPump();
  });

  return {
    hub,
    controls: deps.controls ?? null,

    async open(): Promise<void> {
      if (disposed) return;
      await window.open();
      // Gated on the window actually being open, which is what keeps `nullDebugWindow` from
      // arming a timer that re-arms itself forever with nowhere to send a frame.
      if (window.isOpen() && cancelPump === null) pump();
    },

    close(): void {
      stopPump();
      window.close();
    },

    isOpen: () => window.isOpen(),

    dispose(): void {
      if (disposed) return;
      disposed = true;
      stopPump();
      stopIntent();
      stopClosed();
      window.send({ kind: 'teardown' });
      window.destroy();
      hub.dispose();
    },
  };
}

/** Convenience for the composition root: a hub and a surface in one call. */
export function createDebugComponent(deps: Omit<DebugSurfaceDeps, 'hub'>): DebugSurface {
  return createDebugSurface({ ...deps, hub: createDebugHub() });
}
