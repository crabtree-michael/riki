/**
 * Tier 3: the TypeScript half of the contract (REPO_SKELETON.md §5.3).
 *
 * Both languages parse the same corpus in `fixtures/protocol/` and both must re-encode it to the
 * same value. `crates/riki-ipc/tests/contract.rs` is the other half, and its header explains why
 * the chain is pinned by a committed fixture rather than by a live pipe: `pnpm check` skips every
 * cargo step on a machine with no Rust toolchain, so a cross-process round trip would quietly
 * stop being a test. Equality against a shared fixture on both sides is the same guarantee and
 * survives that.
 *
 * **A message with no fixture is a message the other language has never parsed.** Add one in the
 * same commit as the message.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SidecarCommand, SidecarEvent } from './schemas/sidecar.js';
import { PROTOCOL_VERSION } from './version.js';

const FIXTURES = fileURLToPath(new URL('../../../fixtures/protocol', import.meta.url));

const files = readdirSync(FIXTURES)
  .filter((name) => name.endsWith('.json'))
  .sort();

function load(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as unknown;
}

describe('the protocol fixture corpus', () => {
  it('has fixtures at all — an empty corpus would pass every assertion below', () => {
    expect(files.length).toBeGreaterThanOrEqual(9);
  });

  it.each(files)('%s round-trips through the schema unchanged', (name) => {
    const original = load(name);
    // The prefix says which side of the protocol the message belongs to; the Rust half keys off
    // the same convention.
    const schema = name.startsWith('command-') ? SidecarCommand : SidecarEvent;
    expect(name).toMatch(/^(command|event)-/);

    const parsed = schema.parse(original);
    // zod strips unknown keys, so this catches a fixture with a field the schema does not have —
    // which is exactly the drift a fixture is supposed to reveal rather than absorb.
    expect(JSON.parse(JSON.stringify(parsed))).toStrictEqual(original);
  });

  it.each(files)('%s carries the current protocol version', (name) => {
    expect((load(name) as { v: number }).v).toBe(PROTOCOL_VERSION);
  });
});

describe('the two unions do not overlap', () => {
  it('refuses a command where an event belongs', () => {
    // Both share the `{ v, type }` envelope, so a decoder pointed at the wrong union has to fail
    // rather than succeed with a variant that happens to fit.
    expect(SidecarEvent.safeParse(load('command-hello.json')).success).toBe(false);
    expect(SidecarCommand.safeParse(load('event-ready.json')).success).toBe(false);
  });
});

describe('the fields REPO_SKELETON §4 makes non-optional', () => {
  it('rejects a CV fact with no confidence', () => {
    const detections = load('event-detections.json') as {
      facts: { confidence?: number }[];
    };
    delete detections.facts[0]?.confidence;

    // A CV position constructible without a confidence score eventually reaches the agent as if it
    // were certain. The schema is where that becomes impossible rather than discouraged.
    expect(SidecarEvent.safeParse(detections).success).toBe(false);
  });

  it('rejects a CV fact with no detector or timestamp', () => {
    for (const field of ['detector', 'capturedAtMonoMs'] as const) {
      const detections = load('event-detections.json') as {
        facts: Record<string, unknown>[];
      };
      delete detections.facts[0]?.[field];
      expect(SidecarEvent.safeParse(detections).success, field).toBe(false);
    }
  });

  it('rejects a confidence outside 0..1', () => {
    const detections = load('event-detections.json') as { facts: { confidence: number }[] };
    const fact = detections.facts[0];
    if (fact === undefined) throw new Error('the fixture lost its facts');
    fact.confidence = 1.5;
    expect(SidecarEvent.safeParse(detections).success).toBe(false);
  });
});
