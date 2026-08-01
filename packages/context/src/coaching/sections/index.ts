/**
 * The seven brief sections.
 *
 * Adding one is one file here, one mention in whichever `BRIEF_PLAN` rows want it, and one golden
 * diff (§14). The plan row is the part not to skip: **a section this array holds but no plan row
 * names is a section that never renders**, which is a quieter failure than a section with no
 * declared priority, because nothing throws and no test fails unless one asserts over the pair.
 * `plan.test.ts` does.
 *
 * Order here is lookup order only. What the model sees is the order of the plan row, because
 * priority in a brief is per-cause — there is no fixed ladder to be in.
 *
 * **A section may not import another section.** They are leaves, exactly as the deleted command
 * handlers were, and for the better of that design's two reasons: a section that read another's
 * output would have a rendering order the plan does not describe. `eslint.config.js` holds it, and
 * the rule was proved by writing a violating file and watching it fail.
 */

import type { BriefSectionSource } from '../contracts.js';
import { threat } from './threat.js';
import { economy } from './economy.js';
import { windows } from './windows.js';
import { cooldowns } from './cooldowns.js';
import { positions } from './positions.js';
import { pace } from './pace.js';
import { history } from './history.js';

export const ALL_BRIEF_SECTIONS: readonly BriefSectionSource[] = [
  threat,
  economy,
  windows,
  cooldowns,
  positions,
  pace,
  history,
];

export { threat, economy, windows, cooldowns, positions, pace, history };
export { HISTORY_WINDOW_SECONDS } from './history.js';
