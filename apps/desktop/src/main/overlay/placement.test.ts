import { describe, expect, it } from 'vitest';

import { BOX_HEIGHT, BOX_WIDTH, resolve, targetDisplay } from './placement.js';
import type { AnchorPreset, ChipScale, DisplaySnapshot } from './contracts.js';

const PRIMARY: DisplaySnapshot = {
  id: 1,
  workArea: { x: 0, y: 0, width: 1920, height: 1080 },
  scaleFactor: 1,
  primary: true,
};

/** To the left of the primary and taller — the awkward real-world arrangement. */
const SECOND: DisplaySnapshot = {
  id: 2,
  workArea: { x: -2560, y: -200, width: 2560, height: 1440 },
  scaleFactor: 2,
  primary: false,
};

const ANCHORS: readonly AnchorPreset[] = [
  'top-left',
  'top-centre',
  'top-right',
  'middle-left',
  'middle-right',
  'bottom-left',
  'bottom-centre',
  'bottom-right',
];

const SCALES: readonly ChipScale[] = [0.75, 1, 1.25, 1.5];

describe('resolve — geometry', () => {
  it('sizes one box per scale, big enough for the widest chip and a caption panel', () => {
    expect(resolve('top-centre', PRIMARY, 1)).toMatchObject({
      width: BOX_WIDTH,
      height: BOX_HEIGHT,
    });
    expect(resolve('top-centre', PRIMARY, 1.5)).toMatchObject({
      width: Math.round(BOX_WIDTH * 1.5),
      height: Math.round(BOX_HEIGHT * 1.5),
    });
  });

  it('docks the default anchor to the top edge, 12 px in', () => {
    const bounds = resolve('top-centre', PRIMARY, 1);
    expect(bounds.y).toBe(12);
    expect(bounds.x).toBe(Math.round((1920 - BOX_WIDTH) / 2));
  });

  it('scales the inset with the chip', () => {
    expect(resolve('top-left', PRIMARY, 1.5).y).toBe(18);
    expect(resolve('top-left', PRIMARY, 0.75).y).toBe(9);
  });

  it('keeps every anchor at every scale inside the work area', () => {
    for (const display of [PRIMARY, SECOND]) {
      for (const anchor of ANCHORS) {
        for (const scale of SCALES) {
          const bounds = resolve(anchor, display, scale);
          const area = display.workArea;
          expect(bounds.x).toBeGreaterThanOrEqual(area.x);
          expect(bounds.y).toBeGreaterThanOrEqual(area.y);
          expect(bounds.x + bounds.width).toBeLessThanOrEqual(area.x + area.width);
          expect(bounds.y + bounds.height).toBeLessThanOrEqual(area.y + area.height);
        }
      }
    }
  });

  it('puts the eight presets in eight distinct places', () => {
    const places = ANCHORS.map((anchor) => {
      const bounds = resolve(anchor, PRIMARY, 1);
      return `${String(bounds.x)},${String(bounds.y)}`;
    });
    expect(new Set(places).size).toBe(ANCHORS.length);
  });

  it('honours a display whose origin is negative', () => {
    const bounds = resolve('top-left', SECOND, 1);
    expect(bounds.x).toBe(-2560 + 12);
    expect(bounds.y).toBe(-200 + 12);
  });

  it('does not apply OS display scaling — Electron bounds are device-independent', () => {
    const scaled = { ...PRIMARY, scaleFactor: 2 };
    expect(resolve('top-centre', scaled, 1)).toEqual(resolve('top-centre', PRIMARY, 1));
  });
});

describe('resolve — drag placement', () => {
  it('treats the fractions as the box centre', () => {
    const bounds = resolve({ kind: 'drag', xFraction: 0.5, yFraction: 0.5 }, PRIMARY, 1);
    expect(bounds.x + bounds.width / 2).toBeCloseTo(960, 0);
    expect(bounds.y + bounds.height / 2).toBeCloseTo(540, 0);
  });

  it('survives a resolution change by staying at the same fraction', () => {
    const drag = { kind: 'drag', xFraction: 0.25, yFraction: 0.75 } as const;
    const wide = resolve(drag, PRIMARY, 1);
    const narrow = resolve(
      drag,
      { ...PRIMARY, workArea: { x: 0, y: 0, width: 1280, height: 720 } },
      1,
    );

    expect((wide.x + wide.width / 2) / 1920).toBeCloseTo(0.25, 2);
    expect((narrow.x + narrow.width / 2) / 1280).toBeCloseTo(0.25, 2);
  });

  it('clamps a fraction that would push the box off-screen', () => {
    const bounds = resolve({ kind: 'drag', xFraction: 1, yFraction: 1 }, PRIMARY, 1);
    expect(bounds.x + bounds.width).toBe(1920);
    expect(bounds.y + bounds.height).toBe(1080);
  });
});

describe('targetDisplay', () => {
  const displays = [PRIMARY, SECOND];

  it('follows the game window', () => {
    const hint = {
      kind: 'gameWindow',
      bounds: { x: -2000, y: 0, width: 1600, height: 900 },
    } as const;
    expect(targetDisplay(displays, hint)?.id).toBe(SECOND.id);
  });

  it('picks the display holding most of a window that straddles two', () => {
    const hint = {
      kind: 'gameWindow',
      bounds: { x: -300, y: 0, width: 1600, height: 900 },
    } as const;
    expect(targetDisplay(displays, hint)?.id).toBe(PRIMARY.id);
  });

  it('answers the same way for a focused window as for the game window', () => {
    const bounds = { x: -2000, y: 0, width: 1600, height: 900 };
    expect(targetDisplay(displays, { kind: 'focused', bounds })?.id).toBe(
      targetDisplay(displays, { kind: 'gameWindow', bounds })?.id,
    );
  });

  it('falls back to the primary display when asked for it', () => {
    expect(targetDisplay(displays, { kind: 'primary' })?.id).toBe(PRIMARY.id);
  });

  it('falls back to the nearest display when the hinted one has been unplugged', () => {
    const hint = {
      kind: 'gameWindow',
      bounds: { x: -2000, y: 0, width: 1600, height: 900 },
    } as const;
    expect(targetDisplay([PRIMARY], hint)?.id).toBe(PRIMARY.id);
  });

  it('returns null rather than guessing when there are no displays at all', () => {
    expect(targetDisplay([], { kind: 'primary' })).toBeNull();
  });

  it('still answers when no display claims to be primary', () => {
    expect(targetDisplay([SECOND], { kind: 'primary' })?.id).toBe(SECOND.id);
  });
});
