/**
 * The one test where both languages are in the room.
 *
 * Everything else about the sidecar is tested against a fake on one side or a fixture on the
 * other: `sidecar.test.ts` drives a fake process, `protocol-codec.test.ts` decodes strings, and
 * the Tier 3 corpus pins the two encoders to the same bytes. None of that would catch the app
 * spawning the real binary and the two of them failing to agree — a flag the sidecar does not
 * accept, a line the buffering splits wrongly, a handshake that never completes.
 *
 * So this spawns `target/debug/riki-vision` through the same `ChildProcessPort` Electron main
 * uses, with the same codec, and waits for a `cv.detections` to come back as an `Observation`.
 * No Dota, no display, no GPU: the sidecar replays `fixtures/frames/synthetic`.
 *
 * **It skips when the binary is absent**, which is the state of any machine that has not run
 * `cargo build`. REPO_SKELETON.md §5.2 forbids a test that requires a game or a GPU; it does not
 * forbid one that requires our own build output, but a hard failure here would mean a
 * TypeScript-only agent could not run `pnpm check`. The skip says which command fixes it.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { MonoMs, Observation } from '@riki/world-model';
import type { Problem, SidecarIdentity } from '@riki/protocol';
import {
  DEFAULT_CAPTURE_CONFIG,
  KILL_GRACE_MS,
  createNodeChildProcessPort,
  createProtocolCodec,
  createSidecarSource,
  type CvDetectionsPayload,
  type SidecarSource,
} from '../src/main/sidecar/index.js';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const BINARY = `${ROOT}target/debug/riki-vision`;
const FRAMES = `${ROOT}fixtures/frames/synthetic`;

const built = existsSync(BINARY);
const describeIfBuilt = built ? describe : describe.skip;

if (!built) {
  // Not a failure: `scripts/cargo.mjs` already skips the Rust half of the gate on a machine with
  // no toolchain, and this is the same honesty at the other end.
  console.warn(
    `[sidecar-process] skipped — ${BINARY} is not built. Run \`cargo build -p riki-vision\`.`,
  );
}

/** Real time, because a real process is on the other end of the pipe. */
function now(): MonoMs {
  return performance.now() as MonoMs;
}

async function waitFor<T>(what: string, poll: () => T | null, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = poll();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describeIfBuilt('the app and the real sidecar binary', () => {
  let source: SidecarSource | null = null;

  afterEach(async () => {
    await source?.stop();
    source = null;
  });

  it('completes the handshake and delivers a CV observation over a real pipe', async () => {
    const observations: Observation[] = [];
    const problems: Problem[] = [];
    let identity: SidecarIdentity | null = null;
    const undecodable: string[] = [];

    source = createSidecarSource({
      processes: createNodeChildProcessPort(),
      request: {
        command: BINARY,
        args: ['--backend', 'replay', '--frames', FRAMES],
        cwd: ROOT,
      },
      now,
      codec: createProtocolCodec({
        capture: { ...DEFAULT_CAPTURE_CONFIG, intervalMs: 50 },
        onReady: (sidecar) => {
          identity = sidecar;
        },
        onProblem: (problem) => problems.push(problem),
        onUndecodable: (line) => undecodable.push(line),
      }),
    });

    source.subscribe((observation) => observations.push(observation));
    await source.start();

    const observation = await waitFor('a cv.detections observation', () => observations[0] ?? null);

    // The handshake happened, and the sidecar said what it is.
    expect(identity).not.toBeNull();
    expect(identity).toMatchObject({ backend: 'replay', backendAvailable: true });

    // Nothing on stdout was unreadable. This is the assertion that a stray `println!` in the
    // sidecar would fail — stdout is protocol only (ADR-0029).
    expect(undecodable).toStrictEqual([]);
    expect(problems).toStrictEqual([]);

    // And a real crop of a real frame arrived, with the three fields REPO_SKELETON §4 makes
    // non-optional actually filled in.
    expect(observation.kind).toBe('cv.detections');
    const detection = (observation.payload as CvDetectionsPayload).detections[0];
    expect(detection?.detector).toBe('region-digest/v1');
    expect(detection?.confidence).toBeGreaterThan(0);
    expect(detection?.confidence).toBeLessThanOrEqual(1);
    // Derived from the sidecar's two timestamps into our clock, so it cannot be in the future.
    expect(detection?.observedAt).toBeLessThanOrEqual(observation.receivedAt);

    expect(detection?.payload.kind).toBe('region.digest');
    expect(detection?.payload.hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is reported as live once it is talking, and the handshake alone does not count', async () => {
    source = createSidecarSource({
      processes: createNodeChildProcessPort(),
      request: {
        command: BINARY,
        args: ['--backend', 'replay', '--frames', FRAMES],
        cwd: ROOT,
      },
      now,
      codec: createProtocolCodec({ capture: { ...DEFAULT_CAPTURE_CONFIG, intervalMs: 50 } }),
    });
    await source.start();

    const health = await waitFor('live health', () => {
      const current = source?.health(now());
      return current?.state === 'live' ? current : null;
    });

    expect(health.lastObservationAt).not.toBeNull();
    // `ready` is handled, not observed — see the counter split in `sidecar/index.ts`.
    expect(source.stats().linesHandled).toBeGreaterThanOrEqual(1);
    expect(source.stats().linesUndecodable).toBe(0);
  });

  it('answers SIGTERM well inside the kill grace period', async () => {
    // `stop()` sends SIGTERM and escalates to SIGKILL after KILL_GRACE_MS (2 s). A sidecar that
    // ignored the signal would still be torn down, but every app quit would take those two
    // seconds — and on a real backend it would be holding a capture session throughout. This is
    // the only place that can tell the two apart, because it needs a real process.
    const subject = createSidecarSource({
      processes: createNodeChildProcessPort(),
      request: {
        command: BINARY,
        args: ['--backend', 'replay', '--frames', FRAMES],
        cwd: ROOT,
      },
      now,
      codec: createProtocolCodec({ capture: DEFAULT_CAPTURE_CONFIG }),
    });
    await subject.start();
    await waitFor('the process to be running', () =>
      subject.health(now()).state === 'starting' ? true : null,
    );

    const startedAt = performance.now();
    await subject.stop();
    const tookMs = performance.now() - startedAt;

    expect(tookMs).toBeLessThan(KILL_GRACE_MS);
  });
});
