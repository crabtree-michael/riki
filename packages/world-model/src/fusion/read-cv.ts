/**
 * A batch of sidecar detections, read into candidate facts.
 *
 * Everything about this file is shaped by one asymmetry: GSI goes silent but never lies, and CV
 * lies confidently after a resolution change (§1). So the reader is strict where the GSI reader is
 * lenient — a detection missing its confidence, or carrying one outside 0–1, is **rejected and
 * counted**, not clamped and admitted. A clamp would turn a detector bug into maximum confidence,
 * which is the exact failure the whole envelope exists to prevent (REPO_SKELETON §4).
 *
 * ⚠ The wire shape belongs to `@riki/protocol` (§4.3), which is step 2 and still empty, so the
 * batch is read structurally here and `CvDetection` below is the vocabulary the composition root's
 * `SidecarObservationSource` must produce. When protocol lands this becomes a schema; until then
 * `fixtures/protocol/` has nothing to check it against, and that gap is real.
 */

import type { Confidence, DetectorId, Timestamps } from '../fact.js';
import { asConfidence, cvFact } from '../fact.js';
import type { HeroId, ItemId, MapPosition, RoshanState } from '../state.js';
import { fieldPath, heroField, itemSeenField } from '../state.js';
import { asSeconds } from '../time.js';
import type { RejectionReason } from './reducer.js';
import type { Candidate } from './candidate.js';
import { asRecord, readBoolean, readNumber, readString } from './candidate.js';

/**
 * What one detector saw. The union is deliberately small: every arm below corresponds to a region
 * in dota2 §2.2's table, and adding a CV region should mean adding one arm here plus a precedence
 * row — not teaching the model a new concept (§9).
 */
export type CvDetection =
  | {
      readonly kind: 'hero_position';
      readonly side: 'allies' | 'enemies';
      readonly hero: string;
      readonly x: number;
      readonly y: number;
    }
  | {
      readonly kind: 'hero_alive';
      readonly side: 'allies' | 'enemies';
      readonly hero: string;
      readonly alive: boolean;
      readonly respawnIn?: number;
    }
  | {
      readonly kind: 'hero_level';
      readonly side: 'allies' | 'enemies';
      readonly hero: string;
      readonly level: number;
    }
  | {
      readonly kind: 'hero_net_worth';
      readonly side: 'allies' | 'enemies';
      readonly hero: string;
      readonly netWorth: number;
    }
  | { readonly kind: 'hero_item'; readonly hero: string; readonly item: string }
  | { readonly kind: 'roshan_state'; readonly state: RoshanState }
  | { readonly kind: 'wards_seen'; readonly wards: readonly MapPosition[] };

export interface CvReadResult {
  readonly candidates: readonly Candidate[];
  readonly rejections: readonly RejectionReason[];
}

/**
 * `payload` is expected to be `{ detections: [...] }`, each detection carrying its own
 * `detector`, `confidence` and — crucially — its own `observedAt`.
 *
 * The per-detection timestamp is not decoration. A batch is assembled over one capture pass but
 * the regions in it were sampled at different moments, and the observation's `receivedAt` is later
 * than all of them by however long the CV worker took. Ageing a minimap blob from the moment the
 * batch arrived rather than the moment the frame was captured makes every position look fresher
 * than it is, in the direction that gets someone killed. A detection with no `observedAt` falls
 * back to the batch timestamp, which is the honest ceiling.
 */
export function readCvDetections(payload: unknown, at: Timestamps): CvReadResult {
  const root = asRecord(payload);
  const raw = root?.detections;
  if (!Array.isArray(raw)) {
    return { candidates: [], rejections: [{ field: fieldPath('cv'), why: 'unparsed' }] };
  }

  const candidates: Candidate[] = [];
  const rejections: RejectionReason[] = [];

  for (const entry of raw) {
    const record = asRecord(entry);
    const detector = readString(record, 'detector');
    const confidence = readNumber(record, 'confidence');

    if (record === undefined || detector === undefined) {
      rejections.push({ field: fieldPath('cv'), why: 'unparsed' });
      continue;
    }
    if (confidence === undefined || confidence < 0 || confidence > 1) {
      // Not clamped. A score outside the range is a broken detector, and admitting it at 1.0 would
      // make the broken one the most trusted thing in the model.
      rejections.push({ field: fieldPath('cv', detector), why: 'unparsed' });
      continue;
    }

    const detection = readDetection(record);
    if (detection === null) {
      rejections.push({ field: fieldPath('cv', detector), why: 'unparsed' });
      continue;
    }

    const observedAt = readNumber(record, 'observedAt');
    const stamp: Timestamps =
      observedAt === undefined
        ? at
        : {
            observedAt: Math.min(observedAt, at.observedAt) as typeof at.observedAt,
            atGameClock: at.atGameClock,
          };

    candidates.push(
      ...candidatesFor(detection, stamp, asConfidence(confidence), detector as DetectorId),
    );
  }

  return { candidates, rejections };
}

function readDetection(record: Readonly<Record<string, unknown>>): CvDetection | null {
  const kind = readString(record, 'kind');
  const side = readString(record, 'side');
  const hero = readString(record, 'hero');
  const heroSide = side === 'allies' || side === 'enemies' ? side : undefined;

  switch (kind) {
    case 'hero_position': {
      const x = readNumber(record, 'x');
      const y = readNumber(record, 'y');
      if (hero === undefined || heroSide === undefined || x === undefined || y === undefined) {
        return null;
      }
      return { kind, side: heroSide, hero, x, y };
    }
    case 'hero_alive': {
      const alive = readBoolean(record, 'alive');
      if (hero === undefined || heroSide === undefined || alive === undefined) return null;
      const respawnIn = readNumber(record, 'respawnIn');
      return respawnIn === undefined
        ? { kind, side: heroSide, hero, alive }
        : { kind, side: heroSide, hero, alive, respawnIn };
    }
    case 'hero_level': {
      const level = readNumber(record, 'level');
      if (hero === undefined || heroSide === undefined || level === undefined) return null;
      return { kind, side: heroSide, hero, level };
    }
    case 'hero_net_worth': {
      const netWorth = readNumber(record, 'netWorth');
      if (hero === undefined || heroSide === undefined || netWorth === undefined) return null;
      return { kind, side: heroSide, hero, netWorth };
    }
    case 'hero_item': {
      const item = readString(record, 'item');
      if (hero === undefined || item === undefined) return null;
      return { kind, hero, item };
    }
    case 'roshan_state': {
      const state = readString(record, 'state');
      if (state !== 'alive' && state !== 'dead' && state !== 'unknown') return null;
      return { kind, state };
    }
    case 'wards_seen': {
      const wards = record.wards;
      if (!Array.isArray(wards)) return null;
      const parsed = wards.flatMap((ward): MapPosition[] => {
        const point = asRecord(ward);
        const x = readNumber(point, 'x');
        const y = readNumber(point, 'y');
        return x === undefined || y === undefined ? [] : [{ x, y }];
      });
      return { kind, wards: parsed };
    }
    default:
      return null;
  }
}

function candidatesFor(
  detection: CvDetection,
  at: Timestamps,
  confidence: Confidence,
  detector: DetectorId,
): readonly Candidate[] {
  const make = (path: ReturnType<typeof fieldPath>, value: unknown): Candidate => ({
    path,
    fact: cvFact(value, at, confidence, detector),
    detector,
  });

  switch (detection.kind) {
    case 'hero_position': {
      const hero = detection.hero as HeroId;
      const position: MapPosition = { x: detection.x, y: detection.y };
      // `lastSeenAt` is written by the same step, from the same observation, and given a far
      // longer expiry (fusion/staleness.ts). That is the whole mechanism behind §3.5's
      // "position expires into lastSeenAt" — no timer, no sweep, no mutation on read.
      return [
        make(heroField(detection.side, hero, 'position'), position),
        make(heroField(detection.side, hero, 'lastSeenAt'), position),
      ];
    }
    case 'hero_alive': {
      const hero = detection.hero as HeroId;
      const out = [make(heroField(detection.side, hero, 'alive'), detection.alive)];
      if (detection.respawnIn !== undefined) {
        out.push(
          make(heroField(detection.side, hero, 'respawnIn'), asSeconds(detection.respawnIn)),
        );
      }
      return out;
    }
    case 'hero_level':
      return [make(heroField(detection.side, detection.hero as HeroId, 'level'), detection.level)];
    case 'hero_net_worth':
      return [
        make(heroField(detection.side, detection.hero as HeroId, 'netWorth'), detection.netWorth),
      ];
    case 'hero_item': {
      const item = detection.item as ItemId;
      return [make(itemSeenField(detection.hero as HeroId, item), item)];
    }
    case 'roshan_state':
      return [make(fieldPath('map', 'roshanState'), detection.state)];
    case 'wards_seen':
      return [make(fieldPath('map', 'wardsSeen'), detection.wards)];
  }
}
