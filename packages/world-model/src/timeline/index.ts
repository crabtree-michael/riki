/**
 * The timeline reader — `conversational-architecture.md` §6, ticket T6.
 *
 * `record/` writes a match to disk as it plays. This reads one back at an instant, in work bounded
 * by the keyframe interval rather than by the length of the match, and hands the result to the
 * same four tools that answer about the present.
 *
 * - `reader.ts` — seek, replay, and the guarantee that makes it cheap.
 * - `world-at.ts` — the fifth tool, and the injected seam that keeps it from becoming a second
 *   renderer of T3's four.
 */

export * from './reader.js';
export * from './world-at.js';
