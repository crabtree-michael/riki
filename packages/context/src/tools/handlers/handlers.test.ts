/**
 * The eight commands, against fake ports. Tier 1.
 *
 * The rule most of these guard is §7.2's, which is the one a naive implementation gets backwards:
 *
 * > The default recovery is **not** "report unavailable". It is answer with what the model already
 * > holds, marked with its age, and report unavailable only when there is nothing observed at all.
 *
 * An old fact labelled old is useful; a guess presented as current is the worst outcome the product
 * has; and silence about something we *do* know is a coach who seems broken.
 */

import { describe, expect, it } from 'vitest';
import type { CallId, MonoMs, RawToolCall, TurnId } from './../types.js';
import type { GameClock, HeroId, ItemId } from '../../common/types.js';
import { ManualClock, createFakeToolPorts, observed } from '../testing/index.js';
import { ALL_HANDLERS } from '../all-handlers.js';
import { buildToolSurface } from '../surface.js';
import { failure } from '../failures.js';

const raw = (name: string, argumentsJson = '{}'): RawToolCall => ({
  callId: 'c1' as CallId,
  turnId: 't1' as TurnId,
  name,
  argumentsJson,
  receivedAt: 0 as MonoMs,
});

function harness() {
  const clock = new ManualClock();
  const ports = createFakeToolPorts({
    clock,
    world: {
      roster: { self: 'nevermore' as HeroId, enemies: ['pudge', 'zuus'] as HeroId[] },
      clock: 900 as GameClock,
    },
  });
  const surface = buildToolSurface({
    ports,
    env: { visionEnabled: true, readScreenEnabled: true },
    tools: ALL_HANDLERS,
  });
  const scope = surface.openTurn('t1' as TurnId, 0 as MonoMs);
  return { ports, surface, scope };
}

describe('get_enemy_detail', () => {
  it('marks a stale CV position with its age and confidence, never as a bare fact', async () => {
    // REPO_SKELETON.md §5.4 names this exact test: feed a 30-second-old CV position, assert it is
    // never rendered as a certainty.
    const { ports, surface, scope } = harness();
    ports.world.set(
      'enemies.pudge.area',
      observed('bot lane', { source: 'cv', confidence: 0.78, ageMs: 12_000, staleness: 'aging' }),
    );
    ports.world.set('enemies.pudge.level', observed(14));

    const result = await surface.executor.invoke(
      raw('get_enemy_detail', '{"hero":"pudge"}'),
      scope,
    );

    expect(result.status).toBe('ok');
    expect(result.output).toContain('bot lane');
    expect(result.output).toMatch(/~12s ago\(0\.78\)/);
    expect(result.output).toContain('lvl 14');
  });

  it('drops a below-threshold sighting rather than hedging it', async () => {
    const { ports, surface, scope } = harness();
    ports.world.set(
      'enemies.pudge.area',
      observed('roshan pit', { source: 'cv', confidence: 0.2 }),
    );

    const result = await surface.executor.invoke(
      raw('get_enemy_detail', '{"hero":"pudge"}'),
      scope,
    );

    expect(result.output).not.toContain('roshan');
    expect(result.output).not.toMatch(/probably|maybe|might/i);
  });

  it('says a hero is not in this game rather than describing one who is not', async () => {
    const { surface, scope } = harness();
    const result = await surface.executor.invoke(
      raw('get_enemy_detail', '{"hero":"juggernaut"}'),
      scope,
    );

    expect(result.status).toBe('unknown_subject');
    expect(result.output).toContain("isn't in this game");
    // The candidates come along so the model corrects itself in one turn instead of two.
    expect(result.output).toContain('pudge');
  });

  it('resolves the way the player speaks', async () => {
    const { ports, surface, scope } = harness();
    ports.world.setRoster({ enemies: ['nevermore'] as HeroId[] });
    ports.world.set('enemies.nevermore.level', observed(9));

    const result = await surface.executor.invoke(raw('get_enemy_detail', '{"hero":"sf"}'), scope);
    expect(result.status).toBe('ok');
    expect(result.output).toContain('lvl 9');
  });
});

describe('get_timings', () => {
  it('renders the clock and the timers it has, and stays silent about the rest', async () => {
    const { ports, surface, scope } = harness();
    ports.world.set('map.roshanState', observed('dead'));
    ports.world.set('self.respawnIn', observed(24));

    const result = await surface.executor.invoke(raw('get_timings'), scope);

    expect(result.output).toContain('15:00');
    expect(result.output).toContain('rosh dead');
    expect(result.output).toContain('respawn 24s');
    // Never observed is absent, not guessed and not an empty label.
    expect(result.output).not.toContain('buyback');
  });
});

describe('get_minimap_summary', () => {
  it('answers from memory with the fact marked, when the fresh capture times out', async () => {
    // §7.2, the row a naive implementation gets backwards: the request failed, the memory did not.
    const { ports, surface, scope } = harness();
    ports.world.set(
      'enemies.pudge.area',
      observed('top rune', { source: 'cv', confidence: 0.8, ageMs: 8000, staleness: 'aging' }),
    );
    ports.fresh.outcome = () => failure('timeout', { detail: 'no capture' });

    const result = await surface.executor.invoke(raw('get_minimap_summary'), scope);

    expect(result.status).toBe('ok');
    expect(result.output).toContain('no fresh look');
    expect(result.output).toContain('top rune');
    expect(result.output).toMatch(/~8s ago\(0\.80\)/);
  });

  it('does not degrade to memory when the turn was cancelled', async () => {
    // Barge-in is the one case with nothing to answer honestly *with*: the conversation item this
    // would answer no longer exists (§6.5).
    const { ports, surface, scope } = harness();
    ports.fresh.outcome = () => failure('cancelled', { detail: 'barge_in' });

    const result = await surface.executor.invoke(raw('get_minimap_summary'), scope);
    expect(result.status).toBe('cancelled');
    expect(result.output).toBe('');
  });
});

describe('reference commands', () => {
  it('answers an item lookup from the port', async () => {
    const { ports, surface, scope } = harness();
    ports.reference.items.set('black_king_bar', {
      id: 'black_king_bar' as ItemId,
      cost: 4050,
      components: ['ogre_axe', 'mithril_hammer'] as ItemId[],
    });

    const result = await surface.executor.invoke(raw('get_item_info', '{"item":"bkb"}'), scope);

    expect(result.status).toBe('ok');
    expect(result.output).toContain('4050g');
    expect(result.output).toContain('ogre_axe');
  });

  it('degrades to `unavailable` when the reference API is down', async () => {
    // Reference data is by definition not urgent, and dota2 §2.4 already treats it as best-effort.
    const { ports, surface, scope } = harness();
    ports.reference.down = true;

    const result = await surface.executor.invoke(raw('get_item_info', '{"item":"bkb"}'), scope);
    expect(result.status).toBe('unavailable');
    expect(result.output).toBe("I can't see that right now.");
  });

  it('compares the player against a benchmark rather than reciting both numbers', async () => {
    const { ports, surface, scope } = harness();
    ports.world.set('self.hero', observed('nevermore'));
    ports.world.set('self.netWorth', observed(9200));
    ports.world.set('self.level', observed(13));
    ports.reference.benchmarks = {
      atClock: 900 as GameClock,
      expectedNetWorth: 8000,
      expectedLevel: 14,
    };

    const result = await surface.executor.invoke(raw('get_build_benchmark'), scope);

    expect(result.status).toBe('ok');
    expect(result.output).toContain('+1200g');
    expect(result.output).toContain('level -1');
  });
});

describe('read_screen', () => {
  it('asks, looks, and reports what landed in the model', async () => {
    const { ports, surface, scope } = harness();
    ports.world.set('screen.scoreboard', observed(['radiant 12 - 8 dire']));

    const result = await surface.executor.invoke(
      raw('read_screen', '{"region":"scoreboard"}'),
      scope,
    );

    expect(result.status).toBe('ok');
    expect(result.output).toContain('radiant 12 - 8 dire');
    expect(ports.consent.prompts[0]?.prompt).toBe('Look at the scoreboard?');
  });

  it('refuses a region it cannot place, and offers the ones it can', async () => {
    const { surface, scope } = harness();
    const result = await surface.executor.invoke(
      raw('read_screen', '{"region":"my opponents soul"}'),
      scope,
    );

    expect(result.status).toBe('unknown_subject');
    expect(result.output).toContain('minimap');
  });
});
