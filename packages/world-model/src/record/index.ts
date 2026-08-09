/**
 * The match recorder — `conversational-architecture.md` §6.
 *
 * A match is written to `<dataDir>/matches/<matchId>.jsonl` as it plays: every observation with its
 * timestamps, and a full serialised `WorldState` every 30 seconds. The file is a `fixtures/gsi/`
 * fixture as well as a dataset, which is what lets a played match become a replayable test case
 * (ADR-0044).
 *
 * - `format.ts` — the line shape, and the compatibility rule that keeps it replayable.
 * - `keyframe.ts` — `WorldState` to JSON and back.
 * - `recorder.ts` — the cadence, the failure policy, and the chat redaction.
 * - `file-sink.ts` — the one piece of I/O.
 */

export * from './format.js';
export * from './keyframe.js';
export * from './recorder.js';
export * from './file-sink.js';
