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
 * The placeholder handle types this file used to declare are gone: `@riki/realtime` exists and the
 * seam is expressed in its vocabulary. `voice.ts` is the `VoiceBridge` implementation.
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

export interface VoiceBridge {
  attach(source: VoiceEventSource, sink: (input: MachineInput) => void): Unsubscribe;
  /** Machine effects become calls on the session. */
  commands(target: VoiceCommandTarget): VoiceCommandSink;
}

/**
 * The bridge used to take a `PhaseReader` as well, for one decision: `responseStarted` while Idle
 * was unprompted speech and took a different machine input. ADR-0042 removed the input, and with it
 * the only reason this file knew what phase the machine was in.
 *
 * `PolicyBridge` went the same way. overlay-architecture.md §8 had `@riki/events` reaching the
 * overlay through one, carrying `unprompted.speechStarted`; there is no `packages/events` to reach
 * from and no unprompted edge to carry.
 */
export interface SettingsBridge {
  current(): MachineEnvironment;
  watch(sink: (env: MachineEnvironment) => void): Unsubscribe;
}
