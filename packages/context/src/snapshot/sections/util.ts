/**
 * What a section source is allowed to do, and the field paths it may say.
 *
 * Two rules hold this directory together, and both are structural rather than remembered:
 *
 * - **A section never formats an age itself.** `field()` is a thin binding of `renderObserved` to a
 *   `SnapshotContext`, so the only way a value reaches the text is past `AgeFormatter` — the same
 *   one Tier 3 uses. There is deliberately no helper here that takes a bare `T`.
 * - **A section never does arithmetic.** `buy: diffusal2 in ~40s` is `DerivedView`'s number,
 *   formatted (§5.4). A calculation here would be a derived rule in the wrong package, invisible to
 *   fusion's provenance and confidence, and it would put game maths inside the 5 ms budget.
 *
 * See docs/design/context-and-memory-architecture.md §5.1, §5.4.
 */

import type { FieldPath } from '../../common/ports.js';
import type { GameClock, MonoMs, Observed } from '../../common/types.js';
import type { Section, SectionId } from '../../render/types.js';
import type { SnapshotContext, SnapshotSectionId } from '../types.js';
import type { WorldSnapshot } from '../../common/ports.js';
import { createAgeFormatter, renderObserved } from '../../render/age.js';
import { estimateTokens } from '../../render/tokens.js';

/** One formatter for the tier, so one confidence floor and one way to say "unseen". */
const formatter = createAgeFormatter();

export function path(text: string): FieldPath {
  return text as FieldPath;
}

/**
 * `label value 4s ago(0.91)`, or `null` when the fact did not survive the confidence gate.
 *
 * `null` means *leave the field out*, never *render an empty one*: a dropped fact that became a
 * bare `at ` is the failure `render/` exists to prevent, and it is only prevented because every
 * caller has to deal with the null.
 */
export type FieldRenderer = (
  label: string,
  observed: Observed<unknown> | undefined,
  format?: (value: unknown) => string,
) => string | null;

/**
 * Binds `renderObserved` to this turn's clocks once, so a section source has no bare-value path.
 *
 * Both clocks reach the formatter even though it currently ignores them: the age on an `Observed`
 * was computed by the world model, which is where the two-clock rule lives (state-capture §5.5).
 * Threading them anyway is what keeps that a decision `render/` can revisit rather than one Tier 2
 * has quietly taken away by never passing them.
 */
export function fieldsAt(now: MonoMs, clock: GameClock | null): FieldRenderer {
  return (label, observed, format) =>
    observed === undefined ? null : renderObserved(label, observed, formatter, now, clock, format);
}

/** The two things every source needs, bound once per render. */
export function rendererFor(world: WorldSnapshot, ctx: SnapshotContext): FieldRenderer {
  return fieldsAt(ctx.now, world.clock);
}

/** Drops the fields that did not survive and joins what did. `null` when nothing survived. */
export function join(parts: readonly (string | null)[], separator = ' | '): string | null {
  const kept = parts.filter((part): part is string => part !== null && part !== '');
  return kept.length === 0 ? null : kept.join(separator);
}

/**
 * A line, costed.
 *
 * `line()` returning `null` for an empty body is what makes "an empty `seen:` line and an absent one
 * say different things" (contracts.ts) true at every call site rather than at one.
 */
export function line(id: SnapshotSectionId, label: string, body: string | null): Section | null {
  if (body === null || body === '') return null;
  const text = label === '' ? body : `${label}: ${body}`;
  return {
    id: id as unknown as SectionId,
    // Filled in from the ladder by the renderer. A source that chose its own priority would be a
    // source that decided its own place in the truncation order (§5.2).
    priority: 0,
    droppable: true,
    body: { text, tokens: estimateTokens(text) },
  };
}

/** `1840`, `7.2k`, `12.4k` — the coach's own shorthand, and cheaper than the digits. */
export function short(value: number): string {
  const abs = Math.abs(value);
  if (abs < 1000) return String(Math.round(value));
  return `${(value / 1000).toFixed(1)}k`;
}

/** A game clock as `mm:ss`, negative before the horn. Mirrors Tier 3's `clockText`. */
export function clockText(seconds: number | null): string {
  if (seconds === null) return 'pre-horn';
  const sign = seconds < 0 ? '-' : '';
  const abs = Math.abs(Math.round(seconds));
  return `${sign}${String(Math.floor(abs / 60))}:${String(abs % 60).padStart(2, '0')}`;
}

/** `4s`, `1m20`. */
export function duration(seconds: number): string {
  const whole = Math.round(seconds);
  if (whole < 60) return `${String(whole)}s`;
  return `${String(Math.floor(whole / 60))}m${String(whole % 60).padStart(2, '0')}`;
}
