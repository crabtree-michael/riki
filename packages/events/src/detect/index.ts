/**
 * The default detector set — one per `CoachEventKind`, and the compiler says so.
 *
 * Assembled here rather than inside the engine so that a test can build an engine with a single
 * detector in it, which is what keeps a gate test from having to satisfy eight unrelated
 * preconditions to produce one candidate.
 *
 * Adding an advice topic is one file in this directory, one arm on `CoachEventKind`, one weight in
 * `config.ts` and one row in `BRIEF_PLAN` over in `packages/context`. Two packages, and no existing
 * module changes behaviour — the one genuinely good property the deleted tool registry had
 * (coaching-architecture.md §14).
 */

import type { EventDetector } from '../contracts.js';
import type { CoachEventKind } from '../types.js';
import { enemyCoreDeadWindow, lowHpNoEscape, ultReady } from './combat.js';
import { buybackUnaffordable, canAffordKeyItem } from './economy.js';
import { enemyMissing } from './map.js';
import { runeSoon, stackNow } from './timings.js';

/**
 * Keyed by kind and typed `Record<CoachEventKind, …>`, so a new arm on the union fails the compiler
 * here rather than shipping a kind that nothing detects. That is the same totality argument
 * `BRIEF_PLAN` makes on the other side of the seam, and the two failures are complementary: a kind
 * with no row renders an empty brief, and a kind with no detector never fires at all.
 */
export const DETECTORS: Readonly<Record<CoachEventKind, EventDetector>> = {
  enemy_missing: enemyMissing,
  ult_ready: ultReady,
  can_afford_key_item: canAffordKeyItem,
  low_hp_no_escape: lowHpNoEscape,
  rune_soon: runeSoon,
  enemy_core_dead_window: enemyCoreDeadWindow,
  stack_now: stackNow,
  buyback_unaffordable: buybackUnaffordable,
};

export function defaultDetectors(): readonly EventDetector[] {
  return Object.values(DETECTORS);
}

export * from './combat.js';
export * from './economy.js';
export * from './map.js';
export * from './timings.js';
