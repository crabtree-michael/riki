#!/usr/bin/env node
// Generates the four tray glyphs into apps/desktop/resources/tray/.
//
// They are committed, and this script is committed with them, because a binary asset with no
// recipe is one nobody can change. Re-run it after editing a shape:
//
//     node scripts/generate-tray-glyphs.mjs
//
// ## Why they are drawn rather than designed
//
// ui-design.md §2.3 asks for a monochrome glyph that follows OS light/dark. On macOS — the primary
// target — that is a *template image*: an all-black image with an alpha channel, named
// `*Template.png`, which AppKit recolours for the menu bar automatically. There is nothing for a
// designer to pick, because every pixel is either black or transparent; the only decisions are the
// four shapes, and those are in §2.3's diagram.
//
// Written as raw PNG bytes rather than through a library so the repo does not take an image
// dependency for eight 16×16 files. PNG's structure is four chunks and a CRC, and `zlib` is in the
// standard library.

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT_DIR = 'apps/desktop/resources/tray';
const SIZES = [16, 32];

/** Alpha 0..1 at (x, y) in a unit square, for each of the four states (ui-design.md §2.3). */
const SHAPES = {
  // ◇ outline glyph: running and ready.
  idle: (x, y) => ring(x, y, 0.34, 0.1),
  // ◆ filled glyph: a session is in progress.
  active: (x, y) => disc(x, y, 0.34),
  // ⊘ the user has explicitly disabled Riki.
  muted: (x, y) => Math.max(ring(x, y, 0.34, 0.1), slash(x, y, 0.09)),
  // ! mic permission revoked, no audio device, auth expired.
  attention: (x, y) => Math.max(bar(x, y), dot(x, y)),
};

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** One-pixel-ish antialiasing: `edge` is a signed distance, negative inside. */
const coverage = (edge, softness) => clamp01(0.5 - edge / softness);

function disc(x, y, r) {
  const d = Math.hypot(x - 0.5, y - 0.5) - r;
  return coverage(d, 0.06);
}

function ring(x, y, r, thickness) {
  const d = Math.abs(Math.hypot(x - 0.5, y - 0.5) - r) - thickness / 2;
  return coverage(d, 0.06);
}

/** A 45° stroke across the ring, clipped to the ring's own radius. */
function slash(x, y, thickness) {
  const along = (x - 0.5 + (y - 0.5)) / Math.SQRT2;
  const across = (x - 0.5 - (y - 0.5)) / Math.SQRT2;
  const inside = Math.hypot(x - 0.5, y - 0.5) - 0.42;
  return (
    Math.min(coverage(Math.abs(across) - thickness / 2, 0.05), coverage(inside, 0.06), 1) *
    (Math.abs(along) < 0.42 ? 1 : 0)
  );
}

function bar(x, y) {
  const dx = Math.abs(x - 0.5) - 0.1;
  const dy = Math.max(0.14 - y, y - 0.6);
  return coverage(Math.max(dx, dy), 0.05);
}

function dot(x, y) {
  const d = Math.hypot(x - 0.5, y - 0.8) - 0.12;
  return coverage(d, 0.05);
}

function render(size, shape) {
  // RGBA, black with the shape in alpha. A template image's colour channels are ignored, but
  // premultiplied-alpha viewers will show grey if they are left at 255 — so keep them at zero.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let offset = 0;
  for (let row = 0; row < size; row += 1) {
    raw[offset] = 0; // PNG filter type 0 (None), one byte per scanline.
    offset += 1;
    for (let column = 0; column < size; column += 1) {
      // Sample at the pixel centre.
      const alpha = shape((column + 0.5) / size, (row + 0.5) / size);
      raw[offset + 3] = Math.round(clamp01(alpha) * 255);
      offset += 4;
    }
  }
  return raw;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

function png(size, raw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT_DIR, { recursive: true });

for (const [name, shape] of Object.entries(SHAPES)) {
  for (const size of SIZES) {
    // macOS reads the `@2x` suffix as the Retina variant of the base name; on Windows and Linux
    // Electron simply picks the file it is given, and 16 px is the right one there.
    const suffix = size === 16 ? '' : '@2x';
    const file = join(OUT_DIR, `${name}Template${suffix}.png`);
    writeFileSync(file, png(size, render(size, shape)));
    console.log(`[tray] wrote ${file}`);
  }
}
