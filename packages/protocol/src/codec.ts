/**
 * Lines in, lines out — the TypeScript half of the sidecar transport.
 *
 * The mirror of `crates/riki-ipc/src/transport.rs`, and it makes the same two promises:
 *
 * - **Version before content.** {@link decodeSidecarEvent} reads `v` and `type` out of the line
 *   before attempting the real parse, so a sidecar from another build produces "it speaks v2, we
 *   speak v1" rather than a zod error about a field nobody has heard of (REPO_SKELETON.md §4).
 * - **Nothing throws on input.** A malformed line, an unknown message type and a version mismatch
 *   are all values. The supervisor above this counts undecodable lines and keeps going; a throw
 *   here would turn a stray line of sidecar output into a crash in Electron main.
 */

import { z } from 'zod';
import { PROTOCOL_VERSION } from './version.js';
import {
  type AppIdentity,
  type CaptureConfig,
  type SidecarCommand,
  type SidecarEvent,
  SidecarEvent as SidecarEventSchema,
} from './schemas/sidecar.js';

/**
 * The two fields every message carries, and the only two that may never change shape.
 *
 * Parsed loosely on purpose: this has to succeed against a message from a version we do not
 * otherwise understand, because that is the whole mechanism by which a mismatch is reportable.
 */
const Envelope = z.object({ v: z.number(), type: z.string() });

/** What one line of the sidecar's stdout turned out to be. Total: no case throws. */
export type DecodedEvent =
  | { readonly ok: true; readonly event: SidecarEvent }
  | { readonly ok: false; readonly reason: 'malformed'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'version'; readonly theirs: number };

/** Serialise a message as one line, without the newline. */
export function encodeMessage(message: SidecarCommand | SidecarEvent): string {
  return JSON.stringify(message);
}

/** Read one line of the sidecar's stdout. */
export function decodeSidecarEvent(line: string): DecodedEvent {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch (error: unknown) {
    return { ok: false, reason: 'malformed', detail: describe(error) };
  }

  const envelope = Envelope.safeParse(json);
  if (!envelope.success) {
    return { ok: false, reason: 'malformed', detail: 'no { v, type } envelope' };
  }
  if (envelope.data.v !== PROTOCOL_VERSION) {
    return { ok: false, reason: 'version', theirs: envelope.data.v };
  }

  const parsed = SidecarEventSchema.safeParse(json);
  if (!parsed.success) {
    // Same version, unreadable content: a `type` we do not have, or a field of the wrong shape.
    // Naming the type is what makes this actionable in a log.
    return {
      ok: false,
      reason: 'malformed',
      detail: `${envelope.data.type}: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    };
  }
  return { ok: true, event: parsed.data };
}

/**
 * The commands the app sends, as constructors.
 *
 * Not because `{ v: 1, type: 'hello' }` is hard to write, but because `v` is easy to forget and a
 * message without it is a message the sidecar reports as malformed.
 */
export const commands = {
  hello(app: AppIdentity): SidecarCommand {
    return { v: PROTOCOL_VERSION, type: 'hello', app };
  },
  configure(config: CaptureConfig): SidecarCommand {
    return { v: PROTOCOL_VERSION, type: 'capture.configure', config };
  },
  start(): SidecarCommand {
    return { v: PROTOCOL_VERSION, type: 'capture.start' };
  },
  stop(): SidecarCommand {
    return { v: PROTOCOL_VERSION, type: 'capture.stop' };
  },
  shutdown(): SidecarCommand {
    return { v: PROTOCOL_VERSION, type: 'shutdown' };
  },
} as const;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
