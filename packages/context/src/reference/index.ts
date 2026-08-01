/**
 * Reference data — the data that is not about this match.
 *
 * Hero knowledge that is true in every game: what a hero does, where it spikes, how to play against
 * it. It holds nothing observed, nothing timestamped and nothing per-player, which is why none of it
 * is `Observed<T>` — there is no age to render because nothing here was seen. What it carries
 * instead is a **patch** (ADR-0027).
 *
 * Nothing here reads the world model, a clock or a source, and nothing here is async. It is content
 * plus a pure query over it, which is what keeps `packages/context` runnable with no network, no
 * filesystem and no key.
 */

export * from './hero-library/index.js';
