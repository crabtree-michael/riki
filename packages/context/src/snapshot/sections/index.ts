/**
 * The ten section sources, in output order.
 *
 * Adding a line to the snapshot is one file here, one entry in `../ladder.ts`, and one golden diff
 * (§14). The ladder entry is the part not to skip: a section with no declared priority truncates in
 * whatever order this array happened to be in.
 */

import type { SectionSource } from '../contracts.js';
import { header } from './header.js';
import { selfEconomy } from './self-economy.js';
import { selfAbilities } from './self-abilities.js';
import { selfItems } from './self-items.js';
import { enemies } from './enemies.js';
import { seen } from './seen.js';
import { unseen } from './unseen.js';
import { derived } from './derived.js';
import { map } from './map.js';
import { recent } from './recent.js';

export const ALL_SECTIONS: readonly SectionSource[] = [
  header,
  selfEconomy,
  selfAbilities,
  selfItems,
  enemies,
  seen,
  unseen,
  derived,
  map,
  recent,
];

export {
  header,
  selfEconomy,
  selfAbilities,
  selfItems,
  enemies,
  seen,
  unseen,
  derived,
  map,
  recent,
};
export { UNSEEN_AFTER_SECONDS } from './seen.js';
export { MAX_TAPE_EVENTS } from './recent.js';
