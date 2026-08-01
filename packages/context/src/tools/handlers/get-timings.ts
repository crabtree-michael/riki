/**
 * `get_timings` — the clocks a coach actually tracks.
 *
 * Roshan's window, the player's own respawn and buyback, and day/night. All of it is already in the
 * model, none of it is computed here: a timing derived in a handler would be a derived rule in the
 * wrong package, invisible to fusion's provenance and confidence (§14).
 */

import type { FieldPath } from '../../common/ports.js';
import type { Observed } from '../types.js';
import { clockText, compose, duration, field } from '../render.js';
import { NO_ARGS } from '../codec.js';
import { defineTool } from '../registry.js';
import { ok } from '../failures.js';

export interface Timings {
  readonly clock: string;
  readonly roshan?: Observed<string>;
  readonly respawnIn?: Observed<number>;
  readonly buybackCost?: Observed<number>;
  readonly daytime?: Observed<boolean>;
}

export const getTimings = defineTool({
  name: 'get_timings',
  effect: 'model',
  summary:
    "The timers that matter right now: game clock, Roshan status, the player's respawn and " +
    'buyback, and whether it is day or night.',
  args: NO_ARGS,
  needs: ['world'],
  limits: { maxResultTokens: 120 },

  handler: (_a, ctx) => {
    const snapshot = ctx.ports.world.snapshot(ctx.now);
    const path = (p: string): FieldPath => p as FieldPath;

    const roshan = snapshot.get<string>(path('map.roshanState'));
    const respawnIn = snapshot.get<number>(path('self.respawnIn'));
    const buyback = snapshot.get<{ readonly cost: number }>(path('self.buyback'));
    const daytime = snapshot.get<boolean>(path('map.daytime'));

    return Promise.resolve(
      ok<Timings>({
        clock: clockText(snapshot.clock),
        ...(roshan === undefined ? {} : { roshan }),
        ...(respawnIn === undefined ? {} : { respawnIn }),
        ...(buyback === undefined
          ? {}
          : { buybackCost: { ...buyback, value: buyback.value.cost } }),
        ...(daytime === undefined ? {} : { daytime }),
      }),
    );
  },

  renderer: {
    render(value: Timings, ctx) {
      return compose(
        [
          { id: 'clock', priority: 100, droppable: false, text: value.clock },
          { id: 'roshan', priority: 90, text: field('rosh', value.roshan, ctx) },
          {
            id: 'respawn',
            priority: 80,
            text: field('respawn', value.respawnIn, ctx, (v) => duration(Number(v))),
          },
          {
            id: 'buyback',
            priority: 60,
            text: field('buyback', value.buybackCost, ctx, (v) => `${String(v)}g`),
          },
          {
            id: 'daytime',
            priority: 50,
            text: field('', value.daytime, ctx, (v) => (v === true ? 'day' : 'night')),
          },
        ],
        ctx,
      );
    },
  },
});
