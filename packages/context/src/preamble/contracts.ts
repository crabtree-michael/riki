/**
 * Tier 1 assembly — the two things that build a preamble.
 *
 * See docs/design/context-and-memory-architecture.md §4. Declarations only.
 */

import type { MonoMs } from '../common/types.js';
import type {
  DraftView,
  EnrichmentRequest,
  PlayerIdentity,
  Preamble,
  PreambleInput,
} from './types.js';

/**
 * Called once, on `match_started`, before the session opens.
 *
 * **Total:** an enrichment failure is recorded in `degraded`, never thrown. A preamble that fails
 * is a match with no coach, and a coach with no matchup notes is still a coach.
 *
 * **Pure in its input:** `assemble(input)` must produce byte-identical text for identical input,
 * because a reconnect (§7.5) re-assembles it and a new session that cannot cache the prefix it
 * already paid for has thrown away the reason Tier 1 exists. A Tier 1 test asserts the identity.
 */
export interface PreambleAssembler {
  assemble(input: PreambleInput, deadline: MonoMs): Promise<Preamble>;
}

/**
 * What to fetch for this draft, in priority order.
 *
 * The deadline is short *(tunable: 3,000 ms, concurrent with the draft)* and the alternative —
 * blocking match start on enrichment — is worse than it looks: a slow or down external API would
 * make Riki silent through the laning phase, which is when the advice is most valuable and most
 * time-critical.
 */
export interface EnrichmentPlanner {
  plan(draft: DraftView, player: PlayerIdentity): readonly EnrichmentRequest[];
}
