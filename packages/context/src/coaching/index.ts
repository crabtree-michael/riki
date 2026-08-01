/**
 * The coaching brief — the content half of proactive coaching.
 *
 * `packages/events` decides *whether* to speak and *about what*; this decides what the model is
 * shown so that it can. The two meet at `BRIEF_PLAN`, a lookup table from event id to sections,
 * which lives on this side of the edge so the salience path never acquires a reason to know about
 * tokens (coaching-architecture.md §4.4).
 *
 * It sits in `packages/context` rather than in a package of its own for the reason
 * context-and-memory §2.2 gives: *nobody can enforce a ceiling on a resource they can only see a
 * third of.* The brief is a third claimant on the same conversation window as the snapshot and the
 * conversation, and a separate package would need its own copy of `AgeFormatter` — which §5.1 warns
 * is how two renderers end up disagreeing about whether to say "probably".
 *
 * Architecture: docs/design/coaching-architecture.md §4–§5.
 */

export type * from './types.js';
export type * from './contracts.js';
export { BRIEF_PLAN, createBriefPlanner, planKeyFor } from './plan.js';
export { createBriefRenderer, sectionIdsOf, asBriefSectionId } from './render.js';
export type { BriefRendererOptions } from './render.js';
export {
  ALL_BRIEF_SECTIONS,
  HISTORY_WINDOW_SECONDS,
  cooldowns,
  economy,
  history,
  pace,
  positions,
  threat,
  windows,
} from './sections/index.js';
