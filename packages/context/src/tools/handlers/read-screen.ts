/**
 * `read_screen` — the only command that can do something a player would not expect.
 *
 * The sole member of the `consequential` class, and it will stay that way while ADR-0003 holds. The
 * class exists rather than a special case so that consent, the activity indicator and the rate
 * limit are properties of a *category*: if a second consequential command is ever proposed, "does
 * it need consent?" is already answered structurally (§3.2).
 *
 * Three things are load-bearing here and none of them are in the happy path:
 *
 * - **Consent was already obtained**, at admission, before this ran (§4.4). A handler that asked
 *   for consent itself would put the prompt after the rate check had passed and after a queue slot
 *   had been taken, which is a prompt the player might see for a command that was refused anyway.
 * - **`begin()` is separate from the prompt.** dota2 §7 asks for an unmistakable indicator *while*
 *   capture is happening, and a prompt that disappears on `Y` is not one. The activity handle drives
 *   the overlay's Acting state, so the indicator can neither outlive nor under-live the capture.
 * - **The handle is ended on every path**, including barge-in. An indicator left up after a
 *   cancelled turn is a UI that says Riki is looking at your screen when it is not.
 *
 * ⚠ The pixels' destination is not modelled. §0 C1 describes `read_screen` as sending pixels to a
 * VLM, but §5 declares four ports and none of them is that egress. What is implemented here is the
 * capture half — consent, indicator, rate, a fresh pass, and reading the result back out of the
 * world model like every other observation. Whoever adds the VLM adds a fifth port and an egress
 * test alongside it; see the report and §15.
 */

import type { ActivityHandle } from '../types.js';
import type { RegionId } from '../types.js';
import { compose } from '../render.js';
import { defineArgs } from '../codec.js';
import { defineTool } from '../registry.js';
import { failure, ok } from '../failures.js';
import type { FieldPath } from '../../common/ports.js';

const args = defineArgs({
  region: {
    kind: 'region',
    description:
      'Which part of the screen to look at: minimap, scoreboard, shop, hud, inventory, killfeed.',
  },
});

export interface ScreenRead {
  readonly region: RegionId;
  readonly lines: readonly string[];
}

export const readScreen = defineTool({
  name: 'read_screen',
  effect: 'consequential',
  summary:
    'Take a fresh look at one part of the screen. Asks the player first, every time. Use only ' +
    'when nothing else can answer.',
  args,
  needs: ['world', 'capture', 'consent'],

  handler: async (a, ctx) => {
    const region = a.region as RegionId;

    let activity: ActivityHandle | undefined;
    try {
      activity = ctx.ports.consent.begin({ callId: ctx.callId, kind: 'read_screen', region });
      const fresh = await ctx.ports.fresh.request(
        region,
        Math.max(0, ctx.deadlineAt - ctx.now),
        ctx.scope.signal,
      );
      if (!fresh.ok) return fresh;

      const text = fresh.value.get<readonly string[]>(`screen.${String(region)}` as FieldPath);
      if (text === undefined) {
        return failure('unavailable', { detail: `nothing observed for ${String(region)}` });
      }
      return ok<ScreenRead>({ region, lines: [...text.value] });
    } finally {
      // Ended here rather than after the outcome is inspected, so the indicator comes down on the
      // cancelled and failed paths too.
      activity?.end();
    }
  },

  renderer: {
    render(value: ScreenRead, ctx) {
      return compose(
        value.lines.length === 0
          ? [
              {
                id: 'empty',
                priority: 100,
                droppable: false,
                text: `nothing readable on the ${String(value.region)}`,
              },
            ]
          : value.lines.map((line, index) => ({
              id: `line${String(index)}`,
              priority: value.lines.length - index,
              text: line,
            })),
        ctx,
      );
    },
  },
});
