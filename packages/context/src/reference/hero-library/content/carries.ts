/**
 * Position 1. Five heroes.
 *
 * Content policy is hero-library.md §3, and it is worth restating the part that bites while
 * authoring: **no numbers a patch can silently invalidate.** No cooldowns, no damage, no gold, no
 * clock timings. "Spikes on her second item" survives a rebalance; "spikes at 22 minutes" quietly
 * stops being true and nothing tells you. Items are named only where they have meant the same
 * thing for years.
 */

import type { HeroEntry } from '../types.js';
import { entry, note } from './entry.js';

export const CARRIES: readonly HeroEntry[] = [
  entry(
    'spectre',
    'Spectre',
    [1],
    [
      note(
        'overview',
        90,
        'Late-game carry. Weak and farm-hungry early, close to unkillable once her core items land.',
      ),
      note(
        'counters',
        85,
        'Take objectives early. This game is decided before she comes online, not after.',
      ),
      note(
        'counters',
        82,
        'Break her farm rather than fighting her late — ward her jungle and take her camps.',
      ),
      note('weaknesses', 79, 'No escape and no burst. Caught out before items, she simply dies.'),
      note(
        'timings',
        76,
        'Her real spike is the second core item, not the first. Before that she loses fights she joins.',
      ),
      note(
        'timings',
        72,
        'Haunt puts her in any fight on the map, so she is a threat everywhere the moment it is up.',
      ),
      note(
        'items',
        66,
        'Dispersion turns damage back on the attacker; Heart and Butterfly are what make that unkillable.',
      ),
      note(
        'laning',
        55,
        'Expect a rough lane. She concedes ground to farm safely and comes back on items.',
      ),
    ],
  ),

  entry(
    'life_stealer',
    'Lifestealer',
    [1],
    [
      note(
        'overview',
        90,
        'Durable melee carry who is immune to magic under Rage and closes distance for free.',
      ),
      note(
        'counters',
        86,
        'Do not spend magic damage or disables into Rage. Wait it out, then commit.',
      ),
      note(
        'weaknesses',
        82,
        'Rage dispels magic but does nothing about physical damage. Armour and kiting beat him.',
      ),
      note(
        'counters',
        78,
        'He has to be in melee range to do anything at all. Slows and blinks keep him harmless.',
      ),
      note(
        'timings',
        76,
        'Dangerous from level six: Infest means he arrives in a fight from inside an ally or a creep.',
      ),
      note(
        'items',
        66,
        'Attack speed, lifesteal and Armlet. He wants sustained damage, not burst.',
      ),
      note('laning', 60, 'Strong laner — Feast wins him most early right-click trades outright.'),
    ],
  ),

  entry(
    'phantom_lancer',
    'Phantom Lancer',
    [1],
    [
      note(
        'overview',
        90,
        'Illusion carry who becomes an army. Very hard to lock down and very hard to burst.',
      ),
      note(
        'counters',
        86,
        'Buy area damage early. Killing his illusions one at a time is how he wins the game.',
      ),
      note(
        'weaknesses',
        82,
        'Illusions melt to area damage — Mjollnir, Radiance, Shivas and Battle Fury all cut through him.',
      ),
      note(
        'counters',
        78,
        'He has no lockdown. A hero who can burst the real one through the crowd beats him.',
      ),
      note(
        'timings',
        76,
        'Juxtapose plus his first big item is the spike; after that illusion count wins fights on its own.',
      ),
      note(
        'items',
        66,
        'Diffusal and Manta are core. Heart later makes the real hero indistinguishable from the rest.',
      ),
      note(
        'laning',
        58,
        'Weak and mana-hungry early. He farms with Spirit Lance and comes online on items.',
      ),
    ],
  ),

  entry(
    'skeleton_king',
    'Wraith King',
    [1],
    [
      note(
        'overview',
        90,
        'Carry who fights twice. Reincarnation means every engagement on him costs you double.',
      ),
      note(
        'counters',
        86,
        'Check his mana before you commit. Reincarnation with no mana is not a second life.',
      ),
      note(
        'weaknesses',
        82,
        'Burn his mana and he stops coming back. Slow, and easy to kite outside his stun.',
      ),
      note(
        'counters',
        78,
        'Mana burn, silences and heal reduction all hurt him more than raw damage does.',
      ),
      note(
        'timings',
        76,
        'A real threat from level six, and stronger again once his skeletons scale into pushes.',
      ),
      note(
        'items',
        66,
        'Mana matters more than damage — Reincarnation has to be paid for or it does not fire.',
      ),
      note(
        'laning',
        62,
        'Strong lane with a stun and lifesteal. He bullies most safe-lane matchups early.',
      ),
    ],
  ),

  entry(
    'juggernaut',
    'Juggernaut',
    [1],
    [
      note(
        'overview',
        90,
        'Flexible carry with a spell-immune blade and a targeted ultimate. Safe pick, strong early.',
      ),
      note(
        'counters',
        85,
        "Ghost Scepter or Eul's on yourself blunts Omnislash. Once it starts you cannot disable him out of it.",
      ),
      note('counters', 79, 'Kill the Healing Ward. It wins him fights he would otherwise lose.'),
      note(
        'weaknesses',
        77,
        'Fragile without items, and stopped cold by a disable landed the moment Blade Fury ends.',
      ),
      note(
        'timings',
        76,
        'Level six is the spike. Omnislash kills most heroes outright if they have no answer up.',
      ),
      note('items', 66, "Aghanim's Scepter, then attack speed and lifesteal."),
      note(
        'laning',
        62,
        'Blade Fury gives him both a strong lane and an escape. Hard to gank before six.',
      ),
    ],
  ),
];
