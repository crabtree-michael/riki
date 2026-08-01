/**
 * The second of the two independent gates on chat text.
 *
 * The first is at the source, where the log tailer tags it `sensitive` (state-capture §4.2). This
 * one is at the point of rendering, and it is the last thing standing between other players' words
 * and a third-party API. dota2 §7's ⚠ row is exactly that, so both defaults are off and a Tier 1
 * test asserts it rather than trusting the literal below to stay `false`.
 *
 * See docs/design/context-and-memory-architecture.md §5.1.
 */

import type { FieldPath } from '../common/ports.js';
import type { PrivacyPolicy } from '../common/types.js';
import type { PrivacyGate } from './contracts.js';
import type { FieldClass } from './types.js';

/** Both off. REPO_SKELETON.md §7.2 asks for this to be asserted, not assumed. */
export const DEFAULT_PRIVACY: PrivacyPolicy = {
  allowChatText: false,
  allowPlayerNames: false,
};

/**
 * Which privacy class a world-model field belongs to.
 *
 * A path-prefix classifier rather than a per-field table, because the failure mode of a table is a
 * field nobody added to it — which defaults to `game_state` and leaks. Everything under `chat` is
 * chat, whatever it is called, and an unrecognised path is only ever game state because game state
 * is the class with no gate.
 */
export function classifyField(path: FieldPath): FieldClass {
  const p = String(path);
  if (p === 'chat' || p.startsWith('chat.')) return 'chat_text';
  if (p.endsWith('.name') || p.endsWith('.playerName') || p.endsWith('.steamId')) {
    return 'player_name';
  }
  if (p === 'self' || p.startsWith('self.')) return 'self_identity';
  return 'game_state';
}

/** Names are `Word` or `[Tag] Word`-ish tokens preceding a `:` — the log tailer's speaker form. */
const SPEAKER_PREFIX = /^[^:]{1,32}:\s*/u;

export function createPrivacyGate(): PrivacyGate {
  return {
    allow(field: FieldClass, policy: PrivacyPolicy): boolean {
      switch (field) {
        case 'chat_text':
          return policy.allowChatText;
        case 'player_name':
          return policy.allowPlayerNames;
        case 'game_state':
        case 'self_identity':
          return true;
      }
    },

    /**
     * Strips a leading `speaker:` from a line that is allowed through on its own merits.
     *
     * Never a substitute for `allow`: redaction is for text the policy already permits, and using
     * it to "safely" emit chat would be exactly the leak the gate exists to stop.
     */
    redact(text: string, policy: PrivacyPolicy): string {
      return policy.allowPlayerNames ? text : text.replace(SPEAKER_PREFIX, '');
    },
  };
}
