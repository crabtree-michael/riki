/**
 * `windows: rune 15:00 | rosh 16:50 | stack 14:53 | night`
 *
 * Predicted moments. The lead section for `rune_soon` and `stack_now`, which are the two triggers
 * that fire *before* the thing they are about — the only time that advice is actionable.
 *
 * **Absolute clock times, not "in 40 seconds", and that is a deviation worth naming.** §5.4 asks
 * for these relative to now. Relative would mean subtracting the current clock from each window,
 * which is arithmetic over two observed values inside a section — the thing §5.5's second rule
 * forbids, and it would produce a number carrying neither age nor confidence. The snapshot's header
 * carries `T mm:ss` on every turn, so the model has both halves; if a relative form turns out to
 * read better, the fix is a `derived.*In` field in `packages/world-model`, not a subtraction here.
 */

import type { BriefSectionSource } from '../contracts.js';
import { clockText, fieldsFor, join, line, path } from './util.js';

export const windows: BriefSectionSource = {
  id: 'windows',

  build(world, ctx) {
    const field = fieldsFor(ctx, world.clock);

    return line(
      'windows',
      'windows',
      join([
        field('rune', world.get<number>(path('derived.nextRuneAt')), (v) => clockText(Number(v))),
        field('rosh', world.get<number>(path('derived.roshanWindowAt')), (v) =>
          clockText(Number(v)),
        ),
        field('stack', world.get<number>(path('derived.nextStackAt')), (v) => clockText(Number(v))),
        field('', world.get<boolean>(path('map.daytime')), (v) => (v === true ? 'day' : 'night')),
      ]),
    );
  },
};
