/**
 * @riki/log-tail
 *
 * Tails Dota's console.log for what GSI does not expose — chat and the kill feed — including
 * log rotation. Chat text is privacy-sensitive: it never leaves the machine by default
 * (state capture design §7) and is redacted by @riki/telemetry.
 *
 * Contracts only — no behaviour yet. Signatures are
 * docs/design/state-capture-architecture.md §4.2, waiting for REPO_SKELETON.md §10 step 4.
 */

export type * from './contracts.js';
