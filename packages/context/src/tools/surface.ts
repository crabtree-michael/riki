/**
 * `buildToolSurface()` — what `packages/context` hands the composition root.
 *
 * Nothing above this file constructs anything, and this file constructs everything: the registry,
 * the six pipeline stages, the queue, and the turn bookkeeping. The composition root
 * (`apps/desktop/src/main/agent/`, §9.3) wires the result to a session through `ToolCallBridge`,
 * which is the only file in the repo that speaks both this vocabulary and the Realtime one.
 *
 * The manifest is computed **here**, once, and frozen (ADR-0011).
 *
 * See docs/design/agent-command-execution-architecture.md §9.3.
 */

import type { RegisteredTool, ToolManifest, ToolSurface } from './contracts.js';
import type { ManifestEnvironment } from './contracts.js';
import type { MonoMs, PrivacyPolicy, TurnId } from './types.js';
import type { ToolPorts } from './ports.js';
import type { Timers } from './timers.js';
import type { ToolTunables } from './tunables.js';
import { ALL_HANDLERS } from './all-handlers.js';
import { DEFAULT_TUNABLES } from './tunables.js';
import { RateLimiter, ALWAYS_HEALTHY, createAdmissionController } from './admission.js';
import type { PortHealth } from './admission.js';
import { DEFAULT_PRIVACY } from '../render/privacy.js';
import { Turn } from './turn.js';
import { createExecutor } from './executor.js';
import { createParser } from './parse.js';
import { createPortBreaker } from './breaker.js';
import { createRegistry } from './registry.js';
import { createSubjectResolver } from './resolve.js';
import { createToolQueue } from './queue.js';

export interface ToolSurfaceDeps {
  readonly ports: ToolPorts;
  /** Decided before the session opens, never during it (ADR-0011). */
  readonly env: ManifestEnvironment;
  /** From `packages/config`, injected. This package never reads `process.env`. */
  readonly privacy?: PrivacyPolicy;
  readonly tunables?: Partial<ToolTunables>;
  /** `SourceSupervisor`'s view when there is one; the breaker is the fallback (§7.3). */
  readonly health?: PortHealth;
  readonly timers?: Timers;
  /** Defaults to the eight commands. A test registers fewer, or its own. */
  readonly tools?: readonly RegisteredTool[];
}

export interface AgentToolSurface extends ToolSurface {
  readonly manifest: ToolManifest;
}

export function buildToolSurface(deps: ToolSurfaceDeps): AgentToolSurface {
  const tunables: ToolTunables = { ...DEFAULT_TUNABLES, ...deps.tunables };
  const privacy = deps.privacy ?? DEFAULT_PRIVACY;

  const registry = createRegistry(deps.tools ?? ALL_HANDLERS);
  const rate = new RateLimiter();
  const breaker = createPortBreaker({
    failureThreshold: tunables.breakerFailureThreshold,
    cooldownMs: tunables.breakerCooldownMs,
  });

  const late = { count: 0 };
  const queue = createToolQueue({
    clock: deps.ports.clock,
    ...(deps.timers === undefined ? {} : { timers: deps.timers }),
    onLateValue: () => {
      late.count += 1;
    },
  });

  const turns = new Map<TurnId, Turn>();

  const executor = createExecutor({
    registry,
    parser: createParser(registry),
    resolver: createSubjectResolver(),
    admission: createAdmissionController({
      registry,
      breaker,
      health: deps.health ?? ALWAYS_HEALTHY,
      rate,
      turnResultTokens: tunables.turnResultTokens,
      consentTimeoutMs: tunables.consentTimeoutMs,
    }),
    queue,
    breaker,
    rate,
    ports: deps.ports,
    clock: deps.ports.clock,
    privacy,
    turns,
    late,
  });

  return {
    // Computed once and frozen: changing the set mid-session rewrites the cached prefix, which
    // realtime §5 names as the cost and latency cliff of a long session (§8.1).
    manifest: registry.manifest(deps.env, deps.ports.clock.now(), tunables.manifestMaxTokens),
    executor,

    openTurn(turnId: TurnId, now: MonoMs) {
      const turn = new Turn(turnId, now, tunables.turnDeadlineMs);
      turns.set(turnId, turn);
      return turn;
    },

    closeTurn(turnId: TurnId) {
      // Draining rather than merely forgetting: anything still queued for this turn resolves with
      // `cancelled` instead of leaving a promise its caller is still holding (§6.5).
      queue.cancel(turnId, 'session_closed');
      turns.get(turnId)?.cancel('session_closed');
      turns.delete(turnId);
      rate.endTurn(turnId);
    },
  };
}
