/**
 * The voice bridge's decode side, and the constructors that stamp `v`.
 *
 * The sidecar's `codec.ts` frames lines over a pipe; this one has no framing to do — Electron's
 * IPC hands both sides a structured-clone of an object, so what is left is the two things that
 * survive from that file's contract:
 *
 * - **Version before content.** `v` and `type` are read out first, so a message from a mismatched
 *   build produces "it speaks v2, we speak v1" rather than a zod error about a field nobody has
 *   heard of.
 * - **Nothing throws on input.** A malformed message is a value. A throw inside an `ipcRenderer.on`
 *   handler is an unhandled rejection in a renderer that has no console anyone is watching, and the
 *   symptom is a voice session that stops responding with no error anywhere.
 *
 * ## Why validate at all when both sides are the same build
 *
 * Main and the voice renderer ship in one asar, so a version mismatch here is nearly impossible and
 * the version field is close to ceremony. What is *not* ceremony is the parse: it is the only thing
 * standing between a shape change on one side and a silent misread on the other, and this bridge
 * carries the session config — where a wrong shape does not error, it misconfigures the session
 * (the beta-schema trap, one layer up). Cheap, and it fails where the mistake is.
 */

import { z } from 'zod';
import { PROTOCOL_VERSION } from './version.js';
import {
  VoiceDirective as VoiceDirectiveSchema,
  VoiceUpdate as VoiceUpdateSchema,
  type VoiceDirective,
  type VoiceUpdate,
} from './schemas/voice.js';

/** Parsed loosely on purpose — it has to succeed against a version we do not otherwise read. */
const Envelope = z.object({ v: z.number(), type: z.string() });

export type Decoded<T> =
  | { readonly ok: true; readonly message: T }
  | { readonly ok: false; readonly reason: 'malformed'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'version'; readonly theirs: number };

function decode<T>(raw: unknown, schema: z.ZodType<T>): Decoded<T> {
  const envelope = Envelope.safeParse(raw);
  if (!envelope.success) {
    return { ok: false, reason: 'malformed', detail: 'no { v, type } envelope' };
  }
  if (envelope.data.v !== PROTOCOL_VERSION) {
    return { ok: false, reason: 'version', theirs: envelope.data.v };
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    // Same version, unreadable content. Naming the `type` is what makes this actionable at all —
    // without it a log line says only that some field somewhere was the wrong shape.
    return {
      ok: false,
      reason: 'malformed',
      detail: `${envelope.data.type}: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
    };
  }
  return { ok: true, message: parsed.data };
}

/** Read a message main sent. Called in the voice renderer. */
export function decodeVoiceDirective(raw: unknown): Decoded<VoiceDirective> {
  return decode(raw, VoiceDirectiveSchema);
}

/** Read a message the voice renderer sent. Called in main. */
export function decodeVoiceUpdate(raw: unknown): Decoded<VoiceUpdate> {
  return decode(raw, VoiceUpdateSchema);
}

/**
 * Constructors, so `v` cannot be forgotten.
 *
 * Not because `{ v: 1, type: 'voice.command', command: 'abort' }` is hard to write, but because a
 * message missing `v` is reported as malformed by the other side and dropped — which on this
 * bridge means an `Esc` that does nothing, once, with no error.
 */
export const voice = {
  sessionOpen(
    fields: Omit<Extract<VoiceDirective, { type: 'voice.session.open' }>, 'v' | 'type'>,
  ): VoiceDirective {
    return { v: PROTOCOL_VERSION, type: 'voice.session.open', ...fields };
  },
  sessionClose(reason: string): VoiceDirective {
    return { v: PROTOCOL_VERSION, type: 'voice.session.close', reason };
  },
  credential(
    secret: Extract<VoiceDirective, { type: 'voice.credential' }>['secret'],
  ): VoiceDirective {
    return { v: PROTOCOL_VERSION, type: 'voice.credential', secret };
  },
  turnBegin(turnId: string, mode: 'push' | 'latch'): VoiceDirective {
    return { v: PROTOCOL_VERSION, type: 'voice.turn.begin', turnId, mode };
  },
  turnEnd(
    turnId: string,
    reason: Extract<VoiceDirective, { type: 'voice.turn.end' }>['reason'],
    snapshotText: string,
  ): VoiceDirective {
    return { v: PROTOCOL_VERSION, type: 'voice.turn.end', turnId, reason, snapshotText };
  },
  turnSpeak(
    turnId: string,
    snapshotText: string,
    eventId: string,
    salience: number,
  ): VoiceDirective {
    return {
      v: PROTOCOL_VERSION,
      type: 'voice.turn.speak',
      turnId,
      snapshotText,
      eventId,
      salience,
    };
  },
  command(command: 'interrupt' | 'abort'): VoiceDirective {
    return { v: PROTOCOL_VERSION, type: 'voice.command', command };
  },
  windowApply(
    plan: Extract<VoiceDirective, { type: 'voice.window.apply' }>['plan'],
  ): VoiceDirective {
    return { v: PROTOCOL_VERSION, type: 'voice.window.apply', plan };
  },
  levelEnable(enabled: boolean): VoiceDirective {
    return { v: PROTOCOL_VERSION, type: 'voice.level.enable', enabled };
  },
} as const;

/** The renderer's half of the same. */
export const voiceUpdates = {
  ready(): VoiceUpdate {
    return {
      v: PROTOCOL_VERSION,
      type: 'voice.ready',
      rendererProtocolVersion: PROTOCOL_VERSION,
    };
  },
  event(event: Extract<VoiceUpdate, { type: 'voice.event' }>['event']): VoiceUpdate {
    return { v: PROTOCOL_VERSION, type: 'voice.event', event };
  },
  sessionState(
    state: Extract<VoiceUpdate, { type: 'voice.session.state' }>['state'],
    fault: Extract<VoiceUpdate, { type: 'voice.session.state' }>['fault'] = null,
  ): VoiceUpdate {
    return { v: PROTOCOL_VERSION, type: 'voice.session.state', state, fault };
  },
  windowApplied(
    applied: Extract<VoiceUpdate, { type: 'voice.window.applied' }>['applied'],
  ): VoiceUpdate {
    return { v: PROTOCOL_VERSION, type: 'voice.window.applied', applied };
  },
} as const;
