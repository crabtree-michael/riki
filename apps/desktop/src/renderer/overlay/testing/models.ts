/**
 * Chip models for renderer tests.
 *
 * Hand-written rather than produced by `main/session/machine.ts`, and deliberately so: the
 * renderer may not import from main, and a view that could reach the machine would be a view that
 * had opinions about state. What the two sides share is `shared/overlay.ts` and nothing else.
 */

import type { ChipViewModel } from '../../../shared/overlay.js';

const BASE: ChipViewModel = {
  state: 'hidden',
  phase: 'settled',
  glyph: 'dot-outline',
  accent: 'muted',
  motion: 'none',
  bars: 'none',
  text: null,
  latched: false,
  dimmed: false,
  affordances: [],
  captions: null,
  revision: 1,
};

export const models = {
  hidden: (): ChipViewModel => ({ ...BASE, phase: 'leaving' }),

  armed: (): ChipViewModel => ({
    ...BASE,
    state: 'armed',
    glyph: 'dot-outline',
    accent: 'listening',
    motion: 'none',
    bars: 'none',
  }),

  listening: (): ChipViewModel => ({
    ...BASE,
    state: 'listening',
    glyph: 'dot',
    accent: 'listening',
    motion: 'amplitude',
    bars: 'input',
  }),

  processing: (): ChipViewModel => ({
    ...BASE,
    state: 'processing',
    glyph: 'dot-segmented',
    accent: 'working',
    motion: 'sweep',
    bars: 'sweep',
  }),

  confirming: (): ChipViewModel => ({
    ...BASE,
    state: 'confirming',
    glyph: 'query',
    accent: 'confirm',
    motion: 'none',
    bars: 'none',
    text: { primary: 'Look at your screen?', hint: '[Y] yes   [N] no' },
    affordances: ['confirm'],
  }),

  speaking: (): ChipViewModel => ({
    ...BASE,
    state: 'speaking',
    glyph: 'dot-ringed',
    accent: 'speaking',
    motion: 'envelope',
    bars: 'output',
  }),

  error: (): ChipViewModel => ({
    ...BASE,
    state: 'error',
    glyph: 'bang',
    accent: 'error',
    motion: 'double-pulse-then-static',
    bars: 'none',
    text: { primary: 'Microphone blocked', hint: 'Fix ▸' },
    affordances: ['fix'],
  }),

  muted: (): ChipViewModel => ({
    ...BASE,
    state: 'muted',
    glyph: 'slashed',
    accent: 'muted',
    motion: 'none',
    bars: 'none',
  }),
};
