/**
 * @riki/coach
 *
 * The LLM coach: an OpenAI agent that decides for itself whether Riki should say anything, and what.
 *
 * It is the **alternative** to `packages/events`, not a stage inside it. Both packages answer the
 * same question — *should Riki speak right now, and about what* — and the composition root runs
 * exactly one of them at a time, switched by the tray's Coach row. The deterministic coach is kept
 * intact and is the baseline every judgement here is compared against.
 *
 * | | `packages/events` | `packages/coach` |
 * |---|---|---|
 * | Decides whether to speak | thirteen gates, in order, each counted | one model call |
 * | Decides what to say | `BRIEF_PLAN` picks sections; a template renders them | the model drafts the line |
 * | Runs on | every world-model version bump | a **fresh** detection, rate-limited. No timer |
 * | Tunable against a fixture corpus with no network | yes, entirely | no |
 * | Why it is quiet | a `SuppressionReason`, counted per gate | a sentence, in the model's words |
 *
 * The last two rows are the trade in both directions and neither is small. What this package buys
 * is judgement; what it costs is that the primary tuning instrument stops being a counter and starts
 * being prose, and that a coach that has gone wrong cannot be debugged by reading `config.ts`.
 *
 * **What it shares with the deterministic coach, deliberately:** the eight detectors (`signals.ts`),
 * so both coaches are triggered by the same underlying world-model events; and the rendered world
 * snapshot, so both models are looking at the same game. What it does not share is everything
 * between those two — salience, the gates, the latch, the cooldowns, `BRIEF_PLAN`.
 *
 * **One rule that has to hold and is not enforced by a type:** *this package renders no fact.* It
 * holds a `WorldSnapshot` only to hand to a detector, and every value the model reads arrived
 * either through `packages/context`'s `AgeFormatter` (the narration) or through a detector's own
 * `text`. A number produced here would be the first in the product to reach a player with no age and
 * no confidence attached — which is the failure the whole fact envelope exists to prevent.
 *
 * Architecture: docs/design/llm-coach-architecture.md.
 * See REPO_SKELETON.md §2.2 for what belongs here.
 */

export type * from './types.js';
export { SKIP_REASONS, eventIdOf } from './types.js';

export type * from './contracts.js';

export type { LlmCoachConfig } from './config.js';
export { DEFAULT_COACH_CONFIG, DEFAULT_COACH_MODEL, withCoachConfig } from './config.js';

export { INSTRUCTIONS, renderStimulus } from './prompt.js';

export { lookupHero, normaliseHeroName } from './library.js';
export type { HeroLookup } from './library.js';

export { createSignalReader } from './signals.js';
export type { SignalReader, SignalReaderDeps } from './signals.js';

export { createCoachRecord } from './record.js';

export { createLlmCoach } from './coach.js';

// The SDK lives behind this one export, and it is the only thing in the package that can reach a
// network. Everything above runs in a bare vitest process with no key.
export { createOpenAiCoachModel, toJudgement } from './openai-model.js';
export type { OpenAiCoachModelDeps, RevealableKey } from './openai-model.js';
