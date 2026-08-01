/**
 * The registry — data, not behaviour.
 *
 * The set of commands that exist, their argument schemas, their limits, and the manifest the model
 * is shown. Nothing here executes anything, which is what keeps "add a command" down to one file in
 * `handlers/` plus one `register()` call (§14).
 *
 * See docs/design/agent-command-execution-architecture.md §1, §8.1.
 */

import type {
  JsonSchemaObject,
  ManifestEnvironment,
  RegisteredTool,
  ResultRenderer,
  ToolContext,
  ToolDefinition,
  ToolHandler,
  ToolManifest,
  ToolRegistry,
} from './contracts.js';
import type {
  MonoMs,
  PortId,
  RenderContext,
  RenderedResult,
  ToolEffect,
  ToolLimits,
  ToolName,
  ToolOutcome,
} from './types.js';
import type { ArgsOf, DeclaredCodec, FieldSpecs, SubjectKind } from './codec.js';
import { EFFECT_DEFAULTS } from './tunables.js';
import { buildManifest } from './manifest.js';

/**
 * What a command declares. One of these per file in `handlers/`.
 *
 * The limits are the effect class's unless overridden, and an override may only **tighten** — a
 * definition that bought itself a longer deadline or a weaker rate cap than its class would mean
 * the class no longer decides the five things §3.2 exists to have it decide. `tighten()` holds
 * that at construction rather than in review.
 */
export interface ToolSpec<S extends FieldSpecs, R> {
  readonly name: ToolName;
  readonly effect: ToolEffect;
  /** Shown to the model. Prompt, not code — its home is REPO_SKELETON.md §11.5 (§15.1). */
  readonly summary: string;
  readonly args: DeclaredCodec<S>;
  /** Which ports must be usable for this command to answer freshly (§4.4, §7.3). */
  readonly needs: readonly PortId[];
  readonly limits?: Partial<ToolLimits>;
  readonly handler: ToolHandler<ArgsOf<S>, R>;
  readonly renderer: ResultRenderer<R>;
}

function tighten(
  name: ToolName,
  base: ToolLimits,
  over: Partial<ToolLimits> | undefined,
): ToolLimits {
  if (over === undefined) return base;

  const merged: ToolLimits = { ...base, ...over };
  const looser =
    merged.deadlineMs > base.deadlineMs ||
    merged.maxResultTokens > base.maxResultTokens ||
    merged.minIntervalMs < base.minIntervalMs ||
    merged.maxPerTurn > base.maxPerTurn ||
    (base.maxPerMatch !== null &&
      (merged.maxPerMatch === null || merged.maxPerMatch > base.maxPerMatch)) ||
    (base.consent === 'per_call' && merged.consent === 'none');

  if (looser) {
    throw new Error(
      `${name}: a definition may only tighten its effect class's limits, never loosen them ` +
        `(agent-command-execution-architecture.md §3.2).`,
    );
  }
  return merged;
}

/**
 * Erase a typed definition into the shape the pipeline runs.
 *
 * **This is the one place a type assertion is justified in this component, and it is worth saying
 * why.** The pipeline is generic over nothing: the executor holds a `RegisteredTool` and knows only
 * `unknown`. A single erased `ToolDefinition<never, unknown>` cannot express that, because
 * `ResultRenderer<R>` is contravariant in `R` — under `strictFunctionTypes` a
 * `ResultRenderer<EnemyDetail>` is not a `ResultRenderer<unknown>`, and no substitution for `R`
 * makes both the handler and the renderer assignable at once.
 *
 * So the erasure is done by *closing over* the typed pair here, where `S` and `R` are still in
 * scope and the value flowing through genuinely is `ArgsOf<S>` — it came out of `this.decode`, which
 * is the same codec. Every other module then sees a total, monomorphic function and no casts.
 */
export function defineTool<S extends FieldSpecs, R>(spec: ToolSpec<S, R>): RegisteredTool {
  const limits = tighten(spec.name, EFFECT_DEFAULTS[spec.effect].limits, spec.limits);

  const definition: ToolDefinition<ArgsOf<S>, R> = {
    name: spec.name,
    effect: spec.effect,
    summary: spec.summary,
    codec: spec.args,
    limits,
    needs: spec.needs,
    handler: spec.handler,
    renderer: spec.renderer,
  };

  return {
    name: definition.name,
    effect: definition.effect,
    summary: definition.summary,
    limits: definition.limits,
    needs: definition.needs,
    schema: spec.args.schema,
    subjects: spec.args.subjects,

    decode(raw: unknown): ToolOutcome<unknown> {
      return spec.args.decode(raw);
    },

    async execute(args: unknown, ctx: ToolContext): Promise<ToolOutcome<R>> {
      return definition.handler(args as ArgsOf<S>, ctx);
    },

    render(value: unknown, ctx: RenderContext): RenderedResult {
      return definition.renderer.render(value as R, ctx);
    },
  };
}

/** Order is declaration order, which is also manifest order, which is also golden-test order. */
class Registry implements ToolRegistry {
  readonly #tools = new Map<ToolName, RegisteredTool>();

  register(tool: RegisteredTool): void {
    if (this.#tools.has(tool.name)) {
      throw new Error(`${tool.name} is already registered`);
    }
    this.#tools.set(tool.name, tool);
  }

  lookup(name: string): RegisteredTool | undefined {
    return this.#tools.get(name as ToolName);
  }

  names(): readonly ToolName[] {
    return [...this.#tools.keys()];
  }

  all(): readonly RegisteredTool[] {
    return [...this.#tools.values()];
  }

  manifest(env: ManifestEnvironment, frozenAt: MonoMs, maxTokens: number): ToolManifest {
    return buildManifest(this.all(), env, frozenAt, maxTokens);
  }
}

export function createRegistry(tools: readonly RegisteredTool[] = []): ToolRegistry {
  const registry = new Registry();
  for (const tool of tools) registry.register(tool);
  return registry;
}

export type { JsonSchemaObject, SubjectKind };
