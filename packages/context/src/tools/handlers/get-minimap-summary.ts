/**
 * `get_minimap_summary` — where everyone was, after asking for a fresh look.
 *
 * The `observe`-class archetype, and the one that shows why the capture path is indirect: this does
 * **not** call the sidecar and get an answer. It asks for a fresh pass and waits for the model to
 * change, so the detections it reports have been through fusion, precedence, the confidence gate
 * and ageing exactly like every other fact (§5.2).
 *
 * It is also the clearest case of §7.2's rule. When the fresh capture times out, the answer is not
 * "I can't see that" — it is the pre-request snapshot with its ages attached. **The request failed;
 * the memory did not.** Reporting unavailable here would be a coach who seems broken while holding
 * a perfectly good four-second-old read of the map.
 */

import type { FieldPath, WorldSnapshot } from '../../common/ports.js';
import type { HeroId, Observed, RegionId } from '../types.js';
import { compose, field } from '../render.js';
import { NO_ARGS } from '../codec.js';
import { defineTool } from '../registry.js';
import { ok } from '../failures.js';

export interface MinimapSummary {
  readonly positions: readonly { readonly hero: HeroId; readonly area: Observed<string> }[];
  readonly unseen: readonly HeroId[];
  /** True when the fresh pass did not land in time and this is remembered, not current (§7.2). */
  readonly fromMemory: boolean;
}

const MINIMAP = 'minimap' as RegionId;
const UNSEEN_AFTER_SECONDS = 20;

export const getMinimapSummary = defineTool({
  name: 'get_minimap_summary',
  effect: 'observe',
  summary:
    'Where enemy heroes were last seen on the minimap, and who has not been visible recently. ' +
    'Asks for a fresh look at the map first.',
  args: NO_ARGS,
  needs: ['world', 'capture'],

  handler: async (_a, ctx) => {
    const before = ctx.ports.world.snapshot(ctx.now);
    const fresh = await ctx.ports.fresh.request(
      MINIMAP,
      Math.max(0, ctx.deadlineAt - ctx.now),
      ctx.scope.signal,
    );

    // A cancelled turn is the one case that does not degrade to memory: the conversation item this
    // would answer no longer exists, so there is nothing to answer honestly *with* (§6.5).
    if (!fresh.ok && fresh.failure.code === 'cancelled') return fresh;

    const snapshot = fresh.ok ? fresh.value : before;
    return ok(summarise(snapshot, !fresh.ok));
  },

  renderer: {
    render(value: MinimapSummary, ctx) {
      const positions = value.positions
        .map(({ hero, area }) => field(String(hero), area, ctx))
        .filter((text): text is string => text !== null);

      return compose(
        [
          {
            id: 'stale',
            priority: 95,
            // Said plainly rather than hedged into every line: one marker costs three tokens, and
            // repeating "not fresh" per hero costs thirty.
            text: value.fromMemory ? 'no fresh look — last known:' : null,
          },
          {
            id: 'positions',
            priority: 90,
            droppable: false,
            text: positions.length === 0 ? null : positions.join(', '),
          },
          {
            id: 'unseen',
            priority: 60,
            text:
              value.unseen.length === 0
                ? null
                : `unseen >${String(UNSEEN_AFTER_SECONDS)}s: ${value.unseen.map(String).join(', ')}`,
          },
        ],
        ctx,
      );
    },
  },
});

function summarise(snapshot: WorldSnapshot, fromMemory: boolean): MinimapSummary {
  const unseen = new Set(snapshot.unseenFor(UNSEEN_AFTER_SECONDS).map(String));

  const positions = snapshot.roster().enemies.flatMap((hero) => {
    if (unseen.has(String(hero))) return [];
    const area = snapshot.get<string>(`enemies.${String(hero)}.area` as FieldPath);
    return area === undefined ? [] : [{ hero, area }];
  });

  return {
    positions,
    unseen: snapshot.unseenFor(UNSEEN_AFTER_SECONDS),
    fromMemory,
  };
}
