/**
 * Pings and the chat wheel.
 *
 * > ⚠ **Unverified**, per `chat.ts`.
 *
 * A ping is intent rather than state — "missing mid" tells you what a teammate believes, not
 * where anyone is — so it never becomes a fact. `packages/events` is where it earns its keep, on
 * the delta tape, and until that exists this matcher's output is dropped by fusion. That is worth
 * knowing before wondering why nothing happens.
 */

import type { LineMatcher, LogEvent, PingEvent } from '../contracts.js';
import { stripLogPrefix } from './chat.js';

/** `[Ping] SomePlayer: Missing Enemy Hero` and the chat-wheel form. */
const PING = /^\[ping\]\s*(?:([^:]{1,64}):\s*)?(.+)$/i;
const CHAT_WHEEL = /^([^:]{1,64})\s+used\s+chat\s+wheel:\s*(.+)$/i;

export function createPingMatcher(): LineMatcher {
  return {
    id: 'ping',
    // The timestamps parameter is declared by `LineMatcher` and deliberately not taken: a
    // matcher is a pure function of the line, and reading a clock here would be the first
    // step towards one that decides what a line *means*, which is fusion's job.
    match(line: string): LogEvent | null {
      const body = stripLogPrefix(line);

      const ping = PING.exec(body);
      if (ping?.[2] !== undefined) return event(ping[2].trim());

      const wheel = CHAT_WHEEL.exec(body);
      // Chat-wheel phrases are a fixed Valve-authored set, not free text, so they are `public`
      // where a typed line is `sensitive`. Nobody's own words are in them.
      if (wheel?.[2] !== undefined) return event(wheel[2].trim());

      return null;
    },
  };
}

function event(detail: string): PingEvent {
  return { kind: 'ping', kind_detail: detail, privacy: 'public' };
}
