/**
 * What a reader hands the reducer.
 *
 * An observation is a batch of *candidate* facts (§3.3). The readers in this directory turn one
 * source's payload into candidates; `reducer.ts` decides which of them land. Splitting it this way
 * is what keeps the precedence, gate and ageing logic from being restated once per source — a
 * reader knows how Valve spells `respawn_seconds` and nothing else.
 *
 * The `detector` on a candidate is carried separately from the fact even though `cvFact` also
 * stores it in `origin`, because the confidence gate is keyed by detector and reading it back out
 * of an optional string field would be a parse where a value belongs.
 */

import type { DetectorId, Fact } from '../fact.js';
import type { FieldPath } from '../state.js';

export interface Candidate {
  readonly path: FieldPath;
  readonly fact: Fact<unknown>;
  /** Present only for `cv` candidates; the key the confidence gate is looking up. */
  readonly detector?: DetectorId;
}

/** Small, mistake-resistant readers for payloads whose shape is somebody else's to change. */
export function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

export function readNumber(
  source: Readonly<Record<string, unknown>> | undefined,
  key: string,
): number | undefined {
  const value = source?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function readString(
  source: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | undefined {
  const value = source?.[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export function readBoolean(
  source: Readonly<Record<string, unknown>> | undefined,
  key: string,
): boolean | undefined {
  const value = source?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

export function readRecord(
  source: Readonly<Record<string, unknown>> | undefined,
  key: string,
): Readonly<Record<string, unknown>> | undefined {
  return asRecord(source?.[key]);
}
