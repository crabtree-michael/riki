/**
 * `@riki/world-model`'s read view, as `@riki/context` reads it.
 *
 * `packages/context/src/common/ports.ts` predicted this file in its own header: *"Mirrors
 * `WorldSnapshot` in packages/world-model/src/snapshot.ts, except that reads come back as
 * `Observed<T>` rather than that package's `StaleFact<T>` … collapsing them is one adapter in the
 * composition root."* This is that adapter, and the collapse itself is four lines.
 *
 * The part that is not mechanical is the **names**. `packages/context`'s renderers read about forty
 * field paths that they invented — `self.hpPct`, `derived.nextRuneAt` — and `packages/world-model`
 * supplies roughly half of them under different names and in different shapes. So this file also
 * holds the projection table, and it holds exactly one rule:
 *
 * > **This adapter renames and reshapes. It does not compute anything the world model could not
 * > already answer.**
 *
 * `self.hpPct` is `self.health`'s `current/max` — one fact in, one fact out, same source, same
 * confidence, same age. `map.towers` is `map.buildings` re-labelled from radiant/dire to us/them
 * using `meta.team`, and it carries the *minimum* confidence and *oldest* observation of the two,
 * which is `derivedFact`'s own rule. Neither invents a quantity.
 *
 * `derived.threats` ("can that hero reach me" — two positions, a movement speed and a set of
 * blinks) and `derived.pace*` ("am I behind" — farm against a benchmark) do invent one. They are
 * **left unsatisfied**, the sections that read them are omitted and recorded. That is the designed
 * degradation, not a shortcut: a number with no provenance sitting next to numbers that have some
 * is the failure the whole fact envelope exists to prevent.
 *
 * See docs/design/conversational-architecture.md §5, which makes the same rule the tool layer's
 * whole correctness obligation.
 */

import type {
  FieldPath as ContextFieldPath,
  Observed,
  Roster,
  Staleness,
  WorldModelReader as ContextWorldModelReader,
  WorldSnapshot as ContextWorldSnapshot,
  MonoMs,
} from '@riki/context';
import type {
  BuybackAffordable,
  Fact,
  GoldUntilItem,
  HeroId,
  ItemState,
  NetWorthLead,
  RoshanWindow,
  RuneTimings,
  StackTiming,
  StalenessPolicy,
  WorldModelReader,
  WorldSnapshot,
} from '@riki/world-model';
import { DERIVED_IDS, createStalenessPolicy, fieldPath, ageInBasis } from '@riki/world-model';

/** Dota's inventory is six slots; `freeSlots` is the only place that number is needed. */
const INVENTORY_SLOTS = 6;
const PERCENT = 100;

interface Projection {
  readonly value: unknown;
  readonly from: readonly (Fact<unknown> | undefined)[];
}

/**
 * `undefined` means *this path has no answer here*, which the renderers already treat as "leave the
 * field out". It is deliberately indistinguishable from "the model has never observed it": both are
 * an omitted section, and neither is a guess.
 */
type Projector = (world: WorldSnapshot) => Projection | undefined;

function fact<T>(world: WorldSnapshot, path: string): Fact<T> | undefined {
  return world.get<T>(path as never)?.fact;
}

/**
 * One fact in, one value out. The common case, and the one the header's rule is written for.
 *
 * A mapper that answers `undefined` — a percentage of a zero maximum, say — means *this fact cannot
 * produce this value*, and it collapses to the same absence as a never-observed field. Passing the
 * `undefined` through as a *value* would hand the renderer a fact envelope wrapped around nothing,
 * which prints as a bare label with an age on it.
 */
function of<T>(source: Fact<T> | undefined, map: (value: T) => unknown): Projection | undefined {
  if (source === undefined) return undefined;
  const value = map(source.value);
  return value === undefined ? undefined : { value, from: [source] };
}

interface Health {
  readonly current: number;
  readonly max: number;
}

interface Gold {
  readonly reliable: number;
  readonly unreliable: number;
}

interface Buildings {
  readonly towers: Readonly<Record<string, number>>;
  readonly barracks: Readonly<Record<string, number>>;
}

function percent(value: Health | undefined): number | undefined {
  if (value === undefined || value.max <= 0) return undefined;
  return Math.round((value.current / value.max) * PERCENT);
}

/**
 * `{ radiant_top: 1, dire_mid: 0 }` → `[{ id, side, down }]`.
 *
 * The side is `meta.team`'s, which is why this is the one projection reading two facts. Without a
 * team it answers nothing rather than guessing which half of the map is the player's — rendering
 * "their tier 2 is down" the wrong way round is worse than rendering neither.
 */
function buildingsFor(
  record: Readonly<Record<string, number>> | undefined,
  team: string | undefined,
): unknown {
  if (record === undefined || team === undefined) return undefined;
  return Object.entries(record).map(([id, health]) => ({
    id,
    side: id.startsWith(team) ? 'us' : 'them',
    down: health <= 0,
  }));
}

/**
 * The table.
 *
 * Anything not here answers `undefined`. That set is not empty and it is listed rather than hidden:
 * `self.area`, `enemies.*.area`, `derived.threats`, `derived.paceLevel` and `derived.paceNetWorth`.
 * The first two need a map-region table — position to `top`/`mid`/`rosh` — which belongs with the
 * sidecar that already speaks in regions; the last three need game arithmetic the world model does
 * not do. Each one costs the section that reads it, and nothing else.
 */
const PROJECTIONS: Readonly<Record<string, Projector>> = {
  'self.hpPct': (w) => of(fact<Health>(w, 'self.health'), percent),
  'self.mpPct': (w) => of(fact<Health>(w, 'self.mana'), percent),
  'self.gold': (w) => of(fact<Gold>(w, 'self.gold'), (g) => g.reliable + g.unreliable),
  'self.goldReliable': (w) => of(fact<Gold>(w, 'self.gold'), (g) => g.reliable),
  'self.items': (w) =>
    of(fact<readonly ItemState[]>(w, 'self.items'), (items) =>
      items.filter((i) => i.location === 'inventory'),
    ),
  'self.stash': (w) =>
    of(fact<readonly ItemState[]>(w, 'self.items'), (items) =>
      items.filter((i) => i.location === 'stash'),
    ),
  // The two slots that are not the inventory and are not interchangeable with it. Both come from
  // the same `items` component and both were invisible to the model until 2026-08-09, because
  // `self.items` above filters to `inventory` — so "do I have a TP" and "what neutral am I on" were
  // unanswerable from any path, snapshot or tool. An empty list is a fact worth rendering for both:
  // no TP is the classic avoidable death, and no neutral item is free power left on the floor.
  'self.teleport': (w) =>
    of(fact<readonly ItemState[]>(w, 'self.items'), (items) =>
      items.filter((i) => i.location === 'teleport'),
    ),
  'self.neutral': (w) =>
    of(fact<readonly ItemState[]>(w, 'self.items'), (items) =>
      items.filter((i) => i.location === 'neutral'),
    ),
  'self.freeSlots': (w) =>
    of(fact<readonly ItemState[]>(w, 'self.items'), (items) =>
      Math.max(0, INVENTORY_SLOTS - items.filter((i) => i.location === 'inventory').length),
    ),

  'map.towers': (w) => {
    const buildings = fact<Buildings>(w, 'map.buildings');
    const team = fact<string>(w, 'meta.team');
    const value = buildingsFor(buildings?.value.towers, team?.value);
    return value === undefined ? undefined : { value, from: [buildings, team] };
  },
  'map.barracks': (w) => {
    const buildings = fact<Buildings>(w, 'map.buildings');
    const team = fact<string>(w, 'meta.team');
    const value = buildingsFor(buildings?.value.barracks, team?.value);
    return value === undefined ? undefined : { value, from: [buildings, team] };
  },

  // Derived state, selected down to the one field the renderers name. `DerivedView.get` already
  // returns a fact whose confidence is the minimum of its inputs, so nothing is lost by selecting.
  'derived.nextItem': (w) => {
    const gold = w.derived.get<GoldUntilItem>(DERIVED_IDS.goldUntilItem);
    // A null ETA means GPM is unknown or zero. "In ∞ seconds" is not an answer, and neither is a
    // `nextItem` with no time on it — the renderer would print the item as if it were imminent.
    const eta = gold?.value.etaSeconds;
    if (gold === null || eta === null || eta === undefined) return undefined;
    return { value: { item: gold.value.item, inSeconds: eta }, from: [gold] };
  },
  'derived.buybackCost': (w) =>
    of(w.derived.get<BuybackAffordable>(DERIVED_IDS.buybackAffordable) ?? undefined, (b) => b.cost),
  'derived.netWorthLead': (w) =>
    of(w.derived.get<NetWorthLead>(DERIVED_IDS.netWorthLead) ?? undefined, (n) => n.lead),
  'derived.nextRuneAt': (w) =>
    of(w.derived.get<RuneTimings>(DERIVED_IDS.runeTimings) ?? undefined, (r) =>
      Math.min(r.nextBountyAt, r.nextPowerAt, r.nextWaterAt ?? Number.POSITIVE_INFINITY),
    ),
  'derived.nextStackAt': (w) =>
    of(w.derived.get<StackTiming>(DERIVED_IDS.stackTiming) ?? undefined, (s) => s.nextStackAt),
  'derived.roshanWindowAt': (w) =>
    of(w.derived.get<RoshanWindow>(DERIVED_IDS.roshanWindow) ?? undefined, (r) => r.opensAt),
};

export interface WorldViewOptions {
  /**
   * The store's own policy, injected rather than constructed, because an age classified by one
   * policy and rendered against another is a fact that says `4s ago` under one threshold and
   * `unseen >20s` under the next.
   */
  readonly staleness?: StalenessPolicy;
}

/**
 * `Observed<T>` from a `StaleFact<T>`.
 *
 * The one piece of information `StaleFact` does not carry is the age in milliseconds, because
 * `packages/world-model` computes it at read time from the two clocks rather than storing it. So it
 * is recomputed here through that package's own `ageInBasis`, on the basis its own policy declares
 * for the field — not a local subtraction, which is how the two would drift apart.
 */
export function observedFrom(
  source: Fact<unknown>,
  path: string,
  world: WorldSnapshot,
  staleness: StalenessPolicy,
  overrideStaleness?: Staleness,
): Observed<unknown> {
  const basis = staleness.policyFor(path as never).basis;
  return {
    value: source.value,
    staleness:
      overrideStaleness ?? staleness.classify(path as never, source, world.now, world.clock),
    ageMs: ageInBasis(source, world.now, world.clock, basis).ms,
    confidence: source.confidence,
    source: source.source,
  };
}

/** `derivedFact`'s rule, applied to a projection: the least confident and oldest of its inputs. */
function envelopeOf(
  from: readonly (Fact<unknown> | undefined)[],
): { readonly confidence: number; readonly oldest: Fact<unknown> } | undefined {
  let oldest: Fact<unknown> | undefined;
  let confidence = 1;
  for (const source of from) {
    if (source === undefined) continue;
    confidence = Math.min(confidence, source.confidence);
    if (oldest === undefined || source.observedAt < oldest.observedAt) oldest = source;
  }
  return oldest === undefined ? undefined : { confidence, oldest };
}

export function toContextSnapshot(
  world: WorldSnapshot,
  staleness: StalenessPolicy,
): ContextWorldSnapshot {
  return {
    version: world.version,
    now: world.now,
    clock: world.clock,

    get<T>(path: ContextFieldPath): Observed<T> | undefined {
      const key = String(path);

      const projector = PROJECTIONS[key];
      if (projector !== undefined) {
        const projected = projector(world);
        if (projected === undefined) return undefined;
        const envelope = envelopeOf(projected.from);
        if (envelope === undefined) return undefined;
        const observed = observedFrom(
          { ...envelope.oldest, value: projected.value, confidence: envelope.confidence as never },
          // Staleness is classified against the *source* path, because that is the field whose age
          // policy the value actually inherits. Classifying `self.hpPct` would fall through to the
          // policy table's default and quietly give a health reading a different expiry.
          sourcePathFor(key),
          world,
          staleness,
        );
        return observed as Observed<T>;
      }

      const direct = world.get<T>(fieldPath(...key.split('.')));
      if (direct === undefined) return undefined;
      return observedFrom(direct.fact, key, world, staleness, direct.staleness) as Observed<T>;
    },

    roster(): Roster {
      const state = world.state;
      return {
        self: state.self.hero?.value,
        allies: [...state.allies.keys()],
        enemies: [...state.enemies.keys()],
      };
    },

    unseenFor(seconds: number): readonly HeroId[] {
      return world.unseenFor(seconds);
    },
  };
}

/** Which world-model field a projected path inherits its ageing policy from. */
function sourcePathFor(key: string): string {
  switch (key) {
    case 'self.hpPct':
      return 'self.health';
    case 'self.mpPct':
      return 'self.mana';
    case 'self.gold':
    case 'self.goldReliable':
      return 'self.gold';
    case 'self.items':
    case 'self.stash':
    case 'self.teleport':
    case 'self.neutral':
    case 'self.freeSlots':
      return 'self.items';
    case 'map.towers':
    case 'map.barracks':
      return 'map.buildings';
    default:
      // Every `derived.*` path lands here. Derived facts already carry the oldest `observedAt` of
      // their inputs, and the fallback policy's `game` basis is the right one for all of them.
      return key;
  }
}

/**
 * The reader `createSnapshotSource` takes.
 *
 * `onVersion` and `history` are declared by the port and **not used by `packages/context`** — the
 * snapshot renderer only ever needs `snapshot()`. They are wired anyway rather than thrown from,
 * because a port that throws on a method nobody calls is a trap for whoever calls it first.
 */
export function toContextReader(
  world: WorldModelReader,
  options: WorldViewOptions = {},
): ContextWorldModelReader {
  const staleness = options.staleness ?? createStalenessPolicy();

  return {
    snapshot: (now: MonoMs) => toContextSnapshot(world.snapshot(now), staleness),
    onVersion: (listener) =>
      world.onVersion((version) => {
        // `packages/context`'s `WorldDelta` mirrors this one with `Observed` in place of `Fact`.
        // Nothing in that package subscribes, so translating a delta nobody reads would be dead code
        // with a real cost: it walks every changed field on every version bump.
        listener(version, {
          fromVersion: version - 1,
          toVersion: version,
          atGameClock: null,
          changes: [],
        });
      }),
    history: () => [],
  };
}
