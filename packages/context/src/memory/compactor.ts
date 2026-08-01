/**
 * When to compact — §7.3. A separate question from *what*, which is `retention.ts`.
 *
 * Not when the window is full. realtime §5's guidance is to trim aggressively but rarely, because
 * every truncation busts the prompt cache — and a cache bust is a latency cost, which lands on the
 * player as a slow answer. So there is a low-water mark *(0.75)* and a preference for a quiet
 * moment, and "quiet" needs no new dependency: the world model's derived state already knows about
 * teamfight intensity, the same signal `packages/events` uses to suppress speech during a fight.
 *
 * Above the cap it plans regardless — `reason: 'forced'`. A cache bust during a teamfight is still
 * better than the API truncating oldest-first, because **oldest-first removes the cached prefix**:
 * Riki would forget its persona and the whole match preamble and keep its most recent small talk.
 * Whatever else happens, we must reach the budget before the API does.
 *
 * `consider()` is called on turn *close*, never on turn open (§9.2). At open it would add latency
 * to the path the 5 ms and 100 ms budgets protect; at close there is nobody waiting.
 */

import type { MonoMs } from '../common/types.js';
import type { WorldSnapshot } from '../common/ports.js';
import type { Compactor, ConversationLedger, RetentionPolicy } from './contracts.js';
import type { MutableWorkingMemory } from './working.js';
import type { LedgerRef, WindowBudget, WindowPlan } from './types.js';
import { path } from '../snapshot/sections/util.js';

export interface CompactorOptions {
  readonly ledger: ConversationLedger;
  readonly working: MutableWorkingMemory;
  readonly retention: RetentionPolicy;
  readonly budget: WindowBudget;
  /**
   * Above this, the moment is not quiet *(tunable)*. `derived.teamfightIntensity` is the world
   * model's own 0–1 signal; when it is absent the moment counts as quiet, because a missing signal
   * should not be able to postpone a compaction indefinitely.
   */
  readonly quietBelow?: number;
  readonly onPlan?: (plan: WindowPlan) => void;
}

const DEFAULT_QUIET_BELOW = 0.2;

export function createCompactor(options: CompactorOptions): Compactor {
  const quietBelow = options.quietBelow ?? DEFAULT_QUIET_BELOW;
  const { ledger, working, retention, budget } = options;
  let consideredAt = 0 as MonoMs;

  return {
    consider(world: WorldSnapshot, now: MonoMs): WindowPlan | null {
      consideredAt = now;
      const occupancy = working.window().estimatedTokens;
      const forced = occupancy >= budget.capTokens;

      if (!forced && occupancy < budget.capTokens * budget.lowWaterMark) return null;

      const intensity = world.get<number>(path('derived.teamfightIntensity'))?.value ?? 0;
      const quiet = intensity < quietBelow;
      if (!forced && !quiet) return null;

      const plan = retention.plan(ledger, budget, now);
      // Nothing to drop is not a plan. Handing `packages/realtime` an empty one would bust the
      // cache for no reduction, which is the exact cost §7.3 exists to avoid.
      if (plan.drop.length === 0 && plan.replace.length === 0) return null;

      const labelled: WindowPlan = {
        ...plan,
        reason: forced ? 'forced' : quiet ? 'quiet_moment' : 'low_water',
      };
      options.onPlan?.(labelled);
      return labelled;
    },

    /**
     * Applied after `packages/realtime` confirms execution — with what it *actually* dropped, which
     * may be less than the plan asked for (§8.4's `AppliedWindowPlan.failed`). Recording the plan
     * instead would put a divergence into `inWindow()` that nothing later could detect.
     */
    applied(plan: WindowPlan, dropped: readonly LedgerRef[]): void {
      ledger.markDropped(dropped, 'planned');

      // A replacement is two things, and doing only the first is the bug: the replaced refs leave
      // the window *and* the summary joins it. Appending the summary entry is what makes it count
      // towards occupancy on the next `window()` — otherwise every compaction would under-report
      // by the size of the thing it just added, and the drift would compound.
      for (const replacement of plan.replace) {
        ledger.markDropped(replacement.refs, 'planned');
        ledger.append({
          kind: 'summary',
          replaces: replacement.refs,
          rendered: replacement.with,
          at: consideredAt,
        });
      }

      working.noteCompacted(consideredAt);
    },
  };
}
