/**
 * The one file in this package that reaches OpenAI, and the only one that imports the Agents SDK.
 *
 * Requirement 6 asks for OpenAI's agent-building platform rather than a raw chat completion, and
 * this is what that buys concretely: a typed output schema the model is *made* to fill rather than
 * asked to, and a tool loop the SDK runs on our behalf — the run comes back only once the model has
 * stopped calling `lookup_hero` and produced an answer. Both of those are the parts a hand-rolled
 * integration gets wrong first.
 *
 * ## Three decisions worth knowing before you edit this
 *
 * **A `Runner`, not the module-level `run()`.** The SDK's convenience entry point resolves a model
 * provider from process-global state (`setDefaultOpenAIKey`), and a key in a module global is the
 * thing REPO_SKELETON.md §7.1 exists to prevent — it would be reachable from any package that
 * imports the SDK, which is exactly the property the lint boundary is trying to establish. A
 * `Runner` holding its own `OpenAIProvider` keeps the key on one object with one owner.
 *
 * **`tracingDisabled` follows config and defaults to on-disabled.** The SDK's tracing exporter
 * posts prompts, tool arguments and outputs to a second endpoint as a side channel. A stimulus
 * contains the rendered world snapshot. `config.ts` has the full argument; the point here is that
 * it is a *privacy* default, not a performance one, and it is asserted by a test.
 *
 * **A failed run is `null`, never a throw.** `CoachModel.judge` is specified that way and this is
 * where it is honoured: a timeout, a malformed output, an exhausted tool budget and a 401 all
 * produce silence and a counter. The alternative is an exception on the path that decides whether
 * to talk to a player mid-fight.
 *
 * See docs/design/llm-coach-architecture.md §5.4.
 */

import { Agent, OpenAIProvider, Runner, tool } from '@openai/agents';
import { z } from 'zod';

import type { LlmCoachConfig } from './config.js';
import { DEFAULT_COACH_CONFIG } from './config.js';
import type { CoachModel } from './contracts.js';
import { lookupHero } from './library.js';
import { INSTRUCTIONS, renderStimulus } from './prompt.js';
import type { DetectionKey } from '@riki/events';
import type { CoachJudgement, CoachStimulus } from './types.js';

/**
 * The API key, structurally.
 *
 * `ApiKey` is a class in `packages/realtime` (ADR-0022) and this package may not import that one —
 * a coach with a line to the thing that speaks would make the composition root optional. Taking the
 * shape instead means an `ApiKey` satisfies it without either package knowing about the other, and
 * the value still never exists here as a bare `string` outside the single `reveal()` below.
 */
export interface RevealableKey {
  reveal(): string;
}

/**
 * The output schema, and the reason this is an Agents SDK integration rather than a prompt.
 *
 * `.nullable()` rather than `.optional()` on both nullable fields: the Responses API's structured
 * output requires every property to be present, so an optional field is a field the model is free
 * to omit and then a schema failure. Null is a value it can supply.
 */
const JUDGEMENT_SCHEMA = z.object({
  speak: z.boolean().describe('True only if Riki should say something out loud right now.'),
  reasoning: z.string().describe('One sentence. Why you did or did not speak. Never spoken aloud.'),
  say: z
    .string()
    .nullable()
    .describe('What Riki says, one or two short spoken sentences. Null when speak is false.'),
  about: z
    .string()
    .nullable()
    .describe(
      'The key of the signal this is about, copied exactly from the stimulus — e.g. ' +
        '"enemy_missing:sf". Null when not speaking.',
    ),
  weight: z.number().min(0).max(1).describe('Your own view of how much this mattered, 0 to 1.'),
});

export interface OpenAiCoachModelDeps {
  readonly apiKey: RevealableKey;
  readonly config?: LlmCoachConfig;
  /** Overridable for a proxy or a compatible endpoint. Unset means OpenAI's own. */
  readonly baseUrl?: string;
  /**
   * Why a run produced nothing.
   *
   * A callback rather than a `CoachTelemetry` port, because this is the *only* thing in this file
   * worth reporting and taking the whole port would let a later edit log a stimulus or a judgement
   * from inside the module that holds the key. The shell wires it to `modelFailed`.
   */
  readonly onFailure?: (message: string) => void;
}

const HERO_TOOL = tool({
  name: 'lookup_hero',
  description:
    'Static coaching notes about one hero: what it does, when it spikes, how to play against it. ' +
    'Patch-stamped, never about this match, and it covers twenty heroes rather than all of them.',
  parameters: z.object({
    hero: z.string().describe('The hero, as a player says it — "Shadow Fiend", "Enigma".'),
    topic: z
      .enum(['overview', 'laning', 'timings', 'items', 'weaknesses', 'counters'])
      .nullable()
      .describe('Narrow to one aspect, or null for the hero’s best notes.'),
  }),
  execute: ({ hero, topic }): string => lookupHero(hero, topic ?? undefined).text,
});

/**
 * `finalOutput` is typed by the schema, but it arrives from a network boundary — so it is validated
 * again rather than trusted, and a shape that does not parse is a failed run rather than a
 * judgement with a hole in it.
 *
 * The two cross-field rules the schema itself cannot state are checked here: speaking requires
 * something to say, and staying quiet means there is nothing to say. Both are coerced rather than
 * rejected, because a model that set `speak: true` and left `say` empty has told us its judgement
 * and fumbled the payload — and the safe direction for this product is silence.
 */
export function toJudgement(raw: unknown): CoachJudgement | null {
  const parsed = JUDGEMENT_SCHEMA.safeParse(raw);
  if (!parsed.success) return null;

  const { speak, reasoning, say, about, weight } = parsed.data;
  const text = say === null ? '' : say.trim();
  if (speak && text === '') return null;

  // Cast, not validated: this function has no idea which keys were in the stimulus, and the only
  // place that does is `coach.ts` — which checks membership and discards a judgement naming a key
  // it was not shown. Validating a `DetectionKey` by shape here would be a second, weaker check
  // that could pass on a well-formed key for a signal that does not exist.
  const key = about === null ? null : (about.trim() as DetectionKey);

  return {
    speak,
    reasoning,
    say: speak ? text : null,
    about: key === null || key === '' ? null : key,
    weight,
  };
}

export function createOpenAiCoachModel(deps: OpenAiCoachModelDeps): CoachModel {
  const config = deps.config ?? DEFAULT_COACH_CONFIG;

  const provider = new OpenAIProvider({
    // The one call site. ADR-0022 names `reveal()` so it is greppable and looks wrong in a log
    // statement; a second one in this package should be treated as a design question.
    apiKey: deps.apiKey.reveal(),
    ...(deps.baseUrl === undefined ? {} : { baseURL: deps.baseUrl }),
  });

  const runner = new Runner({
    modelProvider: provider,
    tracingDisabled: !config.tracing,
    workflowName: 'riki-coach',
  });

  const agent = new Agent({
    name: 'Riki coach',
    instructions: INSTRUCTIONS,
    model: config.model,
    tools: [HERO_TOOL],
    outputType: JUDGEMENT_SCHEMA,
  });

  let closed = false;

  return {
    async judge(stimulus: CoachStimulus): Promise<CoachJudgement | null> {
      if (closed) return null;
      try {
        const result = await runner.run(agent, renderStimulus(stimulus), {
          maxTurns: config.maxTurns,
        });
        const judgement = toJudgement(result.finalOutput);
        if (judgement === null) deps.onFailure?.('the run produced no usable judgement');
        return judgement;
      } catch (error: unknown) {
        // Every failure mode lands here and every one of them means the same thing: Riki says
        // nothing this consultation. A 401, a timeout, an exhausted tool budget and a malformed
        // output are indistinguishable to the caller by design — what differs is the message, and
        // a rising count of any of them is the key, the model id or the network.
        deps.onFailure?.(error instanceof Error ? error.message : String(error));
        return null;
      }
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await provider.close();
    },
  };
}
