/**
 * The tool surface: what the model may ask the world model for, and the shape of every answer.
 *
 * ADR-0042 reverses ADR-0023's `tools: []`. With no trigger engine choosing the topic of a turn,
 * nothing knows what the turn needs before the model does, so the model reaches the world through
 * five named tools instead of through a brief someone else assembled
 * (`docs/design/conversational-architecture.md` §4).
 *
 * ## Why this is protocol and not a detail of either side
 *
 * It crosses a boundary — `packages/world-model` produces these values and `packages/realtime`
 * sends them to a model — and the two must not each have an opinion about the shape. That is the
 * same argument ADR-0018 made for its local declaration and then asked to be revisited *"when
 * `packages/protocol` lands zod and a JSON-Schema emitter"*. Both have landed, so the tool
 * arguments are zod here and the JSON Schema the model is shown is generated from them in
 * `packages/realtime/src/tools.ts`. A schema that has drifted from its validator is exactly the
 * failure `pnpm codegen` exists to prevent for the sidecar, and it presents identically here: the
 * model is told a shape, sends it, and is told it is invalid — mid-sentence, out loud.
 *
 * ## Three things about this boundary that are not true of the other two
 *
 * **No Rust half, and no `MODULES` entry.** `scripts/codegen.mjs` generates Rust from
 * `SidecarProtocol` alone. This crosses a *process* boundary at most — usually not even that — so
 * there is nothing for `crates/riki-ipc` to parse, exactly as for `schemas/voice.ts`. Adding a
 * schema file does not wire it into codegen; the module list is explicit, which is what makes that
 * safe.
 *
 * **No `v` field.** Every message in `sidecar.ts` and `voice.ts` carries the protocol version
 * because the peer may be a different build. The peer here is a language model: it has no build,
 * it never sends a version, and a version it did send would be one it invented. What replaces the
 * version check is that the model is shown the argument schema in the same `session.update` that
 * opens the session it will call through.
 *
 * **snake_case.** Everything else in this package is camelCase, because the Rust emitter renames
 * to it and because that is the repo's TypeScript. These names are read aloud by a model, appear
 * in the design document as snake_case, and match the tool names themselves (`my_state`,
 * `world_at`). Consistency with the reader wins over consistency with the file next door.
 *
 * ## The one correctness obligation
 *
 * `Fact<T>` in `packages/world-model/src/fact.ts` carries value, source, confidence and
 * timestamps, and its header states the stake: a pipeline that flattens a 0.55-confidence minimap
 * blob and a GSI health value into the same `number` has discarded the only thing that stops Riki
 * confidently getting someone killed. This file is where that envelope crosses to the model, and
 * the whole job is to not lose it on the way out. Hence `ToolFact`: a **union of two shapes**,
 * never a value that might be null. See its comment for why the distinction is structural rather
 * than a convention.
 */

import { z } from 'zod';

// -----------------------------------------------------------------------------------------------
// The fact envelope
// -----------------------------------------------------------------------------------------------

/**
 * Where a value came from, in the world model's own vocabulary (`FactSource`).
 *
 * The model is expected to weigh these differently, which is why the string travels rather than a
 * flattened "trustworthy" boolean: `gsi` is the game telling us, `cv` is a detector's guess about
 * a handful of minimap pixels, and `derived` is arithmetic that is only ever as good as its worst
 * input.
 */
export const FactSource = z
  .enum(['gsi', 'log', 'cv', 'api', 'derived'])
  .meta({ id: 'FactSource', description: 'Where this value came from.' });

/**
 * No value, and why not.
 *
 * A first-class return rather than an error or a null (design §5.1). GSI gives Riki its own team
 * live; everything about the enemy is inference from vision and the console log, so "zero" and
 * "never seen" are different answers to most questions about the other side — and a tool that
 * cannot tell them apart is a tool that will state a guess as a fact.
 *
 * The reason is free text because it is read aloud: "nobody has seen Roshan this match" is a
 * sentence, and an enum of reason codes would only be turned back into one somewhere else.
 * `UNKNOWN_REASONS` below is a suggested vocabulary, not a closed set.
 */
export const UnknownFact = z
  .strictObject({
    unknown: z
      .string()
      .min(1)
      .describe('Why there is no value — say this, do not guess a number instead.'),
  })
  .meta({ id: 'UnknownFact' });

/**
 * The phrasings `packages/world-model` should reach for first, so that five tools written by
 * different hands do not give the player five vocabularies for the same condition.
 */
export const UNKNOWN_REASONS = {
  neverObserved: 'never observed this match',
  notInThisMatch: 'not in this match',
  noClockYet: 'the match has no clock yet',
  sourceUnavailable: 'the source that would know is not running',
  beforeRecording: 'before the recording starts',
} as const;

/** The three fields that travel with every value. `value` is added per tool by `toolFact`. */
const FactEnvelope = z.strictObject({
  /**
   * How long ago this was observed, at the moment the tool answered.
   *
   * Computed at read time from `observedAt` and never stored, because a stored age is already
   * wrong by the time anyone reads it (design §5.2). Non-negative: a clock that ran backwards is a
   * bug to clamp at the producer, not a negative age to explain to a player.
   */
  age_seconds: z.number().min(0),
  /** 0–1. Exactly 1 for `gsi`, `log` and `api`; a detector match score for `cv`. */
  confidence: z.number().min(0).max(1),
  source: FactSource,
});

/**
 * One value and everything needed to judge it — or no value and the reason.
 *
 * **The two are sibling shapes, not one shape with a hole in it.** `{ value: number | null }` would
 * be the obvious encoding and it is the wrong one twice over: `null` carries no reason, and a
 * caller that forgets to check it reads a plausible-looking absence as a value. Here there is no
 * field to forget — `value` does not exist on the unknown branch, so TypeScript refuses to read it
 * and `z.union` refuses to parse an object carrying both. `isUnknown` is the only way through.
 *
 * Both branches are strict. That is the load-bearing detail: zod strips unknown keys by default,
 * so a non-strict known branch would happily accept `{ value: 0, …, unknown: 'never seen' }`,
 * silently drop the `unknown`, and hand the model a confident zero. Strict makes that object parse
 * as neither branch.
 */
export function toolFact<T extends z.ZodType>(value: T) {
  return z.union([z.strictObject({ value, ...FactEnvelope.shape }), UnknownFact]);
}

/** A value that is not itself a single observation — a list, a section — or nothing, with a reason. */
export function orUnknown<T extends z.ZodType>(schema: T) {
  return z.union([schema, UnknownFact]);
}

export type UnknownFact = z.infer<typeof UnknownFact>;
export type FactSource = z.infer<typeof FactSource>;
export type KnownFact<T> = { readonly value: T } & z.infer<typeof FactEnvelope>;
export type ToolFact<T> = KnownFact<T> | UnknownFact;

/**
 * The only accessor. There is deliberately no `valueOr(fact, fallback)` and no `factValue()`
 * returning `T | undefined`: both are one keystroke from the flattening this whole file exists to
 * prevent, and a fallback is a made-up number with a real number's type.
 */
export function isUnknown<T>(fact: ToolFact<T>): fact is UnknownFact {
  return 'unknown' in fact;
}

// -----------------------------------------------------------------------------------------------
// Vocabulary
// -----------------------------------------------------------------------------------------------

/** The world model's `HeroId`: Valve's short name, e.g. `shadow_fiend`. */
const HeroName = z.string().min(1);
/** The world model's `ItemId`, e.g. `black_king_bar`. */
const ItemName = z.string().min(1);

/**
 * Match clock as a person says it: `12:34`, `1:05:00`, or `-1:30` before the horn.
 *
 * A string rather than seconds because it is both the model's input to `world_at` and what it says
 * out loud, and because seconds would be the one number in this file with no unit attached to it.
 * Pre-horn time is negative and is not the same as `0:00`, which is why the sign is in the grammar.
 *
 * No `.meta({ id })`, unlike everything else here, and that is deliberate: an `id` makes
 * `z.toJSONSchema` lift the schema into `$defs` and leave a `$ref` behind, and this one appears
 * inside `world_at`'s *arguments*, which are the one thing in this file the model actually reads.
 * A five-line indirection for a string with a pattern is worse than the pattern.
 */
export const GameClock = z
  .string()
  .regex(/^-?\d{1,3}:[0-5]\d(:[0-5]\d)?$/)
  .describe('Match clock, `m:ss` or `h:mm:ss`; negative before 0:00.');

/**
 * The five tools, and the four topics `world_at` can reconstruct.
 *
 * Declared up here rather than beside `TOOLS` so that `WORLD_AT_TOPICS` can be checked against
 * `ToolName` by the compiler: a topic naming a tool that does not exist is the kind of thing
 * nobody notices until the model asks for it.
 */
export const ToolName = z
  .enum(['my_state', 'enemy', 'objectives', 'economy', 'world_at'])
  .meta({ id: 'ToolName', description: 'The five tools the model may call.' });

export type ToolName = z.infer<typeof ToolName>;

const WORLD_AT_TOPICS = [
  'my_state',
  'enemy',
  'objectives',
  'economy',
] as const satisfies readonly ToolName[];

/**
 * Which side, from the player's seat rather than the map's.
 *
 * Every count in this file is `mine`/`theirs` and never `radiant`/`dire`. The model would
 * otherwise have to remember which side the player is on in order to read a scoreboard, and it
 * will sometimes get that wrong in a way that is invisible — "you're up four towers" is a complete
 * and confident sentence whichever way round it is. `my_state.team` is there for when the actual
 * side matters, as a fact like everything else.
 */
const Sides = <T extends z.ZodType>(of: T) => z.strictObject({ mine: of, theirs: of });

/**
 * A place on the map, and what to call it.
 *
 * `area` is the field the model should speak; the coordinates are for the inspector and for a
 * future caller that wants to compute with them. "They were at 4300, 2100" is not a sentence
 * anyone says, and a model given only numbers will say it.
 */
export const MapPoint = z
  .strictObject({
    x: z.number(),
    y: z.number(),
    area: z
      .string()
      .min(1)
      .nullable()
      .describe(
        'What to call this place out loud — "bottom rune", "their jungle". Null if unnamed.',
      ),
  })
  .meta({ id: 'MapPoint' });

// -----------------------------------------------------------------------------------------------
// my_state
// -----------------------------------------------------------------------------------------------

export const AbilityReport = z
  .strictObject({
    id: z.string().min(1),
    level: z.int().min(0),
    cooldown_seconds: z.number().min(0),
    castable: z.boolean(),
    ultimate: z.boolean(),
  })
  .meta({ id: 'AbilityReport' });

export const ItemReport = z
  .strictObject({
    id: ItemName,
    location: z.enum(['inventory', 'backpack', 'stash', 'neutral', 'teleport']),
    charges: z.int().min(0).nullable(),
    cooldown_seconds: z.number().min(0),
    castable: z.boolean(),
  })
  .meta({ id: 'ItemReport' });

/**
 * The player's own hero. All GSI, so in a live match almost none of it is ever unknown — which is
 * exactly why every field is still a `ToolFact`: the one time GSI is down is the one time the
 * difference matters, and a shape that is only honest when the data is good is not a shape.
 *
 * `alive` and `respawn_in_seconds` are not in the design's table and are here anyway, because
 * without them a dead hero reports `health: { value: { current: 0, max: 1200 } }` and the model
 * says "you're at zero HP" — true, useless, and the wrong sentence.
 */
export const MyStateReport = z
  .strictObject({
    hero: toolFact(HeroName),
    team: toolFact(z.enum(['radiant', 'dire'])),
    level: toolFact(z.int().min(1)),
    alive: toolFact(z.boolean()),
    respawn_in_seconds: toolFact(z.number().min(0)),
    health: toolFact(z.strictObject({ current: z.number(), max: z.number() })),
    mana: toolFact(z.strictObject({ current: z.number(), max: z.number() })),
    gold: toolFact(z.strictObject({ reliable: z.number(), unreliable: z.number() })),
    buyback: toolFact(
      z.strictObject({
        cost: z.number().min(0),
        cooldown_seconds: z.number().min(0),
        /** Derived from gold and cost together, so it inherits the worse of the two. */
        affordable: z.boolean(),
      }),
    ),
    items: toolFact(z.array(ItemReport)),
    abilities: toolFact(z.array(AbilityReport)),
  })
  .meta({ id: 'MyStateReport' });

// -----------------------------------------------------------------------------------------------
// enemy
// -----------------------------------------------------------------------------------------------

/**
 * One enemy, as far as anyone has seen.
 *
 * `hero` is a bare string and the only unenveloped value in this file. It is the address of the
 * answer rather than an observation about the world: a report whose subject is `{ unknown: … }`
 * cannot be attached to anything, and the model asked about this hero by name.
 *
 * `last_seen` carries its age in the envelope, which is the whole point of the tool — "was bottom
 * thirty seconds ago" is a different claim from "is bottom", and the second one is how somebody
 * walks into four people.
 */
export const EnemyReport = z
  .strictObject({
    hero: HeroName,
    level: toolFact(z.int().min(1)),
    alive: toolFact(z.boolean()),
    respawn_in_seconds: toolFact(z.number().min(0)),
    last_seen: toolFact(MapPoint),
    net_worth: toolFact(z.number().min(0)),
    /**
     * One fact per item rather than one fact for the list: seeing a Blink at 0.91 twenty seconds
     * ago is a different claim from seeing a BKB at 0.55 four minutes ago, and the world model
     * already keeps them apart (`EnemyState.itemsSeen`). The list as a whole is `unknown` when
     * nothing has ever looked, which is not the same as the empty list.
     */
    items_seen: orUnknown(z.array(toolFact(ItemName))),
  })
  .meta({ id: 'EnemyReport' });

/**
 * Always a list, even for a call that named one hero.
 *
 * Design §11 open question 1 — does a no-argument `enemy()` return five summaries or refuse and
 * ask which hero — is T3's to settle, and this shape settles neither: five summaries is a list of
 * five, one hero is a list of one, and a refusal is the `UnknownFact` branch of `EnemyResult`
 * carrying the question to ask.
 */
export const EnemiesReport = z
  .strictObject({ enemies: z.array(EnemyReport) })
  .meta({ id: 'EnemiesReport' });

// -----------------------------------------------------------------------------------------------
// objectives
// -----------------------------------------------------------------------------------------------

/**
 * Roshan, with the uncertainty in the shape.
 *
 * The world model's `RoshanState` has three values — `alive`, `dead`, `unknown` — and the third
 * collapses into the envelope here: nobody having seen Roshan is an absence of observation, not a
 * state Roshan is in. `respawn_window` is null while he is alive and while he is dead at a time
 * nobody recorded; the window is the uncertainty rather than a guess at the middle of it.
 */
export const RoshanReport = z
  .strictObject({
    state: z.enum(['alive', 'dead']),
    respawn_window: z
      .strictObject({
        opens_in_seconds: z.number(),
        closes_in_seconds: z.number(),
        /** The window has opened. He may be up, and the only way to know is to look. */
        maybe_up: z.boolean(),
      })
      .nullable(),
  })
  .meta({ id: 'RoshanReport' });

/** Clock-only, and therefore correct through a pause for free (`derived/rules/timings.ts`). */
export const RuneReport = z
  .strictObject({
    next_bounty_in_seconds: z.number().min(0),
    next_power_in_seconds: z.number().min(0),
    /** Water runes are 2:00 and 4:00 only, so this is null for most of a match. */
    next_water_in_seconds: z.number().min(0).nullable(),
  })
  .meta({ id: 'RuneReport' });

export const BuildingsReport = z
  .strictObject({
    towers: Sides(z.int().min(0).max(11)),
    barracks: Sides(z.int().min(0).max(6)),
    /** Named for saying out loud: `top tier 2`, `mid barracks`. Newest loss first. */
    recently_lost: z.array(
      z.strictObject({ side: z.enum(['mine', 'theirs']), name: z.string().min(1) }),
    ),
  })
  .meta({ id: 'BuildingsReport' });

export const ObjectivesReport = z
  .strictObject({
    /** Every other timing in this report is relative to it, so it travels with them. */
    clock: toolFact(GameClock),
    daytime: toolFact(z.boolean()),
    buildings: toolFact(BuildingsReport),
    roshan: toolFact(RoshanReport),
    runes: toolFact(RuneReport),
  })
  .meta({ id: 'ObjectivesReport' });

// -----------------------------------------------------------------------------------------------
// economy
// -----------------------------------------------------------------------------------------------

export const EconomyReport = z
  .strictObject({
    my_net_worth: toolFact(z.number().min(0)),
    /**
     * All ten net worths or none: a lead computed from six known values and four missing ones is
     * not a smaller lead, it is a wrong one, and wrong in whichever direction the missing heroes
     * fell (`derived/rules/economy.ts`). So this is one fact over the pair rather than two facts
     * that could be half-known.
     */
    team_net_worth: toolFact(
      z.strictObject({
        ours: z.number().min(0),
        theirs: z.number().min(0),
        /** Positive means the player's team is ahead. */
        lead: z.number(),
      }),
    ),
    gpm: toolFact(z.number()),
    xpm: toolFact(z.number()),
    last_hits: toolFact(z.int().min(0)),
    denies: toolFact(z.int().min(0)),
    /**
     * Who is winning each lane, by net worth.
     *
     * Live GSI knows only the player, so this needs the scoreboard and will be `unknown` in most
     * calls. It is declared anyway because the design names it and because a field that is
     * *honestly* unknown is the cheapest possible answer — one that had to be inferred from the
     * absence of a field would not be.
     */
    lanes: toolFact(
      z.array(
        z.strictObject({
          lane: z.enum(['top', 'mid', 'bottom']),
          ours: z.number(),
          theirs: z.number(),
        }),
      ),
    ),
  })
  .meta({ id: 'EconomyReport' });

// -----------------------------------------------------------------------------------------------
// Arguments
// -----------------------------------------------------------------------------------------------

/**
 * Every argument object is strict, so `additionalProperties: false` is what the model is shown and
 * also what the validator does. ADR-0018 named the alternative — a hand-written JSON Schema beside
 * a hand-written validator — as the failure this arrangement prevents.
 */
export const MyStateArguments = z.strictObject({}).meta({ id: 'MyStateArguments' });

export const EnemyArguments = z
  .strictObject({
    hero: HeroName.optional().describe(
      'Which enemy, by hero name. Omit to ask about all of them at once.',
    ),
  })
  .meta({ id: 'EnemyArguments' });

export const ObjectivesArguments = z.strictObject({}).meta({ id: 'ObjectivesArguments' });

export const EconomyArguments = z.strictObject({}).meta({ id: 'EconomyArguments' });

/**
 * `topic` narrows the reconstruction, and omitting it asks for everything.
 *
 * Design §11 open question 2 — should `world_at` also take "thirty seconds ago", since players
 * speak in both — is T6's to settle and is deliberately not settled here. It is additive when it
 * comes: `clock` becomes one branch of a union and every existing call keeps parsing. What is
 * *not* additive is accepting free text and parsing it loosely, which is how a voice tool call
 * fails in the middle of a spoken sentence.
 */
export const WorldAtArguments = z
  .strictObject({
    clock: GameClock.describe('The moment to reconstruct, as a match clock: "12:34".'),
    topic: z
      .enum(WORLD_AT_TOPICS)
      .optional()
      .describe('Which part of the world. Omit for all of it, which costs more to read.'),
  })
  .meta({ id: 'WorldAtArguments' });

// -----------------------------------------------------------------------------------------------
// Results
// -----------------------------------------------------------------------------------------------

/**
 * A tool answers with its report, or with a reason it cannot answer at all.
 *
 * The second branch is not an error path: "no match is in progress" and "there is no hero called
 * that in this game" are ordinary answers, and ADR-0011's surviving half applies — availability
 * belongs in the result, never in the presence of the tool.
 */
export const MyStateResult = orUnknown(MyStateReport).meta({ id: 'MyStateResult' });
export const EnemyResult = orUnknown(EnemiesReport).meta({ id: 'EnemyResult' });
export const ObjectivesResult = orUnknown(ObjectivesReport).meta({ id: 'ObjectivesResult' });
export const EconomyResult = orUnknown(EconomyReport).meta({ id: 'EconomyResult' });

/**
 * A past moment, with the sections that were asked for.
 *
 * `at_clock` is the moment actually reconstructed, which is the nearest one the recording can
 * support and not necessarily the one asked for — a reader that returned the requested clock
 * regardless would be inventing precision it does not have.
 */
export const WorldAtReport = z
  .strictObject({
    at_clock: GameClock,
    my_state: MyStateReport.optional(),
    enemies: EnemiesReport.optional(),
    objectives: ObjectivesReport.optional(),
    economy: EconomyReport.optional(),
  })
  .refine(
    (report) =>
      report.my_state !== undefined ||
      report.enemies !== undefined ||
      report.objectives !== undefined ||
      report.economy !== undefined,
    { message: 'world_at answered with no section at all — say why with `unknown` instead.' },
  )
  .meta({ id: 'WorldAtReport' });

export const WorldAtResult = orUnknown(WorldAtReport).meta({ id: 'WorldAtResult' });

// -----------------------------------------------------------------------------------------------
// The registry
// -----------------------------------------------------------------------------------------------

export interface ToolSpec {
  /**
   * What the model is told the tool does. This is prose in the cached prefix and it is charged for
   * on every session, so it is written to be short and to answer "would I call this?" — see the
   * manifest budget in `packages/realtime/src/tools.ts`.
   */
  readonly description: string;
  readonly arguments: z.ZodType;
  readonly result: z.ZodType;
}

/**
 * Five narrow tools rather than one `get_world(topic)` or a generic `query(path)`, for a reason
 * specific to voice: a failed call is not a retry, it is a pause in a spoken sentence. A path
 * query invites the model to invent `enemy.puck.last_seen_position` and find out mid-answer that
 * it does not exist (design §4).
 *
 * `satisfies` rather than a type annotation, so the schemas keep their concrete types for the
 * inference below while the key set is still checked against `ToolName` — a sixth tool with no
 * entry, or an entry for a tool that does not exist, is a type error here.
 */
export const TOOLS = {
  my_state: {
    description:
      "The player's own hero right now: level, health, mana, gold, buyback, items and abilities with cooldowns.",
    arguments: MyStateArguments,
    result: MyStateResult,
  },
  enemy: {
    description:
      'What is known about an enemy hero: where they were last seen and how long ago, level, items seen, net worth. Name one hero, or omit the argument for all of them.',
    arguments: EnemyArguments,
    result: EnemyResult,
  },
  objectives: {
    description:
      'The map: towers and barracks standing on each side, Roshan and his respawn window, the next runes, day or night, and the match clock.',
    arguments: ObjectivesArguments,
    result: ObjectivesResult,
  },
  economy: {
    description:
      "Net worth on both sides and the lead, the player's gpm, xpm, last hits and denies, and lane net worth where the scoreboard has been seen.",
    arguments: EconomyArguments,
    result: EconomyResult,
  },
  world_at: {
    description:
      'Any of the above as it stood at a past moment in this match, read back from the recording. Use it for "where were they at twelve minutes" rather than answering from memory.',
    arguments: WorldAtArguments,
    result: WorldAtResult,
  },
} as const satisfies Record<ToolName, ToolSpec>;

export type ToolArgumentsFor<N extends ToolName> = z.infer<(typeof TOOLS)[N]['arguments']>;
export type ToolResultFor<N extends ToolName> = z.infer<(typeof TOOLS)[N]['result']>;

/**
 * A call the model made, once its arguments have been parsed.
 *
 * Written as a mapped type over `TOOLS` rather than as five hand-written members, because a
 * hand-written union is a second declaration of the tool set and would drift from the first one
 * the moment a tool changed shape.
 */
export type ToolInvocation = {
  [N in ToolName]: { readonly name: N; readonly arguments: ToolArgumentsFor<N> };
}[ToolName];

/** The matching answer. `name` joins the two, so a result cannot be attached to the wrong call. */
export type ToolAnswer = {
  [N in ToolName]: { readonly name: N; readonly result: ToolResultFor<N> };
}[ToolName];

export type MyStateReport = z.infer<typeof MyStateReport>;
export type EnemyReport = z.infer<typeof EnemyReport>;
export type EnemiesReport = z.infer<typeof EnemiesReport>;
export type ObjectivesReport = z.infer<typeof ObjectivesReport>;
export type EconomyReport = z.infer<typeof EconomyReport>;
export type WorldAtReport = z.infer<typeof WorldAtReport>;
export type MapPoint = z.infer<typeof MapPoint>;
export type GameClock = z.infer<typeof GameClock>;
