/**
 * Where the rest of Riki is allowed to be mentioned.
 *
 * The interaction machine has never heard of `response.audio.done` or
 * `conversation.item.truncate`; it has heard of `turn.responseEnded` and `voice.interrupt`. These
 * adapters hold the translation, so when the Realtime API's event names change — and
 * openai-realtime-research.md §3 documents that they already did once, silently — the diff is
 * confined to one file with a table in it.
 *
 * See docs/design/overlay-architecture.md §5.6 and §8.
 *
 * The placeholder handle types this file used to declare are gone: `@riki/realtime` and
 * `@riki/events` both exist now, and the seam is expressed in their vocabulary. `voice.ts` is the
 * `VoiceBridge` implementation; `PolicyBridge` has no implementation and does not need one — see
 * the note on it below.
 */

import type { VoiceCommand as RealtimeVoiceCommand, VoiceEvent } from '@riki/realtime';
import type { Unsubscribe } from '../../shared/overlay.js';
import type { MachineEnvironment, MachineInput } from '../session/types.js';
import type { VoiceCommandSink } from '../session/contracts.js';

/** Anything that emits the vendor-free event stream: a `RealtimeSession`, or a stand-in. */
export interface VoiceEventSource {
  onEvent(listener: (event: VoiceEvent) => void): Unsubscribe;
}

/** The other direction: `interrupt` (barge-in → truncate) and `abort`. */
export interface VoiceCommandTarget {
  send(command: RealtimeVoiceCommand): void;
}

/**
 * What the machine's current phase is, read at the moment an event arrives.
 *
 * The bridge needs it for exactly one decision — `responseStarted` while Idle is *unprompted*
 * speech and takes a different machine input (§9.3) — and giving it a reader rather than the whole
 * runtime keeps that the only thing it can do.
 */
export interface PhaseReader {
  phase(): string;
}

export interface VoiceBridge {
  attach(source: VoiceEventSource, sink: (input: MachineInput) => void): Unsubscribe;
  /** Machine effects become calls on the session. */
  commands(target: VoiceCommandTarget): VoiceCommandSink;
}

/**
 * ⚠ **No implementation, deliberately.**
 *
 * overlay-architecture.md §8 has `@riki/events` reaching the overlay through a `PolicyBridge`
 * carrying `unprompted.speechStarted`. Under ADR-0023 that is not how it happens: the trigger
 * policy hands a `CoachEvent` to the composition root, which opens a turn and hands *that* to the
 * session, and the chip appears when the session starts speaking. So the unprompted edge arrives
 * over `VoiceBridge` like every other turn edge, and a second path from `packages/events` straight
 * to the chip would be a way for the chip to claim Riki is speaking when nothing is.
 *
 * The type is kept because the overlay document still names it and a reader who goes looking
 * should find the answer rather than an absence.
 */
export interface PolicyBridge {
  attach(policy: unknown, sink: (input: MachineInput) => void): Unsubscribe;
}

export interface SettingsBridge {
  current(): MachineEnvironment;
  watch(sink: (env: MachineEnvironment) => void): Unsubscribe;
}
