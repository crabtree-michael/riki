/**
 * Who is allowed to write what.
 *
 * The rule everyone quotes — *GSI beats CV; CV never overwrites fresh GSI* — needs two things to
 * become code: a definition of "fresh", and the recognition that **precedence is per field class,
 * not global**. `cv` outranks nothing on `self.health` and outranks everything on an enemy
 * position.
 *
 * See docs/design/state-capture-architecture.md §5.3, which carries the full matrix.
 */

import type { Fact, FactSource } from '../fact.js';
import type { FieldPath } from '../state.js';
import { parsePath } from '../state.js';
import type { MonoMs } from '../time.js';

/**
 * Fields grouped by who may write them. The class is the unit of the precedence matrix, so adding
 * a field means choosing its class rather than restating four rules.
 */
export type FieldClass =
  /** GSI authoritative, CV feeds the drift monitor instead of the model (§5.6). */
  | 'self'
  /** GSI authoritative; the `buildings` component covers both teams, so minimap CV is redundant. */
  | 'buildings'
  /** Match identity and clock. Exactly one honest source. */
  | 'meta'
  /**
   * Who is in this game. GSI's `draft` component names all ten, but it is only populated during
   * the draft phase and is absent entirely if the app started mid-match — so the top bar has to be
   * able to name a hero GSI never did.
   *
   * Not in the architecture's §5.3 table, which had no row that both admits GSI and admits CV;
   * folding identity into `meta` would have made a CV-only start nameless, and folding it into
   * `enemy_progress` would have let a 0.6 top-bar guess overwrite a hero the draft confirmed.
   */
  | 'roster'
  /** CV only — GSI cannot see it, and §8.2 forbids inferring it any other way. */
  | 'enemy_position'
  /** Log (kill feed) is exact; CV (top bar) rounds. Log wins, CV fills gaps. */
  | 'enemy_liveness'
  /** CV: top bar and scoreboard. */
  | 'enemy_progress'
  /** Log primary; OCR only when the log path is unavailable — availability, not confidence. */
  | 'chat'
  /** Recomputed, never written from outside. */
  | 'derived';

export type PrecedenceVerdict =
  | { readonly write: true }
  | {
      readonly write: false;
      readonly reason: 'lower_rank' | 'gsi_shadow' | 'older' | 'lower_confidence';
    };

export interface PrecedenceOptions {
  /**
   * How long an authoritative source's silence must last before a lower-ranked source may write a
   * field it owns. 2000 ms (tunable).
   *
   * This number exists because the rule as usually stated is ambiguous about a *silent* GSI, and
   * both readings are defensible — but they behave oppositely during a dropout, which is exactly
   * when Riki is most likely to say something wrong.
   */
  readonly gsiShadowWindowMs: number;
  /**
   * How long a CV detection defends its field against a *less* confident one. 2000 ms (tunable).
   *
   * Rule 4 says a 0.55 blob may not erase a 0.91 sighting "that is still fresh", and freshness
   * needs a number for the same reason the shadow window does. Not in the architecture's option
   * list; without it, either the confidence rule never fires or a high-confidence sighting from
   * four minutes ago blocks every update forever.
   */
  readonly confidenceWindowMs?: number;
}

export const DEFAULT_PRECEDENCE_OPTIONS: PrecedenceOptions = {
  gsiShadowWindowMs: 2000,
  confidenceWindowMs: 2000,
};

/**
 * Applied in order: rank → GSI shadow → recency → confidence. Recency is what makes out-of-order
 * delivery harmless rather than corrupting, and it is checked per field, so a late batch still
 * contributes the fields it is newest for.
 */
export interface PrecedencePolicy {
  classOf(field: FieldPath): FieldClass;
  rankFor(cls: FieldClass, source: FactSource): number;
  canWrite(
    field: FieldPath,
    incoming: Fact<unknown>,
    existing: Fact<unknown> | undefined,
    now: MonoMs,
  ): PrecedenceVerdict;
}

/**
 * §5.3's matrix, as ranks. Higher wins; **absent means rank 0, which is the "never writes"
 * column** — not "lowest priority". A rank-0 source is refused unconditionally, however stale the
 * field is and however long the authoritative source has been quiet.
 *
 * The split between "never writes" and "may fill gaps" is the whole of the difference between
 * `self.health` (CV must never write it, because GSI is ground truth and a disagreeing CV reading
 * is a calibration signal, not a fact — §5.6) and `enemies.*.alive` (CV should write it once the
 * kill feed has been quiet, because otherwise nobody would).
 */
const RANKS: Readonly<Record<FieldClass, Partial<Record<FactSource, number>>>> = {
  self: { gsi: 3 },
  buildings: { gsi: 3 },
  meta: { gsi: 3, api: 1 },
  roster: { gsi: 3, cv: 2 },
  enemy_position: { cv: 3 },
  enemy_liveness: { log: 3, cv: 2 },
  enemy_progress: { cv: 3 },
  chat: { log: 3, cv: 2 },
  derived: { derived: 3 },
};

/**
 * Path → class.
 *
 * Three mappings are worth stating because they are not obvious from the field name:
 *
 * - `map.daytime` is `meta`. It is GSI-only and nothing else may write it, which is exactly the
 *   `meta` policy; giving it its own class would duplicate a row to no effect.
 * - `map.roshanState` is `enemy_liveness`. Roshan's liveness has the same two sources in the same
 *   trust order as an enemy hero's — the kill feed is exact, the top bar rounds — so it shares
 *   the row rather than copying it.
 * - `map.wardsSeen` is `enemy_position`. Wards are CV-only and §8.2 allows only what the minimap
 *   actually renders, which is the same constraint, stated once.
 */
export function classOfPath(field: FieldPath): FieldClass {
  const parsed = parsePath(field);
  if (parsed === null) return 'derived';

  switch (parsed.root) {
    case 'meta':
      return 'meta';
    case 'self':
      return 'self';
    case 'map':
      if (parsed.key === 'buildings') return 'buildings';
      if (parsed.key === 'roshanState') return 'enemy_liveness';
      if (parsed.key === 'wardsSeen') return 'enemy_position';
      return 'meta';
    case 'itemsSeen':
      return 'enemy_progress';
    case 'allies':
    case 'enemies':
      if (parsed.key === 'hero') return 'roster';
      if (parsed.key === 'position' || parsed.key === 'lastSeenAt') return 'enemy_position';
      if (parsed.key === 'alive' || parsed.key === 'respawnIn') return 'enemy_liveness';
      return 'enemy_progress';
  }
}

export function createPrecedencePolicy(
  opts: PrecedenceOptions = DEFAULT_PRECEDENCE_OPTIONS,
): PrecedencePolicy {
  const shadowMs = opts.gsiShadowWindowMs;
  const confidenceMs =
    opts.confidenceWindowMs ?? DEFAULT_PRECEDENCE_OPTIONS.confidenceWindowMs ?? 0;

  const rankFor = (cls: FieldClass, source: FactSource): number => RANKS[cls][source] ?? 0;

  return {
    classOf: classOfPath,
    rankFor,

    canWrite(field, incoming, existing, now): PrecedenceVerdict {
      const cls = classOfPath(field);
      const incomingRank = rankFor(cls, incoming.source);

      // 1. Rank. Rank 0 is the "never writes" column and is not negotiable.
      if (incomingRank === 0) return { write: false, reason: 'lower_rank' };
      if (existing === undefined) return { write: true };

      const existingRank = rankFor(cls, existing.source);

      // 2. GSI shadow. A lower-ranked source may fill a gap the authoritative source has left, but
      //    only once that source has actually been quiet — otherwise a CV reading would race a GSI
      //    POST that is 80 ms behind it and win half the time.
      if (incomingRank < existingRank) {
        if (now - existing.observedAt < shadowMs) return { write: false, reason: 'gsi_shadow' };
        return { write: true };
      }

      // 3. Recency. Out-of-order delivery is expected (§6.2) and must be harmless, not corrupting.
      if (incoming.observedAt < existing.observedAt) return { write: false, reason: 'older' };

      // 4. Confidence, within a source. A 0.55 blob does not get to erase a 0.91 sighting from a
      //    second ago — but it does once that sighting has stopped being current, because by then
      //    a hedged answer beats a confident stale one.
      if (
        incoming.source === existing.source &&
        incoming.confidence < existing.confidence &&
        now - existing.observedAt < confidenceMs
      ) {
        return { write: false, reason: 'lower_confidence' };
      }

      return { write: true };
    },
  };
}
