/**
 * Position 3. Five heroes.
 *
 * Content policy: hero-library.md §3. Note the Enigma `against` line in particular — it exists
 * because the obvious counterplay is wrong, and a library that repeats the obvious wrong thing is
 * worse than one that says nothing.
 */

import type { HeroEntry } from '../types.js';
import { entry, note } from './entry.js';

export const OFFLANERS: readonly HeroEntry[] = [
  entry(
    'night_stalker',
    'Night Stalker',
    [3],
    [
      note(
        'overview',
        90,
        'Night is his. He is a different hero after dark, and he chooses when fights happen.',
      ),
      note(
        'counters',
        86,
        'Watch the clock, not the map. Do not take a fight in the first night if you can avoid it.',
      ),
      note(
        'weaknesses',
        82,
        'Daytime, plainly. Fight him and take objectives while the sun is up.',
      ),
      note(
        'timings',
        78,
        'Level six at night is the spike. He picks a target and it does not get away.',
      ),
      note(
        'counters',
        76,
        'Crippling Fear silences. Without a BKB or a dispel your team does not get to answer.',
      ),
      note('items', 66, 'Blink to open, then survivability. He wants to arrive first and stay in.'),
      note(
        'laning',
        64,
        'Weak through the first day, strong from the first night. The lane swings on the clock.',
      ),
    ],
  ),

  entry(
    'centaur',
    'Centaur Warrunner',
    [3],
    [
      note(
        'overview',
        90,
        'Durable initiator. Blink-stomp starts the fight and Stampede brings the whole team into it.',
      ),
      note('counters', 86, 'Break his Blink Dagger. Every fight he wins starts with it.'),
      note(
        'weaknesses',
        79,
        'Almost no damage without his team around him. Denied the opening, he does nothing.',
      ),
      note(
        'counters',
        77,
        'Stampede is a team-wide gap close. Spread out, and save a disable for whatever arrives.',
      ),
      note(
        'timings',
        76,
        'Blink is the timing that matters. Before it he is a body; after it he opens every fight.',
      ),
      note(
        'items',
        66,
        'Blink first, then armour and health — his damage scales off his own strength.',
      ),
      note(
        'laning',
        64,
        'Tanky lane presence. Double Edge trades hard and he is very hard to kill early.',
      ),
    ],
  ),

  entry(
    'dawnbreaker',
    'Dawnbreaker',
    [3],
    [
      note(
        'overview',
        90,
        'Durable frontliner who heals herself while fighting and can drop into any fight on the map.',
      ),
      note(
        'counters',
        86,
        'Heal reduction beats her. Spirit Vessel and its like turn her from a tank into a target.',
      ),
      note(
        'weaknesses',
        78,
        'Low damage without items, and her sustain is halved the moment healing is cut.',
      ),
      note(
        'timings',
        76,
        'Solar Guardian at six means she is in every fight, whether or not you saw her coming.',
      ),
      note('counters', 74, 'Her global entrance is telegraphed. Move out of the landing circle.'),
      note(
        'items',
        66,
        'Armour, health and Pipe. She is a body that has to survive being focused.',
      ),
      note(
        'laning',
        64,
        'Strong, sustainable lane — Luminosity heals her through trades she should lose.',
      ),
    ],
  ),

  entry(
    'legion_commander',
    'Legion Commander',
    [3],
    [
      note(
        'overview',
        90,
        'She wins the game one duel at a time, and every duel she wins makes the next one worse for you.',
      ),
      note('counters', 86, 'Break her Blink Dagger. Without it she cannot choose who she duels.'),
      note(
        'counters',
        80,
        'Every duel she wins is permanent damage. Saving the target matters more than winning the fight.',
      ),
      note(
        'weaknesses',
        78,
        'Duel is a commitment. If her team is not with her, she is alone in the middle of yours.',
      ),
      note(
        'timings',
        76,
        'Blink plus Duel is the spike. Before Blink she cannot pick her target; after it she picks yours.',
      ),
      note('items', 66, 'Blink, then Blade Mail. She wants to be duelled back, not saved.'),
      note('laning', 62, 'Aggressive laner — Overwhelming Odds both farms and harasses.'),
    ],
  ),

  entry(
    'enigma',
    'Enigma',
    [3, 4],
    [
      note(
        'overview',
        90,
        'One spell decides games. Black Hole is the strongest teamfight ultimate in Dota.',
      ),
      note(
        'counters',
        88,
        'Never group up without knowing where Enigma is. That is the whole of the counterplay.',
      ),
      note(
        'counters',
        84,
        "Break the channel — a stun, a silence or Eul's on him stops it. BKB does not: Black Hole goes through spell immunity.",
      ),
      note(
        'weaknesses',
        78,
        'Fragile and slow. Deny him the Blink and the ultimate never reaches you.',
      ),
      note(
        'timings',
        76,
        'Level six with Blink is the timing. Everything before it is farming toward that.',
      ),
      note(
        'items',
        66,
        'Blink and Refresher; his Scepter and Shard change how the Black Hole lands.',
      ),
      note('laning', 56, 'Weak laner who farms the jungle with eidolons and scales on levels.'),
    ],
  ),
];
