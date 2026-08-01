/**
 * The manifest — frozen for the session, and taxed for the session.
 *
 * Command definitions are sent in `session.update` alongside the instructions, against a
 * **16,384-token shared cap**, inside the cached prefix (realtime §1, §5). Two consequences drive
 * everything here:
 *
 * - **Every command costs prefix tokens for the whole session**, called or not. Hence the ceiling,
 *   asserted by a Tier 1 test — "we added a tool" is otherwise an invisible tax on every turn.
 * - **Changing the manifest mid-session rewrites the prefix and busts the cache.** So
 *   **availability is a property of the result, never of the manifest**: when the sidecar dies,
 *   `get_minimap_summary` stays advertised and answers with aged facts or `unavailable`.
 *
 * The only thing that legitimately changes the *set* is build configuration, decided once before
 * the session opens (ADR-0011).
 *
 * See docs/design/agent-command-execution-architecture.md §8.1.
 */

import type {
  ManifestEntry,
  ManifestEnvironment,
  RegisteredTool,
  ToolManifest,
} from './contracts.js';
import type { MonoMs, ToolName } from './types.js';
import { estimateTokens } from '../render/tokens.js';

/** The commands that cannot answer without the vision sidecar. `RIKI_VISION=off` removes them. */
const VISION_BACKED: ReadonlySet<ToolName> = new Set<ToolName>([
  'get_minimap_summary',
  'read_screen',
]);

/**
 * What a manifest entry costs, tokenized the way the model will see it.
 *
 * The name, the summary and the JSON Schema all go on the wire verbatim, so all three are counted.
 * §12 flags "tool definitions are tokenized as verbatim JSON Schema" as unverified — if that turns
 * out to be wrong the number here changes, but the ceiling stays, which is the point of measuring
 * it in one function.
 */
export function estimateEntryTokens(tool: RegisteredTool): number {
  return (
    estimateTokens(tool.name) +
    estimateTokens(tool.summary) +
    estimateTokens(JSON.stringify(tool.schema))
  );
}

export function includedIn(tool: RegisteredTool, env: ManifestEnvironment): boolean {
  if (!env.visionEnabled && VISION_BACKED.has(tool.name)) return false;
  if (!env.readScreenEnabled && tool.name === 'read_screen') return false;
  return true;
}

/**
 * Assemble and freeze.
 *
 * Over the ceiling is a **throw**, not a truncation. Everything else in this component turns a
 * failure into a speakable sentence, and this is the deliberate exception: the manifest is built
 * once, at `match_started`, from a static registry, so exceeding the ceiling is a mistake made at
 * development time by a developer who added a command. Silently dropping one would hand the model
 * a manifest that disagrees with the registry, and the model would then call a tool that answers
 * `unknown_tool` — the failure would surface in a match, phrased as Riki being confused.
 */
export function buildManifest(
  tools: readonly RegisteredTool[],
  env: ManifestEnvironment,
  frozenAt: MonoMs,
  maxTokens: number,
): ToolManifest {
  const entries: ManifestEntry[] = tools
    .filter((tool) => includedIn(tool, env))
    .map((tool) => ({
      name: tool.name,
      summary: tool.summary,
      parameters: tool.schema,
      estimatedTokens: estimateEntryTokens(tool),
    }));

  const estimatedTokens = entries.reduce((sum, entry) => sum + entry.estimatedTokens, 0);

  if (estimatedTokens > maxTokens) {
    throw new Error(
      `tool manifest is ${String(estimatedTokens)} tokens, over the ${String(maxTokens)}-token ceiling ` +
        `(agent-command-execution-architecture.md §8.1). Every command is a permanent tax on the ` +
        `cached prefix — shorten a summary or a schema description, or raise the ceiling deliberately.`,
    );
  }

  return { tools: entries, estimatedTokens, frozenAt };
}
