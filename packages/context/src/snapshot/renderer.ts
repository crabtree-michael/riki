/**
 * Tier 2 — the ~300-token snapshot, rendered per turn.
 *
 * Four steps, and the order matters: build every section, apply the cause's one promotion, compose
 * under the budget, then **expand what was dropped to its closure and re-compose**. That last step
 * is the one that looks redundant and is not — the composer drops sections one at a time by
 * priority, so it can perfectly well drop `unseen` and keep `seen`, which §5.2 says is worse than
 * dropping both. Closure is applied after composition rather than before because what gets dropped
 * is not knowable until the budget has been measured against the text.
 *
 * The loop terminates: each pass drops at least one more section than the last, and the section set
 * is finite. In practice it runs once, or twice when a pair is involved.
 *
 * See docs/design/context-and-memory-architecture.md §5.
 */

import type { WorldSnapshot } from '../common/ports.js';
import type { Section, SectionId } from '../render/types.js';
import type { PriorityLadder, SectionSource, SnapshotRenderer } from './contracts.js';
import type { RenderedSnapshot, SnapshotContext, SnapshotSectionId } from './types.js';
import { createSectionComposer } from '../render/compose.js';
import { estimateTokens } from '../render/tokens.js';
import { ALL_SECTIONS } from './sections/index.js';
import { createPriorityLadder, promoted } from './ladder.js';
import { elide } from './elision.js';

export interface SnapshotRendererOptions {
  readonly sources?: readonly SectionSource[];
  readonly ladder?: PriorityLadder;
}

const composer = createSectionComposer();

export function createSnapshotRenderer(options: SnapshotRendererOptions = {}): SnapshotRenderer {
  const sources = options.sources ?? ALL_SECTIONS;
  const ladder = options.ladder ?? createPriorityLadder();

  return {
    render(world: WorldSnapshot, ctx: SnapshotContext): RenderedSnapshot {
      const entries = promoted(
        ladder.entries,
        ctx.cause.by === 'trigger' ? ladder.promote(ctx.cause.event) : null,
        ladder,
      );
      const rung = new Map(entries.map((entry) => [entry.id, entry]));

      // A source that produces nothing is a section that is *absent*, not empty, and it is recorded
      // in `omitted` for the same reason a budgeted drop is: the golden corpus should show which of
      // the two happened.
      const built: Section[] = [];
      const missing: SectionId[] = [];

      for (const source of sources) {
        const entry = rung.get(source.id);
        const section = source.build(world, ctx);
        if (section === null || entry === undefined) {
          missing.push(source.id as unknown as SectionId);
          continue;
        }
        built.push({ ...section, priority: entry.priority, droppable: entry.droppable });
      }

      const elided = elide(built, ctx.elisionBase);

      let candidates = elided;
      let composed = composer.compose(candidates, ctx.budget);

      for (;;) {
        const wanted = new Set(
          ladder.closure(composed.omitted.map((id) => String(id) as SnapshotSectionId)),
        );
        const next = candidates.filter(
          (section) => !wanted.has(String(section.id) as SnapshotSectionId),
        );
        if (next.length === candidates.length) break;
        candidates = next;
        composed = composer.compose(candidates, ctx.budget);
      }

      // `omitted` is everything the model did not get, whatever the reason. A caller reconciling a
      // fixture against a live render should not have to know whether the world model was silent or
      // the budget was tight — only that the line is not there.
      const droppedByClosure = elided
        .filter((section) => !candidates.includes(section))
        .map((section) => section.id);

      return {
        turnId: ctx.turnId,
        text: composed.text,
        tokens: composed.tokens,
        sections: candidates,
        truncated: composed.truncated,
        omitted: [...missing, ...new Set([...droppedByClosure, ...composed.omitted])],
      };
    },
  };
}

/** What an empty world renders to, so a caller can assert "never an empty string" cheaply. */
export function isEmpty(rendered: RenderedSnapshot): boolean {
  return estimateTokens(rendered.text) === 0;
}
