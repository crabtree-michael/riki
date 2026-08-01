/**
 * The seven preamble sections — dota2 §6.1's list, one builder each.
 *
 * Two of them are ours rather than an external API's. `history` is durable memory (§6.4) rendered as
 * a handful of lines about how this player has played this hero *with Riki* — the thing OpenDota
 * structurally cannot know. `persona` is REPO_SKELETON §11.5's open question, injected from wherever
 * the prompt files land and counted here either way, because §4.2's budget has to sum all three
 * claimants on the cached prefix whether or not one of them has found its home yet.
 *
 * Every builder is a **pure function of `PreambleInput` and the enrichment that arrived**. That is
 * what makes §4.4's byte-identity property testable: a reconnect re-assembles from the retained
 * input and must produce the same bytes, or the new session pays for a prefix it had already cached.
 * Nothing here reads a clock, a world model or a config.
 */

import type { PreambleInput, PreambleSection, PreambleSectionId } from '../types.js';
import type { BuildBenchmark, MatchupNote } from '../../common/ports.js';
import type { HeroId } from '../../common/types.js';
import { estimateTokens } from '../../render/tokens.js';
import { clockText, short } from '../../snapshot/sections/util.js';

/** What arrived before the deadline. A missing entry is a section that degrades, not one that waits. */
export interface Enrichment {
  readonly matchups: ReadonlyMap<string, MatchupNote>;
  readonly benchmark: BuildBenchmark | null;
}

export interface PreambleSectionSource {
  readonly id: PreambleSectionId;
  /** `null` is "nothing to say", which is not the same as "did not arrive" — see `degraded`. */
  build(
    input: PreambleInput,
    enrichment: Enrichment,
    persona: string | null,
  ): PreambleSection | null;
}

function section(id: PreambleSectionId, text: string): PreambleSection {
  return { id, text, tokens: estimateTokens(text) };
}

/**
 * REPO_SKELETON §11.5 is still open about where this text lives. It is injected either way, and it
 * is counted either way, which is the only part §4.2 needs settled.
 */
const persona: PreambleSectionSource = {
  id: 'persona',
  build: (_input, _enrichment, text) =>
    text === null || text === '' ? null : section('persona', text),
};

const player: PreambleSectionSource = {
  id: 'player',
  build: (input) =>
    section(
      'player',
      [
        `You are coaching a ${input.player.role} playing ${String(input.player.hero)}`,
        `${input.player.lane} lane`,
        input.player.bracket === null ? null : `${input.player.bracket} bracket`,
      ]
        .filter((part): part is string => part !== null)
        .join(', ') + '.',
    ),
};

const draft: PreambleSectionSource = {
  id: 'draft',
  build: (input) =>
    section(
      'draft',
      [
        `allies: ${input.draft.allies.map(String).join(', ')}`,
        `enemies: ${input.draft.enemies.map(String).join(', ')}`,
      ].join(' | '),
    ),
};

const matchups: PreambleSectionSource = {
  id: 'matchups',
  build: (input, enrichment) => {
    // Draft order, not arrival order. Enrichment resolves concurrently, and a section built in the
    // order results happened to land in would break §4.4's byte-identity on every reconnect.
    const lines = input.draft.enemies
      .map((enemy: HeroId) => {
        const note = enrichment.matchups.get(String(enemy));
        return note === undefined ? null : `${String(enemy)}: ${note.summary}`;
      })
      .filter((line): line is string => line !== null);

    return lines.length === 0 ? null : section('matchups', `matchups — ${lines.join(' · ')}`);
  },
};

const benchmarks: PreambleSectionSource = {
  id: 'benchmarks',
  build: (_input, enrichment) => {
    const mark = enrichment.benchmark;
    return mark === null
      ? null
      : section(
          'benchmarks',
          `benchmark at ${clockText(mark.atClock)}: nw ${short(mark.expectedNetWorth)}, ` +
            `lvl ${String(mark.expectedLevel)} is typical for this hero.`,
        );
  },
};

/**
 * The patch line is **local data**, not enrichment: `PreambleInput.patch` is the version the world
 * model already reported.
 *
 * Hero-specific patch notes are a different thing and have no `ReferenceDataPort` method today —
 * the port is `item`/`matchup`/`benchmark` (command architecture §5.3). The planner still emits the
 * request the design's union declares, so that adding the method later is one fetcher case rather
 * than a change to three files; until then this section says what it can and does not pretend the
 * rest is missing.
 */
const patchNotes: PreambleSectionSource = {
  id: 'patch_notes',
  build: (input) => (input.patch === '' ? null : section('patch_notes', `patch ${input.patch}.`)),
};

/**
 * Durable memory, rendered — §6.4's "three lines in the preamble", and the payoff for the whole
 * persistence surface.
 *
 * Only this player, only ids and enums, and never a count that could identify a session: what goes
 * in is how many matches on this hero, how it has gone, and which advice this player acts on.
 */
const history: PreambleSectionSource = {
  id: 'history',
  build: (input) => {
    const familiarity = input.memory.heroes.get(input.player.hero);
    const tendencies = [...input.memory.adviceTendency.entries()]
      .filter(([, tendency]) => tendency.followed + tendency.ignored >= MIN_SAMPLES)
      // Sorted so identical memory renders identical bytes whatever order the map was built in.
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([topic, tendency]) =>
        tendency.followed >= tendency.ignored ? `acts on ${topic}` : `tends to skip ${topic}`,
      );

    const lines = [
      familiarity === undefined
        ? null
        : `${String(input.player.hero)}: ${String(familiarity.matches)} matches with you, ` +
          `${String(familiarity.wins)} won.`,
      tendencies.length === 0 ? null : `this player ${tendencies.join(', ')}.`,
    ].filter((line): line is string => line !== null);

    return lines.length === 0 ? null : section('history', lines.join(' '));
  },
};

/** Enough observations for a tendency to be worth stating at all *(tunable)*. */
const MIN_SAMPLES = 3;

/** Output order. The persona first, because it frames everything after it. */
export const ALL_PREAMBLE_SECTIONS: readonly PreambleSectionSource[] = [
  persona,
  player,
  draft,
  matchups,
  benchmarks,
  patchNotes,
  history,
];

export { persona, player, draft, matchups, benchmarks, patchNotes, history };
