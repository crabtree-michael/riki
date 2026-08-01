/**
 * Who is allowed to write what.
 *
 * The rule everyone quotes — *GSI beats CV; CV never overwrites fresh GSI* — needs two things to
 * become code: a definition of "fresh", and the recognition that **precedence is per field class,
 * not global**. `cv` outranks nothing on `self.hp` and outranks everything on an enemy position.
 *
 * See docs/design/state-capture-architecture.md §5.3, which carries the full matrix.
 */

import type { Fact, FactSource } from '../fact.js';
import type { FieldPath } from '../state.js';
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
}

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

export declare function createPrecedencePolicy(opts: PrecedenceOptions): PrecedencePolicy;
