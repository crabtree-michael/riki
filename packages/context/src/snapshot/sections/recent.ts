/**
 * `recent: [22:04] tide died top · [21:46] you got 3rd item`
 *
 * The event tape, and **the first thing to go** — dota2 §6.2 names history as what a tight budget
 * eats. It is also the section that is not ours: the text arrives from `packages/events` already
 * phrased (§8.2), because that package is the one that decides what an event *is*. This file places
 * events, ages them by their own clock, and drops them; it does not write them.
 *
 * The privacy gate is the reason this is not a two-line file. An event tape can carry a chat line,
 * and this is the second of the two independent gates standing between other players' words and a
 * third-party API (state-capture §4.2 is the first). Default off, asserted by the egress test.
 */

import type { SectionSource } from '../contracts.js';
import { classifyField, createPrivacyGate } from '../../render/privacy.js';
import { clockText, line, path } from './util.js';

const gate = createPrivacyGate();

/** How many tape events the line carries before the budget gets involved *(tunable)*. */
export const MAX_TAPE_EVENTS = 5;

/**
 * An event id that names chat is classified as chat.
 *
 * `classifyField` is a path-prefix classifier and an event id is not a path, so the id is mapped
 * onto one — `chat.<id>` — rather than a second classifier being written here. One classifier means
 * a new chat-ish event kind is covered by the rule that already exists instead of by a rule
 * somebody has to remember to add.
 */
function allowed(id: string, policy: Parameters<typeof gate.allow>[1]): boolean {
  const chatLike = id === 'chat' || id.startsWith('chat_') || id.endsWith('_chat');
  return gate.allow(classifyField(path(chatLike ? `chat.${id}` : id)), policy);
}

export const recent: SectionSource = {
  id: 'recent',

  build(_world, ctx) {
    const events = ctx.tape
      .filter((event) => allowed(String(event.id), ctx.privacy))
      .slice(-MAX_TAPE_EVENTS)
      .map((event) => `[${clockText(event.at)}] ${gate.redact(event.text, ctx.privacy)}`);

    return line('recent', 'recent', events.length === 0 ? null : events.join(' · '));
  },
};
