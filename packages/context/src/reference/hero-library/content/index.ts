/**
 * The library, assembled — twenty heroes, one patch, one date.
 *
 * The roster and the rule that chose it are hero-library.md §2. In short: ranked by win-rate edge
 * over 50 % in the Ancient and Divine brackets, weighted by pick rate, plus a professional contest
 * bonus, then adjusted until every position had at least three heroes. The data came from
 * OpenDota's public `heroStats` API on the date below, not from the tier-list blogs, which
 * disagreed with each other and with the bracket data.
 *
 * **Nothing refreshes this** (ADR-0023). `PATCH` is therefore load-bearing rather than
 * informational: it is rendered with every result, non-droppably, and it is the only thing
 * separating "notes written for 7.41e" from a claim about the game as it is today.
 */

import type { HeroLibrary } from '../types.js';
import { CARRIES } from './carries.js';
import { MIDS } from './mids.js';
import { OFFLANERS } from './offlaners.js';
import { SUPPORTS } from './supports.js';

/** The patch the notes were written against, and the patch every result is stamped with. */
export const PATCH = '7.41e';

/** When the roster was selected and the notes authored. ISO, because §2 asks to be repeatable. */
export const AUTHORED = '2026-08-01';

export const HERO_LIBRARY: HeroLibrary = {
  patch: PATCH,
  authored: AUTHORED,
  entries: [...CARRIES, ...MIDS, ...OFFLANERS, ...SUPPORTS],
};

export { CARRIES, MIDS, OFFLANERS, SUPPORTS };
