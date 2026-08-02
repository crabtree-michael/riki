/**
 * The stdio protocol between Electron main and `crates/riki-vision`.
 *
 * zod is the source of truth (REPO_SKELETON.md §4). `pnpm codegen` turns this file into
 * `packages/protocol/generated/sidecar.schema.json` and then into
 * `crates/riki-ipc/src/generated/mod.rs`. Never hand-edit either.
 *
 * ## Two properties are structural rather than documented
 *
 * **There is no way to ask for a screen.** A capture target is a window — a process name and a
 * title fragment — and there is no display id, monitor index, or region-of-desktop anywhere in
 * this file. dota2-state-capture-design.md §7 makes window-scoped capture the privacy story, and
 * the cheapest way to keep a promise like that is to leave the alternative unrepresentable rather
 * than to rely on every future caller passing the right flag.
 *
 * **A detection cannot be constructed without confidence, provenance and a timestamp.** Those
 * three live on `CvFact`, which wraps every detection payload; a new detector adds a variant to
 * `DetectionPayload` and inherits the envelope whether its author thought about it or not. §4
 * rule 3 of the design doc calls a confidence-free CV fact the worst outcome in the product — a
 * player told something false in a confident voice — so the envelope is the one shape that is
 * worth the ceremony.
 *
 * ## The two clocks
 *
 * The sidecar's monotonic clock and the app's share no epoch, so a sidecar timestamp cannot be
 * compared to `MonoMs` on the other side. Both `capturedAtMonoMs` and `emittedAtMonoMs` are
 * therefore sidecar-local, and the app uses only their *difference*: how long a fact spent inside
 * the sidecar between the capture and the write. Subtracting that from the app-local receive time
 * gives an `observedAt` in the app's own clock, which is the only form the world model can age
 * correctly (state-capture-architecture.md §3.1, §5.5).
 */

import { z } from 'zod';
import { PROTOCOL_VERSION } from '../version.js';

/** `v` on every message: the frozen field a mismatched peer can still read (see version.ts). */
const version = z.int().min(1).describe('Protocol version this message was written against.');

// ---------------------------------------------------------------------------------------------
// Capture targeting
// ---------------------------------------------------------------------------------------------

/**
 * The regions the pipeline knows how to crop.
 *
 * A closed set, not a free string: "add a CV region" is a protocol change by design
 * (state-capture-architecture.md §9), and a closed set is what makes the Rust side a real enum
 * instead of a string that might be anything.
 */
export const RegionId = z
  .enum(['minimap', 'top-bar', 'scoreboard', 'shop', 'self-hud', 'chat'])
  .meta({ id: 'RegionId', description: 'A named crop region within the Dota 2 window.' });

/**
 * A crop rectangle in window-normalised coordinates.
 *
 * Normalised rather than pixels because resolution, aspect ratio and Dota's HUD scale slider all
 * vary per user (dota2 §2.2, "calibration is mandatory"). Pixel rectangles are what calibration
 * will eventually solve for; they are not what crosses this boundary.
 */
export const NormalizedRect = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    w: z.number().gt(0).max(1),
    h: z.number().gt(0).max(1),
  })
  .meta({
    id: 'NormalizedRect',
    description: 'Crop rectangle in 0..1 coordinates relative to the captured window.',
  });

export const CaptureRegion = z
  .object({ id: RegionId, rect: NormalizedRect })
  .meta({ id: 'CaptureRegion', description: 'One region the sidecar should crop and report.' });

/**
 * A point inside a cropped region, in that crop's own 0..1 coordinates.
 *
 * Image convention: the origin is the crop's top-left and `y` grows downward, because that is what
 * a detector holding a buffer of pixels actually measures. Turning it into anything a game
 * understands — Dota world units, a named lane — is the app's job and happens exactly once, in
 * `apps/desktop/src/main/sidecar/protocol-codec.ts`. The sidecar reports pixels; it does not know
 * where the map's origin is (ADR-0035).
 */
export const NormalizedPoint = z
  .object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
  .meta({
    id: 'NormalizedPoint',
    description: 'A point in 0..1 crop coordinates, origin top-left, y downward.',
  });

/**
 * What to capture.
 *
 * A window, identified the way a screen recorder identifies one. There is deliberately no
 * display or desktop variant — see the header.
 */
export const WindowTarget = z
  .object({
    processName: z.string().min(1).describe('Executable name, e.g. "dota2".'),
    titleContains: z.string().min(1).describe('Substring of the window title, e.g. "Dota 2".'),
  })
  .meta({ id: 'WindowTarget', description: 'The single window the sidecar may capture.' });

export const CaptureConfig = z
  .object({
    target: WindowTarget,
    regions: z.array(CaptureRegion).min(1),
    intervalMs: z
      .int()
      .min(1)
      .max(60_000)
      .describe(
        'Requested spacing between capture passes; the sidecar may go slower, never faster.',
      ),
  })
  .meta({ id: 'CaptureConfig', description: 'Everything the sidecar needs to start capturing.' });

// ---------------------------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------------------------

/**
 * What one detector saw in one region.
 *
 * Two variants, and they are different *kinds* of thing rather than two detectors:
 *
 * - **`region.digest`** is the crop-first pipeline's own output, before any recognition runs. It is
 *   what the region hash gate is computed from (dota2 §2.2), so reporting it makes the capture path
 *   observable end to end without the digit and icon atlases existing yet. It carries no game fact
 *   and nothing downstream writes it into the world model — see ADR-0035.
 * - **`minimap.hero`** is the first variant that does carry one, and it is the *only* CV fact the
 *   world model treats as authoritative: `enemies[].position` has no other source, because GSI
 *   cannot see it and §8.2 fairness allows only what the minimap renders
 *   (state-capture-architecture.md §5.3).
 *
 * **One sighting per fact, not a list per pass.** A minimap pass finds several heroes at several
 * match scores, and confidence lives on `CvFact` rather than in here (see its header). A
 * `minimap.heroes: [...]` payload would therefore have had one confidence for the whole batch,
 * which is the confident-hallucination failure REPO_SKELETON §4 exists to prevent — the weakest
 * blob in the pass would inherit the strongest one's score.
 */
export const DetectionPayload = z
  .discriminatedUnion('kind', [
    z.object({
      kind: z.literal('region.digest'),
      hash: z
        .string()
        .regex(/^[0-9a-f]{16}$/)
        .describe('64-bit region hash, lower-case hex. Equal hashes mean an unchanged region.'),
      width: z.int().min(1).describe('Cropped region width in pixels, after any downscale.'),
      height: z.int().min(1),
      meanLuma: z.number().min(0).max(1).describe('Mean luminance, 0..1. Zero means a black crop.'),
      changed: z
        .boolean()
        .describe('False when the hash matched the previous pass and no CV work was done.'),
    }),
    z.object({
      kind: z.literal('minimap.hero'),
      hero: z
        .string()
        .min(1)
        .describe('Hero id in the app’s vocabulary, e.g. "npc_dota_hero_nevermore".'),
      side: z
        .enum(['allies', 'enemies'])
        .describe('Which team the icon belongs to, from its colour key.'),
      at: NormalizedPoint,
    }),
  ])
  .meta({ id: 'DetectionPayload', description: 'What a detector produced, by detector kind.' });

/**
 * The envelope that makes a bare fact unrepresentable.
 *
 * Every field here is required. A detector that wants to report something adds a
 * `DetectionPayload` variant and gets confidence, provenance and a timestamp whether or not it
 * remembered to think about them (REPO_SKELETON.md §4).
 */
export const CvFact = z
  .object({
    regionId: RegionId,
    detector: z
      .string()
      .min(1)
      .describe('Provenance: the detector and its version, e.g. "region-digest/v1".'),
    confidence: z
      .number()
      .min(0)
      .max(1)
      .describe('0..1. For a digest this is the fraction of the requested rect actually captured.'),
    capturedAtMonoMs: z
      .number()
      .min(0)
      .describe('Sidecar-local monotonic ms at capture. Comparable only to emittedAtMonoMs.'),
    payload: DetectionPayload,
  })
  .meta({ id: 'CvFact', description: 'One CV observation with its confidence and provenance.' });

// ---------------------------------------------------------------------------------------------
// Problems
// ---------------------------------------------------------------------------------------------

/**
 * The failure modes dota2 §9 names, as things the sidecar can say out loud.
 *
 * The cross-cutting principle there is *degrade loudly to the developer, quietly to the user, and
 * never silently into wrongness*. A capture that returns black frames because macOS Screen
 * Recording was never granted looks exactly like a CV failure from the inside; naming it here is
 * what stops it being reported as one.
 */
export const ProblemKind = z
  .enum([
    'protocol_version_mismatch',
    'handshake_required',
    'malformed_message',
    'permission_denied',
    'exclusive_fullscreen',
    'window_not_found',
    'backend_unavailable',
    'capture_failed',
  ])
  .meta({ id: 'ProblemKind', description: 'Why the sidecar cannot do what was asked of it.' });

export const Problem = z
  .object({
    kind: ProblemKind,
    fatal: z
      .boolean()
      .describe('True when the sidecar is about to exit. False means degraded but still running.'),
    message: z.string().min(1).describe('Developer-facing. Never contains pixels or chat text.'),
    remedy: z
      .string()
      .min(1)
      .optional()
      .describe('User-facing next step, when there is one, e.g. "switch to borderless windowed".'),
  })
  .meta({ id: 'Problem', description: 'A named failure, reported rather than silently absorbed.' });

// ---------------------------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------------------------

export const AppIdentity = z
  .object({ name: z.string().min(1), build: z.string().min(1) })
  .meta({ id: 'AppIdentity', description: 'Who is on the other end, for logs and bug reports.' });

export const SidecarIdentity = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
    platform: z.string().min(1).describe('Rust target_os: "macos", "linux", "windows".'),
    backend: z.string().min(1).describe('Capture backend in use, e.g. "screencapturekit".'),
    backendAvailable: z
      .boolean()
      .describe('False when the handshake succeeded but nothing can be captured on this build.'),
  })
  .meta({ id: 'SidecarIdentity', description: 'What answered the handshake.' });

/** App → sidecar. Commands, never queries (state-capture-architecture.md §4.3). */
export const SidecarCommand = z
  .discriminatedUnion('type', [
    z.object({ v: version, type: z.literal('hello'), app: AppIdentity }),
    z.object({ v: version, type: z.literal('capture.configure'), config: CaptureConfig }),
    z.object({ v: version, type: z.literal('capture.start') }),
    z.object({ v: version, type: z.literal('capture.stop') }),
    z.object({ v: version, type: z.literal('shutdown') }),
  ])
  .meta({ id: 'SidecarCommand', description: 'One line written to the stdin of the sidecar.' });

/** Sidecar → app. */
export const SidecarEvent = z
  .discriminatedUnion('type', [
    z.object({ v: version, type: z.literal('ready'), sidecar: SidecarIdentity }),
    z.object({ v: version, type: z.literal('problem'), problem: Problem }),
    z.object({
      v: version,
      type: z.literal('cv.detections'),
      emittedAtMonoMs: z
        .number()
        .min(0)
        .describe('Sidecar-local monotonic ms at write. Minus capturedAtMonoMs gives the age.'),
      facts: z.array(CvFact),
    }),
  ])
  .meta({ id: 'SidecarEvent', description: 'One line read from the stdout of the sidecar.' });

/**
 * The root the generator walks. Every named type above reaches Rust through one of these two.
 */
export const SidecarProtocol = z.object({ command: SidecarCommand, event: SidecarEvent }).meta({
  id: 'SidecarProtocol',
  description: 'Root of the sidecar stdio protocol. Generated, not hand-written.',
});

export type RegionId = z.infer<typeof RegionId>;
export type NormalizedRect = z.infer<typeof NormalizedRect>;
export type NormalizedPoint = z.infer<typeof NormalizedPoint>;
export type CaptureRegion = z.infer<typeof CaptureRegion>;
export type WindowTarget = z.infer<typeof WindowTarget>;
export type CaptureConfig = z.infer<typeof CaptureConfig>;
export type DetectionPayload = z.infer<typeof DetectionPayload>;
export type CvFact = z.infer<typeof CvFact>;
export type ProblemKind = z.infer<typeof ProblemKind>;
export type Problem = z.infer<typeof Problem>;
export type AppIdentity = z.infer<typeof AppIdentity>;
export type SidecarIdentity = z.infer<typeof SidecarIdentity>;
export type SidecarCommand = z.infer<typeof SidecarCommand>;
export type SidecarEvent = z.infer<typeof SidecarEvent>;

/** The version every message this build writes carries. Re-exported for callers' convenience. */
export const CURRENT_PROTOCOL_VERSION = PROTOCOL_VERSION;
