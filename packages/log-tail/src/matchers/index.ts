/**
 * The matcher registry.
 *
 * The point of a registry rather than one big parser: console log format is outside our control
 * and will change under us, so the unit of breakage should be one small file with its own
 * fixtures (§4.2). Adding kill-feed parsing later is a new file here and one array entry — and,
 * more usefully, *removing* a matcher whose format turned out not to exist is a deletion rather
 * than surgery.
 *
 * Order matters only in that the first match wins, so the specific patterns come before the
 * permissive ones: `ping` last, because its bracketed form is the loosest regex in the set.
 */

import type { GameClock, LineMatcher, LogEvent, MonoMs } from '../contracts.js';
import { createChatMatcher } from './chat.js';
import { createKillFeedMatcher } from './killfeed.js';
import { createPingMatcher } from './ping.js';

export * from './chat.js';
export * from './killfeed.js';
export * from './ping.js';

export function defaultMatchers(): readonly LineMatcher[] {
  return [createKillFeedMatcher(), createChatMatcher(), createPingMatcher()];
}

/**
 * First match wins, and a line matching nothing is the common case — most of `console.log` is
 * engine noise. Kept cheap for exactly that reason: no allocation on the miss path.
 */
export function matchLine(
  matchers: readonly LineMatcher[],
  line: string,
  at: { readonly observedAt: MonoMs; readonly atGameClock: GameClock | null },
): LogEvent | null {
  for (const matcher of matchers) {
    const event = matcher.match(line, at);
    if (event !== null) return event;
  }
  return null;
}
