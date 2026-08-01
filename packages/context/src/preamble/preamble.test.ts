/**
 * Tier 1 assembly and the prefix budget. Tier 1 by REPO_SKELETON.md §5.3.
 *
 * Three of §13's rows, and two of them guard something no reviewer would catch:
 *
 * - **Byte-identity for identical input** (§4.4). A reconnect re-assembles the preamble, and a new
 *   session that cannot cache the prefix it already paid for has thrown away the reason Tier 1
 *   exists. The failure is a latency and cost regression with no error attached to it.
 * - **The enrichment deadline** (§4.3). A port that never resolves must still produce a preamble,
 *   because the alternative is Riki silent through the laning phase — the phase where advice is
 *   most valuable and most time-critical.
 * - **The prefix budget** (§4.2) — *the sum nobody was computing*. It catches a class of change,
 *   "one more line per hero", that looks like nothing in review and is how 1,500 becomes 4,000.
 */

import { describe, expect, it } from 'vitest';
import type { HeroId, MatchId, MonoMs } from '../common/types.js';
import type { PreambleInput } from './types.js';
import { FakeReferenceData, ManualTimers } from '../tools/testing/index.js';
import { EMPTY_PLAYER_MEMORY } from '../memory/player-memory.js';
import { createPreambleAssembler } from './assemble.js';
import { createEnrichmentPlanner } from './enrichment.js';
import { createPrefixBudget, PREFIX_ALLOCATION, PREFIX_CAP_TOKENS } from './budget.js';

const RIKI = 'riki' as HeroId;
const ENEMIES = ['nevermore', 'tidehunter', 'crystal_maiden'] as HeroId[];

function input(overrides: Partial<PreambleInput> = {}): PreambleInput {
  return {
    matchId: 'm1' as MatchId,
    draft: { self: RIKI, allies: ['zuus'] as HeroId[], enemies: ENEMIES },
    player: { hero: RIKI, role: 'carry', lane: 'safe', bracket: 'legend' },
    patch: '7.39c',
    memory: EMPTY_PLAYER_MEMORY,
    ...overrides,
  };
}

function reference(): FakeReferenceData {
  const port = new FakeReferenceData();
  port.benchmarks = { atClock: 600 as never, expectedNetWorth: 9000, expectedLevel: 12 };
  for (const enemy of ENEMIES) {
    port.matchups.set(`${RIKI}|${String(enemy)}`, {
      summary: `watch the ${String(enemy)} stun`,
      patch: '7.39c',
    });
  }
  return port;
}

describe('PreambleAssembler', () => {
  it('renders the dota2 §6.1 sections', async () => {
    const preamble = await createPreambleAssembler({
      reference: reference(),
      persona: 'You are Riki, a terse Dota 2 coach.',
    }).assemble(input(), 0 as MonoMs);

    expect(preamble.text).toContain('You are Riki');
    expect(preamble.text).toContain('coaching a carry playing riki, safe lane, legend bracket.');
    expect(preamble.text).toContain('enemies: nevermore, tidehunter, crystal_maiden');
    expect(preamble.text).toContain('watch the nevermore stun');
    expect(preamble.text).toContain('benchmark at 10:00');
    expect(preamble.text).toContain('patch 7.39c');
    expect(preamble.degraded).toStrictEqual([]);
  });

  it('is byte-identical for identical input', async () => {
    // §4.4: a reconnect re-assembles it, and the new session must be able to cache the same prefix.
    const assembler = createPreambleAssembler({ reference: reference(), persona: 'p' });
    const first = await assembler.assemble(input(), 0 as MonoMs);
    const second = await assembler.assemble(input(), 9_999 as MonoMs);
    expect(second.text).toBe(first.text);
    expect(second.tokens).toBe(first.tokens);
  });

  it('degrades a section rather than the preamble when enrichment fails', async () => {
    const down = new FakeReferenceData();
    down.down = true;
    const preamble = await createPreambleAssembler({ reference: down }).assemble(
      input(),
      0 as MonoMs,
    );

    expect(preamble.degraded).toStrictEqual(['matchups', 'benchmarks']);
    // A coach with no matchup notes is still a coach.
    expect(preamble.text).toContain('coaching a carry');
    expect(preamble.text).toContain('patch 7.39c');
  });

  it('produces a preamble within the deadline even if a port never resolves', async () => {
    const hanging = new FakeReferenceData();
    hanging.matchup = () => new Promise(() => undefined);
    hanging.benchmark = () => new Promise(() => undefined);

    const timers = new ManualTimers();
    const pending = createPreambleAssembler({
      reference: hanging,
      timers,
      enrichmentDeadlineMs: 3_000,
    }).assemble(input(), 0 as MonoMs);

    timers.advance(3_000);
    const preamble = await pending;
    expect(preamble.degraded).toStrictEqual(['matchups', 'benchmarks']);
    expect(preamble.text).not.toBe('');
  });

  it('renders durable memory as the history section', async () => {
    // The payoff for the whole persistence surface: what OpenDota structurally cannot know.
    const preamble = await createPreambleAssembler({ reference: reference() }).assemble(
      input({
        memory: {
          schemaVersion: 1,
          heroes: new Map([[RIKI, { hero: RIKI, matches: 9, wins: 5, lastPlayedAt: 1 }]]),
          adviceTendency: new Map([
            ['objective:ward', { followed: 4, ignored: 0 }],
            ['event:rune_soon', { followed: 0, ignored: 5 }],
          ]),
          patterns: [],
        },
      }),
      0 as MonoMs,
    );

    expect(preamble.text).toContain('riki: 9 matches with you, 5 won.');
    expect(preamble.text).toContain('tends to skip event:rune_soon');
    expect(preamble.text).toContain('acts on objective:ward');
  });
});

describe('EnrichmentPlanner', () => {
  it('puts the player’s own benchmark first, so the deadline eats the tail', () => {
    const plan = createEnrichmentPlanner().plan(input().draft, input().player);
    expect(plan[0]).toStrictEqual({ want: 'benchmark', hero: RIKI, at: 600 });
    expect(plan.at(-1)?.want).toBe('patch_notes');
    expect(plan.filter((r) => r.want === 'matchup')).toHaveLength(ENEMIES.length);
  });
});

describe('PrefixBudget', () => {
  it('sums the three claimants against the 16,384 cap', () => {
    // The sum nobody was computing. Persona, preamble and manifest are sized in three different
    // documents, and this is the only place they meet.
    const budget = createPrefixBudget(
      new Map([
        ['persona', PREFIX_ALLOCATION.persona],
        ['preamble', PREFIX_ALLOCATION.preamble],
        ['manifest', PREFIX_ALLOCATION.manifest],
      ]),
    );
    expect(budget.capTokens).toBe(PREFIX_CAP_TOKENS);
    expect(budget.total()).toBe(4_700);
    expect(budget.check()).toStrictEqual({ ok: true, overBy: 0 });
  });

  it('fails a test rather than a match when the sum crosses the cap', () => {
    const budget = createPrefixBudget(new Map([['preamble', PREFIX_CAP_TOKENS + 100]]));
    expect(budget.check()).toStrictEqual({ ok: false, overBy: 100 });
  });
});
