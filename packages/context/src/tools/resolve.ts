/**
 * Validate the *subject*, which schema validation cannot.
 *
 * Schema validation says the argument is a string. It does not say the string names a hero in
 * **this match**, and that distinction is where fabrication gets in: `get_enemy_detail("pudge")` in
 * a game with no Pudge has exactly one correct answer — *"Pudge isn't in this game"* — and the
 * failure to give it is how a voice coach ends up confidently discussing a hero nobody is playing.
 *
 * So the draft comes from the snapshot, not from a list, and `unknown_subject` carries the
 * candidates so the model corrects itself in one turn instead of two.
 *
 * See docs/design/agent-command-execution-architecture.md §4.3.
 */

import type { MatchSubjects, RegisteredTool, Resolved, SubjectResolver } from './contracts.js';
import type { HeroId, ItemId, ParsedCall, RegionId, ToolOutcome } from './types.js';
import {
  HERO_BY_SPOKEN,
  ITEM_BY_SPOKEN,
  KNOWN_REGIONS,
  REGION_BY_SPOKEN,
  normalise,
} from './aliases.js';
import { ok, unknownSubject } from './failures.js';
import { withArgs } from './parse.js';

/**
 * Edit distance, capped. Only ever used to *offer* a match, never to accept a wrong one silently:
 * a fuzzy hit is admitted and recorded, and a rising fuzzy rate means the alias table is behind a
 * patch — a maintenance signal available for free (§4.3).
 */
function distance(a: string, b: string): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 2) return 3;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const deletion = (previous[j] ?? 0) + 1;
      const insertion = (current[j - 1] ?? 0) + 1;
      current[j] = Math.min(substitution, deletion, insertion);
    }
    previous = current;
  }
  return previous[b.length] ?? 3;
}

/** One spoken form, against one table, with the fuzzy fallback. */
function lookup(
  spoken: string,
  table: ReadonlyMap<string, string>,
): { readonly id: string; readonly matched: 'exact' | 'alias' | 'fuzzy' } | undefined {
  const key = normalise(spoken);
  if (key === '') return undefined;

  const direct = table.get(key);
  if (direct !== undefined) {
    return { id: direct, matched: direct === key ? 'exact' : 'alias' };
  }

  // Nearest within one edit, and only if it is unambiguously nearest — two candidates at the same
  // distance is exactly the case where guessing produces confident nonsense.
  let best: string | undefined;
  let bestDistance = 2;
  let tied = false;
  for (const [candidate, id] of table) {
    const d = distance(key, candidate);
    if (d < bestDistance) {
      bestDistance = d;
      best = id;
      tied = false;
    } else if (d === bestDistance && id !== best) {
      tied = true;
    }
  }
  return best !== undefined && !tied ? { id: best, matched: 'fuzzy' } : undefined;
}

export function createSubjectResolver(): SubjectResolver {
  return {
    /**
     * A hero has to be *in the draft*. `not_in_match` is the reason this stage exists at all, and
     * it is checked after aliasing so that "pudge" and "pudge" spelled three ways all reach it.
     */
    hero(spoken: string, subjects: MatchSubjects): Resolved<HeroId> {
      // `self` is empty before the draft resolves; an empty id is absence, not a hero.
      const inMatch = [subjects.self, ...subjects.allies, ...subjects.enemies].filter(
        (hero) => String(hero) !== '',
      );
      const candidates = inMatch.map(String);

      const hit = lookup(spoken, HERO_BY_SPOKEN);
      const id = hit?.id ?? normalise(spoken).replace(/ /g, '_');

      const match = inMatch.find((hero) => String(hero) === id);
      if (match !== undefined) {
        return { ok: true, value: match, matched: hit?.matched ?? 'exact' };
      }

      // The draft is *complete*, and that is what makes this stage work without a full hero table:
      // whatever the name turns out to be, if it is not one of these ten it is not in this match,
      // and "Juggernaut isn't in this game" is the right answer whether or not the alias table has
      // heard of Juggernaut. `unknown` is reserved for having nothing to compare against — before
      // the draft resolves, refusing a name would be asserting something we cannot know.
      return inMatch.length === 0
        ? { ok: false, reason: 'unknown', candidates }
        : { ok: false, reason: 'not_in_match', candidates };
    },

    item(spoken: string): Resolved<ItemId> {
      const hit = lookup(spoken, ITEM_BY_SPOKEN);
      return hit === undefined
        ? { ok: false, reason: 'unknown' }
        : { ok: true, value: hit.id as ItemId, matched: hit.matched };
    },

    region(spoken: string): Resolved<RegionId> {
      const hit = lookup(spoken, REGION_BY_SPOKEN);
      return hit === undefined
        ? { ok: false, reason: 'unknown', candidates: KNOWN_REGIONS }
        : { ok: true, value: hit.id as RegionId, matched: hit.matched };
    },
  };
}

/**
 * Walk a call's declared subject fields and rewrite them to canonical ids.
 *
 * Generic over the command, which is the whole point of `SubjectKind` being a codec kind rather
 * than a convention: eight handlers would otherwise mean eight alias lookups and eight chances to
 * disagree about whether `nevermore` is Shadow Fiend.
 */
export function resolveSubjects(
  call: ParsedCall,
  tool: RegisteredTool,
  resolver: SubjectResolver,
  subjects: MatchSubjects,
): ToolOutcome<ParsedCall> {
  if (tool.subjects.length === 0) return ok(call);

  const args = { ...(call.args as Record<string, unknown>) };

  for (const [field, kind] of tool.subjects) {
    const spoken = args[field];
    if (typeof spoken !== 'string') continue; // optional and absent — the codec already checked it

    const resolved =
      kind === 'hero'
        ? resolver.hero(spoken, subjects)
        : kind === 'item'
          ? resolver.item(spoken)
          : resolver.region(spoken);

    if (!resolved.ok) {
      return {
        ok: false,
        failure: unknownSubject(spoken, resolved.reason, resolved.candidates ?? []),
      };
    }
    args[field] = resolved.value;
  }

  return ok(withArgs(call, args));
}

/** The draft as the resolver needs it, read from the snapshot rather than from a list (§4.3). */
export function subjectsFrom(roster: {
  readonly self: HeroId | undefined;
  readonly allies: readonly HeroId[];
  readonly enemies: readonly HeroId[];
}): MatchSubjects {
  return {
    self: roster.self ?? ('' as HeroId),
    allies: roster.allies,
    enemies: roster.enemies,
  };
}
