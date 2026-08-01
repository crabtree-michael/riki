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
 * Declarations only. The handle types below are placeholders: each becomes an import from its
 * package once that package exists (@riki/realtime is step 7, @riki/events follows
 * packages/context). They are declared structurally here so this file states the seam without
 * reaching into someone else's directory.
 */

import type { Unsubscribe } from '../../shared/overlay.js';
import type { MachineEnvironment, MachineInput } from '../session/types.js';
import type { VoiceCommandSink } from '../session/contracts.js';

/** Placeholder for the session handle @riki/realtime will expose. */
export interface RealtimeSessionHandle {
  readonly sessionId: string;
}

/** Placeholder for the trigger-policy handle @riki/events will expose (dota2 §6.4). */
export interface TriggerPolicyHandle {
  readonly enabled: boolean;
}

export interface VoiceBridge {
  attach(session: RealtimeSessionHandle, sink: (input: MachineInput) => void): Unsubscribe;
  /** The other direction: machine effects become calls on the session. */
  commands(session: RealtimeSessionHandle): VoiceCommandSink;
}

export interface PolicyBridge {
  attach(policy: TriggerPolicyHandle, sink: (input: MachineInput) => void): Unsubscribe;
}

export interface SettingsBridge {
  current(): MachineEnvironment;
  watch(sink: (env: MachineEnvironment) => void): Unsubscribe;
}
