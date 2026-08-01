/**
 * A parsed GSI POST.
 *
 * Deliberately shallow. The full component set is dota2-state-capture-design.md §2.1; restating
 * every field here before anything reads them would be a large surface with no test behind it, and
 * the components are Valve's to change. What is fixed is the *parsing discipline*, which is where
 * the expensive mistakes are:
 *
 * - **Unknown fields pass through rather than failing.** Valve adds components between patches,
 *   and a strict parser turns a patch day into a total outage.
 * - **A POST is a partial state.** Only enabled components appear, and a component may be absent
 *   from a given POST. Absent means *unchanged*, not *cleared* — the reducer must never null a
 *   field because a POST omitted it.
 * - **`previously` and `added` are discarded.** Dota includes both alongside the current values;
 *   the current values are the truth, and fusion computes its own deltas. Consuming Valve's would
 *   mean maintaining two notions of what changed. ⚠ Verify against a live capture — this is the
 *   assumption in the architecture most likely to be wrong (§11.5).
 * - **`clock_time` is negative before the horn** and does not advance while `map.paused`.
 *
 * ⚠ In a live game GSI exposes **only the local player**. Ten-player data, `minimap`, `roshan` and
 * `couriers` are gated to spectators; Valve did that deliberately and ADR-0003 respects it. That
 * gap is the entire justification for the vision layer — do not look for a way around it.
 */

export interface GsiPayload {
  readonly provider: GsiProvider | undefined;
  readonly map: GsiMap | undefined;
  readonly player: Readonly<Record<string, unknown>> | undefined;
  readonly hero: Readonly<Record<string, unknown>> | undefined;
  readonly abilities: Readonly<Record<string, unknown>> | undefined;
  readonly items: Readonly<Record<string, unknown>> | undefined;
  readonly buildings: Readonly<Record<string, unknown>> | undefined;
  /** Only populated during the draft phase. */
  readonly draft: Readonly<Record<string, unknown>> | undefined;
  /** Anything Valve added that this build does not know about. Kept, never interpreted. */
  readonly unknown: Readonly<Record<string, unknown>>;
}

export interface GsiProvider {
  readonly name: string;
  readonly appid: number;
  readonly version: number;
  readonly timestamp: number;
}

export interface GsiMap {
  readonly matchid: string | undefined;
  /** Seconds. Negative pre-horn. */
  readonly clock_time: number | undefined;
  readonly game_time: number | undefined;
  readonly game_state: string | undefined;
  readonly paused: boolean | undefined;
  readonly daytime: boolean | undefined;
  readonly radiant_score: number | undefined;
  readonly dire_score: number | undefined;
  /** Present for Turbo, Ability Draft and custom games — mode-specific advice is disabled, not guessed. */
  readonly customgamename: string | undefined;
}

export type ParseResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

/**
 * Parse failures are counted and dropped, never thrown at the HTTP layer: Dota does not care and
 * will keep POSTing, and a 500 loop helps nobody.
 */
export interface GsiPayloadParser {
  parse(raw: unknown): ParseResult<GsiPayload>;
}
