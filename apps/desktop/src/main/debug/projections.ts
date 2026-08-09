/**
 * The world model, rendered for a human rather than for a model.
 *
 * `packages/context`'s snapshot renderer answers the same question for the LLM, and this is
 * deliberately **not** that: the snapshot is budgeted to ~300 tokens, drops what does not fit, and
 * phrases everything. An inspector wants the opposite — every observed leaf, its
 * raw value, and the whole envelope around it. When the two disagree about what the world holds,
 * the answer is in the difference, so the second one has to be an independent read.
 *
 * ## Nothing here can be read without its provenance
 *
 * `WorldSnapshot.get()` returns a `StaleFact<T>` and there is no accessor that hands back a bare
 * `T`. That is `packages/world-model`'s central discipline, and the inspector honours it: every row
 * carries source, confidence, staleness, age and age **basis**. The basis is the one people forget
 * and the one that makes an age look wrong — tactical facts age in match time, so during a pause a
 * ten-second-old enemy position stays ten seconds old, correctly.
 *
 * ## Values become strings here
 *
 * The leaves are heterogeneous — `{current, max}`, an array of abilities, a `MapPosition` — and a
 * renderer that knew how to display each of them would be a second snapshot renderer living in a
 * sandboxed window. One `render` function, in main, where the types are.
 */

import type {
  DerivedId,
  FieldPath,
  MonoMs,
  StalenessPolicy,
  WorldModelReader,
} from '@riki/world-model';
import { MAP_KEYS, META_KEYS, SELF_KEYS, fieldPath } from '@riki/world-model';

import type { DebugWorldInput } from './contracts.js';

/** Long enough for an ability array, short enough that one row cannot fill the panel. */
const MAX_VALUE_CHARS = 160;

/**
 * A world-model value as one line.
 *
 * `JSON.stringify` for anything structured, which is the honest choice for a debug view: it shows
 * the shape as well as the contents, and a hand-written formatter per leaf type would be six
 * formatters that drift from the fields they format.
 */
export function renderValue(value: unknown): string {
  return clamp(text(value));
}

/**
 * The cap, applied to **every** value and not only to the structured ones.
 *
 * A string leaf is the case that matters: it is the one kind of value that arrives already rendered,
 * so it is the one an early return is most tempting for — and it is also the only kind with no
 * natural bound, since a `Fact<string>` fused from CV or from a future source is whatever that
 * source said. `shared/debug.ts` promises that a frame is a projection rather than a log and that
 * everything in it is bounded; a value that skipped this would be the one place that is not true.
 */
function clamp(rendered: string): string {
  return rendered.length <= MAX_VALUE_CHARS ? rendered : `${rendered.slice(0, MAX_VALUE_CHARS)}…`;
}

function text(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Map) return text(Object.fromEntries(value));

  // The two inputs `JSON.stringify` answers `undefined` for are `undefined` itself, handled above,
  // and a function, which a `Fact` value cannot be. So the declared `string` return holds here.
  try {
    return JSON.stringify(value);
  } catch {
    // A cycle. The world model has none, but this runs over `unknown` and a debug view that throws
    // is worse than one that says it could not read something.
    return '<unrenderable>';
  }
}

export interface WorldProjectionDeps {
  readonly world: WorldModelReader;
  readonly staleness: StalenessPolicy;
}

/**
 * Every observed `meta.*`, `self.*` and `map.*` leaf, plus the enemies and the derived rules.
 *
 * The path list comes from the key arrays `packages/world-model` exports rather than being written
 * out here, so a field added to `WorldState` appears in the inspector with no change to this file —
 * which matters because `state.ts` says in as many words that the field list is expected to grow.
 *
 * `allies.*` is the one part of the model not shown. It is keyed by hero and fed only by CV, and
 * the sidecar speaks no protocol yet (REPO_SKELETON.md §10 step 2), so today it is always empty; it
 * gets a section beside `enemies` on the day something writes to it.
 */
export function projectWorld(deps: WorldProjectionDeps): (now: number) => DebugWorldInput {
  return (now: number): DebugWorldInput => {
    const snapshot = deps.world.snapshot(now as MonoMs);

    const paths: FieldPath[] = [
      ...META_KEYS.map((key) => fieldPath('meta', key)),
      ...SELF_KEYS.map((key) => fieldPath('self', key)),
      ...MAP_KEYS.map((key) => fieldPath('map', key)),
    ];

    const facts = paths.flatMap((path) => {
      const held = snapshot.get<unknown>(path);
      // Undefined means **never observed**, which is not the same as observed-to-be-absent — so it
      // is omitted rather than rendered as a null row. `packages/world-model`'s rule 2.
      if (held === undefined) return [];
      const age = deps.staleness.ageOf(held.fact, now as MonoMs, snapshot.clock);
      return [
        {
          path: String(path),
          value: renderValue(held.fact.value),
          source: held.fact.source,
          confidence: held.fact.confidence,
          staleness: held.staleness,
          ageMs: Math.round(age.ms),
          ageBasis: age.basis,
        },
      ];
    });

    const enemies = snapshot.enemies().map((enemy) => ({
      hero: String(enemy.hero),
      staleness: enemy.staleness,
      alive: enemy.state.alive?.value ?? null,
      level: enemy.state.level?.value ?? null,
      position: enemy.state.position === undefined ? null : renderValue(enemy.state.position.value),
      lastSeenAt:
        enemy.state.lastSeenAt === undefined ? null : renderValue(enemy.state.lastSeenAt.value),
      itemsSeen: [...enemy.state.itemsSeen.keys()].map(String),
    }));

    const derived = snapshot.derived.ids.map((id: DerivedId) => {
      const fact = snapshot.derived.get<unknown>(id);
      return {
        id: String(id),
        // Null is an answer, not an absence: the rule declined because its inputs were too stale to
        // answer honestly, which is a different thing from the rule not existing.
        value: fact === null ? null : renderValue(fact.value),
        confidence: fact === null ? null : fact.confidence,
      };
    });

    return {
      version: snapshot.version,
      clock: snapshot.clock,
      paused: snapshot.get<boolean>(fieldPath('meta', 'paused'))?.fact.value ?? false,
      facts,
      enemies,
      derived,
    };
  };
}
