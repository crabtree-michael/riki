/**
 * The scenarios the inspector may run, and the only way it can run them (ADR-0039).
 *
 * The sibling of `controls.ts`, built the same way and kept apart deliberately. A control is a
 * *value* the window moves and then watches; an action is something the window makes happen. They
 * arrive on different intents, they are described by different records, and ADR-0037 admitted the
 * first while explicitly refusing the second — so folding actions into the control registry would
 * erase that distinction at the boundary whose whole job is to enforce it.
 *
 * ## The rules this file keeps
 *
 * **Two rows, audited.** `scenario.match` and `scenario.speak`. A third is a decision to be argued
 * in an ADR, not a row somebody adds — which is why the registry is a literal here rather than
 * derived from anything.
 *
 * **One run at a time, per row.** A second click while a run is in flight is refused with a reason
 * rather than queued. Two synthetic matches interleaved would produce a trace nobody can read, which
 * defeats the point of having one.
 *
 * **A refusal is a value.** As in `controls.ts`: the intent path must not throw, so everything here
 * answers with an outcome and the window reports it.
 */

import type { DebugAction } from '../../shared/debug.js';

/** Whether a run started. `reason` is null when it did, and why not when it did not. */
export interface DebugActionOutcome {
  readonly ok: boolean;
  readonly reason: string | null;
}

/** What `DebugSurface` needs to serve the Actions panel. Absent means the panel is empty. */
export interface DebugActionPort {
  list(): readonly DebugAction[];
  run(id: string): DebugActionOutcome;
}

/**
 * One scenario's implementation, supplied by the shell.
 *
 * `unavailable()` is asked on every frame and again at the moment of the click, rather than being
 * fixed at construction: `scenario.speak` needs a coaching root, and a match can start or end
 * between one frame and the next. A row whose availability were decided once would spend most of a
 * session lying about itself.
 */
export interface ScenarioSeam {
  /** Null when it can run right now; otherwise the reason it cannot, phrased for the panel. */
  unavailable(): string | null;
  run(): Promise<void>;
}

export interface DebugActionDeps {
  readonly match: ScenarioSeam;
  readonly speak: ScenarioSeam;
  /** Every step of a run, in order. The trace panel is the output of this whole feature. */
  readonly trace: (stage: string, message: string) => void;
  /** Bracket a run so its steps carry `sinceRunMs`. */
  readonly markRun: (startedAt: number | null) => void;
  readonly now: () => number;
}

interface Row {
  readonly id: string;
  readonly group: string;
  readonly label: string;
  readonly note: string;
  readonly seam: ScenarioSeam;
}

export function createDebugActions(deps: DebugActionDeps): DebugActionPort {
  const running = new Set<string>();
  const outcomes = new Map<string, string>();

  const rows: readonly Row[] = [
    {
      id: 'scenario.match',
      group: 'Scenarios',
      label: 'Run synthetic match',
      note: 'pushes a scripted GSI sequence — pre-game, the horn, the clock walked to the first stack window — through the same path a real POST takes. Everything downstream is the production chain. About 15 seconds.',
      seam: deps.match,
    },
    {
      id: 'scenario.speak',
      group: 'Scenarios',
      label: 'Speak now',
      note: 'sends one turn straight to the session port, skipping detection and gates, to isolate the voice leg. Costs an API call. Speaks the current snapshot — it carries no text of its own.',
      seam: deps.speak,
    },
  ];

  const byId = new Map(rows.map((row) => [row.id, row]));

  function describe(row: Row): DebugAction {
    const blocked = row.seam.unavailable();
    return {
      id: row.id,
      group: row.group,
      label: row.label,
      note: blocked === null ? row.note : `${row.note} — unavailable: ${blocked}`,
      running: running.has(row.id),
      lastOutcome: outcomes.get(row.id) ?? null,
    };
  }

  return {
    list: (): readonly DebugAction[] => rows.map(describe),

    run(id: string): DebugActionOutcome {
      const row = byId.get(id);
      // The check the preload boundary structurally cannot make, exactly as in `controls.ts`: shape
      // is not authority, and an id that is not in this map reaches nothing.
      if (row === undefined) return { ok: false, reason: `no action named ${id}` };
      if (running.has(id)) return { ok: false, reason: `${id} is already running` };

      const blocked = row.seam.unavailable();
      if (blocked !== null) return { ok: false, reason: blocked };

      const started = deps.now();
      running.add(id);
      outcomes.delete(id);
      deps.markRun(started);
      deps.trace('scenario', `${row.label} started`);

      // A seam that throws synchronously must not reach the intent handler: main is not allowed to
      // crash because a debug window was clicked.
      let promise: Promise<void>;
      try {
        promise = row.seam.run();
      } catch (error: unknown) {
        running.delete(id);
        deps.markRun(null);
        const message = error instanceof Error ? error.message : String(error);
        outcomes.set(id, `failed: ${message}`);
        deps.trace('fault', `${row.label} failed to start: ${message}`);
        return { ok: false, reason: message };
      }

      void promise.then(
        () => {
          running.delete(id);
          const took = deps.now() - started;
          outcomes.set(id, `ok in ${String(Math.round(took))} ms`);
          deps.trace('scenario', `${row.label} finished in ${String(Math.round(took))} ms`);
          deps.markRun(null);
        },
        (error: unknown) => {
          running.delete(id);
          const message = error instanceof Error ? error.message : String(error);
          outcomes.set(id, `failed: ${message}`);
          deps.trace('fault', `${row.label} failed: ${message}`);
          deps.markRun(null);
        },
      );

      return { ok: true, reason: null };
    },
  };
}
