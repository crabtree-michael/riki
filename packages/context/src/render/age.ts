/**
 * The one place a staleness becomes words.
 *
 * dota2 §4 rule 3 and §6.2 both say a stale CV fact renders with its age and confidence or it does
 * not render at all. That rule is not held by anyone remembering it — it is held by there being
 * exactly one function that turns an `Observed<T>` into a string, and by handlers and section
 * sources having no bare value to render instead.
 *
 * See docs/design/context-and-memory-architecture.md §5.1.
 */

import type { GameClock, MonoMs, Observed, Provenance } from '../common/types.js';
import type { AgeFormatter } from './contracts.js';

export interface AgeFormatterOptions {
  /**
   * Facts below this confidence are dropped, not hedged: hedging spends tokens to say nothing.
   * Applies to `cv` only — gsi, log and api facts are 1.0 by construction (world-model fact.ts).
   */
  readonly confidenceFloor: number;
  /** Beyond this, an age stops being a number and becomes `unseen >Ns`. */
  readonly unseenAfterMs: number;
}

export const DEFAULT_AGE_OPTIONS: AgeFormatterOptions = {
  confidenceFloor: 0.5,
  unseenAfterMs: 20_000,
};

/** Sources whose facts are exact by construction and therefore carry no confidence marker. */
const EXACT_SOURCES: ReadonlySet<Provenance> = new Set<Provenance>(['gsi', 'log', 'api']);

/** Under this, a fact is current enough that spending tokens on its age says nothing. */
const FRESH_ENOUGH_MS = 1_000;

function formatSeconds(ms: number): string {
  const seconds = ms / 1000;
  return seconds < 10
    ? `${seconds.toFixed(1).replace(/\.0$/, '')}s`
    : `${String(Math.round(seconds))}s`;
}

/**
 * `4s ago(0.91)`, `~12s ago`, `unseen >20s`, or `null`.
 *
 * `null` is the below-threshold case and it means *drop the field*, not *render an empty string* —
 * callers that concatenate the result without checking would turn a dropped fact into a bare label,
 * which is the failure this whole module exists to prevent.
 */
export function createAgeFormatter(
  options: AgeFormatterOptions = DEFAULT_AGE_OPTIONS,
): AgeFormatter {
  return {
    // `now` and `clock` are part of the interface and deliberately unused: `Observed.ageMs` was
    // computed by the world model, which is where the two-clock rule lives (state-capture §5.5) —
    // tactical facts age in match time, pipeline facts in wall time. Re-deriving an age here from
    // whichever clock happened to be handy is exactly how those two would drift apart.
    format(observed: Observed<unknown>): string | null {
      if (observed.staleness === 'expired') return null;
      if (!EXACT_SOURCES.has(observed.source) && observed.confidence < options.confidenceFloor) {
        return null;
      }

      const exact = EXACT_SOURCES.has(observed.source);
      const confidence = exact ? '' : `(${observed.confidence.toFixed(2)})`;

      if (observed.ageMs >= options.unseenAfterMs) {
        return `unseen >${formatSeconds(options.unseenAfterMs)}${confidence}`;
      }
      if (observed.ageMs < FRESH_ENOUGH_MS) {
        // Fresh: no age marker, but a CV fact still says how sure it is.
        return confidence === '' ? '' : confidence;
      }

      // `~` marks an approximate observation; an exact source's age is exact.
      const tilde = exact ? '' : '~';
      return `${tilde}${formatSeconds(observed.ageMs)} ago${confidence}`;
    },
  };
}

/**
 * `value marker` with the single space collapsed when the marker is empty.
 *
 * Handlers never build this string themselves — they hand an `Observed<T>` to the formatter and
 * this joins the two halves, so there is no code path that renders a value without going past the
 * confidence gate. Returns `null` when the fact was dropped.
 */
export function renderObserved(
  label: string,
  observed: Observed<unknown>,
  formatter: AgeFormatter,
  now: MonoMs,
  clock: GameClock | null,
  format: (value: unknown) => string = String,
): string | null {
  const marker = formatter.format(observed, now, clock);
  if (marker === null) return null;
  const value = format(observed.value);
  const body = marker === '' ? value : `${value} ${marker}`;
  return label === '' ? body : `${label} ${body}`;
}
