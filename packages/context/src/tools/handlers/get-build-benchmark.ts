/**
 * `get_build_benchmark` — is the player ahead or behind for this point in the game.
 *
 * ⚠ **Classified `reference`, where §3.2's table says `model`.** The table's own rule is that the
 * effect class decides the deadline, and `model`'s deadline is 20 ms — but this command's answer
 * comes from `ReferenceDataPort.benchmark()`, an external, disk-cached, patch-keyed lookup that
 * §3.2 gives 400 ms. Under `model` it could only ever time out, and a definition may tighten its
 * class's limits but never loosen them (§3.2), so there is no override that rescues it. §5.3 and
 * §16 step 5 both place `benchmark()` on the reference port, which is the reading this follows.
 * ADR-0018 records the correction.
 *
 * The comparison itself is arithmetic over one observed value and one fetched value, which is why
 * it lives here rather than in the world model: it is not a fact about the match, it is a fact
 * about the match *and* a benchmark, and fusing those would give the model a reason to know it is
 * feeding an LLM (state-capture §7.3).
 */

import type { FieldPath } from '../../common/ports.js';
import type { HeroId, Observed } from '../types.js';
import type { BuildBenchmark } from '../ports.js';
import { compose, field } from '../render.js';
import { NO_ARGS } from '../codec.js';
import { defineTool } from '../registry.js';
import { failure, ok } from '../failures.js';

export interface BenchmarkComparison {
  readonly benchmark: BuildBenchmark;
  readonly netWorth?: Observed<number>;
  readonly level?: Observed<number>;
}

export const getBuildBenchmark = defineTool({
  name: 'get_build_benchmark',
  effect: 'reference',
  summary:
    'How the player compares to a typical game on this hero at this point: net worth and level ' +
    'against the benchmark.',
  args: NO_ARGS,
  needs: ['world', 'reference'],

  handler: async (_a, ctx) => {
    const snapshot = ctx.ports.world.snapshot(ctx.now);
    const hero = snapshot.get<HeroId>('self.hero' as FieldPath);
    if (hero === undefined || snapshot.clock === null) {
      return failure('unavailable', { detail: 'no hero or no clock yet' });
    }

    const fetched = await ctx.ports.reference.benchmark(hero.value, snapshot.clock);
    if (!fetched.ok) return failure(fetched.reason, { detail: 'reference data' });

    const netWorth = snapshot.get<number>('self.netWorth' as FieldPath);
    const level = snapshot.get<number>('self.level' as FieldPath);

    return ok<BenchmarkComparison>({
      benchmark: fetched.value,
      ...(netWorth === undefined ? {} : { netWorth }),
      ...(level === undefined ? {} : { level }),
    });
  },

  renderer: {
    render(value: BenchmarkComparison, ctx) {
      // The delta is the answer; the raw numbers are the supporting detail and drop first.
      const netWorthDelta =
        value.netWorth === undefined
          ? null
          : signed(value.netWorth.value - value.benchmark.expectedNetWorth);
      const levelDelta =
        value.level === undefined
          ? null
          : signed(value.level.value - value.benchmark.expectedLevel);

      return compose(
        [
          {
            id: 'netWorth',
            priority: 100,
            droppable: false,
            text: netWorthDelta === null ? null : `net worth ${netWorthDelta}g vs typical`,
          },
          { id: 'level', priority: 90, text: levelDelta === null ? null : `level ${levelDelta}` },
          {
            id: 'raw',
            priority: 20,
            text: field('now', value.netWorth, ctx, (v) => `${String(v)}g`),
          },
        ],
        ctx,
      );
    },
  },
});

function signed(n: number): string {
  const rounded = Math.round(n);
  return rounded >= 0 ? `+${String(rounded)}` : String(rounded);
}
