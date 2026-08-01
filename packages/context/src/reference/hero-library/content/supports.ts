/**
 * Positions 4 and 5. Six heroes.
 *
 * Content policy: hero-library.md §3. Supports get more `against` weight than cores do, because
 * what a player most needs from Riki about an enemy support is what it costs them to ignore it.
 */

import type { HeroEntry } from '../types.js';
import { entry, note } from './entry.js';

export const SUPPORTS: readonly HeroEntry[] = [
  entry(
    'treant',
    'Treant Protector',
    [5],
    [
      note(
        'overview',
        90,
        'Support who heals buildings and allies from anywhere, and roots an entire team at once.',
      ),
      note(
        'counters',
        85,
        'Fight him in open ground, away from the treeline, where his passive does nothing.',
      ),
      note(
        'weaknesses',
        79,
        'Slow, and only hidden near trees. Away from them he is easy to see coming.',
      ),
      note('counters', 77, 'Overgrowth is a root, not a stun. BKB and dispels answer it.'),
      note(
        'timings',
        74,
        'Overgrowth at six is a full teamfight root; with Blink it starts fights instead of saving them.',
      ),
      note(
        'items',
        66,
        "Blink and Aghanim's. Living Armor means he needs very little for himself.",
      ),
      note(
        'laning',
        68,
        'Enormous lane presence — Leech Seed plus his damage wins trades, and Living Armor undoes harass.',
      ),
    ],
  ),

  entry(
    'keeper_of_the_light',
    'Keeper of the Light',
    [4, 5],
    [
      note(
        'overview',
        90,
        'Support who solves mana for a whole team and does real damage from a screen away.',
      ),
      note('counters', 85, 'Jump him. He has no escape and dies to any real commitment.'),
      note('weaknesses', 80, 'Paper-thin and immobile. Anyone who reaches him kills him.'),
      note(
        'counters',
        77,
        'Do not stand in the Illuminate channel. It is a long, visible wind-up.',
      ),
      note(
        'timings',
        73,
        'Useful from level one and steady thereafter. His value is constant rather than spiky.',
      ),
      note(
        'items',
        66,
        "Aghanim's and Octarine. His items are about casting more, not about surviving.",
      ),
      note(
        'laning',
        66,
        'Illuminate out-ranges almost everything — he shoves and harasses without being touched.',
      ),
    ],
  ),

  entry(
    'undying',
    'Undying',
    [5],
    [
      note(
        'overview',
        90,
        'Support who makes a lane miserable and turns fights with a Tombstone nobody can kill in time.',
      ),
      note(
        'counters',
        86,
        'Kill the Tombstone first. Everything else in that fight is downstream of it.',
      ),
      note(
        'counters',
        78,
        'Do not let him free-cast Decay in lane. Every cast he lands arrives at the next fight with him.',
      ),
      note('weaknesses', 77, 'Slow, no escape, and he falls off hard if the game goes long.'),
      note(
        'timings',
        74,
        'Tombstone at six wins most early fights outright if it lands in the right place.',
      ),
      note(
        'items',
        64,
        'Cheap and cheerful. He wants to be where the fight is, not to survive it.',
      ),
      note(
        'laning',
        70,
        'One of the hardest lanes to play against. Decay makes him bigger and you smaller, and he never leaves.',
      ),
    ],
  ),

  entry(
    'snapfire',
    'Snapfire',
    [4],
    [
      note(
        'overview',
        90,
        'Support with a stun, a shove, and a long-range ultimate that lands on the whole enemy team.',
      ),
      note(
        'counters',
        84,
        'Stay spread for the ultimate. It covers a wide area but is slow enough to walk out of.',
      ),
      note('counters', 78, 'Punish her at range. Her strongest tool only works up close.'),
      note(
        'weaknesses',
        76,
        'Squishy and slow, and she has to be in dangerous range for Scatterblast to matter.',
      ),
      note(
        'timings',
        74,
        'Mortimer Kisses at six is real damage and area denial from outside the fight.',
      ),
      note(
        'items',
        66,
        "Aghanim's and Blink. The cookie is a team gap-closer as much as it is a stun.",
      ),
      note(
        'laning',
        66,
        'Scatterblast up close hurts. She wins short-range trades and shoves a wave fast.',
      ),
    ],
  ),

  entry(
    'bane',
    'Bane',
    [4, 5],
    [
      note(
        'overview',
        90,
        'The best single-target lockdown in the game. Anyone he grips is out of the fight.',
      ),
      note(
        'counters',
        86,
        "Save a stun or a dispel for Fiend's Grip. It is a channel, and it can be broken.",
      ),
      note('counters', 79, "BKB and Linken's blunt him. He is single-target from start to finish."),
      note('weaknesses', 77, 'The Grip is a channel. Interrupt it and he has contributed nothing.'),
      note(
        'timings',
        74,
        'Useful from level one. His ultimate at six turns a five-on-five into a four-on-five.',
      ),
      note(
        'items',
        66,
        'Glimmer and Aeon Disk — he needs to survive the channel, not to do damage.',
      ),
      note(
        'laning',
        68,
        "Brutal laner. Enfeeble removes a carry's damage and Nightmare sets up every kill.",
      ),
    ],
  ),

  entry(
    'bounty_hunter',
    'Bounty Hunter',
    [4],
    [
      note('overview', 90, 'Roaming support who funds his team off Track and never stops moving.'),
      note(
        'counters',
        88,
        'Sentries and dust, early. He is the cheapest hero in the game to shut down.',
      ),
      note(
        'weaknesses',
        80,
        'Almost no damage of his own late, and detection turns him off entirely.',
      ),
      note(
        'counters',
        77,
        'Track gives him vision on you. A tracked hero should not be split-pushing alone.',
      ),
      note(
        'timings',
        74,
        'Level six is the spike: from there every kill on the map pays his whole team.',
      ),
      note(
        'items',
        66,
        'Boots and utility. His Scepter and Shard change how much the team gets, not how hard he hits.',
      ),
      note('laning', 60, 'He is barely in the lane. Expect him behind you from the first minute.'),
    ],
  ),
];
