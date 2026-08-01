/**
 * Elision — **specified, implemented, and off by default** (§5.3).
 *
 * dota2 §6.2 asks the snapshot to elide what did not change between close-together turns. Working
 * that against the retention policy turned it from a formatting choice into a coupling: an elided
 * snapshot is a delta, a delta is only meaningful while its base is still in the model's context
 * window, and the base — a superseded snapshot — is exactly what compaction drops third on its
 * ladder (§7.2). So this is a keyframe-and-delta scheme whose failure is silent, lands in the tier
 * that carries self-state, and depends on our *estimate* of window occupancy being right, which
 * §12 lists as unverified.
 *
 * The switch is `SnapshotContext.elisionBase`: `null` means full render, and `WorkingMemory` returns
 * null unless elision has been explicitly enabled. Turn it on when §12's window-belief
 * reconciliation has been measured — not before.
 *
 * The marker carries its base's clock — `(unchanged since 14:12)`, not a bare `(unchanged)` —
 * because a bare marker is unfalsifiable: the model cannot tell a working chain from a broken one.
 * A model whose base was truncated sees a reference to a time it has no record of, which is at
 * least a question it can ask instead of a claim it cannot check.
 */

import type { Section } from '../render/types.js';
import type { ElisionBase } from './types.js';
import { estimateTokens } from '../render/tokens.js';
import { clockText } from './sections/util.js';

/**
 * The header is never elided.
 *
 * It carries the clock, so it changes every turn anyway — and it is the line that tells the model
 * when "now" is, which is the one thing a delta must never make it look up.
 */
const NEVER_ELIDED: ReadonlySet<string> = new Set(['header']);

/** `items` from `items: diffusal(1), phase`; the id when the line has no label of its own. */
function labelOf(section: Section): string {
  const [head] = section.body.text.split(': ', 1);
  return head !== undefined && head !== '' && !head.includes(' ') ? head : String(section.id);
}

export function elide(sections: readonly Section[], base: ElisionBase | null): readonly Section[] {
  if (base === null) return sections;

  const previous = new Map(base.rendered.sections.map((s) => [String(s.id), s.body.text]));

  return sections.map((section) => {
    if (NEVER_ELIDED.has(String(section.id))) return section;
    if (previous.get(String(section.id)) !== section.body.text) return section;

    const text = `${labelOf(section)}: (unchanged since ${clockText(base.clock)})`;
    // An elision that costs more than the line it replaces is not a saving, and short lines are
    // common — `unseen >20s: ws` is already cheaper than any marker.
    const tokens = estimateTokens(text);
    return tokens >= section.body.tokens ? section : { ...section, body: { text, tokens } };
  });
}
