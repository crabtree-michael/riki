/**
 * The failure taxonomy — ten codes, and the sentence each one says out loud.
 *
 * The whole reason this file exists rather than a `throw` at each site: `speakable` is **content,
 * not a diagnostic**. The model is handed this string and will say it, so "I can't see the minimap
 * right now" is correct and "ECONNREFUSED 127.0.0.1:53101" is not. Writing the user-facing half of
 * a failure at the point where the failure is *classified* is what keeps ten codes and eight
 * commands consistent, and it is the difference between degrading quietly to the player and
 * degrading confusingly.
 *
 * `detail` is the other half, separated by type rather than by convention so that the egress test
 * has something structural to assert: nothing from `detail` ever reaches `output`.
 *
 * See docs/design/agent-command-execution-architecture.md §3.4 and §7.1.
 */

import type { ToolErrorCode, ToolFailure, ToolName, ToolOutcome } from './types.js';

/** Every code, its voice, and whether asking again could ever help. §7.1, in one table. */
const TAXONOMY: Readonly<
  Record<ToolErrorCode, { readonly speakable: string; readonly retryable: boolean }>
> = {
  unknown_tool: { speakable: "That isn't something I can look up.", retryable: false },
  malformed_arguments: {
    speakable: "I didn't catch what to look up — say that again?",
    retryable: false,
  },
  invalid_arguments: {
    speakable: "I didn't catch what to look up — say that again?",
    retryable: false,
  },
  unknown_subject: { speakable: "That isn't in this game.", retryable: false },
  unavailable: { speakable: "I can't see that right now.", retryable: true },
  timeout: { speakable: "That's taking too long — ask me again in a second.", retryable: true },
  rate_limited: { speakable: 'I just looked — give it a moment.', retryable: true },
  // Never phrased as an error: the player did not fail at anything by saying no.
  consent_denied: { speakable: "Okay, I won't look.", retryable: false },
  // Never submitted (§6.5) — the conversation item it would answer no longer exists.
  cancelled: { speakable: '', retryable: false },
  internal: { speakable: 'Something went wrong on my end.', retryable: false },
};

/**
 * Build a failure. `detail` is optional and is the only channel for internals.
 *
 * `speak` overrides the taxonomy's default sentence for the cases where a *specific* one is better
 * than a generic one — "Pudge isn't in this game" beats "That isn't in this game", and §7.1 says
 * `unknown_tool` must answer with the commands that do exist, because that corrects the model
 * inside the turn instead of costing a round trip.
 */
export function fail(
  code: ToolErrorCode,
  options: { readonly speak?: string; readonly detail?: string } = {},
): ToolFailure {
  const row = TAXONOMY[code];
  const speakable = options.speak ?? row.speakable;
  return options.detail === undefined
    ? { code, speakable, retryable: row.retryable }
    : { code, speakable, retryable: row.retryable, detail: options.detail };
}

/** `{ ok: false, failure }` in one call, because every stage returns one of these. */
export function failure<R>(
  code: ToolErrorCode,
  options?: { readonly speak?: string; readonly detail?: string },
): ToolOutcome<R> {
  return { ok: false, failure: fail(code, options) };
}

export function ok<R>(value: R): ToolOutcome<R> {
  return { ok: true, value };
}

/** The default sentence for a code, for tests and for anything that needs it without a failure. */
export function speakableFor(code: ToolErrorCode): string {
  return TAXONOMY[code].speakable;
}

export function isRetryable(code: ToolErrorCode): boolean {
  return TAXONOMY[code].retryable;
}

/**
 * `unknown_tool`, phrased so the model can correct itself this turn.
 *
 * The name check is a real code path, not defensive programming: the model calls tools that do not
 * exist — usually ones it saw in a similar API, occasionally ones it invented — and the cheapest
 * repair is telling it the truth about what exists (§4.2).
 */
export function unknownTool(name: string, available: readonly ToolName[]): ToolFailure {
  return fail('unknown_tool', {
    speak: `That isn't something I can look up. I can check: ${available.join(', ')}.`,
    detail: `unregistered tool ${JSON.stringify(name)}`,
  });
}

/**
 * `unknown_subject`, carrying the candidates so the model spends one turn correcting itself
 * rather than two. `get_enemy_detail("pudge")` in a game with no Pudge has exactly one correct
 * answer, and the failure to give it is how a voice coach ends up confidently discussing a hero
 * nobody is playing (§4.3).
 */
export function unknownSubject(
  spoken: string,
  reason: 'unknown' | 'ambiguous' | 'not_in_match',
  candidates: readonly string[] = [],
): ToolFailure {
  const list = candidates.length > 0 ? ` I can see: ${candidates.join(', ')}.` : '';
  const speak =
    reason === 'not_in_match'
      ? `${spoken} isn't in this game.${list}`
      : reason === 'ambiguous'
        ? `I'm not sure which one you mean.${list}`
        : `I don't know ${spoken}.${list}`;
  return fail('unknown_subject', { speak, detail: `${reason}: ${spoken}` });
}
