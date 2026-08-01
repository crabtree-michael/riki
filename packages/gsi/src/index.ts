/**
 * @riki/gsi
 *
 * Receives Dota 2's Game State Integration POSTs: HTTP listener, token auth, parsing into
 * protocol types, and liveness/heartbeat tracking so a silent client is detectable.
 *
 * Inputs arrive at 2–8 Hz. FakeGsiSource in `@riki/gsi/testing` replays fixtures/gsi/*.jsonl,
 * which is what lets every consumer be tested without Dota running (§5.2).
 *
 * Skeleton only — no implementation yet. See REPO_SKELETON.md §2.2 for what belongs here
 * and §10 for where this package sits in the scaffolding order.
 */

export {};
