/**
 * The adapter between `@riki/protocol` and the world model's vocabulary.
 *
 * `state-capture-architecture.md` §4.3 calls for exactly this: the sidecar speaks protocol
 * messages, and something in the composition root wraps them into an `Observation`, so the wire
 * format and the in-process vocabulary stay free to diverge. This is that something.
 *
 * ## The two clocks
 *
 * The sidecar's monotonic clock and ours share no epoch, so a sidecar timestamp cannot be compared
 * to a `MonoMs` here. What *is* comparable is the difference between two sidecar timestamps: how
 * long a fact spent inside the sidecar between its capture and the write. Subtracting that from
 * our own receive time gives an `observedAt` in our clock:
 *
 * ```text
 *   observedAt = receivedAt − (emittedAtMonoMs − capturedAtMonoMs)
 * ```
 *
 * That is the only form `packages/world-model` can age correctly (§3.1, §5.5). Deriving it here,
 * once, is what stops every consumer downstream from having to know that the number on the wire
 * belongs to somebody else's clock.
 *
 * ## The two vocabularies
 *
 * The wire says `{ payload: { kind: 'minimap.hero', at: { x, y } } }` in the crop's own 0..1
 * coordinates. `packages/world-model`'s `readCvDetections` reads a *flat* record with `kind` at the
 * top level and positions in Dota world units. Those are different shapes on purpose — §4.3 wants
 * the wire format and the in-process vocabulary free to diverge — and translating between them is
 * the whole job of this file. ADR-0035 records what went wrong when nobody did: the codec emitted
 * the wire shape verbatim, fusion could not read a single field of it, and every CV observation
 * ever produced was counted as `unparsed`.
 *
 * ## Nothing here throws
 *
 * A line that cannot be read is a counted `undecodable`, never an exception. Electron main holds
 * the API key and the whole coaching path; a stray line of sidecar output is not permitted to be
 * the thing that ends it.
 */

import {
  type AppIdentity,
  type CaptureConfig,
  type CvFact,
  type NormalizedPoint,
  type Problem,
  type RegionId,
  type SidecarIdentity,
  commands,
  decodeSidecarEvent,
  encodeMessage,
} from '@riki/protocol';
import type {
  CvDetection as WorldCvDetection,
  MonoMs,
  Observation,
  SourceId,
} from '@riki/world-model';
import type { DecodedLine, SidecarCodec } from './contracts.js';

/**
 * A CV fact in the world model's own vocabulary, with the envelope the protocol makes mandatory.
 *
 * Confidence, provenance and a timestamp are all still non-optional — the protocol makes them so,
 * and nothing here is allowed to widen that. `readCvDetections` reads all three off the same flat
 * record it reads `kind` from, which is why they are spread here rather than nested.
 */
export type CvDetection = WorldCvDetection & {
  readonly detector: string;
  readonly confidence: number;
  /** Local monotonic, derived from the sidecar's two timestamps. See the header. */
  readonly observedAt: MonoMs;
};

/**
 * The crop-first pipeline reporting on itself: a region hash, its size, and whether it changed.
 *
 * Carried beside the detections rather than among them because it is **not a fact about the
 * match** — there is no field in the world model a region hash could write, and putting it in
 * `detections` is what made fusion reject every batch the sidecar has ever sent. It stays on the
 * observation because it is the only evidence that capture is running at all when nothing on screen
 * has moved (the vision-sidecar skill's "an unchanged region is still reported").
 */
export interface RegionDigest {
  readonly regionId: RegionId;
  readonly detector: string;
  readonly confidence: number;
  readonly observedAt: MonoMs;
  readonly hash: string;
  readonly width: number;
  readonly height: number;
  readonly meanLuma: number;
  readonly changed: boolean;
}

/**
 * The payload of an `Observation<'cv.detections'>` from the sidecar.
 *
 * `detections` is the only key `readCvDetections` looks at; `digests` is deliberately invisible to
 * fusion and exists for health, the inspector and a human reading a log.
 */
export interface CvDetectionsPayload {
  readonly detections: readonly CvDetection[];
  readonly digests: readonly RegionDigest[];
}

/**
 * How wide Dota's map is, in world units, for turning a minimap point into a position.
 *
 * ⚠ **Approximate and unverified.** The playable area is documented by the community as spanning
 * about −8288…8288 on each axis; nobody here has run the game to confirm it, and the minimap crop
 * in `DEFAULT_CAPTURE_REGIONS` is a guessed rectangle that certainly includes some HUD border. So
 * the number below is a scale factor with real error in it.
 *
 * What that error does and does not break is worth being precise about, because it decides whether
 * this is allowed to ship ahead of calibration:
 *
 * - **`enemy_missing` is unaffected.** It asks whether a position exists and how old it is, never
 *   where it is (`packages/events/src/detect/map.ts`), so the whole vision → coaching edge works at
 *   any scale.
 * - **`nearbyEnemies` is affected**, because it compares a CV position against `self.position` from
 *   GSI — which is in real world units — using a 2000-unit radius. A wrong scale makes "in the same
 *   fight" mean the wrong distance.
 *
 * Emitting 0..1 minimap coordinates into a field measured in world units would have been far worse
 * than an imprecise conversion: every enemy would sit within 1 unit of the origin and therefore
 * within any radius, so `nearbyEnemies` would return the whole enemy team forever. That is the
 * "silently into wrongness" failure dota2 §9 forbids, and it is the reason this constant exists
 * rather than being left for calibration to supply later.
 */
export const MAP_WORLD_EXTENT_UNITS = 16_576;

/**
 * How this build introduces itself.
 *
 * ⚠ `build` is a literal because nothing in the shell knows its own version yet: `ShellConfig` is
 * a stand-in for `@riki/config` (see its header) and carries no build identifier. The field is
 * only ever read by a human looking at a sidecar log or a bug report, so a wrong value here
 * misleads rather than breaks — but it does mislead, and it should become the packaged version
 * when `@riki/config` lands.
 */
export const APP_IDENTITY: AppIdentity = { name: 'riki-desktop', build: 'dev' };

export interface ProtocolCodecDeps {
  readonly app?: AppIdentity;
  /** Sent immediately after the handshake — see `hello()`. */
  readonly capture: CaptureConfig;
  readonly sourceId?: string;
  /** The sidecar answered the handshake. Carries the backend it has, and whether it works. */
  readonly onReady?: (identity: SidecarIdentity) => void;
  /** A named failure: the Screen Recording permission, exclusive fullscreen, no backend at all. */
  readonly onProblem?: (problem: Problem) => void;
  /** The sidecar speaks a protocol this build does not. Distinct from a line we cannot parse. */
  readonly onVersionMismatch?: (theirs: number) => void;
  /** A line that is not protocol at all. Already counted by the supervisor; this is for logs. */
  readonly onUndecodable?: (line: string, detail: string) => void;
}

/**
 * The regions the app asks for until calibration exists.
 *
 * Deliberately approximate and deliberately here rather than in `@riki/protocol`: these are
 * *policy*, not contract. dota2 §2.2 is blunt that hardcoded coordinates break on real users —
 * resolution, aspect ratio, HUD scale, and the minimap-on-the-right setting all move them — so
 * these exist to give the pipeline something to crop, and calibration replaces them wholesale.
 *
 * Normalised to the window, 1080p 16:9 defaults, minimap bottom-left.
 */
export const DEFAULT_CAPTURE_REGIONS: CaptureConfig['regions'] = [
  { id: 'minimap', rect: { x: 0.0, y: 0.755, w: 0.155, h: 0.245 } },
  { id: 'top-bar', rect: { x: 0.29, y: 0.0, w: 0.42, h: 0.055 } },
];

/**
 * The Dota 2 window, and how fast to look at it.
 *
 * 200 ms is dota2 §5's 4–5 Hz minimap budget: a hero moves ~300 units/s and a minimap pixel is
 * ~60 units, so 5 Hz keeps positional error near one pixel and anything faster buys nothing.
 */
export const DEFAULT_CAPTURE_CONFIG: CaptureConfig = {
  target: { processName: 'dota2', titleContains: 'Dota 2' },
  regions: DEFAULT_CAPTURE_REGIONS,
  intervalMs: 200,
};

export function createProtocolCodec(deps: ProtocolCodecDeps): SidecarCodec {
  const sourceId = (deps.sourceId ?? 'sidecar') as SourceId;

  return {
    /**
     * Handshake, configuration, start — in that order, on spawn.
     *
     * Sending all three without waiting for `ready` is safe because a pipe preserves order: the
     * sidecar's handshake gate reads `hello` first and is established before it reaches the next
     * line. Waiting for `ready` instead would need a write path back through the codec, which
     * this seam does not have and does not need for one static region schedule.
     */
    hello(): readonly string[] {
      return [
        encodeMessage(commands.hello(deps.app ?? APP_IDENTITY)),
        encodeMessage(commands.configure(deps.capture)),
        encodeMessage(commands.start()),
      ];
    },

    decode(line: string, at: MonoMs, seq: number): DecodedLine {
      const decoded = decodeSidecarEvent(line);

      if (!decoded.ok) {
        if (decoded.reason === 'version') {
          // A different build, not a broken one. Naming it is the whole point of the version
          // field (REPO_SKELETON.md §4).
          deps.onVersionMismatch?.(decoded.theirs);
        } else {
          deps.onUndecodable?.(line, decoded.detail);
        }
        return { kind: 'undecodable' };
      }

      const event = decoded.event;
      switch (event.type) {
        case 'ready':
          deps.onReady?.(event.sidecar);
          return { kind: 'handled' };

        case 'problem':
          deps.onProblem?.(event.problem);
          return { kind: 'handled' };

        case 'cv.detections': {
          const detections: CvDetection[] = [];
          const digests: RegionDigest[] = [];

          for (const fact of event.facts) {
            const stamp = observedAt(at, event.emittedAtMonoMs, fact.capturedAtMonoMs);
            if (fact.payload.kind === 'region.digest') {
              const { hash, width, height, meanLuma, changed } = fact.payload;
              digests.push({
                regionId: fact.regionId,
                detector: fact.detector,
                confidence: fact.confidence,
                observedAt: stamp,
                hash,
                width,
                height,
                meanLuma,
                changed,
              });
              continue;
            }
            const detection = toDetection(fact, stamp);
            if (detection !== null) detections.push(detection);
          }

          const observation: Observation<'cv.detections'> = {
            kind: 'cv.detections',
            sourceId,
            seq,
            receivedAt: at,
            payload: { detections, digests } satisfies CvDetectionsPayload,
            v: event.v,
          };
          return { kind: 'observation', observation };
        }
      }
    },
  };
}

/**
 * One protocol fact → the flat record `readCvDetections` knows how to read, or null for a payload
 * that is not a fact about the match.
 *
 * The switch covers **every** `DetectionPayload` variant, including the `region.digest` its caller
 * has already dealt with, and that redundancy is the point: adding a variant is then a
 * non-exhaustive-switch error here, rather than a detection that silently reaches fusion and is
 * counted as `unparsed`. That is exactly the failure this file just had (ADR-0035).
 */
function toDetection(fact: CvFact, observedAt: MonoMs): CvDetection | null {
  const envelope = {
    detector: fact.detector,
    confidence: fact.confidence,
    observedAt,
  } as const;

  switch (fact.payload.kind) {
    case 'region.digest':
      return null;
    case 'minimap.hero': {
      const { hero, side } = fact.payload;
      const { x, y } = toWorldUnits(fact.payload.at);
      return { kind: 'hero_position', side, hero, x, y, ...envelope };
    }
  }
}

/**
 * A point in the minimap crop → Dota world units.
 *
 * Two transforms, and the second one is the easy thing to forget: the crop's origin is its
 * top-left with `y` growing *downward* (an image), and the world's origin is the centre of the map
 * with `y` growing *upward*. Getting only the first right mirrors the whole map north-to-south,
 * which is not a wrong number so much as advice about the wrong lane.
 *
 * See `MAP_WORLD_EXTENT_UNITS` for how approximate the scale is and what that does and does not
 * affect.
 */
export function toWorldUnits(at: NormalizedPoint): { readonly x: number; readonly y: number } {
  return {
    x: (at.x - 0.5) * MAP_WORLD_EXTENT_UNITS,
    y: (0.5 - at.y) * MAP_WORLD_EXTENT_UNITS,
  };
}

/**
 * Translate a sidecar timestamp into our clock.
 *
 * Clamped at both ends. A negative age would mean a fact captured after it was emitted, which is
 * a clock bug rather than a fresh fact, and letting it through would make the world model treat
 * the fact as *newer* than the moment it arrived. An age longer than the app has been running
 * would push `observedAt` before our own epoch.
 */
function observedAt(receivedAt: MonoMs, emittedAt: number, capturedAt: number): MonoMs {
  const ageMs = Math.max(0, emittedAt - capturedAt);
  return Math.max(0, receivedAt - ageMs) as MonoMs;
}
