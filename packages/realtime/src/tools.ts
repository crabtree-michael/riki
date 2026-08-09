/**
 * The tool registry: the five tools as the Realtime API wants to see them, and the two conversions
 * on either side of a call.
 *
 * `@riki/protocol`'s `schemas/tools.ts` owns the shapes. This file owns everything vendor-shaped
 * about them — the wire form of a tool definition, the JSON Schema the model is shown, and the
 * parse and encode steps that sit between `response.function_call_arguments.done` and
 * `function_call_output`. Nothing here reads a `WorldState` or calls a tool; the dispatcher is a
 * port, and `packages/world-model` implements it (T3).
 *
 * ## The shape trap, which is the same one `session-config.ts` documents
 *
 * A Realtime tool definition is **flat**:
 *
 * ```json
 * { "type": "function", "name": "my_state", "description": "…", "parameters": { … } }
 * ```
 *
 * Chat Completions nests the same four fields under a `function` key, and that is the form most
 * examples show. What a Realtime session does when given it — refuse the update, or accept it and
 * configure nothing — has **not** been measured here, and the point of the assertion is that we
 * never find out during a match. It is the same third layer `assertGaShape` is for the session
 * payload, for the same reason: a misconfigured session does not error, it just never calls a tool,
 * and that is indistinguishable from a model choosing not to.
 *
 * ## The manifest is frozen, and it is a permanent tax
 *
 * ADR-0011 was superseded with the command manifest it described, but the half of its reasoning
 * that survives applies here unchanged: tool definitions live in the **cached prefix**, so
 * changing the list mid-session rewrites the prefix and invalidates the cache for the rest of the
 * match. So the manifest is computed once, at session open, and availability is expressed in the
 * *result* of a call — which is what `UnknownFact` is for — never in the presence of the tool.
 *
 * It is also charged for on every session whether or not anything calls it, which is why
 * `TOOL_MANIFEST_BUDGET_CHARACTERS` exists and is asserted by a test. Without a number the tax is
 * invisible.
 */

import { z } from 'zod';
import {
  TOOLS,
  ToolName,
  type ToolAnswer,
  type ToolArgumentsFor,
  type ToolInvocation,
  type ToolResultFor,
  type UnknownFact,
} from '@riki/protocol';

import type { CallId, ToolCallRefusal } from './types.js';

// -----------------------------------------------------------------------------------------------
// The manifest
// -----------------------------------------------------------------------------------------------

/** One entry of `session.tools`. Flat — see the header. */
export interface RealtimeToolDefinition {
  readonly type: 'function';
  readonly name: ToolName;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

/**
 * Roughly what the manifest may cost the cached prefix, in characters of JSON.
 *
 * Characters and not tokens, deliberately: a tokeniser here would be a dependency and a second
 * thing to keep current, and the number is a tripwire rather than a measurement. Four English
 * characters to a token puts this at about 500 tokens, well inside the 16,384 the definitions
 * share with the session instructions. Adding a tool means re-measuring, which is the point.
 */
export const TOOL_MANIFEST_BUDGET_CHARACTERS = 3_000;

/**
 * The five definitions, generated from the zod argument schemas.
 *
 * Generated rather than hand-written, because the schema the model is shown and the validator that
 * rejects what it sends must have one source — ADR-0018's rule, now that `packages/protocol` has
 * the emitter that ADR asked it to wait for. A hand-written `parameters` block that has drifted
 * from its validator tells the model a shape, accepts it, and refuses it, out loud, mid-answer.
 */
export function buildToolManifest(): readonly RealtimeToolDefinition[] {
  return ToolName.options.map((name) => ({
    type: 'function',
    name,
    description: TOOLS[name].description,
    parameters: parametersOf(name),
  }));
}

function parametersOf(name: ToolName): Readonly<Record<string, unknown>> {
  // `io: 'input'` is what the model is filling in — the output type of an argument schema is what
  // *we* get after parsing, and for anything with a default or a transform the two differ.
  const parameters: Record<string, unknown> = {
    ...z.toJSONSchema(TOOLS[name].arguments, { target: 'draft-2020-12', io: 'input' }),
  };
  // `$schema` is a fact about the document, not about the arguments, and the model does not read
  // it. Sixty characters of prefix, five times, for every session.
  delete parameters.$schema;
  return parameters;
}

/**
 * Throws on a tool list that is not the Realtime shape.
 *
 * The nested `function` form is the one that matters and the reason this exists; the rest is the
 * cheap arithmetic that catches a definition assembled by hand somewhere it should not have been.
 */
export function assertRealtimeToolShape(
  tools: unknown,
): asserts tools is readonly RealtimeToolDefinition[] {
  if (!Array.isArray(tools)) throw new TypeError('session.tools is not an array.');

  for (const [index, entry] of tools.entries()) {
    const at = `session.tools[${String(index)}]`;
    if (typeof entry !== 'object' || entry === null) throw new TypeError(`${at} is not an object.`);
    const tool = entry as Record<string, unknown>;

    if ('function' in tool) {
      throw new TypeError(
        `${at} nests its fields under \`function\` — that is the Chat Completions shape. Realtime takes {type, name, description, parameters} flat, and configures no tools at all when given the other one.`,
      );
    }
    if (tool.type !== 'function') throw new TypeError(`${at} has no \`type: "function"\`.`);
    if (typeof tool.name !== 'string' || tool.name.length === 0) {
      throw new TypeError(`${at} has no name.`);
    }
    if (typeof tool.description !== 'string' || tool.description.length === 0) {
      throw new TypeError(`${at} (${tool.name}) has no description — the model chooses by it.`);
    }
    const parameters = tool.parameters;
    if (typeof parameters !== 'object' || parameters === null) {
      throw new TypeError(`${at} (${tool.name}) has no parameters object.`);
    }
    if ((parameters as Record<string, unknown>).additionalProperties !== false) {
      throw new TypeError(
        `${at} (${tool.name}) does not say additionalProperties: false, so the model is invited to send fields the validator will reject.`,
      );
    }
  }
}

// -----------------------------------------------------------------------------------------------
// A call, coming in
// -----------------------------------------------------------------------------------------------

/**
 * Why a call could not be turned into a `ToolInvocation`.
 *
 * Three failures rather than one because they need different answers and only one of them is our
 * bug: `unknown-tool` and `invalid-arguments` are the model getting it wrong and are recoverable
 * by telling it so, while `malformed-json` means the arguments never arrived intact and there is
 * nothing to correct.
 */
export interface ToolCallFailure {
  readonly ok: false;
  readonly reason: ToolCallRefusal;
  /** Safe to hand back as the function output: it names the tool and what was wrong with it. */
  readonly detail: string;
}

export type ParsedToolCall = { readonly ok: true; readonly call: ToolInvocation } | ToolCallFailure;

/**
 * The raw `arguments` string from `response.function_call_arguments.done`, validated.
 *
 * A **value, never a throw.** This runs inside a turn that is already speaking, and an exception
 * escaping here is a turn that stops mid-sentence with no audio and no error the player can
 * interpret — the failure mode ADR-0042 exists to have fewer of.
 */
export function parseToolCall(name: string, argumentsJson: string): ParsedToolCall {
  const parsedName = ToolName.safeParse(name);
  if (!parsedName.success) {
    return {
      ok: false,
      reason: 'unknown-tool',
      detail: `There is no tool called \`${name}\`. The tools are: ${ToolName.options.join(', ')}.`,
    };
  }
  const tool = parsedName.data;

  let raw: unknown;
  try {
    // A no-argument call may arrive as `""` rather than `"{}"` depending on how it was assembled,
    // and `JSON.parse('')` throws — which would classify a perfectly ordinary `my_state()` as
    // malformed. Not measured against a live session; cheap enough to handle either way, and the
    // failure it guards costs a turn.
    raw = argumentsJson.trim() === '' ? {} : JSON.parse(argumentsJson);
  } catch (error) {
    return {
      ok: false,
      reason: 'malformed-json',
      detail: `The arguments for \`${tool}\` were not valid JSON: ${String(error)}`,
    };
  }

  const parsed = TOOLS[tool].arguments.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      reason: 'invalid-arguments',
      detail: `The arguments for \`${tool}\` do not match its schema: ${describeIssues(parsed.error)}`,
    };
  }

  // `safeParse` erases the per-tool argument type through the `ToolSpec` index, and re-deriving it
  // is what makes `ToolInvocation` a discriminated union the dispatcher can switch on.
  return { ok: true, call: { name: tool, arguments: parsed.data } as ToolInvocation };
}

// -----------------------------------------------------------------------------------------------
// An answer, going out
// -----------------------------------------------------------------------------------------------

export type EncodedToolOutput =
  { readonly ok: true; readonly json: string } | { readonly ok: false; readonly detail: string };

/**
 * The JSON that becomes a `function_call_output`, validated against the tool's result schema on
 * the way past.
 *
 * This is where the design's one correctness obligation is actually enforced. A tool that answered
 * a never-observed field with `0`, or with `null`, or by omitting it, fails here rather than
 * reaching a model that will read it out as a number — `ToolFact`'s two branches are strict, so
 * there is no shape halfway between a value and an `unknown` for a bug to occupy.
 *
 * A failure is a value for the same reason `parseToolCall`'s is: the caller turns it into a
 * degraded answer, and a throw would turn it into silence.
 */
export function encodeToolOutput(answer: ToolAnswer): EncodedToolOutput {
  const parsed = TOOLS[answer.name].result.safeParse(answer.result);
  if (!parsed.success) {
    return {
      ok: false,
      detail: `\`${answer.name}\` produced a result its schema refuses: ${describeIssues(parsed.error)}`,
    };
  }
  return { ok: true, json: JSON.stringify(parsed.data) };
}

/**
 * A failure, in the one shape the model has already been taught to read.
 *
 * Every tool result is `orUnknown(Report)`, so `{ unknown: reason }` is a **valid** answer to all
 * five — which makes it the right encoding for the four ways a call can fail on our side as well:
 * a refused parse, a dispatcher that threw, a result its own schema rejects, and a tool layer that
 * is not wired. The model does not need a second vocabulary for "I could not get that", and it
 * handles this one already (ADR-0043). `tools.test.ts` asserts the validity rather than assuming
 * it, because it is the whole reason for the choice.
 *
 * The fallback text exists because `UnknownFact.unknown` is `.min(1)`: an empty reason would be
 * refused by the very schema this is trying to satisfy, which is a silence in place of a degraded
 * answer.
 */
export function unknownOutput(reason: string): string {
  const unknown: UnknownFact = {
    unknown: reason.trim() === '' ? 'the tool could not be answered, and gave no reason' : reason,
  };
  return JSON.stringify(unknown);
}

/**
 * The conversation item that answers a call, as the API wants it.
 *
 * Flat, like the tool definition, and addressed by `call_id` rather than by the id of the item the
 * call arrived in. `output` is a **string** — the JSON goes in as text, not as an object — and
 * getting that wrong is the same class of quiet misconfiguration as the nested `function` key.
 */
export function functionCallOutputItem(
  callId: CallId,
  output: string,
): Readonly<Record<string, unknown>> {
  return { type: 'function_call_output', call_id: callId, output };
}

/** zod's issue list, flattened to one line for a log or a function output. */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

// -----------------------------------------------------------------------------------------------
// The port
// -----------------------------------------------------------------------------------------------

/**
 * What answers a call.
 *
 * Structural and injected, like every other collaborator in this package, so the session can be
 * driven with a fake dispatcher and no world model — and so `packages/world-model` never has to
 * import `packages/realtime`, which a boundary rule forbids anyway (`eslint.config.js`: the model
 * must not know it is feeding an LLM).
 *
 * Generic in the tool name so an implementation cannot answer `enemy` with an `economy` result.
 */
export interface ToolDispatcher {
  call<N extends ToolName>(name: N, args: ToolArgumentsFor<N>): Promise<ToolResultFor<N>>;
}

/**
 * Dispatch a parsed call and validate what comes back.
 *
 * Exists to hold the one cast in this package's tool path. `ToolInvocation` is a union of five
 * (name, arguments) pairs and `ToolAnswer` is the matching union of (name, result) pairs, but
 * TypeScript cannot see that a `name` and a `result` obtained together came from the same member —
 * so composing the answer needs an assertion. The alternative is a five-armed switch, which would
 * be the tool list written out for a third time and would drift the first time a tool is added.
 *
 * The assertion is checked a line later rather than trusted: `encodeToolOutput` looks the schema up
 * by `answer.name` and parses `answer.result` against it, so a mismatched pair comes back as a
 * refusal instead of reaching the model.
 *
 * **Rejects when the dispatcher rejects.** Turning a thrown tool into a degraded answer is the
 * session's decision, not this function's — the session is the layer that knows a turn is
 * mid-sentence and that silence is the expensive outcome.
 */
export async function callTool(
  dispatcher: ToolDispatcher,
  call: ToolInvocation,
): Promise<EncodedToolOutput> {
  const result = await dispatcher.call(call.name, call.arguments);
  return encodeToolOutput({ name: call.name, result } as ToolAnswer);
}
