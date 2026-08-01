/**
 * What a source hands over, and the interface every source satisfies.
 *
 * An observation is **a batch of candidate facts, not a state**. The reducer decides what, if
 * anything, it changes. A source that believes it knows the world state has taken on a job that
 * belongs to fusion (ADR-0014).
 *
 * See docs/design/state-capture-architecture.md §3.3 and §3.4.
 *
 * Note on the boundary: `Observation` does not itself cross to Rust. The sidecar speaks
 * @riki/protocol messages, and `SidecarObservationSource` in the composition root (§4.3) wraps
 * them into an `Observation<'cv.detections'>`. That adapter is the reason the wire format and this
 * in-process vocabulary can evolve separately.
 *
 * ⚠ `packages/gsi` and `packages/log-tail` mirror `ObservationSource`, `SourceHealth` and
 * `SourceId` locally, because a source may not import this package (§2.3 — sources and the model
 * meet at a type, not at each other). The three copies collapse into @riki/protocol at
 * REPO_SKELETON.md §10 step 2.
 */

import type { MonoMs, Unsubscribe } from './time.js';

export type SourceId = string & { readonly __brand: 'SourceId' };

export type ObservationKind = 'gsi.payload' | 'log.event' | 'cv.detections' | 'api.enrichment';

/**
 * Payloads are deliberately opaque here. `packages/gsi` owns the shape of a parsed GSI POST,
 * `packages/log-tail` owns a parsed log line, and the CV batch is @riki/protocol's to define when
 * step 2 lands — this module must not become the place where every source's internals are
 * restated.
 */
export interface ObservationPayload {
  'gsi.payload': unknown;
  'log.event': unknown;
  'cv.detections': unknown;
  'api.enrichment': unknown;
}

export interface Observation<K extends ObservationKind = ObservationKind> {
  readonly kind: K;
  readonly sourceId: SourceId;
  /** Per-source monotone counter. A gap means dropped observations; a decrease means reorder. */
  readonly seq: number;
  readonly receivedAt: MonoMs;
  readonly payload: ObservationPayload[K];
  /** Protocol version, checked at the process boundary (REPO_SKELETON.md §4). */
  readonly v: number;
}

export interface SourceHealth {
  readonly state: 'starting' | 'live' | 'degraded' | 'down';
  readonly lastObservationAt: MonoMs | null;
  /** Human-readable, shown to the user on degradation. Never contains a token or chat text. */
  readonly reason?: string;
}

/**
 * The extensibility seam. Adding a fourth live source means implementing this, adding a payload
 * variant, adding a reducer arm and a precedence row — and changing no existing behaviour.
 */
export interface ObservationSource<K extends ObservationKind> {
  readonly id: SourceId;
  readonly kind: K;

  start(): Promise<void>;
  stop(): Promise<void>;
  subscribe(listener: (o: Observation<K>) => void): Unsubscribe;
  /** Cheap, synchronous, called by the supervisor on a timer. Must not do I/O. */
  health(now: MonoMs): SourceHealth;
}
