/**
 * Tier 1 for the registry: no session, no network, no model.
 *
 * Two of these are load-bearing rather than incidental. The manifest shape test is the only thing
 * standing between this package and a tool list the Realtime API accepts and then ignores, and
 * `encodeToolOutput`'s refusals are where an implementation that flattened an `unknown` on the way
 * out is stopped — after that point there is nothing left to tell a guess from an observation.
 */

import { describe, expect, it } from 'vitest';
import { MyStateReport, TOOLS, ToolName, type ToolAnswer } from '@riki/protocol';

import {
  TOOL_MANIFEST_BUDGET_CHARACTERS,
  assertRealtimeToolShape,
  buildToolManifest,
  callTool,
  encodeToolOutput,
  functionCallOutputItem,
  parseToolCall,
  unknownOutput,
} from './tools.js';
import type { CallId } from './types.js';

const manifest = buildToolManifest();

describe('the manifest', () => {
  it('advertises every tool exactly once', () => {
    expect(manifest.map((tool) => tool.name).sort()).toEqual([...ToolName.options].sort());
  });

  it('is flat, which is the shape the Realtime API takes', () => {
    for (const tool of manifest) {
      expect(Object.keys(tool).sort()).toEqual(['description', 'name', 'parameters', 'type']);
      expect(tool.type).toBe('function');
      expect(tool).not.toHaveProperty('function');
    }
  });

  it('shows the model additionalProperties: false, matching what the validator does', () => {
    for (const tool of manifest) {
      expect(tool.parameters).toMatchObject({ type: 'object', additionalProperties: false });
    }
  });

  it('carries no $schema, and no $ref the model would have to resolve', () => {
    for (const tool of manifest) {
      expect(tool.parameters).not.toHaveProperty('$schema');
      expect(JSON.stringify(tool.parameters)).not.toContain('$ref');
    }
  });

  it('offers world_at both ways of naming a moment, and neither is required (ADR-0048)', () => {
    // Since T6 both fields are optional and a refinement demands exactly one, which
    // `z.toJSONSchema` cannot express — so `required` is gone and the prose is the only thing
    // carrying the rule to the model. The two assertions below are what is left of the guarantee.
    const worldAt = manifest.find((tool) => tool.name === 'world_at');
    expect(worldAt?.parameters).not.toHaveProperty('required');
    expect(Object.keys((worldAt?.parameters as { properties: object }).properties).sort()).toEqual([
      'clock',
      'seconds_ago',
      'topic',
    ]);
    expect(JSON.stringify(worldAt?.parameters)).toContain('never both');
  });

  it('stays inside its share of the cached prefix', () => {
    // A permanent tax on every session whether or not anything calls it. If this fails, the answer
    // is to shorten a description or to re-justify the number — not to raise it quietly.
    const size = JSON.stringify(manifest).length;
    expect(size).toBeLessThanOrEqual(TOOL_MANIFEST_BUDGET_CHARACTERS);
  });

  it('passes its own shape assertion', () => {
    expect(() => {
      assertRealtimeToolShape(manifest);
    }).not.toThrow();
  });
});

describe('assertRealtimeToolShape', () => {
  const good = {
    type: 'function',
    name: 'my_state',
    description: 'x',
    parameters: { additionalProperties: false },
  };

  it('names the Chat Completions shape, which is the one that fails silently', () => {
    const nested = [{ type: 'function', function: { name: 'my_state', parameters: {} } }];
    expect(() => {
      assertRealtimeToolShape(nested);
    }).toThrow(/Chat Completions/);
  });

  it('refuses a definition with no description, because that is how the model chooses', () => {
    expect(() => {
      assertRealtimeToolShape([{ ...good, description: '' }]);
    }).toThrow(/description/);
  });

  it('refuses parameters that invite fields the validator will reject', () => {
    expect(() => {
      assertRealtimeToolShape([{ ...good, parameters: { type: 'object' } }]);
    }).toThrow(/additionalProperties/);
  });

  it('refuses anything that is not a list of definitions', () => {
    for (const input of [null, undefined, 42, 'tools', {}, [null], [42]]) {
      expect(() => {
        assertRealtimeToolShape(input);
      }).toThrow();
    }
  });
});

describe('parseToolCall', () => {
  it('accepts a no-argument call sent as an empty string', () => {
    // A no-argument call may arrive as `""` rather than `"{}"`, and `JSON.parse('')` throws —
    // which would classify an ordinary `my_state()` as malformed and lose the turn.
    expect(parseToolCall('my_state', '')).toEqual({
      ok: true,
      call: { name: 'my_state', arguments: {} },
    });
    expect(parseToolCall('my_state', '{}').ok).toBe(true);
  });

  it('parses arguments into the tool’s own type', () => {
    expect(parseToolCall('enemy', '{"hero":"puck"}')).toEqual({
      ok: true,
      call: { name: 'enemy', arguments: { hero: 'puck' } },
    });
  });

  it('tells the model which tools exist when it invents one', () => {
    const result = parseToolCall('get_minimap_summary', '{}');
    expect(result).toMatchObject({ ok: false, reason: 'unknown-tool' });
    expect(result.ok ? '' : result.detail).toContain('world_at');
  });

  it('separates arguments that never arrived from arguments that are wrong', () => {
    expect(parseToolCall('enemy', '{"hero":')).toMatchObject({ reason: 'malformed-json' });
    expect(parseToolCall('enemy', '{"hero":4}')).toMatchObject({ reason: 'invalid-arguments' });
    expect(parseToolCall('world_at', '{"clock":"twelve minutes"}')).toMatchObject({
      reason: 'invalid-arguments',
    });
    expect(parseToolCall('enemy', '{"hero":"puck","since":"2:00"}')).toMatchObject({
      reason: 'invalid-arguments',
    });
  });

  it('never throws, whatever it is handed', () => {
    for (const input of ['', '[]', 'null', '{{{', '"a string"', '4']) {
      expect(() => parseToolCall('my_state', input)).not.toThrow();
      expect(() => parseToolCall('nonsense', input)).not.toThrow();
    }
  });
});

/**
 * A complete `my_state` answer in which nothing was observed, built from the schema's own field
 * list so that a field added later is covered rather than quietly skipped.
 */
const unknownEverywhere = Object.fromEntries(
  Object.keys(MyStateReport.shape).map((key) => [key, { unknown: 'never observed this match' }]),
) as MyStateReport;

describe('encodeToolOutput', () => {
  it('round-trips an answer in which nothing was observed, still unknown', () => {
    const encoded = encodeToolOutput({ name: 'my_state', result: unknownEverywhere });
    expect(encoded.ok).toBe(true);
    const back: unknown = JSON.parse(encoded.ok ? encoded.json : '{}');
    expect(back).toStrictEqual(unknownEverywhere);
    expect(TOOLS.my_state.result.safeParse(back).success).toBe(true);
  });

  it('refuses a result that flattened an unknown into a number', () => {
    // The whole obligation, at the last point it can be enforced. A tool that answered a
    // never-observed field with a plausible zero fails here rather than being read out loud.
    const flattened = { ...unknownEverywhere, level: 11 } as unknown as MyStateReport;
    const encoded = encodeToolOutput({ name: 'my_state', result: flattened });
    expect(encoded).toMatchObject({ ok: false });
    expect(encoded.ok ? '' : encoded.detail).toContain('my_state');
  });

  it('refuses a result that answered with both a value and an unknown', () => {
    const both = {
      ...unknownEverywhere,
      level: { value: 11, age_seconds: 0.2, confidence: 1, source: 'gsi', unknown: 'never seen' },
    } as unknown as MyStateReport;
    expect(encodeToolOutput({ name: 'my_state', result: both }).ok).toBe(false);
  });

  it('refuses a result that simply left a field out', () => {
    const missing: Record<string, unknown> = { ...unknownEverywhere };
    delete missing.level;
    expect(
      encodeToolOutput({ name: 'my_state', result: missing as unknown as MyStateReport }).ok,
    ).toBe(false);
  });

  it('carries a whole tool declining to answer', () => {
    const declined: ToolAnswer = { name: 'enemy', result: { unknown: 'no match is in progress' } };
    const encoded = encodeToolOutput(declined);
    expect(encoded.ok && (JSON.parse(encoded.json) as unknown)).toStrictEqual(declined.result);
  });

  it('is a value rather than a throw, because this runs inside a turn already speaking', () => {
    expect(() => encodeToolOutput({ name: 'economy', result: undefined as never })).not.toThrow();
  });
});

describe('unknownOutput', () => {
  /**
   * The property the whole degraded-answer path rests on, asserted rather than assumed.
   *
   * Every result is `orUnknown(Report)`, which is what lets one encoding serve all four of the
   * ways a call fails on our side — a refused parse, a thrown dispatcher, a result its own schema
   * rejects, and a session with no tool layer. If a tool were ever added whose result is not an
   * `orUnknown`, this fails here rather than mid-match as a `function_call_output` the model
   * cannot read.
   */
  it('is a valid result for every one of the five tools', () => {
    const output: unknown = JSON.parse(unknownOutput('the world model is not running'));
    for (const name of ToolName.options) {
      expect(TOOLS[name].result.safeParse(output).success, name).toBe(true);
    }
  });

  it('never produces the one thing `UnknownFact` refuses, which is an empty reason', () => {
    // `.min(1)`, so an empty reason would be refused by the very schema this exists to satisfy —
    // and a degraded answer that fails validation is a silence.
    const output: unknown = JSON.parse(unknownOutput('   '));
    expect(TOOLS.economy.result.safeParse(output).success).toBe(true);
  });
});

describe('functionCallOutputItem', () => {
  it('is flat, addressed by call id, and carries the JSON as a string', () => {
    // The `output` field is text, not an object. Getting that wrong is the same class of quiet
    // misconfiguration as nesting a tool definition under `function`.
    const item = functionCallOutputItem('call_1' as CallId, '{"enemies":[]}');
    expect(item).toEqual({
      type: 'function_call_output',
      call_id: 'call_1',
      output: '{"enemies":[]}',
    });
  });
});

describe('callTool', () => {
  it('joins the dispatcher’s answer to the name it was called with', async () => {
    const encoded = await callTool(
      { call: () => Promise.resolve({ enemies: [] } as never) },
      { name: 'enemy', arguments: {} },
    );
    expect(encoded).toEqual({ ok: true, json: '{"enemies":[]}' });
  });

  it('refuses an answer the tool’s own schema rejects, rather than passing it on', async () => {
    // The cast inside `callTool` is what makes the union type-check; this is the check that the
    // cast did not paper over a real mismatch.
    const encoded = await callTool(
      { call: () => Promise.resolve({ enemies: [{ hero: '' }] } as never) },
      { name: 'enemy', arguments: {} },
    );
    expect(encoded).toMatchObject({ ok: false });
  });

  it('rejects when the dispatcher rejects, because degrading is the session’s decision', async () => {
    // Deliberately not swallowed here: only the session knows a turn is mid-sentence, and only it
    // can decide that an `unknown` beats silence.
    await expect(
      callTool(
        { call: () => Promise.reject(new Error('boom')) },
        { name: 'economy', arguments: {} },
      ),
    ).rejects.toThrow('boom');
  });
});
