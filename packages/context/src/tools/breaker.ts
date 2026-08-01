/**
 * The circuit breaker — turning a latency failure into an availability failure.
 *
 * Worth having in a component with a 1200 ms turn budget for one reason: without it a dead sidecar
 * costs *every* turn its full `observe` deadline, and the player experiences a coach who has become
 * slow rather than one who has lost a source. Slow is the failure this component cannot explain;
 * unavailable is the one it can.
 *
 * Breaker state is **advisory and superseded by real health**: `SourceSupervisor` (state-capture
 * §8.1) already knows the sidecar is down, and admission prefers that signal when it has one.
 *
 * See docs/design/agent-command-execution-architecture.md §7.3.
 */

import type { PortBreaker } from './contracts.js';
import type { MonoMs, PortId } from './types.js';

interface PortStatus {
  consecutiveFailures: number;
  openedAt: MonoMs | null;
  /** Set while a half-open probe is out, so the second caller does not also get through. */
  probing: boolean;
}

export interface BreakerOptions {
  readonly failureThreshold: number;
  readonly cooldownMs: number;
}

export function createPortBreaker(options: BreakerOptions): PortBreaker & {
  reset(port?: PortId): void;
} {
  const ports = new Map<PortId, PortStatus>();

  const statusFor = (port: PortId): PortStatus => {
    const existing = ports.get(port);
    if (existing !== undefined) return existing;
    const created: PortStatus = { consecutiveFailures: 0, openedAt: null, probing: false };
    ports.set(port, created);
    return created;
  };

  return {
    note(port: PortId, outcome: 'ok' | 'fail', now: MonoMs): void {
      const status = statusFor(port);
      if (outcome === 'ok') {
        status.consecutiveFailures = 0;
        status.openedAt = null;
        status.probing = false;
        return;
      }
      status.consecutiveFailures += 1;
      status.probing = false;
      if (status.consecutiveFailures >= options.failureThreshold) {
        // Re-stamp on every failure while open: a port that keeps failing keeps the cooldown
        // running, rather than being probed every 15 s forever on a stale timestamp.
        status.openedAt = now;
      }
    },

    state(port: PortId, now: MonoMs): 'closed' | 'open' | 'half_open' {
      const status = ports.get(port);
      if (status?.openedAt == null) return 'closed';
      if (now - status.openedAt < options.cooldownMs) return 'open';
      if (status.probing) return 'open';
      status.probing = true;
      return 'half_open';
    },

    reset(port?: PortId): void {
      if (port === undefined) ports.clear();
      else ports.delete(port);
    },
  };
}
