/**
 * Position 2. Four heroes.
 *
 * Content policy: hero-library.md §3 — durable shape, no numbers, no Facets, no innate specifics.
 * Patch 7.41 removed Facets outright and rewrote innate abilities, so a note that leaned on either
 * would be describing a game that no longer exists.
 */

import type { HeroEntry } from '../types.js';
import { entry, note } from './entry.js';

export const MIDS: readonly HeroEntry[] = [
  entry(
    'invoker',
    'Invoker',
    [2],
    [
      note(
        'overview',
        90,
        'The widest toolkit in the game — burst, control, push and escape, depending on which orbs are up.',
      ),
      note(
        'counters',
        86,
        'Silence him or jump him. He needs several uninterrupted seconds to do anything.',
      ),
      note(
        'weaknesses',
        82,
        'Squishy, immobile without Blink, and every combo is a visible wind-up.',
      ),
      note(
        'counters',
        79,
        'Watch his orbs. They tell you which spells are coming before he casts them.',
      ),
      note(
        'timings',
        76,
        'The spike is levels six to eight with the combo online, and again on his Scepter.',
      ),
      note(
        'items',
        66,
        "Aghanim's and Octarine decide how often the combo comes; Blink is what lands it.",
      ),
      note('laning', 58, 'Slow start and weak early levels. He wants experience more than gold.'),
    ],
  ),

  entry(
    'ember_spirit',
    'Ember Spirit',
    [2],
    [
      note(
        'overview',
        90,
        'Mobile mid who fights through remnants. Hard to catch, hard to pin down, deadly in a chase.',
      ),
      note(
        'counters',
        85,
        'Track his remnants. He escapes to them, so cutting off the return is how you kill him.',
      ),
      note(
        'counters',
        79,
        'Break Flame Guard with right-clicks. It absorbs magic damage, not physical.',
      ),
      note(
        'weaknesses',
        77,
        'Fragile the moment he is locked down — no remnant up, and one disable is fatal.',
      ),
      note(
        'timings',
        76,
        'Level six with a remnant placed is when he starts killing supports at will.',
      ),
      note(
        'items',
        66,
        'Battle Fury for farm, then damage. His Scepter changes how far the remnants reach.',
      ),
      note(
        'laning',
        60,
        'Strong lane with Flame Guard, but he needs a level and a mana advantage to press it.',
      ),
    ],
  ),

  entry(
    'lina',
    'Lina',
    [2, 4],
    [
      note(
        'overview',
        90,
        'Burst caster who deletes a hero from range, and a real right-clicker once Fiery Soul stacks.',
      ),
      note(
        'counters',
        85,
        'Magic resistance and BKB blunt her almost entirely. She is one damage type.',
      ),
      note(
        'weaknesses',
        80,
        'Very fragile, and no escape unless she has bought one. Any gap-closer beats her.',
      ),
      note(
        'counters',
        78,
        'Dodge Light Strike Array. It is slow and telegraphed, and her combo does not land without it.',
      ),
      note(
        'timings',
        76,
        'Laguna Blade at six kills most supports through anything short of magic immunity.',
      ),
      note('items', 66, "Aghanim's and Octarine for the burst; Eul's or Blink to land the stun."),
      note(
        'laning',
        62,
        'Strong laner — Dragon Slave farms and harasses, and her stun punishes anyone standing still.',
      ),
    ],
  ),

  entry(
    'necrolyte',
    'Necrophos',
    [2, 3],
    [
      note(
        'overview',
        90,
        'Attrition hero. He out-sustains a lane, and his ultimate executes anyone the fight already hurt.',
      ),
      note(
        'counters',
        87,
        'Heal reduction is the answer — Spirit Vessel above all. Without it he does not lose lanes.',
      ),
      note(
        'counters',
        79,
        'Do not fight at low health near him. The Scythe kills what the fight already softened.',
      ),
      note(
        'weaknesses',
        77,
        'Slow, no escape, and no burst without his ultimate. Blink onto him and he is gone.',
      ),
      note(
        'timings',
        76,
        "Reaper's Scythe snowballs: every kill it lands buys respawn time and the next fight.",
      ),
      note(
        'items',
        66,
        'Magic resistance and regeneration make him unkillable in a lane; his Scepter changes the execute.',
      ),
      note(
        'laning',
        68,
        'Very hard to push off a lane. He heals through harass and wins the last-hit war by attrition.',
      ),
    ],
  ),
];
