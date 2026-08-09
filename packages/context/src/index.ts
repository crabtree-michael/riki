/**
 * @riki/context
 *
 * What the agent sees.
 *
 * One thing, now: the ~300-token snapshot rendered from the world model at the moment a turn
 * begins, plus the reference data that is true in every match rather than in this one. Everything
 * that used to sit beside it — the session preamble, the coaching brief, the conversation ledger
 * and the coaching memory — is deleted by ADR-0042, along with the trigger engine that was the only
 * thing which needed them.
 *
 * The argument for the deletion is that all four existed to serve a coach that decided *when* to
 * speak. A brief is the focused rendering of the facts one specific piece of advice needs, and with
 * no trigger there is no advice to focus on; a ledger is a record of turns Riki started, and Riki no
 * longer starts any. What is left is what was always underneath: the player asks, and the model is
 * handed a picture of the match to answer from.
 *
 * The rendered format is still an interface to the LLM, so it is still golden-tested against
 * `fixtures/golden/snapshot/` — a format change should show up as a readable diff.
 *
 * Architecture: docs/design/conversational-architecture.md §3 and §5;
 * docs/design/context-and-memory-architecture.md §5 for the snapshot itself, which did not move.
 *
 * `createSnapshotRenderer()` is the one runtime surface. Everything else is exported for the
 * composition root's own wiring and for tests.
 *
 * See REPO_SKELETON.md §2.2 for what belongs here.
 */

export type * from './common/index.js';
export { systemTimers } from './common/timers.js';
export * from './render/index.js';
export * from './snapshot/index.js';

// `./reference/` is deliberately **not on this barrel**, and it is reachable on its own subpath —
// `@riki/context/reference`. A named subpath rather than a barrel entry so that it is a declared
// dependency at the manifest level and shows up in a `grep '@riki/context/reference'`, which the
// other things on this barrel do not.
//
// It has no consumer today: `packages/coach` was the one that asked what a hero usually does, and
// ADR-0042 deleted it. The content survives the prune because the model now asks the questions
// itself and the session prompt is the obvious next home for it (T8), not because anything is
// currently reading it.
//
// What has not changed: nothing here fetches, and `eslint.config.js` still forbids `fs`, `path` and
// `http` in this package. hero-library.md §6's price for a live library is still a package boundary.
