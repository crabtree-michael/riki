/**
 * Memory — four spans, from one turn to across matches.
 *
 * The model's context window truncates oldest-first, cannot be enumerated, and dies with the
 * session (realtime §5), so it is a cache of the tail of the ledger rather than a record. ADR-0012
 * is that decision; ADR-0013 constrains what may persist across matches.
 *
 * Architecture: docs/design/context-and-memory-architecture.md §6 and §7.
 */

export type * from './types.js';
export type * from './ports.js';
export type * from './contracts.js';

export { createConversationLedger, isWindowBearing, WINDOW_BEARING } from './ledger.js';
export type { DropCounts, MatchLedger } from './ledger.js';
export { createWorkingMemory } from './working.js';
export type { MutableWorkingMemory, WorkingMemoryOptions } from './working.js';
export { createCoachingMemory, topicKey } from './coaching.js';
export type { CoachingOptions } from './coaching.js';
export { createRetentionPolicy, DEFAULT_WINDOW_BUDGET } from './retention.js';
export type { RetentionOptions } from './retention.js';
export { createSummaryRenderer, topicLabel } from './summary.js';
export { createCompactor } from './compactor.js';
export type { CompactorOptions } from './compactor.js';
export { createRehydrator } from './rehydrate.js';
export type { RehydratorOptions } from './rehydrate.js';
export {
  createPlayerMemoryStore,
  EMPTY_PLAYER_MEMORY,
  PLAYER_MEMORY_KEY,
  PLAYER_MEMORY_SCHEMA_VERSION,
} from './player-memory.js';
export type { PlayerMemoryStoreOptions } from './player-memory.js';
export { observationsFrom } from './observations.js';
export type { MatchOutcome } from './observations.js';
export { entryTokens, speechTokens, TOKENS_PER_SPOKEN_WORD } from './occupancy.js';
