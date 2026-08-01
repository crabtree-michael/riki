/**
 * @riki/gsi
 *
 * Receives Dota 2's Game State Integration POSTs: HTTP listener, token auth, parsing into
 * protocol types, and liveness/heartbeat tracking so a silent client is detectable.
 *
 * Inputs arrive at 2–8 Hz. FakeGsiSource in `@riki/gsi/testing` replays fixtures/gsi/*.jsonl,
 * which is what lets every consumer be tested without Dota running (§5.2).
 *
 * Contracts only — no behaviour yet. Signatures are
 * docs/design/state-capture-architecture.md §4.1, waiting for REPO_SKELETON.md §10 step 4.
 */

export type * from './contracts.js';
export type * from './payload.js';
