/**
 * Turning a POST body into a `GsiPayload`.
 *
 * The parsing discipline is in `payload.ts`; this is where it becomes code. The shape of the job
 * is unusual and worth stating: **almost nothing is rejected**. Valve owns this format, adds
 * components between patches, and does not announce it — so a parser that fails closed converts a
 * patch day into a total outage, while one that fails open converts it into a few fields nobody
 * reads yet.
 *
 * So the only rejection is "this is not an object at all". Everything else is kept: known
 * components in their named slots, everything else in `unknown`, which is preserved rather than
 * interpreted so that a later build can find out what it was missing without a new recording.
 */

import type { GsiMap, GsiPayload, GsiPayloadParser, GsiProvider, ParseResult } from './payload.js';

/** The components the cfg in dota2 §2.1 enables. `auth` is consumed before parsing and dropped. */
const KNOWN_COMPONENTS = [
  'provider',
  'map',
  'player',
  'hero',
  'abilities',
  'items',
  'buildings',
  'draft',
] as const;

/**
 * Valve sends these alongside the current values on every POST.
 *
 * They are discarded, and §4.1 flags this as the assumption in the architecture most likely to be
 * wrong — it needs a live capture to confirm. The reasoning for discarding them is that fusion
 * computes its own deltas from the model it already holds, and consuming Valve's as well would
 * mean maintaining two notions of what changed, which drift.
 *
 * They are dropped here rather than ignored downstream so there is one place to change if the
 * assumption turns out to be wrong.
 */
const DELTA_BLOCKS = ['previously', 'added'] as const;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function num(source: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = source?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function str(source: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = source?.[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function bool(source: Record<string, unknown> | undefined, key: string): boolean | undefined {
  const value = source?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

export function createGsiPayloadParser(): GsiPayloadParser {
  return {
    parse(raw: unknown): ParseResult<GsiPayload> {
      const root = asRecord(raw);
      if (root === undefined) return { ok: false, reason: 'body is not a JSON object' };

      const unknownComponents: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(root)) {
        if (key === 'auth') continue;
        if ((KNOWN_COMPONENTS as readonly string[]).includes(key)) continue;
        if ((DELTA_BLOCKS as readonly string[]).includes(key)) continue;
        unknownComponents[key] = value;
      }

      return {
        ok: true,
        value: {
          provider: parseProvider(asRecord(root.provider)),
          map: parseMap(asRecord(root.map)),
          player: asRecord(root.player),
          hero: asRecord(root.hero),
          // `abilities` and `items` can be objects or arrays depending on the build, so they are
          // handed on as-is: normalising here would mean the world model's reader could not tell
          // which it got, and it is the one place that actually cares.
          abilities: asRecord(root.abilities),
          items: asRecord(root.items),
          buildings: asRecord(root.buildings),
          draft: asRecord(root.draft),
          unknown: unknownComponents,
        },
      };
    },
  };
}

function parseProvider(provider: Record<string, unknown> | undefined): GsiProvider | undefined {
  if (provider === undefined) return undefined;
  const name = str(provider, 'name');
  if (name === undefined) return undefined;
  return {
    name,
    appid: num(provider, 'appid') ?? 0,
    version: num(provider, 'version') ?? 0,
    timestamp: num(provider, 'timestamp') ?? 0,
  };
}

function parseMap(map: Record<string, unknown> | undefined): GsiMap | undefined {
  if (map === undefined) return undefined;
  return {
    matchid: str(map, 'matchid'),
    // Read with `num`, not with a truthiness check: `clock_time` is legitimately 0 at the horn and
    // legitimately negative before it, and both would be lost by the obvious shorthand.
    clock_time: num(map, 'clock_time'),
    game_time: num(map, 'game_time'),
    game_state: str(map, 'game_state'),
    paused: bool(map, 'paused'),
    daytime: bool(map, 'daytime'),
    radiant_score: num(map, 'radiant_score'),
    dire_score: num(map, 'dire_score'),
    customgamename: str(map, 'customgamename'),
  };
}
