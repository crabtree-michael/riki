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
 * See docs/design/voice-input-architecture.md §6.2, §6.3.
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
export const LOCAL_COMMANDS: readonly PhraseRule[] = [
  {
    // Phonetic variants are listed, not fuzzed into. See `withinEditTolerance` for why: at four
    // characters, "stomp" is one edit from "stop", so any tolerance wide enough to catch
    // "shuddup" is wide enough to mute the player for saying the wrong short word.
    phrases: [
      'stop',
      'stop it',
      "that's enough",
      'thats enough',
      'shut up',
      'shuddup',
      'shurrup',
      'be quiet',
      'enough',
    ],
    command: { kind: 'stop' },
    // Lowest bar of the four: it is the one a player reaches for mid-fight, and getting it wrong
    // costs one silenced response that they were interrupting anyway.
    minConfidence: 0.78,
  },
  {
    phrases: ['never mind', 'nevermind', 'cancel that', 'forget it', 'ignore that'],
    command: { kind: 'cancel' },
    minConfidence: 0.82,
  },
  {
    phrases: ['mute', 'mute yourself', 'mute for a bit'],
    command: { kind: 'mute', minutes: null },
    // Higher: a false mute is silent by definition, so the player has no feedback telling them
    // why Riki stopped talking.
    minConfidence: 0.88,
  },
  {
    phrases: ['only when I ask', 'only when i ask', 'quiet mode', 'stop talking unprompted'],
    command: { kind: 'quiet-mode', on: true },
    minConfidence: 0.88,
  },
];

/**
 * Suppresses a match outright rather than reducing its score. "Don't mute" at 0.7 confidence is
 * not a weak mute — it is the opposite instruction, and scoring it would eventually let it
 * through.
 */
const NEGATIONS: readonly string[] = [
  "don't",
  'dont',
  'do not',
  'never',
  'stop',
  'no',
  'not',
  "didn't",
  'didnt',
];

/** `"mute for ten minutes"` → 10. Words as well as digits: ASR spells small numbers out. */
const NUMBER_WORDS: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  ten: 10,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  sixty: 60,
};

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * How many edits a phrase of this length is allowed to be wrong by.
 *
 * A ratio alone cannot do this job on short strings. "stop" is four characters, so one edit is a
 * 0.75 ratio — and "stomp" is one edit away. Any threshold loose enough to accept a real
 * mistranscription of a short command is loose enough to accept a different word entirely, which
 * is the false positive §6.3 says costs the most. So: no fuzz at all below five characters, and
 * one edit per five thereafter. Genuine variants of short commands go in the table instead.
 */
function editTolerance(phrase: string): number {
  return Math.floor(phrase.length / 5);
}

/** Levenshtein, normalised by the longer string, so 0 is unrelated and 1 is identical. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (current[j - 1] ?? 0) + 1,
        (previous[j] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
    }
    previous = current;
  }

  const distance = previous[b.length] ?? Math.max(a.length, b.length);
  return 1 - distance / Math.max(a.length, b.length);
}

/**
 * Split into clauses on the punctuation ASR actually emits, plus the conjunctions it uses instead.
 * "okay, stop" and "okay so stop" both have to yield "stop" as the final clause.
 */
function clauses(text: string): string[] {
  return text
    .split(/\b(?:and|but|so|then|okay|ok)\b|[,.;!?]/g)
    .map((clause) => normalise(clause))
    .filter((clause) => clause !== '');
}

/** Levenshtein distance, unnormalised — the tolerance above is expressed in edits. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (current[j - 1] ?? 0) + 1,
        (previous[j] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
    }
    previous = current;
  }
  return previous[b.length] ?? Math.max(a.length, b.length);
}

interface PhraseHit {
  readonly score: number;
  /** What followed the phrase, when it was a duration suffix. Empty for an exact match. */
  readonly tail: string;
}

/**
 * A candidate clause against one phrase.
 *
 * Exact first, then "phrase + a `for …` duration suffix" — the spec table lists
 * "mute for ten minutes" as a mute phrase, and under strict clause anchoring that clause would
 * otherwise score far too low against the bare word. Only then a bounded fuzzy match.
 */
function matchPhrase(candidate: string, phrase: string): PhraseHit | null {
  if (candidate === phrase) return { score: 1, tail: '' };

  if (candidate.startsWith(`${phrase} `)) {
    const tail = candidate.slice(phrase.length + 1);
    // Only a duration suffix. "mute the enemy mid" is not a mute instruction.
    return tail.startsWith('for ') ? { score: 1, tail } : null;
  }

  const distance = editDistance(candidate, phrase);
  if (distance > editTolerance(phrase)) return null;
  return { score: 1 - distance / Math.max(candidate.length, phrase.length), tail: '' };
}

function hasLeadingNegation(clause: string, phrase: string): boolean {
  const index = clause.indexOf(phrase);
  const before = normalise(index < 0 ? clause : clause.slice(0, index));
  if (before === '') return false;
  const words = before.split(' ');
  // Only the last two words before the phrase: "I said don't mute" negates, "don't die, mute"
  // does not, and looking at the whole clause cannot tell them apart.
  return words.slice(-2).some((word) => NEGATIONS.includes(word));
}

function minutesIn(text: string): number | null {
  const digits = /(\d+)\s*(?:minute|minutes|min|mins)/.exec(text);
  if (digits?.[1] !== undefined) return Number.parseInt(digits[1], 10);

  const words = /\b([a-z]+)\s+(?:minute|minutes|min|mins)\b/.exec(text);
  const word = words?.[1];
  return word !== undefined ? (NUMBER_WORDS[word] ?? null) : null;
}

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
export const DEFAULT_PARSE_OPTIONS: ParseOptions = {
  rules: LOCAL_COMMANDS,
  anchor: 'final-clause',
};

export function parseLocalCommand(
  transcript: string,
  opts: ParseOptions = DEFAULT_PARSE_OPTIONS,
): CommandMatch | null {
  const whole = normalise(transcript);
  if (whole === '') return null;

  // Whole utterance first, then the final clause. Anything earlier in the sentence is context,
  // not an instruction — "don't stop farming, push mid" must not mute anything.
  const candidates =
    opts.anchor === 'utterance' ? [whole] : [whole, clauses(transcript).at(-1) ?? ''];

  let best: CommandMatch | null = null;

  for (const candidate of candidates) {
    if (candidate === '') continue;
    for (const rule of opts.rules) {
      for (const phrase of rule.phrases) {
        const normalisedPhrase = normalise(phrase);
        const hit = matchPhrase(candidate, normalisedPhrase);
        if (hit === null || hit.score < rule.minConfidence) continue;
        if (hasLeadingNegation(candidate, normalisedPhrase)) continue;
        if (best !== null && hit.score <= best.confidence) continue;

        best = {
          command:
            rule.command.kind === 'mute'
              ? { kind: 'mute', minutes: minutesIn(hit.tail === '' ? whole : hit.tail) }
              : rule.command,
          confidence: hit.score,
          matchedPhrase: phrase,
        };
      }
    }
  }

  return best;
}
