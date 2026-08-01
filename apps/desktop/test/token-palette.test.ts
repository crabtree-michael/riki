import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The "no red" guard REPO_SKELETON.md §5.4 asks for, plus the palette itself as a golden.
 *
 * Tier 1 over a text file: no window, no renderer, no Electron. It lives here rather than beside
 * the token module because it reads the CSS off disk, and renderer code deliberately has no Node
 * types (docs/design/overlay-architecture.md §11.3).
 */

const TOKENS = readFileSync(
  new URL('../src/renderer/overlay/tokens/tokens.css', import.meta.url),
  'utf8',
);

/** ui-design.md §4.2, verbatim. A change here should be a visible diff in review. */
const EXPECTED = {
  '--riki-chip-bg': 'rgba(12, 14, 18, 0.72)',
  '--riki-chip-border': 'rgba(255, 255, 255, 0.14)',
  '--riki-chip-shadow': 'rgba(0, 0, 0, 0.45)',
  '--riki-accent-listening': '#6fd3ff',
  '--riki-accent-working': '#b9a8ff',
  '--riki-accent-speaking': '#7ee8b0',
  '--riki-accent-confirm': '#ffd37e',
  '--riki-accent-error': '#ff8a7a',
  '--riki-accent-muted': '#8a93a6',
} as const;

function declarations(css: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const [, name, value] of css.matchAll(/(--riki-[a-z-]+)\s*:\s*([^;]+);/g)) {
    if (name !== undefined && value !== undefined && !found.has(name)) {
      found.set(name, value.trim());
    }
  }
  return found;
}

interface Hsl {
  readonly hue: number;
  readonly saturation: number;
  readonly lightness: number;
}

function toHsl(hex: string): Hsl {
  const value = hex.replace('#', '');
  const r = Number.parseInt(value.slice(0, 2), 16) / 255;
  const g = Number.parseInt(value.slice(2, 4), 16) / 255;
  const b = Number.parseInt(value.slice(4, 6), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const lightness = (max + min) / 2;

  if (delta === 0) return { hue: 0, saturation: 0, lightness };

  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  const hue =
    max === r
      ? 60 * (((g - b) / delta) % 6)
      : max === g
        ? 60 * ((b - r) / delta + 2)
        : 60 * ((r - g) / delta + 4);

  return { hue: (hue + 360) % 360, saturation, lightness };
}

/**
 * "Red" here means what a player's peripheral vision reads as damage: a red hue that is both
 * saturated and dark. Coral (#FF8A7A) is the same hue family and is deliberately allowed — it is
 * light enough (L ≈ 0.74) to read as a notification rather than as a health bar.
 */
function isAlarmRed(hex: string): boolean {
  const { hue, saturation, lightness } = toHsl(hex);
  const nearRed = hue <= 15 || hue >= 345;
  return nearRed && saturation >= 0.6 && lightness <= 0.6;
}

describe('the token palette', () => {
  const found = declarations(TOKENS);

  it('matches ui-design.md §4.2 exactly', () => {
    for (const [name, value] of Object.entries(EXPECTED)) {
      expect(found.get(name)).toBe(value);
    }
  });

  it('names an accent for every state the chip can be in', () => {
    for (const accent of ['listening', 'working', 'speaking', 'confirm', 'error', 'muted']) {
      expect(found.has(`--riki-accent-${accent}`)).toBe(true);
    }
  });

  it('uses no red-family value in the accent palette', () => {
    for (const [name, value] of found) {
      if (!name.startsWith('--riki-accent-')) continue;
      expect(value).toMatch(/^#[0-9a-f]{6}$/);
      expect(isAlarmRed(value), `${name} reads as damage feedback`).toBe(false);
    }
  });

  it('offers a high-contrast variant rather than a second palette', () => {
    expect(TOKENS).toContain('.riki-contrast-high');
    expect(TOKENS).toMatch(
      /\.riki-contrast-high\s*\{[^}]*--riki-chip-bg:\s*rgba\(12, 14, 18, 0\.92\)/,
    );
    expect(TOKENS).toMatch(
      /\.riki-contrast-high\s*\{[^}]*--riki-chip-border:\s*rgba\(255, 255, 255, 0\.4\)/,
    );
  });
});

describe('the no-red guard itself', () => {
  it('rejects the colours it exists to reject', () => {
    for (const red of ['#ff0000', '#e03030', '#cc1111', '#b00020']) {
      expect(isAlarmRed(red)).toBe(true);
    }
  });

  it('accepts coral, which is the point of having a rule rather than a hue ban', () => {
    expect(isAlarmRed('#ff8a7a')).toBe(false);
  });
});
