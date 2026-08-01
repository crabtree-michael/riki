/**
 * The library's content policy, made enforceable. Tier 1.
 *
 * hero-library.md §3 is a set of rules a human is supposed to follow while authoring, which is
 * another way of saying it is a set of rules that quietly stops being true. Three of them are
 * structural enough to assert — no digits, no Facets, one line per note — and those three are the
 * ones that decide whether the library ages gracefully or becomes confidently wrong.
 *
 * The rest of the file covers the search, whose one interesting property is that it cannot widen.
 */

import { describe, expect, it } from 'vitest';
import type { HeroId } from '../../common/types.js';
import { HERO_LIBRARY, PATCH } from './content/index.js';
import { HERO_TOPICS } from './types.js';
import { MAX_NOTES, searchHeroLibrary } from './search.js';

const hero = (id: string): HeroId => id as HeroId;

describe('the roster', () => {
  it('covers every position at least three deep', () => {
    // hero-library.md §2: the selection rule is win-rate edge weighted by pick rate, *then*
    // adjusted for role coverage. Without this the rule alone produces a library that is all
    // supports, and a coach with nothing to say to a position-one player.
    for (const position of [1, 2, 3, 4, 5] as const) {
      const covered = HERO_LIBRARY.entries.filter((e) => e.positions.includes(position));
      expect(covered.length, `position ${String(position)}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('has no duplicate heroes', () => {
    const ids = HERO_LIBRARY.entries.map((e) => String(e.hero));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('is stamped with a patch', () => {
    expect(HERO_LIBRARY.patch).toBe(PATCH);
    expect(HERO_LIBRARY.patch).not.toBe('');
  });
});

describe('the content policy', () => {
  const allNotes = HERO_LIBRARY.entries.flatMap((e) => e.notes.map((n) => ({ e, n })));

  it('covers all six topics for every hero, so a topic filter never comes back empty', () => {
    // The search narrows by topic without a fallback, so a hero missing a topic would answer a
    // perfectly reasonable question with silence.
    for (const entry of HERO_LIBRARY.entries) {
      const topics = new Set(entry.notes.map((n) => n.topic));
      for (const topic of HERO_TOPICS) {
        expect(topics.has(topic), `${entry.name} has no ${topic} note`).toBe(true);
      }
    }
  });

  it('contains no digits — nothing a patch can silently invalidate', () => {
    // §3's first rule. "Spikes on her second item" survives a rebalance; "spikes at 22 minutes"
    // stops being true and nothing tells you. Numbers are spelled as words where they are needed.
    for (const { e, n } of allNotes) {
      expect(n.text, `${e.name}: ${n.text}`).not.toMatch(/\d/);
    }
  });

  it('mentions no Facets and no innate abilities', () => {
    // Patch 7.41 removed Facets outright and rewrote innates, folding parts of each Facet back into
    // base kits. A note leaning on either would describe a game that no longer exists.
    for (const { e, n } of allNotes) {
      expect(n.text.toLowerCase(), `${e.name}: ${n.text}`).not.toMatch(/facet|innate/);
    }
  });

  it('keeps every note to one speakable line', () => {
    // Riki says these out loud, and the `reference` class allows 120 result tokens for about six of
    // them. A note that needs summarising before it can be spoken is the wrong shape.
    for (const { e, n } of allNotes) {
      expect(n.text.length, `${e.name}: ${n.text}`).toBeLessThanOrEqual(125);
      expect(n.text.trim(), e.name).toBe(n.text);
      expect(n.text).toMatch(/[.!?]$/);
    }
  });
});

describe('searchHeroLibrary', () => {
  it('returns notes for a hero it covers, in priority order, capped', () => {
    const found = searchHeroLibrary(HERO_LIBRARY, { hero: hero('spectre') });

    expect(found?.name).toBe('Spectre');
    expect(found?.patch).toBe(PATCH);
    expect(found?.notes.length).toBe(MAX_NOTES);
    const priorities = found?.notes.map((n) => n.priority) ?? [];
    expect([...priorities].sort((a, b) => b - a)).toEqual(priorities);
  });

  it('returns undefined for a hero it does not cover', () => {
    // Not an error and not an empty result: twenty heroes are covered and a match holds ten, so
    // this is the common path, and the caller owes it a different sentence.
    expect(searchHeroLibrary(HERO_LIBRARY, { hero: hero('pudge') })).toBeUndefined();
  });

  it('narrows to one topic', () => {
    const found = searchHeroLibrary(HERO_LIBRARY, { hero: hero('enigma'), topic: 'counters' });
    expect(found?.notes.length).toBeGreaterThan(0);
    expect(found?.notes.every((n) => n.topic === 'counters')).toBe(true);
  });

  it('cannot reach outside the hero it was given', () => {
    const found = searchHeroLibrary(HERO_LIBRARY, { hero: hero('bane') });
    const bane = HERO_LIBRARY.entries.find((e) => String(e.hero) === 'bane');
    for (const note of found?.notes ?? []) {
      expect(bane?.notes).toContain(note);
    }
  });

  it('takes no free text at all — narrowing is the only thing a caller can do', () => {
    // A free-text ranking pass existed here and was removed (ADR-0023, rejected alternatives): over
    // six one-line notes it beat `topic` on nothing, any query that missed degraded to priority
    // order — which is what the search now does in one step.
    //
    // Asserted as behaviour rather than as `Object.keys` of a literal written on the line above,
    // which is a tautology: it restates the literal instead of testing the search. The property
    // that actually matters is that **nothing a caller passes can add a note** — every result is a
    // subset of the entry, and narrowing only ever shrinks it.
    const entry = HERO_LIBRARY.entries.find((e) => String(e.hero) === 'spectre');
    const all = searchHeroLibrary(HERO_LIBRARY, { hero: hero('spectre') })?.notes ?? [];
    expect(all.length).toBe(MAX_NOTES);

    for (const topic of HERO_TOPICS) {
      const narrowed = searchHeroLibrary(HERO_LIBRARY, { hero: hero('spectre'), topic })?.notes;
      expect(narrowed, topic).toBeDefined();
      for (const note of narrowed ?? []) {
        expect(note.topic).toBe(topic);
        expect(entry?.notes).toContain(note);
      }
    }
  });
});
