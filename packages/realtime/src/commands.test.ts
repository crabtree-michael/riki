/**
 * The adversarial cases are the point of this file.
 *
 * §6.3: "the failure mode of a false positive is Riki muting itself in the middle of a fight."
 * Every rule in the parser exists to avoid one, so most of what is asserted here is that a phrase
 * containing a command word does *not* match.
 */

import { describe, expect, it } from 'vitest';
import { LOCAL_COMMANDS, parseLocalCommand, similarity } from './commands.js';

describe('the four commands', () => {
  it.each([
    ['stop', 'stop'],
    ['stop it', 'stop'],
    ["that's enough", 'stop'],
    ['shut up', 'stop'],
    ['never mind', 'cancel'],
    ['cancel that', 'cancel'],
    ['mute', 'mute'],
    ['only when I ask', 'quiet-mode'],
  ])('matches %j as %s', (transcript, kind) => {
    expect(parseLocalCommand(transcript)?.command.kind).toBe(kind);
  });

  it('emits a closed union, never a topic or a free string', () => {
    // ADR-0013 makes free text unrepresentable in durable memory; this parser is the boundary.
    const match = parseLocalCommand('stop');
    expect(['stop', 'mute', 'quiet-mode', 'cancel']).toContain(match?.command.kind);
  });
});

describe('anchoring — the false positives that matter', () => {
  /**
   * The example the design gives by name: "Don't stop farming" contains "stop" and must not match;
   * "okay, stop" must.
   */
  it('does not match a command word buried mid-sentence', () => {
    expect(parseLocalCommand("don't stop farming")).toBeNull();
    expect(parseLocalCommand('should I stop farming and push')).toBeNull();
    expect(parseLocalCommand('I need to stop feeding this lane')).toBeNull();
  });

  it('matches the final clause', () => {
    expect(parseLocalCommand('okay, stop')?.command.kind).toBe('stop');
    expect(parseLocalCommand('yeah alright, never mind')?.command.kind).toBe('cancel');
  });

  it('does not match an early clause', () => {
    // "stop" here is the subject of the sentence, and the instruction is what follows it.
    expect(parseLocalCommand('stop telling me about the enemy mid')).toBeNull();
  });

  it('utterance anchoring is stricter than final-clause', () => {
    const strict = { rules: LOCAL_COMMANDS, anchor: 'utterance' as const };
    expect(parseLocalCommand('okay, stop', strict)).toBeNull();
    expect(parseLocalCommand('stop', strict)?.command.kind).toBe('stop');
  });
});

describe('the negation guard', () => {
  /**
   * A leading negation suppresses the match outright rather than reducing its score — a
   * 0.7-confidence "don't mute" is not a weak mute, it is the opposite instruction.
   */
  it.each(["don't mute", 'do not mute', "don't stop", 'not now, do not mute'])(
    'suppresses %j entirely',
    (transcript) => {
      expect(parseLocalCommand(transcript)).toBeNull();
    },
  );

  it('does not let a distant negation suppress a real command', () => {
    // "don't" belongs to the first clause; the instruction is the last one.
    expect(parseLocalCommand("don't push mid. stop")?.command.kind).toBe('stop');
  });
});

describe('fuzzy matching, because ASR is noisy', () => {
  it('accepts a plausible mistranscription', () => {
    expect(parseLocalCommand('shuddup')?.command.kind).toBe('stop');
    expect(parseLocalCommand('nevermind')?.command.kind).toBe('cancel');
  });

  it('rejects something that merely rhymes', () => {
    expect(parseLocalCommand('stomp')).toBeNull();
    expect(parseLocalCommand('mid')).toBeNull();
  });

  it('holds mute to a higher bar than stop', () => {
    // A false mute is silent by definition, so the player gets no feedback about why Riki
    // stopped talking. A false stop costs one interrupted response.
    const mute = LOCAL_COMMANDS.find((rule) => rule.command.kind === 'mute');
    const stop = LOCAL_COMMANDS.find((rule) => rule.command.kind === 'stop');
    expect(mute?.minConfidence).toBeGreaterThan(stop?.minConfidence ?? 1);
  });

  it('reports the phrase it matched, for telemetry and for debugging a false positive', () => {
    expect(parseLocalCommand('shut up')?.matchedPhrase).toBe('shut up');
  });
});

describe('mute durations', () => {
  it('reads digits and words', () => {
    expect(parseLocalCommand('mute for 10 minutes')?.command).toEqual({
      kind: 'mute',
      minutes: 10,
    });
    expect(parseLocalCommand('mute for ten minutes')?.command).toEqual({
      kind: 'mute',
      minutes: 10,
    });
  });

  it('is null when no duration was given', () => {
    expect(parseLocalCommand('mute')?.command).toEqual({ kind: 'mute', minutes: null });
  });

  it('does not invent a duration from an unrecognised word', () => {
    expect(parseLocalCommand('mute for ages')?.command).toEqual({ kind: 'mute', minutes: null });
  });
});

describe('similarity', () => {
  it('is 1 for identical and 0 for empty', () => {
    expect(similarity('stop', 'stop')).toBe(1);
    expect(similarity('', 'stop')).toBe(0);
  });

  it('is normalised by the longer string', () => {
    // One substitution in four characters.
    expect(similarity('stop', 'stap')).toBeCloseTo(0.75, 5);
  });
});

describe('degenerate input', () => {
  it('returns null rather than throwing', () => {
    for (const input of ['', '   ', '...', '!!!']) {
      expect(parseLocalCommand(input)).toBeNull();
    }
  });

  it('ignores punctuation and casing', () => {
    expect(parseLocalCommand('STOP!')?.command.kind).toBe('stop');
  });
});
