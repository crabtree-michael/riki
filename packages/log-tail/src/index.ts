/**
 * @riki/log-tail
 *
 * Tails Dota's console.log for what GSI does not expose — chat and the kill feed — including
 * log rotation. Chat text is privacy-sensitive: it never leaves the machine by default
 * (state capture design §7) and is redacted by @riki/telemetry.
 *
 * Shapes are docs/design/state-capture-architecture.md §4.2. The tailer is format-independent
 * and tested against temp files; the matchers are the part that a Dota patch breaks, which is
 * why each is its own file with its own fixture lines.
 */

export type * from './contracts.js';
export * from './matchers/index.js';
export * from './privacy.js';
export * from './tailer.js';
