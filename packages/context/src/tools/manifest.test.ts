/**
 * What the command set costs the cached prefix. Tier 1.
 *
 * This test exists because adding a command is the one change in this package whose cost is
 * invisible at the call site: the manifest is sent in `session.update` alongside the instructions,
 * inside the cached prefix, and **every command is billed on every turn of every session whether or
 * not it is ever called** (§8.1). A ninth command that nobody notices is a permanent tax.
 *
 * So the assertion is not only the ceiling — `buildManifest` already throws on that — but the
 * *headroom*, printed, so the next person to add a command sees what they are spending.
 */

import { describe, expect, it } from 'vitest';
import { ALL_HANDLERS } from './all-handlers.js';
import { DEFAULT_TUNABLES } from './tunables.js';
import { buildManifest, estimateEntryTokens } from './manifest.js';

const FULL = { visionEnabled: true, readScreenEnabled: true };

describe('the tool manifest', () => {
  it('fits the ceiling, with the per-command cost visible', () => {
    const manifest = buildManifest(
      ALL_HANDLERS,
      FULL,
      0 as never,
      DEFAULT_TUNABLES.manifestMaxTokens,
    );

    const breakdown = manifest.tools
      .map((entry) => `${String(entry.estimatedTokens).padStart(4)}  ${entry.name}`)
      .join('\n');
    const headroom = DEFAULT_TUNABLES.manifestMaxTokens - manifest.estimatedTokens;

    expect(
      manifest.estimatedTokens,
      `manifest is ${String(manifest.estimatedTokens)} tokens, ` +
        `${String(headroom)} under the ${String(DEFAULT_TUNABLES.manifestMaxTokens)} ceiling:\n${breakdown}`,
    ).toBeLessThanOrEqual(DEFAULT_TUNABLES.manifestMaxTokens);

    expect(manifest.tools.length).toBe(ALL_HANDLERS.length);
  });

  it('holds the hero library command to its measured cost', () => {
    // A ratchet, deliberately close to the real number. `search_hero_library` measures 159 tokens,
    // second only to `get_enemy_detail`, because it carries the manifest's only enum. It was 234
    // when first written and this bound is what found that: 42 tokens went in trimmed descriptions
    // and 33 more when the free-text `query` argument was removed under ADR-0023. If it fires, the
    // enum has grown or a description has — both billed on every turn of every session.
    const library = ALL_HANDLERS.find((tool) => tool.name === 'search_hero_library');
    expect(library).toBeDefined();
    if (library === undefined) return;

    expect(estimateEntryTokens(library)).toBeLessThanOrEqual(170);
  });

  it('offers the model exactly two arguments, and only one of them required', () => {
    // ADR-0023's rule, asserted where it can actually regress: the JSON Schema in the manifest is
    // what the model is shown and what it fills in, so a free-text field reappearing is visible
    // here and nowhere else. Checking the TypeScript type instead proves nothing — the type is
    // what a reader would edit *and* what a test would restate.
    const library = ALL_HANDLERS.find((tool) => tool.name === 'search_hero_library');
    expect(library).toBeDefined();
    if (library === undefined) return;

    const schema = library.schema as { properties?: object; required?: readonly string[] };
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(['hero', 'topic']);
    expect(schema.required).toEqual(['hero']);
  });

  it('drops the vision-backed commands when the sidecar is off, and keeps the rest', () => {
    const manifest = buildManifest(
      ALL_HANDLERS,
      { visionEnabled: false, readScreenEnabled: false },
      0 as never,
      DEFAULT_TUNABLES.manifestMaxTokens,
    );

    const names = manifest.tools.map((entry) => entry.name);
    expect(names).not.toContain('get_minimap_summary');
    expect(names).not.toContain('read_screen');
    // The library needs no sidecar and no network, so it is advertised in every build.
    expect(names).toContain('search_hero_library');
  });
});
