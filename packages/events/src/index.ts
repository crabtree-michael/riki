/**
 * @riki/events
 *
 * Decides whether Riki should speak at all: event detection over the world model, salience scoring,
 * the thirteen gates, the mid-fight intensity signal, and the event tape.
 *
 * **The default is silence.** dota2 §6.4's closing line — *"unprompted speech is the feature most
 * likely to make Riki annoying enough to uninstall"* — is a statement about which direction to fail
 * in, and it is the reason this package is shaped the way it is: a gate that is unsure refuses, a
 * detector that cannot answer honestly emits nothing, and a trigger arriving while a turn is open
 * is dropped rather than queued.
 *
 * Four questions, four seams, and keeping them apart is the whole design
 * (`coaching-trigger-architecture.md` §5.2):
 *
 * | Question | Answered by |
 * |---|---|
 * | What is true right now? | `detect/` — pure functions of a `WorldSnapshot` |
 * | How much does it matter? | `salience.ts` — kind weight × magnitude × urgency × confidence × tendency |
 * | Should we say it anyway? | `gates/` and `policy.ts` — thirteen reasons, in order, each counted |
 * | What has been happening? | `tape.ts` — the snapshot's `recent:` line |
 *
 * **Every number that changes behaviour is in `config.ts`**, so tuning (coaching §16 step 8) is a
 * diff to one file against a replay corpus rather than a hunt through eight detectors.
 *
 * What this package deliberately cannot do: reach `@riki/realtime` (a direct line to the thing that
 * speaks would make the gates bypassable by anyone in a hurry), read `process.env`, call
 * `console.*`, or touch the filesystem. The lint rules in `eslint.config.js` hold all four.
 *
 * Architecture: docs/design/coaching-trigger-architecture.md, and
 * docs/design/coaching-architecture.md §6 for how it meets the content half.
 */

export type * from './types.js';
export { COACH_EVENT_KINDS, SUPPRESSION_REASONS, detectionKey, eventTopic } from './types.js';

export type * from './contracts.js';

export type { TriggerConfig } from './config.js';
export { DEFAULT_TRIGGER_CONFIG, withTriggerConfig } from './config.js';

export { createSalienceScorer, urgencyOf, clamp01 } from './salience.js';
export type { SalienceOptions } from './salience.js';

export { createIntensityMonitor } from './intensity.js';
export type { IntensityMonitor } from './intensity.js';

export { GATES } from './gates/index.js';
export { createTriggerPolicy, rank } from './policy.js';

export { createEventTape } from './tape.js';
export type { EventTapeOptions } from './tape.js';

// The individual detectors as well as the set: a test — and the composition root's own tests —
// needs to build an engine with one detector in it, so that a gate assertion does not have to
// satisfy eight unrelated preconditions to produce a single candidate.
export * from './detect/index.js';

export { createEventEngine } from './engine.js';
export type { EventEngineDeps } from './engine.js';
