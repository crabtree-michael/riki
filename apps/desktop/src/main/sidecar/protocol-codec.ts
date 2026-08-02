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
  type Problem,
  type SidecarIdentity,
  commands,
  decodeSidecarEvent,
  encodeMessage,
} from '@riki/protocol';
import type { MonoMs, Observation, SourceId } from '@riki/world-model';
import type { DecodedLine, SidecarCodec } from './contracts.js';

/**
 * A CV fact with its timestamp translated into our clock.
 *
 * Confidence, provenance and a timestamp are all still non-optional — the protocol makes them so,
 * and nothing here is allowed to widen that.
 */
export interface CvDetection {
  readonly regionId: CvFact['regionId'];
  readonly detector: string;
  readonly confidence: number;
  /** Local monotonic, derived from the sidecar's two timestamps. See the header. */
  readonly observedAt: MonoMs;
  readonly payload: CvFact['payload'];
}

/** The payload of an `Observation<'cv.detections'>` from the sidecar. */
export interface CvDetectionsPayload {
  readonly detections: readonly CvDetection[];
}

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
          const observation: Observation<'cv.detections'> = {
            kind: 'cv.detections',
            sourceId,
            seq,
            receivedAt: at,
            payload: {
              detections: event.facts.map((fact) => ({
                regionId: fact.regionId,
                detector: fact.detector,
                confidence: fact.confidence,
                observedAt: observedAt(at, event.emittedAtMonoMs, fact.capturedAtMonoMs),
                payload: fact.payload,
              })),
            } satisfies CvDetectionsPayload,
            v: event.v,
          };
          return { kind: 'observation', observation };
        }
      }
    },
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
