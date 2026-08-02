/**
 * Scripts for `FakeVisionSidecar`: builders, a fixture format, and the one it uses by default.
 *
 * Split from `fake-sidecar.ts` because the two answer different questions. That file is *how a
 * sidecar behaves* — the handshake, the pipe, dying. This one is *what it saw*, which is the part
 * a test or a dev session actually varies.
 *
 * ## The fixture format is the wire
 *
 * `fixtures/vision/*.jsonl` is one `VisionStep` per line, and the `event` on each line is a literal
 * `SidecarEvent` — the same bytes `crates/riki-vision` would write. Not a compressed notation that
 * a builder expands: a fixture whose relationship to the protocol is a function in this repo is a
 * fixture that keeps agreeing with us after the protocol changes underneath it. Blank lines and
 * `//` lines are skipped so a recording can say where it came from, which matters here for the same
 * reason it does in `fixtures/gsi/` — nobody has run Dota, and a synthesised fixture and a captured
 * one look identical.
 */

import { readFileSync } from 'node:fs';
import type { CvFact, SidecarEvent } from '../index.js';
import { PROTOCOL_VERSION } from '../version.js';
import type { VisionScript, VisionStep } from './fake-sidecar.js';

/** One hero on the minimap, as a caller describes it. */
export interface Sighting {
  readonly hero: string;
  readonly side: 'allies' | 'enemies';
  /** 0..1 within the minimap crop, origin top-left. */
  readonly at: { readonly x: number; readonly y: number };
  /** Template-match score. Below `packages/world-model`'s 0.5 gate the fact is dropped. */
  readonly confidence?: number;
}

export interface SightingsOptions {
  readonly atMs: number;
  readonly heroes: readonly Sighting[];
  /**
   * The sidecar-local clock at capture. Defaults to `atMs`, with the write 8 ms later.
   *
   * The two are separate because the app derives `observedAt` from their *difference* and nothing
   * else — a fake that emitted them equal would make a codec that ignored the age look correct.
   */
  readonly capturedAtMonoMs?: number;
  readonly emittedAtMonoMs?: number;
  readonly detector?: string;
  /** Adds a `region.digest` for the minimap crop, as a real pass would. */
  readonly digest?: { readonly hash: string; readonly changed: boolean };
}

/** How long a real pass spends between capture and write, near enough for a fake. */
const PIPELINE_MS = 8;

/** One capture pass as a protocol message. */
export function sightings(opts: SightingsOptions): VisionStep {
  const capturedAtMonoMs = opts.capturedAtMonoMs ?? opts.atMs;
  const detector = opts.detector ?? 'minimap-icon/v1';

  const facts: CvFact[] = opts.heroes.map((hero) => ({
    regionId: 'minimap',
    detector,
    confidence: hero.confidence ?? 0.9,
    capturedAtMonoMs,
    payload: { kind: 'minimap.hero' as const, hero: hero.hero, side: hero.side, at: hero.at },
  }));

  if (opts.digest !== undefined) {
    facts.push({
      regionId: 'minimap',
      detector: 'region-digest/v1',
      confidence: 1,
      capturedAtMonoMs,
      payload: {
        kind: 'region.digest' as const,
        hash: opts.digest.hash,
        width: 346,
        height: 270,
        meanLuma: 0.13,
        changed: opts.digest.changed,
      },
    });
  }

  return {
    atMs: opts.atMs,
    event: {
      v: PROTOCOL_VERSION,
      type: 'cv.detections',
      emittedAtMonoMs: opts.emittedAtMonoMs ?? capturedAtMonoMs + PIPELINE_MS,
      facts,
    },
  };
}

/** A named failure the sidecar reports rather than absorbing. dota2 §9's list. */
export function problemStep(
  atMs: number,
  problem: Extract<SidecarEvent, { type: 'problem' }>['problem'],
): VisionStep {
  return { atMs, event: { v: PROTOCOL_VERSION, type: 'problem', problem } };
}

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

export function loadVisionFixture(path: string): VisionScript {
  return parseVisionFixture(readFileSync(path, 'utf8'));
}

export function parseVisionFixture(contents: string): VisionScript {
  const steps = contents
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.trimStart().startsWith('//'))
    .map((line, index): VisionStep => {
      const parsed = JSON.parse(line) as Partial<VisionStep> & { atMs?: number };
      return { ...parsed, atMs: parsed.atMs ?? index * 200 } as VisionStep;
    });
  return { steps };
}

// ---------------------------------------------------------------------------------------------
// The built-in script
// ---------------------------------------------------------------------------------------------

/** The five enemies the default script watches, and where each one sits when it is visible. */
const ENEMY_LINEUP: readonly Sighting[] = [
  { hero: 'npc_dota_hero_nevermore', side: 'enemies', at: { x: 0.72, y: 0.3 } },
  { hero: 'npc_dota_hero_tidehunter', side: 'enemies', at: { x: 0.66, y: 0.24 } },
  { hero: 'npc_dota_hero_crystal_maiden', side: 'enemies', at: { x: 0.55, y: 0.45 } },
  { hero: 'npc_dota_hero_axe', side: 'enemies', at: { x: 0.34, y: 0.7 } },
  { hero: 'npc_dota_hero_lion', side: 'enemies', at: { x: 0.3, y: 0.74 } },
];

/** Who stops being reported partway through, which is the whole point of the script. */
const ROTATES_OUT = new Set(['npc_dota_hero_nevermore', 'npc_dota_hero_tidehunter']);

export interface DefaultVisionScriptOptions {
  /** Passes per second. `DEFAULT_CAPTURE_CONFIG` asks for 200 ms, so 5. */
  readonly intervalMs?: number;
  /** How long the whole script covers. */
  readonly durationMs?: number;
  /** When the two rotating heroes drop off the minimap. */
  readonly rotateAtMs?: number;
}

/**
 * The script `RIKI_FAKE_VISION=1` runs when nobody named a fixture.
 *
 * It is written to produce the *one* thing the vision → coaching edge is for: two enemies visible,
 * then not visible, so `enemies.<hero>.position` ages past `unseenEnemies`' 20 s and then past
 * `enemy_missing`'s 25 s and Riki has something to say that GSI could never have told it
 * (state-capture-architecture.md §5.3 — `enemies[].position` is CV-only).
 *
 * Three details are deliberate rather than decorative:
 *
 * - **The rotating heroes stop being *reported*, they are not reported as absent.** There is no
 *   "I cannot see them" message in the protocol and there should not be; absence of a sighting is
 *   the signal, and ageing is what turns it into one.
 * - **Every pass carries a digest**, because a real one does, and because a batch containing
 *   nothing but a digest is what a quiet minimap looks like.
 * - **One hero is under the confidence gate.** `crystal_maiden` is reported at 0.4 throughout, so
 *   the fake produces the "low-confidence output" REPO_SKELETON §5.2 asks of it and the gate has
 *   something to drop on every single pass.
 */
export function defaultVisionScript(opts: DefaultVisionScriptOptions = {}): VisionScript {
  const intervalMs = opts.intervalMs ?? 200;
  const durationMs = opts.durationMs ?? 60_000;
  const rotateAtMs = opts.rotateAtMs ?? 6_000;

  const steps: VisionStep[] = [];
  for (let atMs = 0, pass = 0; atMs <= durationMs; atMs += intervalMs, pass += 1) {
    const visible = ENEMY_LINEUP.filter(
      (hero) => atMs < rotateAtMs || !ROTATES_OUT.has(hero.hero),
    ).map((hero) => ({
      ...hero,
      confidence: hero.hero === 'npc_dota_hero_crystal_maiden' ? 0.4 : 0.9,
      // A pixel of jitter, so consecutive passes are not byte-identical and the change gate has
      // something to be true about.
      at: { x: hero.at.x + (pass % 3) * 0.001, y: hero.at.y + (pass % 2) * 0.001 },
    }));

    steps.push(
      sightings({
        atMs,
        heroes: visible,
        digest: { hash: hashFor(pass), changed: true },
      }),
    );
  }
  return { steps };
}

/** A stable 16-hex-digit digest per pass. Not a hash of anything — there are no pixels here. */
function hashFor(pass: number): string {
  return (BigInt(pass) * 0x9e3779b97f4a7c15n).toString(16).padStart(16, '0').slice(-16);
}
