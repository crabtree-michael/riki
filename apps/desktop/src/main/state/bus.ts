/**
 * The observation bus — `state-capture-architecture.md` §6.3.
 *
 * Bounded per kind, with a **different policy per kind**, because the two kinds fail differently:
 *
 * - **GSI and log observations are never dropped.** They arrive at 2–8 Hz, they are authoritative,
 *   and each one carries information nothing else carries. If the bound is ever reached for one of
 *   these it means a subscriber is blocking, which is a bug — so the bound is not enforced by
 *   dropping, it is enforced by counting and delivering anyway.
 * - **CV batches drop oldest first.** A stale minimap frame is worthless the moment a newer one
 *   exists, so shedding the old one is strictly better than queueing it.
 *
 * Delivery is synchronous. §6.1 budgets steps 1–6 at under 10 ms and the whole path is a fold over
 * a snapshot, so a queue between publish and apply would buy latency and nothing else. The "depth"
 * this bus reports is therefore the depth of the *re-entrant* queue only: a subscriber that
 * publishes while being delivered to (the world model resetting on a match change, say) must not
 * recurse, and the queue is what stops it.
 */

import type { BusStats, Observation, ObservationBus, ObservationKind } from './contracts.js';

/** Per kind. Reached only if a subscriber re-publishes in a loop, which is a bug we want counted. */
const DEFAULT_BOUND = 64;

/** Kinds whose oldest entry is shed when the bound is reached. Everything else is delivered. */
const SHEDDABLE: ReadonlySet<ObservationKind> = new Set<ObservationKind>(['cv.detections']);

export interface ObservationBusOptions {
  readonly bound?: number;
}

export function createObservationBus(options: ObservationBusOptions = {}): ObservationBus {
  const bound = options.bound ?? DEFAULT_BOUND;
  const subscribers = new Set<(o: Observation) => void>();
  const dropped = new Map<ObservationKind, number>();
  const gaps = new Map<string, number>();
  const lastSeq = new Map<string, number>();

  const queue: Observation[] = [];
  let draining = false;

  /**
   * A gap means dropped observations; a decrease means reorder. Neither is fatal — precedence
   * rule 3 rejects a late observation per *field* rather than dropping it wholesale (§6.2) — so
   * this counts and moves on.
   */
  function noteSeq(o: Observation): void {
    const previous = lastSeq.get(o.sourceId);
    lastSeq.set(o.sourceId, o.seq);
    if (previous === undefined) return;
    if (o.seq !== previous + 1) gaps.set(o.sourceId, (gaps.get(o.sourceId) ?? 0) + 1);
  }

  function drop(kind: ObservationKind): void {
    dropped.set(kind, (dropped.get(kind) ?? 0) + 1);
  }

  return {
    publish(o: Observation): void {
      noteSeq(o);

      if (queue.length >= bound && SHEDDABLE.has(o.kind)) {
        // Oldest first, and only among the kind that tolerates it: a queued CV batch behind a
        // newer one is already wrong.
        const index = queue.findIndex((queued) => SHEDDABLE.has(queued.kind));
        if (index === -1) {
          drop(o.kind);
          return;
        }
        const shed = queue.splice(index, 1)[0];
        if (shed !== undefined) drop(shed.kind);
      }

      queue.push(o);
      if (draining) return;

      draining = true;
      try {
        while (queue.length > 0) {
          const next = queue.shift();
          if (next === undefined) break;
          for (const subscriber of [...subscribers]) subscriber(next);
        }
      } finally {
        draining = false;
        // A subscriber that threw must not leave a partial queue to be delivered out of order on
        // the next publish, which would be a reorder we invented rather than one Dota sent.
        queue.length = 0;
      }
    },

    subscribe(fn: (o: Observation) => void): () => void {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },

    stats(): BusStats {
      return {
        depth: queue.length,
        dropped: new Map(dropped),
        gaps: new Map(gaps),
      };
    },
  };
}
