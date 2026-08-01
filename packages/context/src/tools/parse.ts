/**
 * Parse — is this a command, is that JSON, does it fit the schema.
 *
 * Three checks in that order, each of which fails into a value. Nothing here throws: a malformed
 * payload is a result, because an exception escaping the pipeline would leave a `call_id`
 * unanswered, which is the one failure mode that stalls a voice conversation (§3.4, §7.4).
 *
 * See docs/design/agent-command-execution-architecture.md §4.2.
 */

import type { ToolCallParser, ToolRegistry } from './contracts.js';
import type { CallFingerprint, ParsedCall, RawToolCall, ToolName, ToolOutcome } from './types.js';
import { fail, failure, ok, unknownTool } from './failures.js';

/**
 * Canonical name + arguments, key-sorted so that `{a,b}` and `{b,a}` are one question (§6.4).
 *
 * Sorting matters more than it looks: the model repeats itself under interruption, and it does not
 * reliably repeat its key order. A fingerprint that depended on key order would miss exactly the
 * duplicates deduplication exists to catch.
 */
export function fingerprint(name: ToolName, args: unknown): CallFingerprint {
  return `${name}:${stableStringify(args)}` as CallFingerprint;
}

function stableStringify(value: unknown): string {
  // `JSON.stringify(undefined)` is `undefined`, not a string — an optional argument the model left
  // out must still fingerprint, and as the same thing every time.
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}

export function createParser(registry: ToolRegistry): ToolCallParser {
  return {
    parse(raw: RawToolCall): ToolOutcome<ParsedCall> {
      const tool = registry.lookup(raw.name);
      if (tool === undefined) {
        return { ok: false, failure: unknownTool(raw.name, registry.names()) };
      }

      // The Realtime API sends `arguments` as an accumulated string. A zero-argument call arrives
      // as `""` or `"{}"` depending on the model's mood, and both mean the same thing — treating
      // the empty string as malformed would fail six of the eight commands at random.
      const text = raw.argumentsJson.trim();
      let decodedJson: unknown;
      if (text === '') {
        decodedJson = {};
      } else {
        try {
          decodedJson = JSON.parse(text);
        } catch (error) {
          return failure('malformed_arguments', {
            detail: `${raw.name}: ${error instanceof Error ? error.message : 'unparseable'}`,
          });
        }
      }

      const decoded = tool.decode(decodedJson);
      if (!decoded.ok) return { ok: false, failure: decoded.failure };

      return ok({
        callId: raw.callId,
        turnId: raw.turnId,
        name: tool.name,
        args: decoded.value,
        fingerprint: fingerprint(tool.name, decoded.value),
        receivedAt: raw.receivedAt,
      });
    },
  };
}

/** Re-stamp a parsed call after subject resolution rewrote its arguments (§4.3). */
export function withArgs(call: ParsedCall, args: unknown): ParsedCall {
  return { ...call, args, fingerprint: fingerprint(call.name, args) };
}

/** Exported for the taxonomy test: every code must have a non-empty speakable except `cancelled`. */
export const internalFailure = (detail: string): ReturnType<typeof fail> =>
  fail('internal', { detail });
