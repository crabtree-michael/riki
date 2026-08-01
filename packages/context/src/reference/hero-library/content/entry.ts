/**
 * The two helpers the content files are written with.
 *
 * `entry()` exists to confine the `HeroId` brand cast to one place. Content is authored as plain
 * strings — a hero id is `npc_dota_hero_spectre`'s suffix and nothing more — and twenty files each
 * writing `'spectre' as HeroId` would be twenty chances to brand something that is not an id.
 */

import type { HeroEntry, HeroNote, HeroTopic, Position } from '../types.js';
import type { HeroId } from '../../../common/types.js';

/**
 * One note, with the priority that decides what survives a tight budget.
 *
 * The priority ladder is per hero and it is a coaching decision, not a formatting one: what you
 * most need to hear about Enigma is not the same *kind* of thing you most need to hear about
 * Spectre. Roughly, `overview` and the best `against` line sit at the top, `laning` at the bottom.
 */
export function note(topic: HeroTopic, priority: number, text: string): HeroNote {
  return { topic, priority, text };
}

export function entry(
  hero: string,
  name: string,
  positions: readonly Position[],
  notes: readonly HeroNote[],
): HeroEntry {
  return { hero: hero as HeroId, name, positions, notes };
}
