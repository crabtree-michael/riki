/**
 * Chat lines.
 *
 * > ⚠ **The patterns below are inferred from the documented behaviour of `-condebug`, not
 * > derived from a capture.** `dota2-state-capture-design.md` §2.3 flags "exactly which events
 * > reach `console.log` on current builds" as needing verification, and nobody has run it — the
 * > dev platform has no Dota client. Treat a mismatch against a real log as expected, and fix it
 * > here: the matcher registry exists precisely so that a format we do not control breaks one
 * > small file with its own fixtures rather than the tailer (§4.2).
 *
 * Two forms are recognised, because community captures show both depending on build and on
 * whether the line came from the chat wheel:
 *
 * ```
 * [All Chat] SomePlayer: gg go next
 * [Team] SomePlayer: mid is missing
 * SomePlayer says: gg go next
 * ```
 */

import type { ChatLine, LineMatcher, LogEvent } from '../contracts.js';

/** `[All Chat] Name: text`, with the channel word varying. */
const BRACKETED = /^\[(all(?:\s+chat)?|team(?:\s+chat)?|allies)\]\s*([^:]{1,64}):\s*(.+)$/i;

/** `Name says: text` — the plainer form, with no channel, so it is filed as `all`. */
const SAYS = /^([^:]{1,64})\s+says:\s*(.+)$/i;

/**
 * A console log carries timestamps and log-level prefixes on some builds. Stripping a leading
 * `[hh:mm:ss]` or `mm:ss` before matching keeps every pattern in this directory from having to
 * repeat it — and getting that wrong once, in one place, is much easier to notice.
 */
export function stripLogPrefix(line: string): string {
  return line.replace(/^\s*(?:\[\d{1,2}:\d{2}(?::\d{2})?\]|\d{1,2}:\d{2}(?::\d{2})?)\s*/, '');
}

function channelOf(raw: string): ChatLine['channel'] {
  const lowered = raw.toLowerCase();
  return lowered.startsWith('team') || lowered.startsWith('allies') ? 'team' : 'all';
}

export function createChatMatcher(): LineMatcher {
  return {
    id: 'chat',
    // The timestamps parameter is declared by `LineMatcher` and deliberately not taken: a
    // matcher is a pure function of the line, and reading a clock here would be the first
    // step towards one that decides what a line *means*, which is fusion's job.
    match(line: string): LogEvent | null {
      const body = stripLogPrefix(line);

      const bracketed = BRACKETED.exec(body);
      if (bracketed !== null) {
        const [, channel, speaker, text] = bracketed;
        if (channel === undefined || speaker === undefined || text === undefined) return null;
        return chat(text.trim(), speaker.trim(), channelOf(channel));
      }

      const says = SAYS.exec(body);
      if (says !== null) {
        const [, speaker, text] = says;
        if (speaker === undefined || text === undefined) return null;
        return chat(text.trim(), speaker.trim(), 'all');
      }

      return null;
    },
  };
}

/**
 * `privacy` is a literal on the type, so there is no code path that produces an unclassified chat
 * line — the classification is not applied to the value, it is part of what the value is.
 */
function chat(text: string, speaker: string, channel: ChatLine['channel']): ChatLine {
  return { kind: 'chat', text, speaker, channel, privacy: 'sensitive' };
}
