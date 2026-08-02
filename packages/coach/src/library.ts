/**
 * The hero library, as something an agent can ask for.
 *
 * `hero-library.md` §4 is emphatic that the library "is not a thing the agent asks for": under the
 * deterministic coach nothing outside `packages/context` chooses what it is asked, because nothing
 * outside it asks — the `library` brief section reads it on five `BRIEF_PLAN` rows and that is the
 * whole surface. **This coach changes that premise, and requirement 5 says so directly.** A model
 * that decides for itself what a moment is about needs to be able to ask what a hero usually does,
 * and it cannot be pushed the answer to a question it has not asked yet.
 *
 * What does *not* change is any of the content policy. The library is still static, still
 * patch-stamped, still shape rather than numbers, and still twenty heroes (ADR-0027). This file
 * adds a lookup path and nothing else. See ADR-0031 for the decision and what it costs.
 *
 * Pure, synchronous and total — the same three properties the section relies on, and for the same
 * reason: a frozen array and a `filter` cannot make a consultation slow, and wrapping them in a
 * promise would advertise a failure mode that does not exist.
 *
 * See docs/design/llm-coach-architecture.md §5.3.
 */

import type { HeroEntry, HeroTopic } from '@riki/context/reference';
import { HERO_LIBRARY, HERO_TOPICS, searchHeroLibrary } from '@riki/context/reference';

/** What the tool hands back. A string, because the model reads it, not a caller. */
export interface HeroLookup {
  readonly found: boolean;
  readonly text: string;
}

/**
 * The model says "Shadow Fiend"; the library is keyed on `shadow_fiend`.
 *
 * Nothing upstream constrains what a model puts in a tool argument, so this has to be lenient in a
 * way the `library` section never had to be — that section is handed a `HeroId` the subject resolver
 * produced. Lowercase, collapse everything that is not a letter or a digit to one underscore, and
 * strip a leading `npc_dota_hero_` in case the model has seen Valve's spelling somewhere.
 */
export function normaliseHeroName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^npc_dota_hero_/, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Match on the id first and the display name second.
 *
 * Both are needed and neither is sufficient: `shadow_fiend` is the id and "Shadow Fiend" is what a
 * model will say, but "Keeper of the Light" normalises to `keeper_of_the_light` which is also the
 * id, and "Nature's Prophet" would not be either. Checking both costs a linear scan over twenty
 * entries.
 */
function findEntry(query: string): HeroEntry | undefined {
  const wanted = normaliseHeroName(query);
  if (wanted === '') return undefined;
  return HERO_LIBRARY.entries.find(
    (entry) => entry.hero === wanted || normaliseHeroName(entry.name) === wanted,
  );
}

function isHeroTopic(value: string | undefined): value is HeroTopic {
  return value !== undefined && (HERO_TOPICS as readonly string[]).includes(value);
}

/**
 * The answer, rendered.
 *
 * **A hero the library does not cover says so here**, which is the opposite of what the `library`
 * brief section does — that section renders nothing, because "a brief is not a conversation, so
 * there is nobody to apologise to" (hero-library.md §4). A tool call *is* a conversation, and a
 * model that asked a question and got an empty string back will either ask again or assume the
 * hero is unremarkable. Saying "no notes" is what stops both.
 *
 * The patch rides inside the text, for the reason §4 gives: it cannot outlive the notes it
 * qualifies or survive without them.
 */
export function lookupHero(hero: string, topic?: string): HeroLookup {
  const entry = findEntry(hero);
  if (entry === undefined) {
    return {
      found: false,
      text: `No notes for "${hero}". The library covers twenty heroes on patch ${HERO_LIBRARY.patch}; this is not one of them. That is not a judgement about the hero.`,
    };
  }

  const result = searchHeroLibrary(
    HERO_LIBRARY,
    isHeroTopic(topic) ? { hero: entry.hero, topic } : { hero: entry.hero },
  );

  // Unreachable — `findEntry` just matched on the same array — but the search is specified to
  // return `undefined` for a hero with no entry, and asserting that away with a `!` would be the
  // one place in this file that could throw.
  if (result === undefined || result.notes.length === 0) {
    const scope = topic === undefined ? '' : ` on ${topic}`;
    return {
      found: false,
      text: `No notes for ${entry.name}${scope} (patch ${HERO_LIBRARY.patch}).`,
    };
  }

  const lines = result.notes.map((note) => `- ${note.topic}: ${note.text}`);
  const positions = result.positions.map((p) => `pos ${String(p)}`).join(', ');
  return {
    found: true,
    text: `${result.name} (${positions}) — patch ${result.patch}\n${lines.join('\n')}`,
  };
}
