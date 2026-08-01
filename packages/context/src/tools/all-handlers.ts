/**
 * The eight commands of dota2-state-capture-design.md §6.3, plus `search_hero_library`
 * (hero-library.md §4).
 *
 * One file each, and **no handler imports another** — a lint rule holds it (§2.3), because a
 * handler that called another would be a command whose failure paths are somebody else's and whose
 * deadline is spent twice. Anything two handlers need lives in `../render.ts` or a port.
 *
 * Declaration order is manifest order is golden-test order.
 */

import type { RegisteredTool } from './contracts.js';
import { getBuildBenchmark } from './handlers/get-build-benchmark.js';
import { getEnemyDetail } from './handlers/get-enemy-detail.js';
import { getItemInfo } from './handlers/get-item-info.js';
import { getMatchupAdvice } from './handlers/get-matchup-advice.js';
import { getMinimapSummary } from './handlers/get-minimap-summary.js';
import { getRecentEvents } from './handlers/get-recent-events.js';
import { getTimings } from './handlers/get-timings.js';
import { readScreen } from './handlers/read-screen.js';
import { searchHeroLibrary } from './handlers/search-hero-library.js';

export const ALL_HANDLERS: readonly RegisteredTool[] = [
  getEnemyDetail,
  getTimings,
  getRecentEvents,
  getMinimapSummary,
  getItemInfo,
  getMatchupAdvice,
  getBuildBenchmark,
  searchHeroLibrary,
  // Last, deliberately: it is the only one that can do something a player would not expect.
  readScreen,
];

export {
  getBuildBenchmark,
  getEnemyDetail,
  getItemInfo,
  getMatchupAdvice,
  getMinimapSummary,
  getRecentEvents,
  getTimings,
  readScreen,
  searchHeroLibrary,
};
