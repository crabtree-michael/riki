/**
 * The GSI listener.
 *
 * §6.1 fixes the order of the seven steps a POST goes through, and two of them are decisions
 * rather than plumbing:
 *
 * - **The response is sent before fusion runs.** Dota is waiting on this socket; making it wait
 *   on our processing would put our latency inside the game's. So the handler acknowledges,
 *   publishes, and returns.
 * - **A bad token is refused before the body is parsed.** Nothing untrusted gets as far as a
 *   parser, and the 403 costs one comparison.
 *
 * Everything that can fail, fails quietly and is counted. Dota does not read our status codes and
 * will keep POSTing regardless, so a 500 loop helps nobody and a thrown parse error would take
 * the listener down for a component Valve added last Tuesday.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createGsiAuthenticator, tokenFromBody } from './auth.js';
import { createGameClockEstimator } from './clock.js';
import type {
  GameClock,
  GsiServer,
  GsiServerOptions,
  MatchLifecycleEvent,
  MonoMs,
  Observation,
  SourceHealth,
  SourceId,
  Unsubscribe,
} from './contracts.js';
import { createGsiLiveness } from './liveness.js';
import { createGsiPayloadParser } from './parse.js';
import { createMatchSessionTracker } from './session.js';

/** The port the cfg written by `tools/setup-gsi-cfg` points at. */
export const DEFAULT_GSI_PORT = 53101;
/** 1 MiB (tunable). A real POST is a few kB; anything near this is not Dota. */
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

export const PROTOCOL_VERSION = 1;

export interface GsiServerExtras {
  /** Lifecycle edges, which the composition root turns into resets and preamble assembly. */
  onLifecycle(listener: (events: readonly MatchLifecycleEvent[]) => void): Unsubscribe;
  /** Interpolated match clock, for a caller stamping a fact between POSTs. */
  estimateClock(now: MonoMs): GameClock | null;
  /** Counters. Every failure path here is silent to the client, so it must not be silent to us. */
  stats(): GsiServerStats;
}

export interface GsiServerStats {
  readonly received: number;
  readonly accepted: number;
  readonly rejectedAuth: number;
  readonly rejectedParse: number;
  readonly rejectedTooLarge: number;
}

export type GsiServerWithExtras = GsiServer & GsiServerExtras;

export function createGsiServer(opts: GsiServerOptions): GsiServerWithExtras {
  const { port, token, clock, maxBodyBytes } = opts;
  const id = 'gsi' as SourceId;

  const auth = createGsiAuthenticator(token);
  const parser = createGsiPayloadParser();
  const liveness = createGsiLiveness();
  const session = createMatchSessionTracker();
  const estimator = createGameClockEstimator();

  const listeners = new Set<(o: Observation) => void>();
  const lifecycleListeners = new Set<(events: readonly MatchLifecycleEvent[]) => void>();

  let server: Server | null = null;
  let seq = 0;
  const stats = {
    received: 0,
    accepted: 0,
    rejectedAuth: 0,
    rejectedParse: 0,
    rejectedTooLarge: 0,
  };

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }

    stats.received += 1;
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;

    req.on('data', (chunk: Buffer) => {
      if (aborted) return;
      size += chunk.length;
      if (size > maxBodyBytes) {
        // Reject rather than buffer. The alternative is an unbounded allocation driven by
        // whatever else on this machine can reach loopback.
        aborted = true;
        stats.rejectedTooLarge += 1;
        res.writeHead(413).end();
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (aborted) return;

      const receivedAt = clock.now();
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        stats.rejectedParse += 1;
        res.writeHead(400).end();
        return;
      }

      // Auth first: nothing untrusted reaches the parser.
      if (auth.verify(tokenFromBody(body)) !== 'ok') {
        stats.rejectedAuth += 1;
        // The verdict is not echoed. "missing" versus "mismatch" is useful to us and is counted;
        // telling the caller which one would help someone guessing.
        res.writeHead(403).end();
        return;
      }

      const parsed = parser.parse(body);
      if (!parsed.ok) {
        stats.rejectedParse += 1;
        res.writeHead(200).end();
        return;
      }

      // The client is released here, before anything downstream runs (§6.1 step 4).
      res.writeHead(200).end();

      stats.accepted += 1;
      liveness.noteObservation(receivedAt);

      const map = parsed.value.map;
      if (map?.clock_time !== undefined) {
        estimator.update(map.clock_time as GameClock, receivedAt, map.paused ?? false);
      }

      const events = session.observe(parsed.value, { observedAt: receivedAt });
      if (events.length > 0) {
        for (const listener of lifecycleListeners) listener(events);
      }

      const observation: Observation = {
        kind: 'gsi.payload',
        sourceId: id,
        seq: seq++,
        receivedAt,
        payload: parsed.value,
        v: PROTOCOL_VERSION,
      };
      for (const listener of listeners) listener(observation);
    });
  };

  return {
    id,

    async start(): Promise<void> {
      if (server !== null) return;
      const created = createServer(handle);
      server = created;

      await new Promise<void>((resolve, reject) => {
        created.once('error', reject);
        // **Loopback only, and this is a security property rather than a default.** The endpoint
        // accepts an authenticated-shaped POST from anything that can reach it; binding 0.0.0.0
        // would put a per-install secret on the network as the only thing between a stranger and
        // a live feed of where the player is standing.
        created.listen(port, '127.0.0.1', () => {
          created.removeListener('error', reject);
          resolve();
        });
      });
    },

    async stop(): Promise<void> {
      const created = server;
      if (created === null) return;
      server = null;
      await new Promise<void>((resolve) => {
        created.close(() => {
          resolve();
        });
        // Dota holds the connection open between POSTs, so `close()` alone would wait for it.
        created.closeAllConnections();
      });
    },

    subscribe(listener: (o: Observation) => void): Unsubscribe {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    onLifecycle(listener: (events: readonly MatchLifecycleEvent[]) => void): Unsubscribe {
      lifecycleListeners.add(listener);
      return () => lifecycleListeners.delete(listener);
    },

    health(now: MonoMs): SourceHealth {
      const { state, sinceLastMs } = liveness.check(now);
      if (state === 'live' || state === 'starting') {
        return { state, lastObservationAt: lastObservationAt(sinceLastMs, now, state) };
      }
      return {
        state,
        lastObservationAt: lastObservationAt(sinceLastMs, now, state),
        // Shown to the user on degradation, so it names the fix and never the token.
        reason:
          state === 'down'
            ? 'No update from Dota 2 for over 35s — is the game still running?'
            : 'Dota 2 has been quiet longer than its heartbeat.',
      };
    },

    estimateClock(now: MonoMs): GameClock | null {
      return estimator.estimate(now);
    },

    stats(): GsiServerStats {
      return { ...stats };
    },

    get address(): { readonly port: number } | null {
      const addr = server?.address();
      return typeof addr === 'object' && addr !== null ? { port: addr.port } : null;
    },
  };
}

function lastObservationAt(
  sinceLastMs: number,
  now: MonoMs,
  state: SourceHealth['state'],
): MonoMs | null {
  return state === 'starting' ? null : ((now - sinceLastMs) as MonoMs);
}
