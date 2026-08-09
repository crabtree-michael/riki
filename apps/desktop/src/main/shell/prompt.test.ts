/**
 * The session instructions, which are the cached prefix.
 *
 * Two properties and a trap. The properties are ADR-0011's: the same input produces the same bytes,
 * because a reconnect re-assembles it and a prefix that cannot be cached has thrown away the reason
 * it exists; and it is total, because a match with no draft is a match where Riki knows less rather
 * than one that does not start.
 *
 * The trap is where the draft comes from. `main/state/index.ts` resets the world model *before* it
 * announces `match_started`, so anything reading `state.world` on that edge reads nothing — which is
 * what the deleted preamble assembler did for its whole life, silently. The heroes come off the
 * lifecycle event instead, and `prompt.ts`'s header is the record.
 */

import { describe, expect, it } from 'vitest';

import { buildSessionPrompt } from './prompt.js';

const DRAFT = ['npc_dota_hero_riki', 'npc_dota_hero_nevermore', 'npc_dota_hero_tidehunter'];

describe('buildSessionPrompt', () => {
  it('carries the persona and the staleness rule', () => {
    const text = buildSessionPrompt(DRAFT);
    expect(text).toContain('You are Riki');
    // The one rule lifted verbatim from the deleted coach prompt, and the whole reason
    // `packages/world-model`'s fact envelope is not wasted on the way out.
    expect(text).toContain('must not state an aged value as current');
    expect(text).toContain('was bottom thirty seconds ago');
  });

  it('says Riki is a coach, in the one place the model reads before anything else', () => {
    // This assertion used to demand the opposite string. ADR-0042 decided Riki does not interrupt,
    // and the prompt mistranslated that into "You are not a coach" — so a player who asked to be
    // coached was refused by the prefix. ADR-0050 splits the two apart.
    const text = buildSessionPrompt(DRAFT);
    expect(text).toContain('a Dota 2 coach');
    expect(text).not.toContain('not a coach');
  });

  it('keeps answers to the question asked, without denying that it coaches', () => {
    // The property ADR-0042 actually wanted from this paragraph. It is about the length and the
    // scope of an answer while someone is playing, and it survives the identity fix intact.
    const text = buildSessionPrompt(DRAFT);
    expect(text).toContain('do not volunteer advice they did not ask for');
  });

  it('names the heroes without claiming which side they are on', () => {
    const text = buildSessionPrompt(DRAFT);
    expect(text).toContain('npc_dota_hero_nevermore');
    // GSI's `draft` block gives no team on a pick, so splitting the ten here would be a fabrication
    // in the one piece of text that is never re-read. The snapshot observes it per turn instead.
    expect(text).toContain('is in the per-turn snapshot');
  });

  it('assembles a working prompt from an empty draft', () => {
    // `match_started` seen mid-match rather than during the draft carries no heroes at all, which
    // is ordinary. A prompt that degraded to nothing there would be a match with no assistant.
    const text = buildSessionPrompt([]);
    expect(text).toContain('You are Riki');
    expect(text).not.toContain('The heroes in this match');
  });

  it('is byte-identical for identical input, so a reconnect keeps the cached prefix', () => {
    expect(buildSessionPrompt(DRAFT)).toBe(buildSessionPrompt([...DRAFT]));
  });
});
