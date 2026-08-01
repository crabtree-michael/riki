/**
 * `get_recent_events` — what changed lately.
 *
 * **This is the command the privacy gate exists for.** It walks the world model's delta history,
 * and that history contains chat: other players' words, tagged `sensitive` at the source by the log
 * tailer (state-capture §4.2). Everything else in this file is ordinary; the `allowedByPrivacy`
 * call is the second of the two independent gates that keep those words off a third-party API, and
 * dota2 §7's ⚠ row is exactly this path.
 *
 * The default is off, and `tools.egress.test.ts` asserts it against a snapshot that contains chat
 * rather than trusting the flag.
 */

import type { FieldChange } from '../../common/ports.js';
import type { GameClock } from '../types.js';
import { allowedByPrivacy, compose, field, redactText } from '../render.js';
import { defineArgs } from '../codec.js';
import { defineTool } from '../registry.js';
import { ok } from '../failures.js';

const args = defineArgs({
  since_seconds: {
    kind: 'integer',
    description: 'How far back to look, in seconds of game time. Defaults to 30.',
    min: 1,
    max: 300,
    optional: true,
  },
});

export interface RecentEvents {
  readonly sinceSeconds: number;
  readonly changes: readonly FieldChange[];
}

/** Newest first, and capped before rendering: the budget is a ceiling, not a truncation strategy. */
const MAX_EVENTS = 8;

export const getRecentEvents = defineTool({
  name: 'get_recent_events',
  effect: 'model',
  summary:
    'What has changed in the match over the last few seconds — deaths, item pickups, objectives. ' +
    'Ask when you need to know what just happened.',
  args,
  needs: ['world'],
  limits: { maxResultTokens: 200 },

  handler: (a, ctx) => {
    const snapshot = ctx.ports.world.snapshot(ctx.now);
    const sinceSeconds = a.since_seconds ?? 30;
    const since = ((snapshot.clock ?? 0) - sinceSeconds) as GameClock;

    // No privacy filtering here, deliberately: §4.6 makes the policy a *render* input, and a
    // handler that pre-filtered would put the gate in eight places and give the renderer a partial
    // list it could not reason about. The handler's job is to say what changed; deciding what may
    // be spoken is one function, in one place, below.
    const changes = ctx.ports.world
      .history(since)
      .flatMap((delta) => delta.changes)
      .slice(-MAX_EVENTS)
      .reverse();

    return Promise.resolve(ok<RecentEvents>({ sinceSeconds, changes }));
  },

  renderer: {
    render(value: RecentEvents, ctx) {
      const parts = value.changes.map((change, index) => ({
        id: String(change.path),
        // Newest first, so the oldest event is the first thing a tight budget drops.
        priority: value.changes.length - index,
        text: (() => {
          if (!allowedByPrivacy(change.path, ctx.privacy)) return null;
          const rendered = field(String(change.path), change.after, ctx, (v) =>
            typeof v === 'string' ? redactText(v, ctx.privacy) : String(v),
          );
          return rendered;
        })(),
      }));

      return compose(
        parts.length === 0
          ? [{ id: 'none', priority: 100, droppable: false, text: 'nothing notable' }]
          : parts,
        ctx,
      );
    },
  },
});
