/**
 * The fakes that make almost all of this component Tier 1 — REPO_SKELETON.md §5.2.
 *
 * > No test may require a running Dota 2 client, a real microphone, a GPU, or a live OpenAI session.
 *
 * Everything this package touches is a port, and every one of them is satisfied here. `FakeMemoryStore`
 * is a `Map`, which is what makes the durable-memory tests — including the privacy egress test, the
 * one that cannot be walked back once it has failed in the field — run in a bare vitest process.
 *
 * These are not test-only scaffolding: `pnpm dev:replay` drives the real pipeline against them,
 * which is what keeps a fake from quietly drifting from the thing it stands in for (§5.5).
 *
 * Tier 3's own fakes (`FakeWorldModel`, `ManualClock`, `ManualTimers`, `FakeReferenceData`, …) are
 * re-exported rather than re-declared: a second `FakeWorldModel` with slightly different defaults is
 * exactly how two tiers start disagreeing about what a fixture means.
 */

export {
  ManualClock,
  ManualTimers,
  FakeWorldModel,
  FakeCapturePort,
  FakeFreshCapture,
  FakeReferenceData,
  RecordingConsentPort,
  RecordingTelemetry,
  createFakeToolPorts,
  cvChange,
  observed,
} from '../tools/testing/index.js';
export type { FactSpec, FakeToolPorts, FakeWorldOptions } from '../tools/testing/index.js';

import type { ContextTelemetry } from '../common/ports.js';
import type { GameClock } from '../common/types.js';
import type { TokenCounter } from '../render/types.js';
import type { EventTapeReader, MemoryStore } from '../memory/ports.js';
import type { TapeEvent } from '../snapshot/types.js';

/**
 * A `Map` with the `MemoryStore` shape. No paths, no `fs`, no `process.env`.
 *
 * `failWrites` exists because §10's durable-memory row promises that a store which cannot write
 * degrades rather than throwing — a promise no test can check against a store that always works.
 */
export class FakeMemoryStore implements MemoryStore {
  readonly bytes = new Map<string, Uint8Array>();
  readonly writes: string[] = [];
  failReads = false;
  failWrites = false;

  read(key: string): Promise<Uint8Array | null> {
    if (this.failReads) return Promise.reject(new Error('fake: unreadable'));
    return Promise.resolve(this.bytes.get(key) ?? null);
  }

  write(key: string, bytes: Uint8Array): Promise<void> {
    if (this.failWrites) return Promise.reject(new Error('fake: unwritable'));
    this.writes.push(key);
    this.bytes.set(key, bytes);
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.bytes.delete(key);
    return Promise.resolve();
  }

  list(prefix: string): Promise<readonly string[]> {
    return Promise.resolve([...this.bytes.keys()].filter((key) => key.startsWith(prefix)));
  }

  /** What a test asserts against in the egress test: everything ever written, as one string. */
  text(): string {
    return [...this.bytes.values()].map((b) => new TextDecoder().decode(b)).join('\n');
  }

  /** Puts arbitrary bytes at a key — the corrupt-file case, which must load as empty, not throw. */
  corrupt(key: string, text = '{ not json'): void {
    this.bytes.set(key, new TextEncoder().encode(text));
  }
}

/** `packages/events`' half of §8.2, without `packages/events`. Newest last, as the port promises. */
export class FakeEventTape implements EventTapeReader {
  events: TapeEvent[] = [];

  recent(n: number, since: GameClock | null): readonly TapeEvent[] {
    const filtered = since === null ? this.events : this.events.filter((e) => e.at >= since);
    return filtered.slice(-n);
  }

  push(event: TapeEvent): void {
    this.events.push(event);
  }
}

/**
 * A counter that returns exactly what a test tells it to.
 *
 * Every budget assertion in this component is really an assertion about *what happens at a
 * threshold*, and finding the string that costs exactly 401 tokens under the real estimator is
 * research, not a test. `fixed()` makes the threshold the input.
 */
export function fixedCounter(perCall: number): TokenCounter {
  return { count: (text) => (text === '' ? 0 : perCall) };
}

/** Records what the component reported, so a test can assert telemetry rather than infer it. */
export class RecordingContextTelemetry implements ContextTelemetry {
  readonly renders: { tier: string; elapsedMs: number; tokens: number }[] = [];
  readonly truncations: { tier: string; omitted: readonly string[] }[] = [];
  readonly compactions: { reason: string; droppedTokens: number; estimatedAfter: number }[] = [];
  readonly drifts: { estimated: number; reported: number }[] = [];

  noteRender(tier: 'preamble' | 'snapshot' | 'summary', elapsedMs: number, tokens: number): void {
    this.renders.push({ tier, elapsedMs, tokens });
  }

  noteTruncation(tier: string, omitted: readonly string[]): void {
    this.truncations.push({ tier, omitted });
  }

  noteCompaction(reason: string, droppedTokens: number, estimatedAfter: number): void {
    this.compactions.push({ reason, droppedTokens, estimatedAfter });
  }

  noteWindowDrift(estimated: number, reported: number): void {
    this.drifts.push({ estimated, reported });
  }
}
