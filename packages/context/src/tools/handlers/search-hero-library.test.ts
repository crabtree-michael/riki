/**
 * `search_hero_library`, end to end through the surface. Tier 1.
 *
 * Three of these guard distinctions that are easy to collapse and expensive to get wrong:
 *
 * - a hero **not in the match** and a hero **not in the library** are different failures, with
 *   different sentences, and only one of them is a coverage gap;
 * - the patch tag is not decoration, so it has to survive a budget that drops everything else;
 * - a dead reference port degrades to a sentence, not to an unanswered call.
 */

import { describe, expect, it } from 'vitest';
import type { CallId, MonoMs, RawToolCall, RenderContext, TurnId } from '../types.js';
import type { GameClock, HeroId } from '../../common/types.js';
import { ManualClock, createFakeToolPorts } from '../testing/index.js';
import { HERO_LIBRARY, PATCH } from '../../reference/hero-library/index.js';
import { ALL_HANDLERS } from '../all-handlers.js';
import { DEFAULT_PRIVACY } from '../../render/privacy.js';
import { buildToolSurface } from '../surface.js';
import { searchHeroLibrary as search } from '../../reference/hero-library/search.js';

/**
 * Reached through the registry rather than imported directly.
 *
 * A file in `handlers/` is a handler as far as `boundaries/element-types` is concerned, and the
 * rule that no handler may import another applies to its tests too. That is the rule working: the
 * registry is how everything else in the pipeline gets at a definition, so it is how the test
 * should.
 */
const definition = ALL_HANDLERS.find((tool) => tool.name === 'search_hero_library');
if (definition === undefined) throw new Error('search_hero_library is registered');

const raw = (argumentsJson: string): RawToolCall => ({
  callId: 'c1' as CallId,
  turnId: 't1' as TurnId,
  name: 'search_hero_library',
  argumentsJson,
  receivedAt: 0 as MonoMs,
});

/** A draft that contains both a hero the library covers and one it does not. */
function harness() {
  const clock = new ManualClock();
  const ports = createFakeToolPorts({
    clock,
    world: {
      roster: {
        self: 'spectre' as HeroId,
        allies: ['undying', 'skeleton_king'] as HeroId[],
        enemies: ['enigma', 'pudge'] as HeroId[],
      },
      clock: 900 as GameClock,
    },
  });
  const surface = buildToolSurface({
    ports,
    env: { visionEnabled: true, readScreenEnabled: true },
    tools: ALL_HANDLERS,
  });
  return { ports, surface, scope: surface.openTurn('t1' as TurnId, 0 as MonoMs) };
}

describe('search_hero_library', () => {
  it('answers with notes, the hero it resolved to, and the patch they were written for', async () => {
    const { surface, scope } = harness();

    const result = await surface.executor.invoke(raw('{"hero":"enigma"}'), scope);

    expect(result.status).toBe('ok');
    expect(result.output).toContain('Enigma');
    expect(result.output).toContain(`patch ${PATCH}`);
    expect(result.output.toLowerCase()).toContain('black hole');
  });

  it('narrows to a topic when asked', async () => {
    const { surface, scope } = harness();

    const result = await surface.executor.invoke(raw('{"hero":"spectre","topic":"laning"}'), scope);

    expect(result.status).toBe('ok');
    expect(result.output.toLowerCase()).toContain('lane');
    // The `against` ladder is the top of Spectre's priorities, so its absence is what proves the
    // topic filter ran rather than the priority order coinciding with it.
    expect(result.output.toLowerCase()).not.toContain('take objectives early');
  });

  it('distinguishes a hero it has no notes on from a hero not in the game', async () => {
    const { surface, scope } = harness();

    // In the match, not in the library. The common case, with twenty heroes covered and ten drafted.
    const uncovered = await surface.executor.invoke(raw('{"hero":"pudge"}'), scope);
    expect(uncovered.status).toBe('unavailable');
    expect(uncovered.output).toBe("I don't have notes on that hero.");

    // Not in the match at all. The resolver refuses before the library is ever consulted.
    const absent = await surface.executor.invoke(raw('{"hero":"juggernaut"}'), scope);
    expect(absent.status).toBe('unknown_subject');
    expect(absent.output).toContain("isn't in this game");
  });

  it('resolves a nickname through the shared alias table, not its own', async () => {
    const { surface, scope } = harness();
    const result = await surface.executor.invoke(raw('{"hero":"wk"}'), scope);

    // `wk` → `skeleton_king` → "Wraith King". The library is keyed on the same canonical ids the
    // resolver produces, which is what lets this command own no alias logic at all (§4.3).
    expect(result.status).toBe('ok');
    expect(result.output).toContain('Wraith King');
  });

  it('does not resolve an abbreviation the alias table has never heard of', async () => {
    const { surface, scope } = harness();
    const result = await surface.executor.invoke(raw('{"hero":"eni"}'), scope);

    // Worth pinning, because it is the opposite of what the fuzzy fallback looks like it promises:
    // `distance()` bails at a length difference above two, so it covers typos, not abbreviations.
    // Nine of the twenty heroes have no alias entry and reach the library by canonical name only.
    expect(result.status).toBe('unknown_subject');
  });

  it('degrades to a sentence when the reference port is down', async () => {
    const { ports, surface, scope } = harness();
    ports.reference.down = true;

    const result = await surface.executor.invoke(raw('{"hero":"enigma"}'), scope);

    expect(result.status).toBe('unavailable');
    expect(result.output).not.toBe('');
  });

  it('refuses a free-text argument outright, rather than ignoring it (ADR-0023)', async () => {
    const { ports, surface, scope } = harness();

    const result = await surface.executor.invoke(
      raw('{"hero":"enigma","query":"what do pros build"}'),
      scope,
    );

    // `additionalProperties: false` is what makes the closed vocabulary structural: a model that
    // has seen a `query` field on some other search tool gets told no, instead of having the field
    // silently dropped and being left believing it was honoured.
    expect(result.status).toBe('invalid_arguments');
    expect(ports.telemetry.ports.filter((p) => p.port === 'reference')).toEqual([]);
  });

  it('refuses a topic outside the enum', async () => {
    const { surface, scope } = harness();
    const result = await surface.executor.invoke(
      raw('{"hero":"enigma","topic":"teamfight"}'),
      scope,
    );
    expect(result.status).toBe('invalid_arguments');
  });
});

describe('the rendered result', () => {
  const context = (maxTokens: number): RenderContext => ({
    now: 0 as MonoMs,
    clock: 900 as GameClock,
    maxTokens,
    privacy: DEFAULT_PRIVACY,
  });

  it('keeps the patch tag when the budget drops every note', () => {
    // The rule this encodes is the snapshot's: never render a stale fact as a bare fact. Notes
    // written for one patch and spoken during another are exactly that, and nothing refreshes them
    // (ADR-0023) — so if the tag were droppable it would be dropped precisely when the budget is
    // tight, which is every busy turn.
    const value = search(HERO_LIBRARY, { hero: 'spectre' as HeroId });
    expect(value).toBeDefined();
    if (value === undefined) return;

    const rendered = definition.render(value, context(8));

    expect(rendered.text).toContain(`patch ${PATCH}`);
    expect(rendered.text).toContain('Spectre');
    expect(rendered.truncated).toBe(true);
    expect(rendered.omitted.length).toBeGreaterThan(0);
  });

  it('drops the lowest-priority notes first', () => {
    const value = search(HERO_LIBRARY, { hero: 'spectre' as HeroId });
    if (value === undefined) throw new Error('spectre is in the library');

    const tight = definition.render(value, context(40));
    const roomy = definition.render(value, context(400));

    expect(roomy.omitted).toEqual([]);
    expect(tight.omitted.length).toBeGreaterThan(0);
    // Whatever survived the tight budget is the top of the ladder, so it also survived the roomy
    // one — truncation reorders nothing.
    for (const line of tight.text.split('\n')) {
      expect(roomy.text).toContain(line);
    }
  });
});
