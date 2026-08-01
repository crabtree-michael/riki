/**
 * What a brief section is allowed to do, and the field paths it may say.
 *
 * The same two rules that hold the snapshot's `sections/` together, and they hold here for the same
 * reasons — which is why this file is a sibling of that one rather than an import from it
 * (coaching-architecture.md §2.1: the brief's composer is written fresh, and only `render/`'s
 * primitives are shared).
 *
 * - **A section never formats an age itself.** `field()` binds `renderObserved` to the request, so
 *   the only way a value reaches the text is past `AgeFormatter` — the same one Tier 2 uses, with
 *   the same confidence floor. There is deliberately no helper here that takes a bare `T`.
 * - **A section never does arithmetic.** Anything that compares two numbers — farm against a
 *   benchmark, a window against the clock — is `packages/world-model`'s derived state, formatted
 *   here (§5.5). A calculation in this directory would be a derived rule in the wrong package:
 *   invisible to fusion's provenance and confidence, and inside a 5 ms budget.
 *
 * The second rule is why `pace` reads `derived.pace*` rather than subtracting a benchmark from a
 * net worth, and why `windows` renders absolute clock times rather than "in 40 seconds":
 * **a comparison is arithmetic over two observed values**, and doing it here would produce a number
 * with no age and no confidence sitting next to numbers that have both.
 */

import type { FieldPath } from '../../common/ports.js';
import type { Observed } from '../../common/types.js';
import type { Section, SectionId } from '../../render/types.js';
import type { BriefContext, BriefSectionId } from '../types.js';
import { createAgeFormatter, renderObserved } from '../../render/age.js';
import { estimateTokens } from '../../render/tokens.js';

/** One formatter for the brief, so it and the snapshot agree about when to say "probably". */
const formatter = createAgeFormatter();

export function path(text: string): FieldPath {
  return text as FieldPath;
}

export type FieldRenderer = (
  label: string,
  observed: Observed<unknown> | undefined,
  format?: (value: unknown) => string,
) => string | null;

/**
 * `null` means *leave the field out*, never *render an empty one*.
 *
 * Every caller has to deal with the null, which is the only reason a dropped fact cannot become a
 * bare label. Inherited from Tier 2 unchanged, and it is the mechanism behind §4.3's "a stale fact
 * renders with its age and confidence or it does not render".
 */
export function fieldsFor(
  ctx: BriefContext,
  clock: Parameters<typeof renderObserved>[4],
): FieldRenderer {
  return (label, observed, format) =>
    observed === undefined
      ? null
      : renderObserved(label, observed, formatter, ctx.now, clock, format);
}

/** Drops the fields that did not survive and joins what did. `null` when nothing survived. */
export function join(parts: readonly (string | null)[], separator = ' | '): string | null {
  const kept = parts.filter((part): part is string => part !== null && part !== '');
  return kept.length === 0 ? null : kept.join(separator);
}

/**
 * A line, costed. Priority and droppability are filled in by the renderer from `BRIEF_PLAN`.
 *
 * A source that chose its own priority would be a source that decided its own place in the
 * truncation order — and here that order is per-cause, so a source *cannot* know it.
 */
export function line(id: BriefSectionId, label: string, body: string | null): Section | null {
  if (body === null || body === '') return null;
  const text = label === '' ? body : `${label}: ${body}`;
  return {
    id: id as unknown as SectionId,
    priority: 0,
    droppable: true,
    body: { text, tokens: estimateTokens(text) },
  };
}

/** `1840`, `7.2k`. Mirrors Tier 2's, so the same number reads the same in both. */
export function short(value: number): string {
  const abs = Math.abs(value);
  if (abs < 1000) return String(Math.round(value));
  return `${(value / 1000).toFixed(1)}k`;
}

/** A game clock as `mm:ss`, negative before the horn. */
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

/** `+320`, `-1.2k`. The sign is the answer, which is why it is never dropped for brevity. */
export function signed(value: number): string {
  return value >= 0 ? `+${short(value)}` : `-${short(Math.abs(value))}`;
}
