/**
 * The world, as the ~300 tokens of text a turn is answered from.
 *
 * One object, built once for the app rather than once per match, and the only thing between
 * `@riki/world-model` and the model's ears. It is the whole of what survived the coaching root:
 * `ContextAssembler` used to sit here holding a conversation ledger, a coaching memory, a brief
 * planner and a per-match preamble, and ADR-0042 deleted all four. What is left is a pure function
 * of a world snapshot, which is why it needs no match to exist inside.
 *
 * ## What it is not
 *
 * It is **not** the tool surface. conversational-architecture.md §4 has the model reaching the world
 * through five named tools rather than one blob of pre-rendered text, and §10 notes that a short
 * vitals block at turn start may still be worth pre-injecting so a trivial question needs no round
 * trip. This is that blob, kept working while the tools are built (T2–T4) — not a design that
 * competes with them.
 */

import type {
  PrivacyPolicy,
  RenderedSnapshot,
  SnapshotRenderer,
  TurnId,
  WorldModelReader,
} from '@riki/context';
import { DEFAULT_PRIVACY, createSnapshotRenderer } from '@riki/context';
import type { MonoMs } from '@riki/world-model';

import type { SnapshotSource } from './contracts.js';

/**
 * The per-turn ceiling *(tunable: 400, dota2 §6.2's upper bound)*.
 *
 * It lands in the Realtime conversation window, where it is billed as input on every later turn, so
 * this is a budget rather than a target — the ladder in `packages/context` decides what a tight one
 * eats and records it.
 */
export const SNAPSHOT_TOKENS = 400;

export interface SnapshotSourceDeps {
  /** Already projected — `toContextReader(state.world, { staleness })`. */
  readonly world: WorldModelReader;
  /** From config. Defaults to the closed-by-default policy (REPO_SKELETON.md §7.2). */
  readonly privacy?: PrivacyPolicy;
  readonly maxTokens?: number;
  readonly renderer?: SnapshotRenderer;
}

export function createSnapshotSource(deps: SnapshotSourceDeps): SnapshotSource {
  const renderer = deps.renderer ?? createSnapshotRenderer();
  const privacy = deps.privacy ?? DEFAULT_PRIVACY;
  const maxTokens = deps.maxTokens ?? SNAPSHOT_TOKENS;

  return {
    render(turnId: TurnId, now: MonoMs): RenderedSnapshot {
      return renderer.render(deps.world.snapshot(now), {
        turnId,
        now,
        // Every turn has a key press behind it now, so this is the only cause there is. The
        // renderer used to promote a section based on which trigger fired; ADR-0042 removed the
        // triggers and the promotion with them, so two turns against one world render identically.
        cause: { by: 'player', gesture: 'push_to_talk' },
        budget: { maxTokens, spentTokens: 0 },
        privacy,
      });
    },
  };
}
