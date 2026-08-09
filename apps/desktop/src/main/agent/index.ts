/**
 * The composition root for a turn: `@riki/world-model` → `@riki/context` → `@riki/realtime`.
 *
 * One path, where there used to be three:
 *
 * ```
 *   push-to-talk down ──► session.beginTurn                        ← the gesture
 *   push-to-talk up   ──► render snapshot ──► session.endTurn      ← the question
 * ```
 *
 * The two that are gone are the proactive one — `driver.onProposal` opening a turn nobody asked for
 * — and the routing table that fed the trigger engine's four switches from the voice event stream.
 * ADR-0042 deleted the engine; `contracts.ts` argues why the switches went with it rather than being
 * kept as a safety net.
 *
 * What is left is small enough to state completely: **a player turn is a snapshot and a release.**
 * The snapshot is rendered at the moment the key comes up rather than when it goes down, which is
 * the one timing decision in this file — a question takes a second or two to ask, and the world
 * moves in that time. Rendering early would answer against the game as it was before the player
 * finished describing it.
 *
 * **An empty snapshot is still a turn.** The old rule was the opposite ("an empty brief is a turn
 * that does not happen", coaching-architecture.md §6.5) and it was right for a coach that spoke
 * unprompted: with nothing rendered there was nothing to say, and a model handed an empty brief
 * invents. It inverts here for the same reason it held there. The player asked. A model that
 * answers "I cannot see the game yet" is telling the truth, and silence in response to a question
 * is indistinguishable from a broken hotkey.
 *
 * See docs/design/conversational-architecture.md §3.
 */

import type { TurnId } from '@riki/context';
import type { CaptureMode, TurnEndReason } from '@riki/realtime';
import type { SessionTurn, TurnAgent, TurnAgentDeps } from './contracts.js';

export function createTurnAgent(deps: TurnAgentDeps): TurnAgent {
  const { snapshot, session, clock, telemetry } = deps;

  /**
   * The world as text, for one turn, plus the telemetry that says what the model was not shown.
   *
   * Nothing here can reach a network and nothing here awaits: the snapshot is a pure function of a
   * world snapshot, which is what keeps a turn from needing a watchdog.
   */
  function textFor(turnId: TurnId): string {
    const rendered = snapshot.render(turnId, clock.now());
    if (rendered.text === '') telemetry?.emptySnapshot(String(turnId));
    if (rendered.omitted.length > 0) {
      telemetry?.snapshotOmitted?.(String(turnId), rendered.omitted.map(String));
    }
    telemetry?.playerTurn(String(turnId), rendered.tokens);
    return rendered.text;
  }

  return {
    beginPlayerTurn(mode: CaptureMode): TurnId {
      return session.beginTurn(mode, clock.now());
    },

    async endPlayerTurn(turnId: TurnId, reason: TurnEndReason): Promise<void> {
      // A cancelled gesture is not a question: nothing is rendered, nothing is injected, and the
      // session is told so it can drop whatever it has buffered.
      const injected: SessionTurn = {
        turnId,
        snapshotText: reason === 'cancel' ? '' : textFor(turnId),
      };
      await session.endTurn(turnId, reason, injected);
    },
  };
}

export * from './contracts.js';
export { createSnapshotSource, SNAPSHOT_TOKENS } from './snapshot.js';
export type { SnapshotSourceDeps } from './snapshot.js';
export { toContextReader, toContextSnapshot, observedFrom } from './world-view.js';
export type { WorldViewOptions } from './world-view.js';
export { createWorldToolDispatcher } from './tools.js';
export type { WorldToolDeps } from './tools.js';
