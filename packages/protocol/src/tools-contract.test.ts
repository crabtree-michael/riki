/**
 * The corpus for the tool surface, and the one property the whole surface exists to have.
 *
 * `contract.test.ts` pins the sidecar protocol against a Rust re-encode and `voice-contract.test.ts`
 * pins the preload bridge against itself. This file's peer is a language model, so what is worth
 * pinning is different: that an answer nobody observed cannot arrive at that model looking like an
 * answer somebody did.
 *
 * The leaf tests below are the ones that earn their keep. They walk the known fixtures, find every
 * fact-shaped value in them, and assert two things at each one — it may be `unknown`, and it may
 * not be a bare value. Writing that per field by hand would be sixty assertions that go stale the
 * first time a tool grows a field; derived from the corpus, a new field is covered the moment it
 * appears in a fixture, and a field with no fixture fails the coverage test instead.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { TOOLS, ToolName, isUnknown, toolFact, type ToolFact } from './schemas/tools.js';

const FIXTURES = fileURLToPath(new URL('../../../fixtures/protocol/tools', import.meta.url));

const files = readdirSync(FIXTURES)
  .filter((name) => name.endsWith('.json'))
  .sort();

function load(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as unknown;
}

/** `result-world_at-unknown.json` → `world_at`. Tool names contain `_`, so the split is greedy. */
function toolOf(fixture: string): ToolName {
  const stem = fixture.replace(/\.json$/, '');
  const name = ToolName.options.find(
    (tool) =>
      stem === `${prefixOf(fixture)}-${tool}` || stem.startsWith(`${prefixOf(fixture)}-${tool}-`),
  );
  if (name === undefined) throw new Error(`${fixture} does not name one of the five tools.`);
  return name;
}

function prefixOf(fixture: string): 'arguments' | 'result' {
  return fixture.startsWith('arguments-') ? 'arguments' : 'result';
}

function schemaOf(fixture: string): z.ZodType {
  const spec = TOOLS[toolOf(fixture)];
  return prefixOf(fixture) === 'arguments' ? spec.arguments : spec.result;
}

describe('the tool fixture corpus', () => {
  it('is not empty — an empty corpus passes every assertion below', () => {
    expect(files.length).toBeGreaterThanOrEqual(14);
  });

  it.each(files)('%s round-trips through its schema unchanged', (name) => {
    expect(name).toMatch(/^(arguments|result)-/);
    const original = load(name);
    const parsed = schemaOf(name).parse(original);
    // zod strips unknown keys, so this catches a fixture carrying a field the schema no longer
    // has — the drift a fixture is supposed to reveal rather than absorb.
    expect(JSON.parse(JSON.stringify(parsed))).toStrictEqual(original);
  });

  it('covers every tool, in both directions', () => {
    for (const direction of ['arguments', 'result'] as const) {
      const covered = new Set(
        files.filter((name) => prefixOf(name) === direction).map((name) => toolOf(name)),
      );
      expect([...covered].sort()).toEqual([...ToolName.options].sort());
    }
  });

  it('gives every tool an answer in which nothing was observed', () => {
    // The answer the design is most worried about getting wrong, so it is the one answer every
    // tool must have a worked example of.
    const covered = new Set(
      files.filter((name) => name.startsWith('result-') && name.includes('-unknown')).map(toolOf),
    );
    expect([...covered].sort()).toEqual([...ToolName.options].sort());
  });
});

// -----------------------------------------------------------------------------------------------
// An unknown cannot become a value
// -----------------------------------------------------------------------------------------------

const NumberFact = toolFact(z.number());
const KNOWN = { value: 1868, age_seconds: 0.4, confidence: 1, source: 'gsi' } as const;

describe('the fact envelope', () => {
  it('survives a JSON round trip as an unknown, not as an absent value', () => {
    const unknown = { unknown: 'never observed this match' };
    const there = NumberFact.parse(unknown);
    const back = NumberFact.parse(JSON.parse(JSON.stringify(there)));
    expect(back).toStrictEqual(unknown);
    expect(isUnknown(back as ToolFact<number>)).toBe(true);
  });

  it('refuses an object carrying both a value and an unknown', () => {
    // The coercion this whole shape exists to prevent, and the reason both branches are strict:
    // a non-strict known branch would parse this, silently drop the `unknown`, and hand the model
    // a confident number.
    expect(NumberFact.safeParse({ ...KNOWN, unknown: 'never observed this match' }).success).toBe(
      false,
    );
  });

  it('refuses an unknown with no reason, and a reason that is empty', () => {
    expect(NumberFact.safeParse({ unknown: '' }).success).toBe(false);
    expect(NumberFact.safeParse({ unknown: null }).success).toBe(false);
    expect(NumberFact.safeParse({}).success).toBe(false);
  });

  it('refuses a bare value, a null and an undefined where a fact belongs', () => {
    for (const input of [1868, null, undefined, 'unknown', [], { value: 1868 }]) {
      expect(NumberFact.safeParse(input).success).toBe(false);
    }
  });

  it('refuses a fact with no provenance, which is the same failure one field along', () => {
    expect(NumberFact.safeParse({ value: 1868, age_seconds: 0.4, confidence: 1 }).success).toBe(
      false,
    );
    expect(NumberFact.safeParse({ ...KNOWN, source: 'guess' }).success).toBe(false);
    expect(NumberFact.safeParse({ ...KNOWN, confidence: 1.4 }).success).toBe(false);
    // A negative age is a clock that ran backwards. Clamp it at the producer; do not explain it
    // to a player.
    expect(NumberFact.safeParse({ ...KNOWN, age_seconds: -0.2 }).success).toBe(false);
  });
});

/** Every path in a fixture at which a known fact sits, as a list of keys and array indices. */
function factPaths(value: unknown, path: readonly (string | number)[] = []): (string | number)[][] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => factPaths(entry, [...path, index]));
  }
  if (typeof value !== 'object' || value === null) return [];

  const record = value as Record<string, unknown>;
  if ('value' in record && 'age_seconds' in record) return [[...path]];

  return Object.entries(record).flatMap(([key, entry]) => factPaths(entry, [...path, key]));
}

function withPath(
  source: unknown,
  path: readonly (string | number)[],
  replacement: unknown,
): unknown {
  if (path.length === 0) return replacement;
  const [head, ...rest] = path as [string | number, ...(string | number)[]];

  if (Array.isArray(source)) {
    return (source as unknown[]).map((entry, index) =>
      index === head ? withPath(entry, rest, replacement) : entry,
    );
  }
  const record = source as Record<string, unknown>;
  return { ...record, [head]: withPath(record[head], rest, replacement) };
}

const known = files.filter((name) => name.startsWith('result-') && !name.includes('-unknown'));

describe('every fact-shaped field in every tool', () => {
  it('has some, or the two tests below assert nothing at all', () => {
    expect(known.flatMap((name) => factPaths(load(name))).length).toBeGreaterThanOrEqual(30);
  });

  it.each(known)('%s: may be unknown at any one of them', (name) => {
    const fixture = load(name);
    const schema = schemaOf(name);
    for (const path of factPaths(fixture)) {
      const mutated = withPath(fixture, path, { unknown: 'never observed this match' });
      const result = schema.safeParse(mutated);
      expect(result.success, `${name} refused an unknown at ${path.join('.')}`).toBe(true);
    }
  });

  it.each(known)('%s: may not be a bare value at any one of them', (name) => {
    const fixture = load(name);
    const schema = schemaOf(name);
    for (const path of factPaths(fixture)) {
      const fact = path.reduce<unknown>(
        (node, key) => (node as Record<string | number, unknown>)[key],
        fixture,
      ) as { value: unknown };
      // The flattening the envelope exists to prevent: the value with its age, confidence and
      // source dropped. It has to fail *here*, because by the time it reaches the model there is
      // nothing left to tell it apart from an observation made this second.
      const mutated = withPath(fixture, path, fact.value);
      const result = schema.safeParse(mutated);
      expect(result.success, `${name} accepted a bare value at ${path.join('.')}`).toBe(false);
    }
  });
});

// -----------------------------------------------------------------------------------------------
// The registry
// -----------------------------------------------------------------------------------------------

describe('the registry', () => {
  it('holds exactly the five tools the design names', () => {
    expect(Object.keys(TOOLS).sort()).toEqual(
      ['economy', 'enemy', 'my_state', 'objectives', 'world_at'].sort(),
    );
    expect([...ToolName.options].sort()).toEqual(Object.keys(TOOLS).sort());
  });

  it('describes every tool, because the model chooses between them by the description alone', () => {
    for (const name of ToolName.options) {
      expect(TOOLS[name].description.length).toBeGreaterThan(40);
    }
  });

  it('rejects an argument the model invented, rather than ignoring it', () => {
    // `additionalProperties: false` is what the model is shown; this is the validator agreeing
    // with it. A stripped-and-ignored argument is a call that answers a different question.
    expect(TOOLS.enemy.arguments.safeParse({ hero: 'puck', since: '2:00' }).success).toBe(false);
    expect(TOOLS.my_state.arguments.safeParse({ hero: 'puck' }).success).toBe(false);
  });

  it('takes a clock only in the form it is shown, so a call cannot fail mid-sentence', () => {
    for (const clock of ['12:34', '-1:30', '1:05:00', '0:00']) {
      expect(TOOLS.world_at.arguments.safeParse({ clock }).success).toBe(true);
    }
    for (const clock of ['thirty seconds ago', '12:99', '754', '12.34', '']) {
      expect(TOOLS.world_at.arguments.safeParse({ clock }).success).toBe(false);
    }
  });

  it('refuses a world_at answer with no sections in it', () => {
    // Silence dressed as an answer. `unknown` carries a reason; an empty snapshot carries nothing,
    // and the model would narrate it as though it had been told something.
    expect(TOOLS.world_at.result.safeParse({ at_clock: '12:30' }).success).toBe(false);
    expect(
      TOOLS.world_at.result.safeParse({ unknown: 'before the recording starts' }).success,
    ).toBe(true);
  });
});
