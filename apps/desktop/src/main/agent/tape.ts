/**
 * `@riki/events`' `EventTape` as `@riki/context`'s `EventTapeReader`.
 *
 * Two identical method signatures and a one-line body, which is the point: the port is declared by
 * the package that *reads* it and implemented by the package that *writes* it, and the two only
 * ever meet here. That inversion is what keeps `packages/context` free of any import of
 * `@riki/events` while the data flows the way dota2 §3's diagram says (context-and-memory §8.2).
 *
 * If this file ever grows a body, the two definitions of "a recent event" have diverged, and the
 * fix is in one of the two packages rather than in the middle.
 */

import type { EventTapeReader } from '@riki/context';
import type { EventTape } from '@riki/events';

export function toEventTapeReader(tape: EventTape): EventTapeReader {
  return { recent: (n, since) => tape.recent(n, since) };
}
