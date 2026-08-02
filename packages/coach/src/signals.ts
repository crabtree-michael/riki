/**
 * Detections into signals — the half of the pipeline this coach shares with the other one.
 *
 * `packages/events`' eight detectors are pure functions of a `WorldSnapshot` and they answer the
 * question *what is true right now*. That question has one correct answer regardless of which coach
 * is switched on, so both read the same eight files and requirement 3's "the same underlying
 * world-model detected events as triggers" is a shared import rather than a reimplementation.
 *
 * What this file does **not** carry over is everything downstream of that: no salience, no gates, no
 * latch, no cooldown. A `Detection` becomes a `CoachSignal` by losing its score and gaining one
 * fact — whether it is new — and the model decides the rest.
 *
 * That one fact does more work than it looks like. Since the tick was dropped (§4.5) a fresh signal
 * is the *only* thing that wakes the coach, so `fresh` is simultaneously an input to the judgement
 * and the trigger for asking for one. Both readings are the same question — has anything changed —
 * which is why it is one flag and not two.
 *
 * Pure but for one map: `freshness` remembers which keys were true at the last consultation, which
 * is the only state here and is why this is a factory rather than a function.
 *
 * See docs/design/llm-coach-architecture.md §4.1.
 */

import type { EventDetector, TriggerConfig } from '@riki/events';
import type { Detection, DetectionKey } from '@riki/events';
import type { WorldSnapshot } from '@riki/world-model';
import type { CoachSignal } from './types.js';

export interface SignalReader {
  /**
   * Every condition currently true, ordered for a model rather than for a gate.
   *
   * **Does not advance freshness.** Reading and committing are separate so a consultation that is
   * skipped — muted, mid-utterance, a request already in flight — does not silently spend the
   * `fresh` flag on a stimulus nobody ever saw. `commit()` is called once the model has been asked.
   *
   * The skips therefore *defer* a moment rather than dropping it: a condition that first became true
   * while Riki was mid-sentence is still `fresh` on the next version bump, and is judged then.
   */
  read(world: WorldSnapshot, limit: number): readonly CoachSignal[];
  /** Marks everything from the last `read` as no longer new. */
  commit(): void;
  clear(): void;
}

export interface SignalReaderDeps {
  readonly detectors: readonly EventDetector[];
  readonly config: TriggerConfig;
}

/**
 * Fresh first, then by magnitude.
 *
 * Not by salience: this package deliberately never computes one (`types.ts` says why). Magnitude is
 * a fact the detector states about its own instance — a hero missing for forty seconds beats one
 * missing for twenty-one — and ordering by it is a rendering decision rather than a policy, which
 * is the line `sections/util.ts` draws on the other side of the repo.
 *
 * The ordering only decides what survives `maxSignals`. Within the cap the model sees them all and
 * is under no obligation to prefer the first.
 */
function compare(a: CoachSignal, b: CoachSignal): number {
  if (a.fresh !== b.fresh) return a.fresh ? -1 : 1;
  return b.magnitude - a.magnitude;
}

export function createSignalReader(deps: SignalReaderDeps): SignalReader {
  /** Keys that were true the last time a consultation actually happened. */
  let seen = new Set<DetectionKey>();
  /** Keys from the most recent `read`, promoted into `seen` by `commit`. */
  let pending = new Set<DetectionKey>();

  function detect(world: WorldSnapshot): readonly Detection[] {
    const out: Detection[] = [];
    for (const detector of deps.detectors) {
      try {
        out.push(...detector.detect(world, deps.config));
      } catch {
        // A detector is specified as total, so this is a bug rather than a condition — and it is
        // caught for the same reason `packages/events`' engine catches it: one detector throwing
        // must not take the coaching path down with it. There is no per-kind counter here because
        // an unwired detector shows up as an absent signal in a recorded stimulus, which is the
        // corpus this coach is tuned against.
      }
    }
    return out;
  }

  return {
    read(world: WorldSnapshot, limit: number): readonly CoachSignal[] {
      const detections = detect(world);
      pending = new Set(detections.map((detection) => detection.key));

      // **A key survives `seen` only while its condition is still being detected.**
      //
      // Without this, `fresh` means "has never been consulted about since the match began", and a
      // condition that goes away and comes back — a hero who is missing, is spotted, and goes
      // missing again — is never a trigger a second time. The coach would consult once per
      // condition per match and then fall silent about it forever, which is not push-only, it is
      // once-only.
      //
      // It is the same reconciliation `packages/events`' engine does to its latches, for the same
      // reason and at the same point in the tick: the thing that clears the memory is the condition
      // disappearing from the detectors' output, and this is the only place that is known.
      for (const key of seen) {
        if (!pending.has(key)) seen.delete(key);
      }

      const signals = detections.map((detection): CoachSignal => ({
        kind: detection.kind,
        key: detection.key,
        // Copied, never derived. The topic that reaches `agent_said.topics` under this coach is
        // the detector's own value, which is what keeps ADR-0013's closed union closed across a
        // seam that has a language model in it (`types.ts`, `CoachJudgement.about`).
        topic: detection.topic,
        text: detection.text,
        magnitude: detection.magnitude,
        confidence: detection.confidence,
        actWithinSeconds: detection.actWithinSeconds,
        fresh: !seen.has(detection.key),
      }));

      return [...signals].sort(compare).slice(0, Math.max(0, limit));
    },

    commit(): void {
      seen = new Set(pending);
    },

    clear(): void {
      seen = new Set();
      pending = new Set();
    },
  };
}
