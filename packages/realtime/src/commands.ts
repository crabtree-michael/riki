/**
 * The four spoken control phrases that must work when the model is unavailable, slow, or
 * misbehaving. Pure, and a Tier 1 test over a transcript fixture.
 *
 * Most of "command parsing" in this product is not here: the model turns speech into tool calls
 * and `agent-command-execution-architecture.md` owns all of it. What is here is the short list
 * that cannot depend on the model being well.
 *
 * **How much this earns is worth being honest about.** Under the default push-to-talk it earns
 * very little — the player must hold the trigger to be heard at all, and holding the trigger
 * during Speaking *is* barge-in, which stopped Riki before a word of the phrase was parsed. These
 * exist for tap-to-latch (ui-design §6.2), where the mic stays open with no held key, and for the
 * opt-in wake-word mode. If latch mode were cut, this file would go with it.
 *
 * Every rule below exists to avoid false positives, because the failure mode of a false positive
 * is Riki muting itself in the middle of a fight.
 *
 * See docs/design/voice-input-architecture.md §6.2, §6.3. Declarations only.
 */

export type LocalCommand =
  | { readonly kind: 'stop' }
  | { readonly kind: 'mute'; readonly minutes: number | null }
  | { readonly kind: 'quiet-mode'; readonly on: boolean }
  | { readonly kind: 'cancel' };

export interface CommandMatch {
  readonly command: LocalCommand;
  /** 0..1, normalised edit distance over the matched clause. */
  readonly confidence: number;
  readonly matchedPhrase: string;
}

export interface PhraseRule {
  readonly phrases: readonly string[];
  readonly command: LocalCommand;
  /** Per-command, and higher for the ones that are annoying to recover from. */
  readonly minConfidence: number;
}

/**
 * The grammar, as data. A closed union out, never a topic, an intent or a free string —
 * ADR-0013 makes free text unrepresentable in durable memory and this parser is the boundary
 * that keeps it that way.
 */
export declare const LOCAL_COMMANDS: readonly PhraseRule[];

export interface ParseOptions {
  readonly rules: readonly PhraseRule[];
  /**
   * A phrase must be the whole transcript or its final clause. "Don't stop farming" contains
   * "stop" and must not match; "okay, stop" must.
   */
  readonly anchor: 'utterance' | 'final-clause';
}

/**
 * At most one match. A leading negation in the matched clause suppresses the match outright
 * rather than reducing its score — a 0.7-confidence "don't mute" is not a weak mute.
 */
export declare function parseLocalCommand(
  transcript: string,
  opts?: ParseOptions,
): CommandMatch | null;
