/**
 * Where the overlay window goes — pure arithmetic over injected display data.
 *
 * Nothing here touches Electron, so the eight anchors, the four scales, the 12 px inset and the
 * multi-monitor rule from ui-design.md §9.2 are all Tier 1 tests with no window
 * (docs/design/overlay-architecture.md §5.4).
 *
 * The window is sized once per (anchor, scale, display) to a box big enough for the widest chip
 * *and* a caption panel, and everything animates inside it. Resizing a transparent always-on-top
 * window per state change is visibly janky and puts layout on the animation path, which
 * ui-design.md §10 forbids (§3.4).
 */

import type {
  AnchorPreset,
  ChipScale,
  DisplaySnapshot,
  DisplayTargetHint,
  DragPlacement,
  PlacementResolver,
  Rectangle,
} from './contracts.js';

/** Logical pixels at 1×, from ui-design.md §4.1 and §5.4. */
const CHIP_MAX_WIDTH = 180;
const CHIP_HEIGHT = 28;
const CAPTION_MAX_HEIGHT = 96;
const CAPTION_GAP = 6;
/** The chip's drop shadow is `0 2 8`, and it must not be clipped by the window edge. */
const SHADOW_BLEED = 8;
/** Docked to the edge, 12 px in (ui-design.md §2.4). */
const EDGE_INSET = 12;

export const BOX_WIDTH = CHIP_MAX_WIDTH + SHADOW_BLEED * 2;
export const BOX_HEIGHT = CHIP_HEIGHT + CAPTION_GAP + CAPTION_MAX_HEIGHT + SHADOW_BLEED * 2;

export function createPlacementResolver(): PlacementResolver {
  return { resolve, targetDisplay };
}

export function resolve(
  anchor: AnchorPreset | DragPlacement,
  display: DisplaySnapshot,
  scale: ChipScale,
): Rectangle {
  const width = Math.round(BOX_WIDTH * scale);
  const height = Math.round(BOX_HEIGHT * scale);
  const inset = Math.round(EDGE_INSET * scale);
  const area = display.workArea;

  const left = area.x + inset;
  const centreX = area.x + Math.round((area.width - width) / 2);
  const right = area.x + area.width - width - inset;
  const top = area.y + inset;
  const middleY = area.y + Math.round((area.height - height) / 2);
  const bottom = area.y + area.height - height - inset;

  const position =
    typeof anchor === 'string'
      ? PRESETS[anchor]({ left, centreX, right, top, middleY, bottom })
      : // Fractions of the work area, so a drag survives a resolution change, and the fraction
        // names the chip's centre rather than its corner — which is what the drag preview shows.
        {
          x: area.x + Math.round(anchor.xFraction * area.width - width / 2),
          y: area.y + Math.round(anchor.yFraction * area.height - height / 2),
        };

  return {
    x: clamp(position.x, area.x, area.x + area.width - width),
    y: clamp(position.y, area.y, area.y + area.height - height),
    width,
    height,
  };
}

interface Edges {
  readonly left: number;
  readonly centreX: number;
  readonly right: number;
  readonly top: number;
  readonly middleY: number;
  readonly bottom: number;
}

const PRESETS: Readonly<
  Record<AnchorPreset, (e: Edges) => { readonly x: number; readonly y: number }>
> = {
  'top-left': (e) => ({ x: e.left, y: e.top }),
  'top-centre': (e) => ({ x: e.centreX, y: e.top }),
  'top-right': (e) => ({ x: e.right, y: e.top }),
  'middle-left': (e) => ({ x: e.left, y: e.middleY }),
  'middle-right': (e) => ({ x: e.right, y: e.middleY }),
  'bottom-left': (e) => ({ x: e.left, y: e.bottom }),
  'bottom-centre': (e) => ({ x: e.centreX, y: e.bottom }),
  'bottom-right': (e) => ({ x: e.right, y: e.bottom }),
};

/**
 * Degrades rather than failing: a hint whose window is on a display that has just been unplugged
 * falls back to the nearest display, and then to the primary one. A hint that has not arrived is
 * not an error (§5.4).
 */
export function targetDisplay(
  displays: readonly DisplaySnapshot[],
  hint: DisplayTargetHint,
): DisplaySnapshot | null {
  if (displays.length === 0) return null;
  if (hint.kind === 'primary') return primaryOf(displays);

  const overlapping = displays
    .map((display) => ({ display, area: overlap(display.workArea, hint.bounds) }))
    .filter((candidate) => candidate.area > 0)
    .sort((a, b) => b.area - a.area)[0];
  if (overlapping !== undefined) return overlapping.display;

  const nearest = displays
    .map((display) => ({ display, distance: centreDistance(display.workArea, hint.bounds) }))
    .sort((a, b) => a.distance - b.distance)[0];
  return nearest?.display ?? primaryOf(displays);
}

function primaryOf(displays: readonly DisplaySnapshot[]): DisplaySnapshot | null {
  // A display set with no primary is a misreport from the platform, not something to crash on.
  return displays.find((display) => display.primary) ?? displays[0] ?? null;
}

function overlap(a: Rectangle, b: Rectangle): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

function centreDistance(a: Rectangle, b: Rectangle): number {
  const dx = a.x + a.width / 2 - (b.x + b.width / 2);
  const dy = a.y + a.height / 2 - (b.y + b.height / 2);
  return Math.hypot(dx, dy);
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), Math.max(low, high));
}
