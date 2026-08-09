/**
 * What the turn agent needs from the rest of the process, as ports.
 *
 * The composition root is the one place allowed to know about every package at once, and taking its
 * collaborators by injection rather than constructing them is what keeps that privilege from
 * turning into an untestable knot: every behaviour in `index.ts` is asserted against a fake session
 * and a hand-built world, with no Electron and no network.
 *
 * `VoiceSessionPort` is deliberately narrower than `@riki/realtime`'s `RealtimeSession`. The agent
 * needs to open a turn, end it, abort, and hear the vendor-free event stream; it has no business
 * reaching the transport, the window executor or the cost meter, and a port it cannot reach is a
 * coupling nobody has to remember not to add.
 *
 * ## What used to be here
 *
 * A `CoachDriver` — one port over two coaches, with `onProposal`, `onDeclined` and four switches
 * (`setQuietMode`, `setAgentSpeaking`, `setPlayerSpeaking`, `setMuted`). ADR-0042 deleted both
 * coaches, and with them the question those switches answered. `agent_speaking` is the one worth a
 * sentence, because deleting it looks like deleting a safety property: it existed to stop a coaching
 * trigger landing on top of a turn already speaking, and with no triggers nothing can land on
 * anything — every turn has a key press behind it, and barge-in is handled in `packages/realtime` by
 * truncation. The gate was solving a problem the trigger engine created.
 *
 * See docs/design/conversational-architecture.md §7.
 */

import type { RenderedSnapshot, TurnId } from '@riki/context';
import type { CaptureMode, TurnEndReason, VoiceEvent } from '@riki/realtime';
import type { Clock, MonoMs } from '@riki/world-model';

/**
 * What the session is handed for a turn.
 *
 * `@riki/realtime`'s `TurnContext` is a structural mirror of this, and it carries one text field
 * because that package puts the rendered text on the wire and never inspects it.
 */
export interface SessionTurn {
  readonly turnId: TurnId;
  readonly snapshotText: string;
}

/** The world as text, for one turn. */
export interface SnapshotSource {
  render(turnId: TurnId, now: MonoMs): RenderedSnapshot;
}

export interface VoiceSessionPort {
  /**
   * Create a response with no capture behind it.
   *
   * **The product has no path to this.** Riki answers when spoken to; it does not decide to speak
   * (ADR-0042). What keeps the method is the inspector's `scenario.speak` (ADR-0039), which is the
   * only way to exercise the voice leg — mint, negotiate, `session.update`, response, audio out —
   * without a microphone or a game, and it earned its place the morning a mint returned an unusable
   * session id and nothing anywhere said so.
   *
   * The interaction machine has no entry for it, so the chip stays hidden while it plays. That is
   * the honest consequence of removing the unprompted path rather than an oversight, and it is the
   * reason this is reachable only under `config.debug.enabled`.
   */
  speakNow(turn: SessionTurn): Promise<void>;
  /** Push-to-talk. Synchronous, because nothing on the trigger path may await. */
  beginTurn(mode: CaptureMode, now: MonoMs): TurnId;
  endTurn(turnId: TurnId, reason: TurnEndReason, turn: SessionTurn): Promise<void>;
  /** `Esc`, or a local `stop`. */
  abort(): Promise<void>;
  onEvent(listener: (event: VoiceEvent) => void): () => void;
}

/**
 * `console.*` is confined to `packages/telemetry`, so this is a port. It carries no transcript and
 * no rendered text: what is interesting here is *counts*, and the golden corpus is where output is
 * inspected.
 */
export interface AgentTelemetry {
  /**
   * A player turn was submitted, and how much of the world went with it.
   *
   * Tokens rather than characters, because the number that matters is the one competing for the
   * conversation window — and because a token count cannot carry a word the player said.
   */
  playerTurn(turnId: string, snapshotTokens: number): void;
  /**
   * The snapshot rendered nothing at all.
   *
   * Not a reason to stay quiet — the player asked, and a model that has to say "I cannot see the
   * game yet" is giving a true answer. It is a signal that the world model is empty when it should
   * not be, which before a match starts is ordinary and thirty minutes in is a fault.
   */
  emptySnapshot(turnId: string): void;
  /** Sections the budget or the confidence gate left out. Names only; never rendered text. */
  snapshotOmitted?(turnId: string, omitted: readonly string[]): void;
}

export interface TurnAgentDeps {
  readonly snapshot: SnapshotSource;
  readonly session: VoiceSessionPort;
  readonly clock: Clock;
  readonly telemetry?: AgentTelemetry;
}

export interface TurnAgent {
  /**
   * A push-to-talk press. Synchronous and returns the turn id, because the overlay's ≤100 ms budget
   * forbids an `await` between the key press and the window being shown.
   */
  beginPlayerTurn(mode: CaptureMode): TurnId;
  /** The release. This is where the turn's snapshot is rendered and injected. */
  endPlayerTurn(turnId: TurnId, reason: TurnEndReason): Promise<void>;
}
