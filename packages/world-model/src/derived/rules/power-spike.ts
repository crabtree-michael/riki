/**
 * How far the player is from their next real jump in power.
 *
 * Levels 6, 12 and 18 are ultimate ranks; 10, 15, 20 and 25 are talents. Those seven levels are
 * where a hero's threat actually steps, and knowing one is 40 seconds away is the difference
 * between a fight that works and one that does not.
 */

import type { Fact } from '../../fact.js';
import { derivedFact } from '../../fact.js';
import type { FieldPath } from '../../state.js';
import { fieldPath } from '../../state.js';
import type { DerivedRule } from '../registry.js';
import { DERIVED_IDS } from '../registry.js';

/** Ultimate ranks and talent levels, ascending. Stable across patches in a way XP costs are not. */
export const SPIKE_LEVELS: readonly number[] = [6, 10, 12, 15, 18, 20, 25];

const LEVEL_PATH: FieldPath = fieldPath('self', 'level');
const XP_PATH: FieldPath = fieldPath('self', 'xp');
const XPM_PATH: FieldPath = fieldPath('self', 'xpm');

export interface PowerSpike {
  readonly currentLevel: number;
  readonly nextSpikeLevel: number;
  readonly levelsAway: number;
  readonly reason: 'ultimate' | 'talent';
  /**
   * Seconds until the spike at the current XPM, or **null when the XP table has not been
   * supplied** — see `PowerSpikeOptions.xpToLevel`. Null here means "we do not know", and the
   * renderer must say so rather than dropping the field: `levelsAway` is still true and useful.
   */
  readonly etaSeconds: number | null;
}

export interface PowerSpikeOptions {
  /**
   * Cumulative hero XP required to *reach* each level, indexed by level (so `xpToLevel[12]` is the
   * total XP for level 12). `undefined` by default, and that default is the honest one.
   *
   * ⚠ These numbers are patch-versioned and change without much announcement. Committing a table
   * nobody had checked against the live patch would put a wrong countdown in a player's ear while
   * looking exactly as authoritative as a right one — precisely what dota2 §9's *never silently
   * into wrongness* rule forbids. So the table is injected, the rule degrades to a level distance
   * without it, and whoever verifies it against a patch wires it in at the composition root.
   */
  readonly xpToLevel?: readonly number[];
}

export function createPowerSpikeRule(opts: PowerSpikeOptions = {}): DerivedRule<PowerSpike> {
  return {
    id: DERIVED_IDS.powerSpikeIn,
    dependsOn: [LEVEL_PATH, XP_PATH, XPM_PATH],
    compute(state, now, clock): Fact<PowerSpike> | null {
      const level = state.self.level;
      if (level === undefined) return null;

      const nextSpikeLevel = SPIKE_LEVELS.find((spike) => spike > level.value);
      if (nextSpikeLevel === undefined) return null; // Level 25: there is nothing left to spike to.

      const inputs: Fact<unknown>[] = [level];
      const xp = state.self.xp;
      const xpm = state.self.xpm;
      const table = opts.xpToLevel;

      let etaSeconds: number | null = null;
      if (table !== undefined && xp !== undefined && xpm !== undefined && xpm.value > 0) {
        const needed = table[nextSpikeLevel];
        if (needed !== undefined) {
          etaSeconds = (Math.max(0, needed - xp.value) / xpm.value) * 60;
          inputs.push(xp, xpm);
        }
      }

      return derivedFact<PowerSpike>(
        {
          currentLevel: level.value,
          nextSpikeLevel,
          levelsAway: nextSpikeLevel - level.value,
          reason:
            nextSpikeLevel === 6 || nextSpikeLevel === 12 || nextSpikeLevel === 18
              ? 'ultimate'
              : 'talent',
          etaSeconds,
        },
        { observedAt: now, atGameClock: clock },
        inputs,
      );
    },
  };
}
