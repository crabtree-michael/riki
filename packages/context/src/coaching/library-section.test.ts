/**
 * The `library` section. Tier 1.
 *
 * It lives here rather than in `sections/` because a file in that directory *is* a section as far as
 * `boundaries/element-types` is concerned, and the leaf rule applies to its tests too — which is the
 * rule working, and why `coaching.test.ts` and `golden.test.ts` sit at this level as well.
 *
 * The section is unlike every other one in this directory — it renders static content rather than an
 * observation — so what is worth asserting is different too. Three things:
 *
 * - the coverage gap is silent, because it is the *common* case (twenty covered, ten drafted);
 * - the patch tag cannot outlive the notes it qualifies, or survive without them;
 * - ordering follows `derived.threats` when the world model has computed it, so the two heroes shown
 *   are the two the player is most likely to be asking about.
 */

import { describe, expect, it } from 'vitest';
import type { GameClock, HeroId, MonoMs, TurnId } from '../common/types.js';
import type { BriefContext } from './types.js';
import { FakeWorldModel, observed } from '../testing/index.js';
import { DEFAULT_PRIVACY } from '../render/privacy.js';
import { HERO_LIBRARY } from '../reference/hero-library/index.js';
import { MAX_HEROES, library } from './sections/library.js';

const NOW = 60_000 as MonoMs;

function context(): BriefContext {
  return {
    turnId: 't0' as TurnId,
    cause: { by: 'player', gesture: 'push_to_talk' },
    now: NOW,
    budget: { maxTokens: 200, spentTokens: 0 },
    privacy: DEFAULT_PRIVACY,
    history: null,
  };
}

function world(enemies: readonly string[], threats?: readonly { hero: string }[]): FakeWorldModel {
  return new FakeWorldModel({
    clock: 872 as GameClock,
    roster: { self: 'riki' as HeroId, enemies: enemies as HeroId[] },
    facts: threats === undefined ? {} : { 'derived.threats': observed(threats) },
  });
}

describe('the library section', () => {
  it('renders one note per covered enemy, with the patch it was written for', () => {
    const section = library.build(world(['enigma', 'spectre']).snapshot(NOW), context());

    expect(section).not.toBeNull();
    expect(section?.body.text).toContain('Enigma');
    expect(section?.body.text).toContain('Spectre');
    expect(section?.body.text).toContain(HERO_LIBRARY.patch);
  });

  it('renders nothing at all when the library covers none of the draft', () => {
    // Not an empty section and not an apology. `render.ts` puts sections that returned `null` at
    // the front of `omitted`, ahead of the ones the budget took, so the golden corpus shows which
    // of the two happened — which is the reason `build` returns `Section | null` at all.
    const section = library.build(world(['pudge', 'zuus', 'tidehunter']).snapshot(NOW), context());

    expect(section).toBeNull();
  });

  it('never shows more than two heroes, however many the library covers', () => {
    // The cap is the brief's, not the library's: at ~25 tokens a note against ~150 for the whole
    // brief, a third line is one the renderer drops after this section paid to compose it.
    const all = ['enigma', 'spectre', 'undying', 'lina', 'bane'];
    const section = library.build(world(all).snapshot(NOW), context());

    const notes = section?.body.text.split(' | ') ?? [];
    // The trailing patch tag rides in the same section, so it is one more field than there are
    // heroes — and its presence here is what proves it is not a separate droppable line.
    expect(notes).toHaveLength(MAX_HEROES + 1);
    expect(notes.at(-1)).toBe(HERO_LIBRARY.patch);
  });

  it('shows the most threatening covered heroes first, when the world model says which', () => {
    // Ordering is *read* from `derived.threats`, never computed here — "who can reach the player"
    // is arithmetic over positions and movement speeds, which belongs to `packages/world-model`.
    const enemies = ['spectre', 'enigma', 'undying'];
    const section = library.build(
      world(enemies, [{ hero: 'undying' }, { hero: 'enigma' }]).snapshot(NOW),
      context(),
    );

    const text = section?.body.text ?? '';
    expect(text).toContain('Undying');
    expect(text).toContain('Enigma');
    // Spectre is first in the roster and last in threat order, so its absence is what proves the
    // derived ordering was used rather than the fallback coinciding with it.
    expect(text).not.toContain('Spectre');
  });

  it('falls back to roster order rather than rendering nothing when threats are unknown', () => {
    // The failure this guards is a section that goes quiet early in a match, which is exactly when
    // hero knowledge is the only thing anyone has.
    const section = library.build(world(['enigma', 'spectre']).snapshot(NOW), context());

    expect(section?.body.text).toContain('Enigma');
  });

  it('carries no age, because nothing in it was observed', () => {
    // Every other section renders `Observed<T>` through `field()` and therefore through
    // `AgeFormatter`. This one has no age to render and says a patch instead — asserted here so
    // that a future edit which starts feeding it observations has to notice.
    const section = library.build(world(['enigma']).snapshot(NOW), context());

    expect(section?.body.text).not.toMatch(/\d+s ago|~\d+s|\(0\.\d+\)/);
  });
});
