/**
 * The settings the inspector may move, and the only way it can move them.
 *
 * ADR-0032 built this window read-only, and the reasoning was sound as far as it went: an inspector
 * that can poke the thing it inspects produces readings nobody can act on. What it left behind is a
 * window whose whole purpose is to make `packages/events/src/config.ts` legible — *this candidate
 * scored 0.28 and `speakThreshold` is 0.3* — and whose only answer to the next question was to edit
 * the file and replay the match. ADR-0037 is the reversal, and this file is the boundary that keeps
 * the original argument true where it still applies.
 *
 * ## Three rules, each structural
 *
 * **Inert until somebody clicks.** Nothing here changes a value on its own. With no `control`
 * intent, `config` answers exactly what `DEFAULT_TRIGGER_CONFIG` answers, `gates` refuses exactly
 * what `GATES` refuses, and `detectors` detect exactly what `DETECTORS` detect — which is what lets
 * `shell.test.ts` keep asserting that turning the inspector on changes no utterance.
 *
 * **Interposition, not reach-in.** The three live views below are the same trick ADR-0032 used for
 * observation, pointed one step further: `TriggerConfig`, `Gate` and `EventDetector` are all things
 * the composition root already injects, so the inspector changes behaviour by *choosing what to
 * inject* rather than by acquiring a handle on the engine. `packages/events` is still unchanged by
 * this component — it has no setter for a threshold, no way to disable a gate, and nothing in it
 * knows that a debug window exists.
 *
 * **A registry, not a surface.** Every reachable setting is a row in the table this file builds, and
 * the table is derived from `TriggerConfig`, `COACH_EVENT_KINDS` and `GATES` rather than typed out —
 * so a number added to `config.ts` fails the compiler here until it is given a range, and appears in
 * the window with no renderer change. There is no path from an intent to an arbitrary field.
 *
 * ## What is deliberately not reachable
 *
 * | | Why |
 * |---|---|
 * | The `quiet_mode` and `muted` gates | The player's own instruction. The inspector may make Riki quieter by any route it likes and louder only within what the player allowed — see `LOCKED_GATES`. |
 * | Mute itself | One producer, and it is the menu row (ADR-0028). A second one is how that bug happened the first time. |
 * | `blockedModes`, `escapeItems` | List-valued. Shown, locked: a stepper cannot edit them and a text field in a redrawn-whole document is a different feature. |
 * | `debug.enabled`, the API key, ports, paths, the hotkey | Not the judge's or the coach's behaviour, and the first would let the window switch itself off. |
 * | "Force a tick", "say this now" | Not settings. They would need surface on `EventEngine` and `CoachingAgent` that ADR-0032 declined to add, and declining it is still right. |
 *
 * ## Nothing here is persisted
 *
 * Overrides live for the run of the app and are never written to `settings.json`. Two reasons and
 * they are different: the trigger numbers are not config keys at all (`packages/config`'s `keys.ts`
 * has no `events.*` row, deliberately — coaching-trigger-architecture.md §16 step 3 wants the tuning
 * outcome to be a diff to `config.ts` against a corpus, not a file on one machine), and
 * `privacy.unprompted` is a privacy default REPO_SKELETON.md §7.2 requires to ship off, which a
 * debug window must not be able to make sticky.
 *
 * `coach.mode` is the exception and it is not one this file makes: the shell's `setCoachMode`
 * persists through `onCoachModeChanged` because the tray's Coach row does, and routing the control
 * through the same call is what keeps the two from disagreeing.
 */

import type { CoachEventKind, EventDetector, Gate, TriggerConfig } from '@riki/events';
import { COACH_EVENT_KINDS, DEFAULT_TRIGGER_CONFIG, DETECTORS, GATES } from '@riki/events';

import type { DebugControl, DebugControlValue } from '../../shared/debug.js';

// -----------------------------------------------------------------------------------------------
// The table
// -----------------------------------------------------------------------------------------------

/**
 * Every field of `TriggerConfig` that holds a bare number.
 *
 * Computed from the interface rather than listed, so the `Record` below is total against it and a
 * new tunable cannot be added to `packages/events` without either getting a row here or failing the
 * build. That is the same totality argument `DETECTORS` makes against `CoachEventKind`.
 */
type NumericTriggerKey = {
  [K in keyof TriggerConfig]: TriggerConfig[K] extends number ? K : never;
}[keyof TriggerConfig];

interface ScalarSpec {
  readonly group: string;
  readonly label: string;
  readonly min: number;
  readonly max: number;
  /** The stepper's increment, and the grid every value is snapped to. */
  readonly step: number;
  readonly unit: string | null;
  readonly note: string | null;
}

/**
 * Ranges, not opinions.
 *
 * `min` and `max` bound what the stepper can reach; they are not claims about what a sensible value
 * is, because `config.ts`'s header is explicit that nobody knows yet. Where a bound is meaningful it
 * is the one the arithmetic requires — a salience is 0..1 because that is what the score produces —
 * and where it is not, it is generous.
 */
const SCALARS: Readonly<Record<NumericTriggerKey, ScalarSpec>> = {
  speakThreshold: {
    group: 'Thresholds',
    label: 'speak threshold',
    min: 0,
    max: 1,
    step: 0.05,
    unit: null,
    note: 'below this a candidate is refused as below_threshold — the most consequential number here',
  },
  tapeSalience: {
    group: 'Thresholds',
    label: 'tape floor',
    min: 0,
    max: 1,
    step: 0.01,
    unit: null,
    note: "below this a detection never reaches the snapshot's recent: line",
  },
  intensityThreshold: {
    group: 'Thresholds',
    label: 'intensity threshold',
    min: 0,
    max: 1,
    step: 0.05,
    unit: null,
    note: 'refuse above this — 1 disables the mid-fight gate without disabling the score',
  },
  noDeadlineUrgency: {
    group: 'Thresholds',
    label: 'urgency with no deadline',
    min: 0,
    max: 1,
    step: 0.05,
    unit: null,
    note: 'what enemy_missing is scored at, so rune spawns do not structurally outrank it',
  },
  urgencyHorizonSeconds: {
    group: 'Thresholds',
    label: 'urgency horizon',
    min: 1,
    max: 120,
    step: 1,
    unit: 's',
    note: 'the deadline at which urgency is 0.5',
  },
  speakLatencySeconds: {
    group: 'Thresholds',
    label: 'speak latency',
    min: 0,
    max: 10,
    step: 0.5,
    unit: 's',
    note: 'subtracted from every deadline — raising it turns near-misses into stale_window',
  },

  globalCooldownMs: {
    group: 'Cooldowns',
    label: 'global cooldown',
    min: 0,
    max: 300_000,
    step: 5_000,
    unit: 'ms',
    note: null,
  },
  latchExpirySeconds: {
    group: 'Cooldowns',
    label: 'latch expiry',
    min: 0,
    max: 1_800,
    step: 30,
    unit: 's',
    note: 'game clock, not wall clock',
  },
  noveltyWindowSeconds: {
    group: 'Cooldowns',
    label: 'novelty window',
    min: 0,
    max: 3_600,
    step: 60,
    unit: 's',
    note: 'already_advised and ignored_twice both read this, in game seconds',
  },

  intensityWindowSeconds: {
    group: 'Intensity',
    label: 'fold window',
    min: 1,
    max: 60,
    step: 1,
    unit: 's',
    note: 'game seconds, so a pause does not manufacture calm',
  },
  intensityHpSwing: {
    group: 'Intensity',
    label: 'HP swing',
    min: 0,
    max: 1,
    step: 0.05,
    unit: null,
    note: 'fraction of max HP lost in the window that alone reads as a full-intensity moment',
  },
  intensityNearbyEnemies: {
    group: 'Intensity',
    label: 'nearby enemies',
    min: 1,
    max: 5,
    step: 1,
    unit: null,
    note: null,
  },
  intensityCasts: {
    group: 'Intensity',
    label: 'casts',
    min: 1,
    max: 20,
    step: 1,
    unit: null,
    note: null,
  },
  nearbyRadius: {
    group: 'Intensity',
    label: 'nearby radius',
    min: 200,
    max: 8_000,
    step: 200,
    unit: 'units',
    note: 'the minimap is ~16,000 units across',
  },

  missingAfterSeconds: {
    group: 'Detector thresholds',
    label: 'enemy_missing · after',
    min: 5,
    max: 180,
    step: 5,
    unit: 's',
    note: null,
  },
  missingSaturationSeconds: {
    group: 'Detector thresholds',
    label: 'enemy_missing · saturates',
    min: 5,
    max: 300,
    step: 5,
    unit: 's',
    note: null,
  },
  lowHpFraction: {
    group: 'Detector thresholds',
    label: 'low_hp · fraction',
    min: 0,
    max: 1,
    step: 0.05,
    unit: null,
    note: null,
  },
  lowHpActWithinSeconds: {
    group: 'Detector thresholds',
    label: 'low_hp · act within',
    min: 1,
    max: 60,
    step: 1,
    unit: 's',
    note: null,
  },
  deadWindowSeconds: {
    group: 'Detector thresholds',
    label: 'dead_window · respawn left',
    min: 5,
    max: 180,
    step: 5,
    unit: 's',
    note: null,
  },
  deadWindowSaturationSeconds: {
    group: 'Detector thresholds',
    label: 'dead_window · saturates',
    min: 5,
    max: 300,
    step: 5,
    unit: 's',
    note: null,
  },
  buybackShortfallGold: {
    group: 'Detector thresholds',
    label: 'buyback · shortfall',
    min: 0,
    max: 10_000,
    step: 250,
    unit: 'gold',
    note: null,
  },
  runeLeadSeconds: {
    group: 'Detector thresholds',
    label: 'rune_soon · lead',
    min: 1,
    max: 120,
    step: 5,
    unit: 's',
    note: null,
  },
  stackLeadSeconds: {
    group: 'Detector thresholds',
    label: 'stack_now · lead',
    min: 1,
    max: 60,
    step: 1,
    unit: 's',
    note: null,
  },
};

const NUMERIC_KEYS = Object.keys(SCALARS) as readonly NumericTriggerKey[];

/**
 * The two gates that are the player talking, rather than the app deciding.
 *
 * Everything else on the ladder is a judgement Riki made and is therefore something a developer may
 * argue with from this window. These two are not judgements: `quiet_mode` is dota2 §6.4's *"only
 * when I ask"* and `muted` is the menu row. A debug switch that could defeat either would make the
 * inspector the one place in the app where the player's explicit instruction is advisory.
 */
const LOCKED_GATES: Readonly<Record<string, string>> = {
  quiet_mode: "the player's own “only when I ask” — not overridable from a debug window",
  muted: 'the player muted Riki; mute has one producer and it is the menu row (ADR-0028)',
};

// -----------------------------------------------------------------------------------------------
// Contracts
// -----------------------------------------------------------------------------------------------

/** Whether a change landed. A refusal is a value, never a throw — the intent path must not fail. */
export interface DebugControlOutcome {
  readonly ok: boolean;
  /** Null when it landed; otherwise why it did not, phrased for the Problems panel. */
  readonly reason: string | null;
}

/** What `DebugSurface` needs to serve the Controls panel. Absent means the panel is empty. */
export interface DebugControlPort {
  list(): readonly DebugControl[];
  apply(id: string, value: DebugControlValue): DebugControlOutcome;
  /** Drop every override, including the two the shell owns. */
  reset(): void;
}

/**
 * The two settings that are not `packages/events`' to change.
 *
 * They arrive as callbacks rather than as values because the shell owns both: `setCoachMode`
 * resolves `llm` back to `static` when there is no key, and quiet mode has to be reapplied to a
 * driver that is rebuilt on every match and every coach swap. `configured` is what the resolved
 * config said, which is what `reset` restores and what `overridden` is measured against.
 */
export interface CoachModeControl {
  readonly configured: string;
  current(): string;
  set(mode: string): void;
  /** False renders the note explaining why asking for `llm` will answer `static`. */
  available(): boolean;
}

export interface UnpromptedControl {
  readonly configured: boolean;
  current(): boolean;
  set(on: boolean): void;
}

export interface DebugControlsDeps {
  /** Defaults to `DEFAULT_TRIGGER_CONFIG`, which is what the engine would have built for itself. */
  readonly base?: TriggerConfig;
  readonly coach: CoachModeControl;
  readonly unprompted: UnpromptedControl;
  /**
   * Called after a change actually landed.
   *
   * The shell wires this to telemetry. An override is the one thing about a session that cannot be
   * reconstructed afterwards from anything else — a log that says Riki spoke eleven times means
   * something different if `speakThreshold` was at 0.05 for six of them.
   */
  readonly onChanged?: (id: string, value: DebugControlValue) => void;
}

/**
 * The port, plus the three live views the composition root injects in place of the real things.
 *
 * All three are **stable objects whose answers change**, never rebuilt: `createEventEngine` reads
 * `deps.config` and `deps.detectors` once at construction and `createTriggerPolicy` closes over its
 * gate array, so a view that replaced itself would be ignored until the next match. Rebuilding the
 * driver on every click would work and would also throw away the latch set and the cooldown clocks
 * — which are precisely the state somebody is watching while they turn the knob.
 */
export interface DebugControls extends DebugControlPort {
  /** Pass as `createEventEngine({ config })`. */
  readonly config: TriggerConfig;
  /** Pass as `createTriggerPolicy(gates)`. Thirteen, always — a disabled gate refuses nothing. */
  readonly gates: readonly Gate[];
  /** Pass as `createEventEngine({ detectors })`. Eight, always — a disabled one detects nothing. */
  readonly detectors: readonly EventDetector[];
}

// -----------------------------------------------------------------------------------------------
// The live views
// -----------------------------------------------------------------------------------------------

const NO_DETECTIONS = Object.freeze([]) as ReturnType<EventDetector['detect']>;

/**
 * A `TriggerConfig` whose every number is read through the override map.
 *
 * Getters rather than a rebuilt record, because the engine captures this object once. Every read in
 * `packages/events` is a plain property access — `cfg.speakThreshold`, `ctx.cfg.kindCooldownMs[kind]`
 * — so a getter is indistinguishable from a field to every consumer, including the gates that
 * receive it on the `GateContext` and the inspector's own gate-state projection, which is why the
 * Gate state panel starts showing a moved threshold with no extra wiring.
 */
function liveTriggerConfig(
  base: TriggerConfig,
  overrides: ReadonlyMap<string, number>,
): TriggerConfig {
  const view: Record<string, unknown> = {};

  for (const key of NUMERIC_KEYS) {
    Object.defineProperty(view, key, {
      enumerable: true,
      get: () => overrides.get(key) ?? base[key],
    });
  }

  for (const field of ['kindWeight', 'kindCooldownMs'] as const) {
    const nested: Record<string, unknown> = {};
    for (const kind of COACH_EVENT_KINDS) {
      Object.defineProperty(nested, kind, {
        enumerable: true,
        get: () => overrides.get(`${field}.${kind}`) ?? base[field][kind],
      });
    }
    Object.defineProperty(view, field, { enumerable: true, value: nested });
  }

  // The two list-valued fields, passed through. They are locked in the registry below.
  Object.defineProperty(view, 'blockedModes', { enumerable: true, value: base.blockedModes });
  Object.defineProperty(view, 'escapeItems', { enumerable: true, value: base.escapeItems });

  // The one cast in this file. Every member of `TriggerConfig` is defined above — the `Record`
  // totality on `SCALARS` covers the numbers, and the four non-numeric fields are explicit — so what
  // the cast asserts is exactly what the loops built.
  return view as unknown as TriggerConfig;
}

/**
 * The thirteen gates, each asked only when it is switched on.
 *
 * Wrappers rather than a filtered array, for two reasons. The array is captured by
 * `createTriggerPolicy`, so filtering would need mutation in place; and a disabled gate that is
 * still *present* keeps the ladder thirteen rows long everywhere it is displayed, which is what lets
 * the inspector go on showing what a switched-off gate *would* have said. Turning `kind_cooldown`
 * off and watching it still light up on the candidate that now speaks is the whole point.
 */
function liveGates(disabled: ReadonlySet<string>): readonly Gate[] {
  return GATES.map((gate) => ({
    reason: gate.reason,
    refuses: (candidate, ctx) => !disabled.has(gate.reason) && gate.refuses(candidate, ctx),
  }));
}

/** The eight detectors, each run only when it is switched on. A disabled one produces nothing. */
function liveDetectors(disabled: ReadonlySet<string>): readonly EventDetector[] {
  return Object.values(DETECTORS).map((detector) => ({
    kind: detector.kind,
    detect: (world, cfg) =>
      disabled.has(detector.kind) ? NO_DETECTIONS : detector.detect(world, cfg),
  }));
}

// -----------------------------------------------------------------------------------------------
// The registry
// -----------------------------------------------------------------------------------------------

/** One row: how to describe it, and what to do when it is moved. */
interface Entry {
  describe(): DebugControl;
  apply(value: DebugControlValue): DebugControlOutcome;
  reset(): void;
}

const OK: DebugControlOutcome = { ok: true, reason: null };

function refuse(reason: string): DebugControlOutcome {
  return { ok: false, reason };
}

/**
 * Clamp to the spec's range and snap to its step.
 *
 * Snapping first and clamping second, so a bound is always reachable even when it is not a multiple
 * of the step. `toFixed(6)` is there because `0.1 + 0.2` arithmetic on a 0.05 grid otherwise puts
 * `0.30000000000000004` in a display that shows three decimals.
 */
function quantize(spec: ScalarSpec, raw: number): number {
  const snapped = Number((Math.round(raw / spec.step) * spec.step).toFixed(6));
  return Math.min(spec.max, Math.max(spec.min, snapped));
}

export function createDebugControls(deps: DebugControlsDeps): DebugControls {
  const base = deps.base ?? DEFAULT_TRIGGER_CONFIG;

  /** Keyed by the path within `TriggerConfig`: `speakThreshold`, `kindCooldownMs.rune_soon`. */
  const numbers = new Map<string, number>();
  const disabledGates = new Set<string>();
  const disabledDetectors = new Set<string>();

  const config = liveTriggerConfig(base, numbers);
  const gates = liveGates(disabledGates);
  const detectors = liveDetectors(disabledDetectors);

  function numeric(path: string, id: string, spec: ScalarSpec, baseValue: () => number): Entry {
    return {
      describe: (): DebugControl => ({
        id,
        group: spec.group,
        label: spec.label,
        kind: 'number',
        value: numbers.get(path) ?? baseValue(),
        base: baseValue(),
        overridden: numbers.has(path),
        min: spec.min,
        max: spec.max,
        step: spec.step,
        options: [],
        unit: spec.unit,
        note: spec.note,
        locked: null,
      }),
      apply: (value): DebugControlOutcome => {
        if (typeof value !== 'number') return refuse(`${id} takes a number`);
        const next = quantize(spec, value);
        // An override equal to the base is not an override. Deleting it rather than storing it is
        // what keeps the header's count honest when somebody steps a value back to where it was.
        if (next === baseValue()) numbers.delete(path);
        else numbers.set(path, next);
        return OK;
      },
      reset: (): void => {
        numbers.delete(path);
      },
    };
  }

  function toggle(
    id: string,
    group: string,
    label: string,
    note: string | null,
    locked: string | null,
    set: Set<string>,
    member: string,
  ): Entry {
    return {
      describe: (): DebugControl => ({
        id,
        group,
        label,
        kind: 'boolean',
        // Switched *on* is the un-overridden state for both gates and detectors, so the control
        // reads as "is this running" rather than as "is this suppressed".
        value: !set.has(member),
        base: true,
        overridden: set.has(member),
        min: null,
        max: null,
        step: null,
        options: [],
        unit: null,
        note,
        locked,
      }),
      apply: (value): DebugControlOutcome => {
        if (locked !== null) return refuse(`${id} is locked: ${locked}`);
        if (typeof value !== 'boolean') return refuse(`${id} takes a boolean`);
        if (value) set.delete(member);
        else set.add(member);
        return OK;
      },
      reset: (): void => {
        set.delete(member);
      },
    };
  }

  function readOnly(id: string, label: string, value: string, locked: string): Entry {
    return {
      describe: (): DebugControl => ({
        id,
        group: 'Reference data',
        label,
        kind: 'enum',
        value,
        base: value,
        overridden: false,
        min: null,
        max: null,
        step: null,
        options: [],
        unit: null,
        note: null,
        locked,
      }),
      apply: () => refuse(`${id} is locked: ${locked}`),
      reset: () => undefined,
    };
  }

  const entries = new Map<string, Entry>();

  // --- The coach, which is the shell's to change -------------------------------------------------

  entries.set('coach.mode', {
    describe: (): DebugControl => ({
      id: 'coach.mode',
      group: 'Coach',
      label: 'coach',
      kind: 'enum',
      value: deps.coach.current(),
      base: deps.coach.configured,
      overridden: deps.coach.current() !== deps.coach.configured,
      min: null,
      max: null,
      step: null,
      options: ['static', 'llm'],
      unit: null,
      note: deps.coach.available()
        ? 'the same switch as the tray row, and the only control here that is persisted'
        : 'no API key — asking for llm will answer static, and the value below will say so',
      locked: null,
    }),
    apply: (value): DebugControlOutcome => {
      if (value !== 'static' && value !== 'llm') return refuse('coach.mode is static or llm');
      // The shell resolves; the next frame reports whatever it settled on, which is how asking for
      // `llm` with no key behind it shows as `static` rather than as a control that did nothing.
      deps.coach.set(value);
      return OK;
    },
    reset: (): void => {
      deps.coach.set(deps.coach.configured);
    },
  });

  entries.set('coach.unprompted', {
    describe: (): DebugControl => ({
      id: 'coach.unprompted',
      group: 'Coach',
      label: 'unprompted speech',
      kind: 'boolean',
      value: deps.unprompted.current(),
      base: deps.unprompted.configured,
      overridden: deps.unprompted.current() !== deps.unprompted.configured,
      min: null,
      max: null,
      step: null,
      options: [],
      unit: null,
      note: 'off is quiet mode, which both coaches honour identically. Session only — the shipped default is off and stays off.',
      locked: null,
    }),
    apply: (value): DebugControlOutcome => {
      if (typeof value !== 'boolean') return refuse('coach.unprompted takes a boolean');
      deps.unprompted.set(value);
      return OK;
    },
    reset: (): void => {
      deps.unprompted.set(deps.unprompted.configured);
    },
  });

  // --- Every number in packages/events/src/config.ts ---------------------------------------------

  for (const key of NUMERIC_KEYS) {
    const spec = SCALARS[key];
    entries.set(
      `trigger.${key}`,
      numeric(key, `trigger.${key}`, spec, () => base[key]),
    );
  }

  for (const kind of COACH_EVENT_KINDS) {
    entries.set(
      `trigger.kindWeight.${kind}`,
      numeric(
        `kindWeight.${kind}`,
        `trigger.kindWeight.${kind}`,
        {
          group: 'Kind weights',
          label: kind,
          min: 0,
          max: 1,
          step: 0.01,
          unit: null,
          note: null,
        },
        () => base.kindWeight[kind],
      ),
    );

    entries.set(
      `trigger.kindCooldownMs.${kind}`,
      numeric(
        `kindCooldownMs.${kind}`,
        `trigger.kindCooldownMs.${kind}`,
        {
          group: 'Kind cooldowns',
          label: kind,
          min: 0,
          max: 600_000,
          step: 5_000,
          unit: 'ms',
          note: null,
        },
        () => base.kindCooldownMs[kind],
      ),
    );

    entries.set(
      `detector.${kind}`,
      toggle(
        `detector.${kind}`,
        'Detectors',
        kind,
        null,
        null,
        disabledDetectors,
        kind satisfies CoachEventKind,
      ),
    );
  }

  // --- The ladder --------------------------------------------------------------------------------

  for (const gate of GATES) {
    const locked = LOCKED_GATES[gate.reason] ?? null;
    entries.set(
      `gate.${gate.reason}`,
      toggle(
        `gate.${gate.reason}`,
        'Gates',
        gate.reason,
        // A switched-off gate is still evaluated and still shown in the grid — it just stops
        // deciding. Said here because "off" reasonably reads as "hidden".
        'off means the gate is still evaluated and displayed, and no longer refuses',
        locked,
        disabledGates,
        gate.reason,
      ),
    );
  }

  entries.set(
    'trigger.blockedModes',
    readOnly(
      'trigger.blockedModes',
      'blocked modes',
      base.blockedModes.join(', '),
      'list-valued — turn off the not_in_match gate to coach one of these anyway',
    ),
  );

  entries.set(
    'trigger.escapeItems',
    readOnly(
      'trigger.escapeItems',
      'escape items',
      base.escapeItems.join(', '),
      'list-valued — edit packages/events/src/config.ts',
    ),
  );

  return {
    config,
    gates,
    detectors,

    list: (): readonly DebugControl[] => [...entries.values()].map((entry) => entry.describe()),

    apply(id: string, value: DebugControlValue): DebugControlOutcome {
      const entry = entries.get(id);
      // The check the preload boundary structurally cannot make: shape is not authority, and an id
      // that is not in this map reaches nothing.
      if (entry === undefined) return refuse(`no control named ${id}`);
      const outcome = entry.apply(value);
      if (outcome.ok) deps.onChanged?.(id, value);
      return outcome;
    },

    reset(): void {
      for (const entry of entries.values()) entry.reset();
    },
  };
}
