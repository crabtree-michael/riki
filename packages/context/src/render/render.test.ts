/**
 * The three shared primitives. Tier 1 (REPO_SKELETON.md §5.3).
 *
 * These are tested here rather than through a tier because both tiers depend on them behaving
 * identically — the failure this guards is the two renderers agreeing until the day one of them
 * learns to say "probably" (context-and-memory-architecture.md §5.1).
 */

import { describe, expect, it } from 'vitest';
import type { MonoMs, Observed, PrivacyPolicy } from '../common/types.js';
import type { FieldPath } from '../common/ports.js';
import type { Section, SectionId } from './types.js';
import { DEFAULT_PRIVACY, classifyField, createPrivacyGate } from './privacy.js';
import { createAgeFormatter, renderObserved } from './age.js';
import { createSectionComposer } from './compose.js';
import { estimateTokens } from './tokens.js';

const cv = (ageMs: number, confidence: number): Observed<string> => ({
  value: 'bot',
  staleness: 'aging',
  ageMs,
  confidence,
  source: 'cv',
});

describe('estimateTokens', () => {
  it('never under-counts, which is the direction the rule fixes', () => {
    // A counter that estimates must over-count: an over-count wastes headroom, an under-count
    // silently exceeds a cap and is discovered as an API error mid-match.
    const samples = [
      'sf bot 4s ago(0.91), lvl 12',
      'net worth +1240g vs typical',
      'unseen >20s: pudge, zuus, crystal_maiden',
      '{"type":"object","properties":{"hero":{"type":"string"}}}',
      'a',
      '',
    ];
    for (const sample of samples) {
      // A BPE tokenizer will not produce more tokens than characters for text like this, and the
      // estimate must sit between the true count and that ceiling.
      expect(estimateTokens(sample)).toBeGreaterThanOrEqual(Math.ceil(sample.length / 8));
      expect(estimateTokens(sample)).toBeLessThanOrEqual(Math.max(1, sample.length));
    }
  });

  it('is zero only for the empty string', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens(' ')).toBeGreaterThan(0);
  });
});

describe('AgeFormatter', () => {
  const formatter = createAgeFormatter();

  it('renders a stale CV fact with its age and confidence', () => {
    // dota2 §4 rule 3: a stale CV fact renders with its age and confidence, or it does not render.
    expect(formatter.format(cv(4000, 0.91), 0 as MonoMs, null)).toBe('~4s ago(0.91)');
  });

  it('drops a below-threshold fact rather than hedging it', () => {
    // Hedging spends tokens to say nothing.
    expect(formatter.format(cv(4000, 0.2), 0 as MonoMs, null)).toBeNull();
  });

  it('drops an expired fact entirely', () => {
    expect(
      formatter.format({ ...cv(1000, 0.99), staleness: 'expired' }, 0 as MonoMs, null),
    ).toBeNull();
  });

  it('says `unseen >20s` rather than an ever-growing number', () => {
    expect(formatter.format(cv(45_000, 0.9), 0 as MonoMs, null)).toBe('unseen >20s(0.90)');
  });

  it('gives an exact source no confidence marker', () => {
    const gsi: Observed<number> = {
      value: 12,
      staleness: 'fresh',
      ageMs: 3000,
      confidence: 1,
      source: 'gsi',
    };
    expect(formatter.format(gsi, 0 as MonoMs, null)).toBe('3s ago');
  });

  it('has no path that renders a value without going past the gate', () => {
    // `renderObserved` is the only join of label and value, so a dropped fact cannot become a
    // bare label — "sf: " with nothing after it is the failure this prevents.
    expect(renderObserved('lvl', cv(4000, 0.2), formatter, 0 as MonoMs, null)).toBeNull();
    expect(renderObserved('at', cv(4000, 0.91), formatter, 0 as MonoMs, null)).toBe(
      'at bot ~4s ago(0.91)',
    );
  });
});

describe('PrivacyGate', () => {
  const gate = createPrivacyGate();

  it('defaults to both gates closed', () => {
    // REPO_SKELETON.md §7.2 asks for this to be asserted rather than assumed, because dota2 §7's
    // ⚠ row is other people's words.
    expect(DEFAULT_PRIVACY).toStrictEqual({ allowChatText: false, allowPlayerNames: false });
    expect(gate.allow('chat_text', DEFAULT_PRIVACY)).toBe(false);
    expect(gate.allow('player_name', DEFAULT_PRIVACY)).toBe(false);
    expect(gate.allow('game_state', DEFAULT_PRIVACY)).toBe(true);
  });

  it('classifies an unrecognised path as game state, and anything under chat as chat', () => {
    expect(classifyField('chat' as FieldPath)).toBe('chat_text');
    expect(classifyField('chat.42.text' as FieldPath)).toBe('chat_text');
    expect(classifyField('enemies.pudge.level' as FieldPath)).toBe('game_state');
    expect(classifyField('allies.zuus.name' as FieldPath)).toBe('player_name');
  });

  it('strips a speaker prefix when names are not allowed', () => {
    const policy: PrivacyPolicy = { allowChatText: true, allowPlayerNames: false };
    expect(gate.redact('SomePlayer: gg go next', policy)).toBe('gg go next');
    expect(gate.redact('SomePlayer: gg go next', { ...policy, allowPlayerNames: true })).toBe(
      'SomePlayer: gg go next',
    );
  });
});

describe('SectionComposer', () => {
  const composer = createSectionComposer();
  const section = (id: string, priority: number, text: string, droppable = true): Section => ({
    id: id as SectionId,
    priority,
    droppable,
    body: { text, tokens: estimateTokens(text) },
  });

  it('drops the lowest priority first and records what went', () => {
    const result = composer.compose(
      [
        section('keep', 100, 'important'),
        section('drop', 10, 'a much longer and less important line'),
      ],
      { maxTokens: 5, spentTokens: 0 },
    );
    expect(result.omitted).toStrictEqual(['drop']);
    expect(result.text).toBe('important');
    expect(result.truncated).toBe(true);
  });

  it('never drops an undroppable section, and says so instead', () => {
    // The structural form of dota2 §6.2's "self-state never gets truncated": failing loudly beats
    // quietly producing a snapshot with no hero in it.
    const result = composer.compose([section('self', 100, 'a very long undroppable line', false)], {
      maxTokens: 1,
      spentTokens: 0,
    });
    expect(result.text).toBe('a very long undroppable line');
    expect(result.truncated).toBe(true);
    expect(result.omitted).toStrictEqual([]);
  });

  it('leaves output order alone when something is dropped', () => {
    const result = composer.compose(
      [section('a', 100, 'aaa'), section('b', 1, 'bbbbbbbbbbbbbbbbbbbb'), section('c', 90, 'ccc')],
      { maxTokens: 4, spentTokens: 0 },
    );
    expect(result.text).toBe('aaa\nccc');
  });
});
